import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import express from 'express';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, 'templates');

const PORT = parseInt(process.env.RUFLO_PORT || '3000', 10);
const TOKEN = process.env.MCP_AUTH_TOKEN || '';

function ts() {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

// --- Connect to ruflo as MCP client via stdio ---
console.log(`[${ts()}] Connecting to ruflo stdio...`);

const stdioTransport = new StdioClientTransport({
  command: 'ruflo',
  args: ['mcp', 'start'],
});

const client = new Client({ name: 'ruflo-proxy', version: '1.0.0' });
await client.connect(stdioTransport);

// Cache tool list at startup
const toolsResult = await client.listTools();
console.log(`[${ts()}] Connected to ruflo: ${toolsResult.tools.length} tools`);

// --- Express app ---
const app = express();
app.use(express.json());

function checkAuth(req, res) {
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) {
    console.log(`[${ts()}] 401 Unauthorized (ip: ${req.ip})`);
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Unauthorized' },
      id: null,
    });
    return false;
  }
  return true;
}

function jsonrpc(id, result) {
  return { jsonrpc: '2.0', result, id };
}

function jsonrpcError(id, code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id };
}

app.post('/mcp', async (req, res) => {
  if (!checkAuth(req, res)) return;

  const { method, params, id } = req.body;

  try {
    switch (method) {
      case 'initialize':
        res.json(jsonrpc(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ruflo-proxy', version: '1.0.0' },
        }));
        return;

      case 'notifications/initialized':
        res.status(204).end();
        return;

      case 'ping':
        res.json(jsonrpc(id, {}));
        return;

      case 'tools/list':
        res.json(jsonrpc(id, toolsResult));
        return;

      case 'tools/call': {
        const name = params?.name || '?';
        const args = params?.arguments || {};
        console.log(`[${ts()}] ${name} ${JSON.stringify(args).slice(0, 200)}`);

        const result = await client.callTool({ name, arguments: args });
        res.json(jsonrpc(id, result));
        return;
      }

      default:
        console.log(`[${ts()}] Unknown method: ${method}`);
        res.json(jsonrpcError(id, -32601, `Method not found: ${method}`));
    }
  } catch (error) {
    console.error(`[${ts()}] Error:`, error.message);
    res.json(jsonrpcError(id, -32603, error.message));
  }
});

app.get('/mcp', (_req, res) => {
  res.status(405).json(jsonrpcError(null, -32000, 'Method not allowed.'));
});

app.delete('/mcp', (_req, res) => {
  res.status(405).json(jsonrpcError(null, -32000, 'Method not allowed.'));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', tools: toolsResult.tools.length });
});

// GET /stats — summary for statusline clients (no auth, like /health).
// Tries memory_stats first, falls back to memory_list for vector counting.
app.get('/stats', async (_req, res) => {
  const summary = { status: 'ok', vectorCount: 0, namespaces: 0, tools: toolsResult.tools.length, source: 'none' };

  const extractCount = (text) => {
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return { count: parsed.length, namespaces: 0 };
      const count = parsed.totalEntries ?? parsed.total ?? parsed.count
                  ?? parsed.entries?.length ?? parsed.items?.length
                  ?? parsed.vectors ?? parsed.vectorCount ?? 0;
      const nsRaw = parsed.namespaces;
      const namespaces = Array.isArray(nsRaw) ? nsRaw.length
                       : typeof nsRaw === 'number' ? nsRaw
                       : (nsRaw && typeof nsRaw === 'object') ? Object.keys(nsRaw).length
                       : parsed.namespaceCount ?? 0;
      return { count: Number(count) || 0, namespaces: Number(namespaces) || 0 };
    } catch {
      const m = text.match(/(\d+)\s*(?:total\s*)?(?:entries|records|patterns|vectors)/i);
      if (m) return { count: parseInt(m[1], 10) || 0, namespaces: 0 };
      return null;
    }
  };

  // Try memory_stats
  try {
    const result = await client.callTool({ name: 'memory_stats', arguments: {} });
    const text = result?.content?.[0]?.text || '';
    const parsed = extractCount(text);
    if (parsed) {
      summary.vectorCount = parsed.count;
      summary.namespaces = parsed.namespaces;
      summary.source = 'memory_stats';
    }
  } catch { /* fall through */ }

  // Fallback: memory_list
  if (summary.vectorCount === 0) {
    try {
      const result = await client.callTool({ name: 'memory_list', arguments: {} });
      const text = result?.content?.[0]?.text || '';
      const parsed = extractCount(text);
      if (parsed) {
        summary.vectorCount = parsed.count;
        if (!summary.namespaces) summary.namespaces = parsed.namespaces;
        summary.source = summary.source === 'none' ? 'memory_list' : summary.source;
      }
    } catch { /* ignore */ }
  }

  // Swarm status
  summary.swarm = { active: false, agentCount: 0, maxAgents: 0, topology: null };
  try {
    const result = await client.callTool({ name: 'swarm_status', arguments: {} });
    const text = result?.content?.[0]?.text || '';
    try {
      const parsed = JSON.parse(text);
      summary.swarm.active = parsed.status === 'running' || parsed.status === 'active';
      summary.swarm.agentCount = Number(parsed.agentCount) || 0;
      summary.swarm.maxAgents = Number(parsed.maxAgents) || 0;
      summary.swarm.topology = parsed.topology || null;
    } catch { /* ignore */ }
  } catch { /* ignore */ }

  // Real agent count (swarm_status.agentCount may lag behind agent_spawn)
  try {
    const result = await client.callTool({ name: 'agent_list', arguments: {} });
    const text = result?.content?.[0]?.text || '';
    try {
      const parsed = JSON.parse(text);
      let count = 0;
      if (Array.isArray(parsed)) count = parsed.length;
      else if (Array.isArray(parsed?.agents)) count = parsed.agents.length;
      else if (typeof parsed?.total === 'number') count = parsed.total;
      if (count > summary.swarm.agentCount) summary.swarm.agentCount = count;
    } catch { /* ignore */ }
  } catch { /* ignore */ }

  res.json(summary);
});

// ─── MCP Streamable HTTP: handle OAuth discovery gracefully ───────
// Claude Code with type:"http" tries OAuth before connecting.
// These endpoints tell it "no auth needed" so it falls through to direct connection.

app.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.status(404).json({ error: 'oauth_not_supported' });
});

app.post('/register', (_req, res) => {
  res.status(404).json({ error: 'oauth_not_supported' });
});

app.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.status(404).json({ error: 'oauth_not_supported' });
});

// ─── Setup & Templates ────────────────────────────────────────────

// GET /templates/:name — serve template files
app.get('/templates/:name', (req, res) => {
  const name = req.params.name;
  const filePath = join(TEMPLATES_DIR, name);
  if (!existsSync(filePath) || name.includes('..')) {
    return res.status(404).send('Template not found');
  }
  res.type('text/plain').send(readFileSync(filePath, 'utf-8'));
});

// GET /templates — list available templates
app.get('/templates', (_req, res) => {
  try {
    const files = readdirSync(TEMPLATES_DIR).filter(f => !f.startsWith('.'));
    res.json({ templates: files });
  } catch {
    res.json({ templates: [] });
  }
});

// GET /setup — return a self-configuring shell script
// Usage: curl http://ruflo-server:PORT/setup | bash
//    or: curl http://ruflo-server:PORT/setup?project=/path/to/project | bash
app.get('/setup', (req, res) => {
  const serverHost = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${proto}://${serverHost}`;
  const token = req.query.token || '';
  const name = req.query.name || 'ruflo';

  const script = `#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  RuFlo Server — Project Setup                       ║
# ║  Server: ${baseUrl.padEnd(41)}║
# ╚══════════════════════════════════════════════════════╝
set -euo pipefail

RUFLO_URL="${baseUrl}/mcp"
RUFLO_TOKEN="${token}"
RUFLO_NAME="${name}"
PROJECT_DIR="\${1:-\$(pwd)}"

echo ""
echo "  RuFlo Setup"
echo "  Server:  ${baseUrl}"
echo "  Name:    ${name}"
echo "  Token:   ${token ? '***' + token.slice(-4) : '(none)' }"
echo "  Project: \$PROJECT_DIR"
echo ""

# Validate
if [ ! -d "\$PROJECT_DIR" ]; then
  echo "Error: \$PROJECT_DIR is not a directory"
  echo "Usage: curl ${baseUrl}/setup | bash -s /path/to/project"
  exit 1
fi

# Create directories
mkdir -p "\$PROJECT_DIR/.claude/helpers"
mkdir -p "\$PROJECT_DIR/.claude-flow/data"

# Download templates
echo "  Downloading templates..."
for file in auto-memory-hook.mjs hook-handler.cjs statusline.cjs; do
  if curl -sf "${baseUrl}/templates/\$file" -o "\$PROJECT_DIR/.claude/helpers/\$file"; then
    echo "    ✓ .claude/helpers/\$file"
  else
    echo "    ✗ .claude/helpers/\$file (skipped)"
  fi
done

# Write server config (with token for memory bridge)
if [ -n "\$RUFLO_TOKEN" ]; then
  cat > "\$PROJECT_DIR/.claude-flow/ruflo.json" <<RUFLO_EOF
{
  "serverUrl": "\$RUFLO_URL",
  "token": "\$RUFLO_TOKEN",
  "initialized": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "version": "1.0.0"
}
RUFLO_EOF
else
  cat > "\$PROJECT_DIR/.claude-flow/ruflo.json" <<RUFLO_EOF
{
  "serverUrl": "\$RUFLO_URL",
  "initialized": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "version": "1.0.0"
}
RUFLO_EOF
fi
echo "    ✓ .claude-flow/ruflo.json"

# Settings.json — create if missing, warn if exists
if [ -f "\$PROJECT_DIR/.claude/settings.json" ]; then
  echo ""
  echo "  ⚠ .claude/settings.json already exists — not overwriting"
  echo "  Add these hooks manually if missing:"
  echo '    SessionStart → node .claude/helpers/auto-memory-hook.mjs import'
  echo '    Stop         → node .claude/helpers/auto-memory-hook.mjs sync'
else
  if curl -sf "${baseUrl}/templates/settings.json" -o "\$PROJECT_DIR/.claude/settings.json"; then
    echo "    ✓ .claude/settings.json"
  fi
fi

# MCP connection — add .mcp.json if ruflo not already configured
if [ -f "\$PROJECT_DIR/.mcp.json" ]; then
  if grep -q "\$RUFLO_NAME" "\$PROJECT_DIR/.mcp.json" 2>/dev/null; then
    echo "    ⏭ .mcp.json already has ruflo — skipping"
  else
    # Merge ruflo into existing .mcp.json using a temp file
    node -e "
      const f = require('fs');
      const p = '\$PROJECT_DIR/.mcp.json';
      const cfg = JSON.parse(f.readFileSync(p, 'utf-8'));
      if (!cfg.mcpServers) cfg.mcpServers = {};
      const entry = { type: 'http', url: '\$RUFLO_URL' };
      if ('\$RUFLO_TOKEN') entry.headers = { 'Authorization': 'Bearer \$RUFLO_TOKEN' };
      cfg.mcpServers['\$RUFLO_NAME'] = entry;
      f.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\\n');
    " 2>/dev/null && echo "    ✓ .mcp.json — added ruflo server" || echo "    ✗ .mcp.json — merge failed, add manually"
  fi
else
  if [ -n "\$RUFLO_TOKEN" ]; then
    cat > "\$PROJECT_DIR/.mcp.json" <<MCP_EOF
{
  "mcpServers": {
    "\$RUFLO_NAME": {
      "type": "http",
      "url": "\$RUFLO_URL",
      "headers": {
        "Authorization": "Bearer \$RUFLO_TOKEN"
      }
    }
  }
}
MCP_EOF
  else
    cat > "\$PROJECT_DIR/.mcp.json" <<MCP_EOF
{
  "mcpServers": {
    "\$RUFLO_NAME": {
      "type": "http",
      "url": "\$RUFLO_URL"
    }
  }
}
MCP_EOF
  fi
  echo "    ✓ .mcp.json"
fi

# Verify connection
echo ""
echo "  Verifying connection..."
if curl -sf "${baseUrl}/health" > /dev/null 2>&1; then
  echo "    ✓ Server reachable"
else
  echo "    ✗ Server unreachable (will retry on next session)"
fi

echo ""
echo "  ✅ Done! Open Claude Code in \$PROJECT_DIR — memory bridge is active."
echo "  MCP tools: mcp__\${RUFLO_NAME}__memory_store, mcp__\${RUFLO_NAME}__memory_search, ..."
echo ""
`;

  console.log(`[${ts()}] /setup requested (host: ${serverHost})`);
  res.type('text/plain').send(script);
});

app.listen(PORT, '0.0.0.0', () => {
  const authNote = TOKEN ? 'auth enabled' : 'NO AUTH (set MCP_AUTH_TOKEN)';
  console.log(`[${ts()}] Ruflo MCP proxy on http://0.0.0.0:${PORT}/mcp (${authNote})`);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  client.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  client.close();
  process.exit(0);
});
