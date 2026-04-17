#!/usr/bin/env node
/**
 * Auto Memory Bridge Hook
 *
 * Bridges ruflo-personal (HTTP MCP server) with Claude Code sessions.
 * On session start: fetches patterns from ruflo-personal and outputs them as context.
 * On session end: syncs pending insights from local files to ruflo-personal.
 *
 * Usage:
 *   node auto-memory-hook.mjs import   # SessionStart: fetch patterns from ruflo-personal
 *   node auto-memory-hook.mjs sync     # Stop: push pending insights to ruflo-personal
 *   node auto-memory-hook.mjs status   # Show bridge status
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '../..');
const DATA_DIR = join(PROJECT_ROOT, '.claude-flow', 'data');
const INSIGHTS_PATH = join(DATA_DIR, 'pending-insights.jsonl');

// Derive project namespace from directory name
const PROJECT_NS = basename(PROJECT_ROOT);

// Colors
const GREEN = '\x1b[0;32m';
const CYAN = '\x1b[0;36m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const log = (msg) => console.log(`${CYAN}[AutoMemory] ${msg}${RESET}`);
const success = (msg) => console.log(`${GREEN}[AutoMemory] \u2713 ${msg}${RESET}`);
const dim = (msg) => console.log(`  ${DIM}${msg}${RESET}`);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ============================================================================
// Ruflo-personal HTTP client (JSON-RPC over HTTP)
// ============================================================================

// Read ruflo config (URL + token) from project config or environment
let _rufloConfig = undefined;
function getRufloConfig() {
  if (_rufloConfig !== undefined) return _rufloConfig;
  _rufloConfig = { url: 'http://localhost:3000/mcp', token: '' };

  // 1. Project-level config (.claude-flow/ruflo.json)
  const configPath = join(PROJECT_ROOT, '.claude-flow', 'ruflo.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (config.serverUrl) _rufloConfig.url = config.serverUrl;
      if (config.token) _rufloConfig.token = config.token;
    } catch { /* ignore */ }
  }

  // 2. Env vars override
  if (process.env.RUFLO_URL) _rufloConfig.url = process.env.RUFLO_URL;
  if (process.env.RUFLO_TOKEN) _rufloConfig.token = process.env.RUFLO_TOKEN;

  return _rufloConfig;
}

// Discover ruflo-hub URL from config, environment, or nearby ruflo-hub project
function getRufloUrl() {
  const config = getRufloConfig();
  if (config.url !== 'http://localhost:3000/mcp') return config.url;

  // Auto-discover from sibling ruflo-hub project (fallback only)
  if (process.env.RUFLO_URL) return process.env.RUFLO_URL;

  // Check project config already read above
  const rufloConfig = join(PROJECT_ROOT, '.claude-flow', 'ruflo.json');
  if (existsSync(rufloConfig)) {
    try {
      const cfg = JSON.parse(readFileSync(rufloConfig, 'utf-8'));
      if (cfg.serverUrl) return cfg.serverUrl;
    } catch { /* ignore */ }
  }

  // 3. Auto-discover from sibling ruflo-hub project (with legacy ruflo-server fallback)
  const knownPaths = [
    join(dirname(PROJECT_ROOT), 'ruflo-hub'),
    join(PROJECT_ROOT, '..', 'ruflo-hub'),
    join(dirname(PROJECT_ROOT), 'ruflo-server'),
    join(PROJECT_ROOT, '..', 'ruflo-server'),
  ];
  for (const p of knownPaths) {
    // Read host from .env or docker-compose
    let host = 'localhost';
    let port = '3000';

    const envFile = join(p, '.env');
    if (existsSync(envFile)) {
      try {
        const content = readFileSync(envFile, 'utf-8');
        const portMatch = content.match(/RUFLO_PORT=(\d+)/);
        if (portMatch) port = portMatch[1];
        const hostMatch = content.match(/RUFLO_HOST=(.+)/);
        if (hostMatch) host = hostMatch[1].trim();
      } catch { /* ignore */ }
    }

    const override = join(p, 'docker-compose.override.yml');
    if (existsSync(override)) {
      try {
        const content = readFileSync(override, 'utf-8');
        const portMatch = content.match(/RUFLO_PORT:\s*(\d+)/);
        if (portMatch) port = portMatch[1];
      } catch { /* ignore */ }
    }

    if (existsSync(join(p, 'server.mjs'))) {
      return `http://${host}:${port}/mcp`;
    }
  }

  // 4. Default fallback
  return 'http://localhost:3000/mcp';
}

function callRuflo(method, args, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const url = new URL(getRufloUrl());
    const config = getRufloConfig();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: method, arguments: args },
      id: Date.now(),
    });

    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (config.token) headers['Authorization'] = `Bearer ${config.token}`;

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.result && parsed.result.content && parsed.result.content[0]) {
            resolve(JSON.parse(parsed.result.content[0].text));
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ============================================================================
// Commands
// ============================================================================

async function doImport() {
  log('Importing auto memory files into bridge...');

  // 1. Fetch patterns from ruflo-personal for this project
  const listResult = await callRuflo('memory_list', { namespace: PROJECT_NS, limit: 30 });

  if (listResult && listResult.total > 0) {
    success(`ruflo-personal: ${listResult.total} patterns in namespace "${PROJECT_NS}"`);

    // Fetch each entry's content and output as context
    const entries = listResult.entries || [];
    for (const entry of entries.slice(0, 10)) {
      const detail = await callRuflo('memory_retrieve', {
        key: entry.key,
        namespace: PROJECT_NS,
      });
      if (detail && detail.found && detail.value) {
        dim(`[${entry.key}] ${detail.value.substring(0, 150)}`);
      }
    }
    if (listResult.total > 10) {
      dim(`... and ${listResult.total - 10} more patterns`);
    }
  } else if (listResult) {
    dim(`ruflo-personal: no patterns for "${PROJECT_NS}" yet`);
  } else {
    dim('ruflo-personal: server unreachable (non-critical)');
  }

  // 2. Also check cross-project patterns (namespace: "shared")
  const sharedResult = await callRuflo('memory_list', { namespace: 'shared', limit: 10 });
  if (sharedResult && sharedResult.total > 0) {
    success(`ruflo-personal: ${sharedResult.total} shared cross-project patterns`);
    for (const entry of (sharedResult.entries || []).slice(0, 5)) {
      const detail = await callRuflo('memory_retrieve', {
        key: entry.key,
        namespace: 'shared',
      });
      if (detail && detail.found && detail.value) {
        dim(`[shared/${entry.key}] ${detail.value.substring(0, 150)}`);
      }
    }
  }
}

async function doSync() {
  log('Syncing insights to ruflo-personal...');

  // Read pending insights from JSONL
  if (!existsSync(INSIGHTS_PATH)) {
    dim('No pending insights to sync');
    return;
  }

  const lines = readFileSync(INSIGHTS_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    dim('No pending insights to sync');
    return;
  }

  // Group edits by file to create meaningful patterns
  const editsByFile = new Map();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'edit' && entry.file) {
        const file = entry.file;
        if (!editsByFile.has(file)) editsByFile.set(file, []);
        editsByFile.get(file).push(entry);
      }
    } catch { /* skip malformed */ }
  }

  // Store edit patterns for Om-model files (encoding-related)
  let synced = 0;
  for (const [file, edits] of editsByFile) {
    // Only create patterns for significant edit groups (3+ edits = likely a pattern)
    if (edits.length < 3) continue;

    const fileName = basename(file, '.php');
    const result = await callRuflo('memory_store', {
      key: `edit-pattern-${fileName}`,
      value: `File ${fileName} edited ${edits.length} times in session. Path: ${file}`,
      namespace: PROJECT_NS,
      metadata: { type: 'edit-pattern', file, editCount: edits.length },
    });
    if (result && result.success) synced++;
  }

  // Read Claude's auto-memory files and sync key patterns to ruflo server
  // Claude Code stores memory in ~/.claude/projects/-<path-with-dashes>/memory/
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const projectSlug = PROJECT_ROOT.replace(/\//g, '-').replace(/^-/, '');
  const memoryDir = join(home, '.claude', 'projects', `-${projectSlug}`, 'memory');

  if (existsSync(memoryDir)) {
    const memFiles = readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of memFiles) {
      try {
        const content = readFileSync(join(memoryDir, file), 'utf-8');
        // Parse frontmatter
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fmMatch) continue;

        const frontmatter = fmMatch[1];
        const body = fmMatch[2].trim();
        const nameMatch = frontmatter.match(/name:\s*(.+)/);
        const typeMatch = frontmatter.match(/type:\s*(.+)/);
        const name = nameMatch ? nameMatch[1].trim() : file;
        const type = typeMatch ? typeMatch[1].trim() : 'unknown';

        // Only sync feedback and project memories (most useful cross-session)
        if (type === 'feedback' || type === 'project') {
          const key = `claude-memory-${file.replace('.md', '')}`;
          const result = await callRuflo('memory_store', {
            key,
            value: `[${type}] ${name}: ${body.substring(0, 500)}`,
            namespace: PROJECT_NS,
            metadata: { type, source: 'claude-auto-memory', file },
          });
          if (result && result.success) synced++;
        }
      } catch { /* skip */ }
    }
  }

  if (synced > 0) {
    success(`Synced ${synced} patterns to ruflo-personal`);
  } else {
    dim('No new patterns to sync');
  }
}

async function doStatus() {
  console.log('\n=== Auto Memory Bridge Status ===\n');

  const url = getRufloUrl();
  console.log(`  Server:     ${url}`);

  const health = await callRuflo('memory_stats', {});
  if (health) {
    console.log(`  Status:     \u2705 Connected`);
    console.log(`  Entries:    ${health.totalEntries || 0}`);
    console.log(`  Backend:    ${health.backend || 'unknown'}`);
  } else {
    console.log(`  Status:     \u274C Unreachable`);
  }

  const projectList = await callRuflo('memory_list', { namespace: PROJECT_NS });
  console.log(`  Project:    ${PROJECT_NS} (${projectList ? projectList.total : '?'} patterns)`);

  const sharedList = await callRuflo('memory_list', { namespace: 'shared' });
  console.log(`  Shared:     ${sharedList ? sharedList.total : '?'} patterns`);

  console.log('');
}

// ============================================================================
// Main
// ============================================================================

const command = process.argv[2] || 'status';

process.on('unhandledRejection', () => {});

try {
  switch (command) {
    case 'import': await doImport(); break;
    case 'sync': await doSync(); break;
    case 'status': await doStatus(); break;
    default:
      console.log('Usage: auto-memory-hook.mjs <import|sync|status>');
      break;
  }
} catch (err) {
  try { dim(`Error (non-critical): ${err.message}`); } catch (_) {}
}
process.exit(0);
