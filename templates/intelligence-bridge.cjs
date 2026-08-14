#!/usr/bin/env node
/**
 * Intelligence bridge — sends learning signals to ruflo MCP server via HTTP
 * (JSON-RPC). All calls are fire-and-forget with a hard timeout so hooks
 * never block Claude Code.
 *
 * Strategy: writes patterns directly via `hooks_intelligence_pattern-store`
 * (HNSW-indexed) instead of `trajectory-*`. The trajectory API in ruflo 3.5
 * returns a session id but does not persist trajectories/steps to SQLite,
 * which makes downstream learning a no-op. Patterns persist reliably.
 *
 * Session state (sessionId, task) is kept in `.claude-flow/.trajectory.json`
 * so step()/end() invoked from separate hook-handler runs share context.
 *
 * ─── Pattern writes are OFF by default (RUFLO_PATTERN_STORE) ───────────────
 * Every pattern-store lands one row in the server's shared `memory.db`,
 * namespace `pattern`, with a unique key (never upserted) and no TTL. On the
 * sql.js fallback path that upstream uses, a single write costs a full
 * read-modify-write of the ENTIRE database file — twice, because
 * ensureSchemaColumns() rewrites the image before the operation does. At one
 * row per Bash/Edit call across every project the file grew to 336 MB, which
 * put every memory operation at ~10 s and made the shared server unusable.
 * See MEMORY-DB-BLOAT-INVESTIGATION.md for the measurements.
 *
 * So this is opt-in now:
 *   RUFLO_PATTERN_STORE unset / "0" / "off"  → no pattern writes (default)
 *   RUFLO_PATTERN_STORE=1 / "on"             → write every step (old behaviour)
 *   RUFLO_PATTERN_STORE=20                   → sample: write ~1 step in 20
 * Session-summary writes from end() follow the same switch.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const RUFLO_JSON = path.join(PROJECT_DIR, '.claude-flow', 'ruflo.json');
const STATE_FILE = path.join(PROJECT_DIR, '.claude-flow', '.trajectory.json');
const HTTP_TIMEOUT_MS = 1500;
const PROJECT_NAME = path.basename(PROJECT_DIR);

// Parsed once per hook process. Returns 0 when disabled, else the sampling
// denominator (1 = every call).
function patternStoreRate() {
  const raw = String(process.env.RUFLO_PATTERN_STORE || '').trim().toLowerCase();
  if (raw === '' || raw === '0' || raw === 'off' || raw === 'false' || raw === 'no') return 0;
  if (raw === '1' || raw === 'on' || raw === 'true' || raw === 'yes') return 1;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function patternStoreAllowed() {
  const rate = patternStoreRate();
  if (rate === 0) return false;
  if (rate === 1) return true;
  return Math.random() < 1 / rate;
}

function readRufloConfig() {
  try { return JSON.parse(fs.readFileSync(RUFLO_JSON, 'utf8')); } catch (_) { return null; }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (_) { /* non-fatal */ }
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch (_) { /* non-fatal */ }
}

async function callTool(name, args) {
  const cfg = readRufloConfig();
  if (!cfg || !cfg.serverUrl) return null;
  if (typeof fetch !== 'function') return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;

  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name, arguments: args },
    id: Date.now(),
  });

  try {
    const resp = await fetch(cfg.serverUrl, { method: 'POST', headers, body, signal: ctrl.signal });
    if (!resp.ok) return null;
    return true;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function trim(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}

async function start(task, agent) {
  const sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  writeState({
    sessionId,
    task: trim(task || 'Claude Code session', 200),
    agent: agent || 'claude-code',
    project: PROJECT_NAME,
    startedAt: Date.now(),
  });
}

async function step(action, result, quality) {
  const state = readState();
  if (!state) return;
  if (!patternStoreAllowed()) return; // see RUFLO_PATTERN_STORE note at the top
  const pattern = `[${state.project}] ${trim(action, 100)}${result ? ` → ${trim(result, 200)}` : ''}`;
  await callTool('hooks_intelligence_pattern-store', {
    pattern,
    type: 'action',
    confidence: typeof quality === 'number' ? quality : 0.6,
    metadata: {
      sessionId: state.sessionId,
      action: trim(action, 100),
      result: trim(result, 300),
      project: state.project,
      task: state.task,
      ts: Date.now(),
    },
  });
}

async function end(success) {
  const state = readState();
  if (!state) return;
  // Still clear the session state when writes are off, or .trajectory.json
  // would linger and make the next session look like a resumed one.
  if (patternStoreRate() === 0) {
    clearState();
    return;
  }
  const durationSec = Math.round((Date.now() - state.startedAt) / 1000);
  await callTool('hooks_intelligence_pattern-store', {
    pattern: `[${state.project}] session ${success !== false ? 'completed' : 'failed'}: ${trim(state.task, 200)}`,
    type: 'session',
    confidence: success !== false ? 0.8 : 0.3,
    metadata: {
      sessionId: state.sessionId,
      project: state.project,
      task: state.task,
      durationSec,
      success: success !== false,
      ts: Date.now(),
    },
  });
  clearState();
}

module.exports = { start, step, end };
