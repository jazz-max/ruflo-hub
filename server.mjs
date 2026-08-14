import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import express from 'express';
import { readFileSync, existsSync, readdirSync, statSync, createWriteStream, mkdirSync, readlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TEMPLATES_DIR = join(__dirname, 'templates');
const BUNDLE_DIR = join(__dirname, 'skills-bundle');

const PORT = parseInt(process.env.RUFLO_PORT || '3000', 10);
const TOKEN = process.env.MCP_AUTH_TOKEN || '';

// --- Child RSS watchdog (containment for the upstream claude-flow memory leak) ---
//
// `ruflo mcp start` (claude-flow) leaks native memory (ArrayBuffers / external,
// NOT the V8 JS heap) proportional to the number of MCP tool calls — measured
// ~160 МБ/час under load, unbounded. Root cause is upstream (ruvnet/ruflo); see
// LEAK-INVESTIGATION-HANDOFF.md. Until that's fixed, we bound it here: when the
// child's RSS crosses a threshold, gracefully respawn it once it's idle (no
// in-flight tool calls), reusing connectToRuflo() which already kills the old
// child before spawning a new one. A respawn drops all leaked buffers at once.
//
// 0 disables the watchdog entirely.
const CHILD_MAX_RSS_MB = parseInt(process.env.RUFLO_CHILD_MAX_RSS_MB || '1500', 10);
// How often to sample the child's RSS.
const WATCHDOG_INTERVAL_MS = parseInt(process.env.RUFLO_WATCHDOG_INTERVAL_MS || '60000', 10);
// Once over threshold we wait for idle, but not forever — if traffic never lets
// the child go idle within this window, force the respawn anyway (in-flight
// calls are covered by callToolReliably's transparent retry).
const RESPAWN_IDLE_TIMEOUT_MS = parseInt(process.env.RUFLO_RESPAWN_IDLE_TIMEOUT_MS || '30000', 10);

// GET /stats used to probe `memory_stats` and `memory_list` for an entry count.
// On the sql.js fallback path those are the two most expensive tools that exist:
// each one runs ensureSchemaColumns() first, which rewrites the WHOLE database
// image, and then materialises every row's embedding text (278 MB measured on a
// 302 MB DB). With statusline clients polling /stats per session, that alone was
// ~240 whole-image writes per hour. The 2 s client-side timeout below does NOT
// cancel the work — the child runs it to completion regardless.
//
// So the count probes are opt-in now. `dbSizeKB` is computed from the files and
// needs no MCP call, and statusline already tolerates vectorCount 0 alongside a
// non-zero dbSizeKB (see 95d0ce7). Set RUFLO_STATS_MEMORY_PROBE=1 to restore
// them — sensible only on a small memory.db.
// See MEMORY-DB-BLOAT-INVESTIGATION.md.
const STATS_MEMORY_PROBE = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.RUFLO_STATS_MEMORY_PROBE || '').toLowerCase()
);

function ts() {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

// --- Connect to ruflo as MCP client via stdio (auto-reconnect) ---
//
// `ruflo mcp start` runs as a stdio child process. If it exits or its stdin
// pipe closes, the MCP client transport becomes "Not connected" and every
// callTool() throws with that message. To survive that, we wrap the connect
// step in a function and respawn the child when the transport reports close.
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 5000, 5000];
const STDERR_LOG_PATH = '/app/.swarm/ruflo-stderr.log';
let client = null;
let toolsResult = { tools: [] };
let connectionState = 'connecting'; // 'connecting' | 'ready' | 'down'
let reconnectAttempts = 0;
let reconnectTimer = null;
// Single-flight guard for connectToRuflo — без него N параллельных HTTP-запросов,
// поймавших "Not connected", спавнили N свежих `ruflo mcp start` детей; старые
// stdio-транспорты переставали быть активными, но child-процессы оставались
// висеть. За несколько дней набегало >100 осиротевших процессов и >4 ГБ RAM.
let connectingPromise = null;
let currentTransport = null;

// Watchdog state. inFlight counts tool calls currently awaiting the child so we
// can respawn only when idle. respawnPendingSince marks when the RSS threshold
// was first crossed (for the idle-wait timeout).
let inFlight = 0;
let respawnPendingSince = null;
let respawning = false;

// Persistent stats so /health can show whether reconnects have been happening.
const stats = {
  startedAt: new Date().toISOString(),
  reconnectCount: 0,         // successful reconnects (excluding initial start)
  reconnectFailures: 0,      // failed attempts since last successful connect
  lastReconnectAt: null,
  lastReconnectReason: null, // 'transport-close' | 'callTool-failure' | 'startup' | 'rss-threshold'
  currentConnectedSince: null,
  childRespawnCount: 0,        // respawns triggered by the RSS watchdog
  lastChildRespawnAt: null,
  lastChildRespawnRssMB: null, // child RSS at the moment of the last watchdog respawn
};

// Persistent stderr log of the ruflo child — survives container restarts via
// the .swarm volume. Use this to find what killed the child if /health shows
// reconnectCount > 0.
let stderrLog = null;
try {
  mkdirSync(dirname(STDERR_LOG_PATH), { recursive: true });
  stderrLog = createWriteStream(STDERR_LOG_PATH, { flags: 'a' });
  stderrLog.write(`\n=== server.mjs started at ${stats.startedAt} ===\n`);
} catch (err) {
  console.error(`[${ts()}] Failed to open ${STDERR_LOG_PATH}:`, err?.message || err);
}

// Close the old stdio child and wait until its pid is actually gone, so a new
// child never overlaps it on memory.db. SDK close() already escalates
// stdin-end → SIGTERM → SIGKILL over ~4s but returns without confirming the
// exit, so we verify via /proc and escalate once more if needed.
const OLD_CHILD_EXIT_TIMEOUT_MS = parseInt(process.env.RUFLO_OLD_CHILD_EXIT_TIMEOUT_MS || '8000', 10);

function pidAlive(pid) {
  if (!pid) return false;
  try {
    return existsSync(`/proc/${pid}`);
  } catch {
    return false;
  }
}

async function waitForChildExit(oldTransport) {
  const pid = oldTransport?.pid;
  const started = Date.now();
  try {
    await Promise.race([
      Promise.resolve().then(() => oldTransport.close()).catch(() => {}),
      new Promise((r) => setTimeout(r, OLD_CHILD_EXIT_TIMEOUT_MS).unref()),
    ]);
  } catch { /* best effort */ }

  // On non-Linux (no /proc) pidAlive() is always false — nothing more to do.
  while (pidAlive(pid) && Date.now() - started < OLD_CHILD_EXIT_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (pidAlive(pid)) {
    console.warn(`[${ts()}] old ruflo child ${pid} still alive after ${OLD_CHILD_EXIT_TIMEOUT_MS} ms — SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    // Give the kernel a moment so the new child can't open memory.db alongside it.
    for (let i = 0; i < 20 && pidAlive(pid); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (pid) {
    console.log(`[${ts()}] old ruflo child ${pid} gone after ${Date.now() - started} ms`);
  }
}

async function connectToRuflo(reason) {
  // Single-flight: если коннект уже в процессе, все параллельные вызовы
  // дожидаются того же промиса. Без этого callTool-failure от N параллельных
  // запросов спавнил N свежих stdio-детей.
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    connectionState = 'connecting';
    console.log(`[${ts()}] Connecting to ruflo stdio (attempt ${reconnectAttempts + 1}, reason: ${reason})...`);
    if (stderrLog) {
      stderrLog.write(`\n--- [${new Date().toISOString()}] reconnect attempt ${reconnectAttempts + 1} (reason: ${reason}) ---\n`);
    }

    // Прибиваем предыдущего ребёнка ДО спавна нового и ЖДЁМ его выхода.
    //
    // Раньше close() был fire-and-forget, и новый child спавнился сразу. Но SDK
    // close() закрывает stdin, ждёт до 2с, шлёт SIGTERM, ждёт ещё 2с и только
    // тогда SIGKILL — то есть старый `ruflo mcp start` живёт ещё несколько секунд
    // после старта нового. А он держит НАТИВНОЕ WAL-соединение к memory.db
    // (в ruflo 3.14.2 AgentDB-мост открывает сам memory.db через better-sqlite3;
    // проверено на проде: child держит fd на memory.db, -wal и -shm). Два
    // поколения на одном файле дают две беды:
    //   1) DDL/schema-шаг нового child'а может получить SQLITE_BUSY от старого —
    //      initAgentDB() это глотает, ставит agentdb = null и НЕ бросает, из-за
    //      чего bridgeAvailable латчится в false на ВСЮ жизнь процесса: всё
    //      поколение уходит на sql.js whole-image путь (10–21 с на операцию
    //      вместо 1–10 мс). Это лучшее объяснение наблюдаемых «то летает, то
    //      висит» — режим задаётся поколением, а не нагрузкой.
    //   2) если старый child в этот момент делает whole-image запись
    //      (db.export() + rename), она затирает нативно закоммиченные строки —
    //      апстримный #2431 («database disk image is malformed»).
    // Поэтому теперь: ждём выхода старого, проверяем по /proc, добиваем SIGKILL
    // если он всё ещё жив, и только потом спавним нового.
    // См. MEMORY-DB-BLOAT-INVESTIGATION.md.
    const oldTransport = currentTransport;
    currentTransport = null;
    if (oldTransport) {
      oldTransport.onclose = () => {}; // глушим — иначе триггернёт лишний reconnect
      oldTransport.onerror = () => {};
      await waitForChildExit(oldTransport);
    }

    const transport = new StdioClientTransport({
      command: 'ruflo',
      args: ['mcp', 'start'],
      stderr: 'pipe', // capture child stderr so we can persist it
    });

    // Wire up close/error BEFORE connect so we don't miss an immediate failure.
    transport.onclose = () => {
      // Игнорируем close от стейл-транспортов (они приходят от детей,
      // которых мы уже заменили на новых).
      if (transport !== currentTransport) return;
      if (connectionState === 'down') return; // already scheduled
      console.error(`[${ts()}] ruflo stdio transport closed — scheduling reconnect`);
      connectionState = 'down';
      scheduleReconnect('transport-close');
    };
    transport.onerror = (err) => {
      if (transport !== currentTransport) return;
      console.error(`[${ts()}] ruflo stdio transport error:`, err?.message || err);
    };

    const newClient = new Client({ name: 'ruflo-proxy', version: '1.0.0' });
    await newClient.connect(transport);

    // Pipe child stderr to the persistent log. transport.stderr is a Readable
    // stream when stderr: 'pipe' is set above.
    if (stderrLog && transport.stderr) {
      transport.stderr.on('data', (chunk) => stderrLog.write(chunk));
      transport.stderr.on('error', () => { /* ignore — file write errors */ });
    }

    // Refresh tool list every time we reconnect (ruflo could have updated).
    const tools = await newClient.listTools();
    client = newClient;
    currentTransport = transport;
    toolsResult = tools;
    connectionState = 'ready';
    // Track stats: count this as a reconnect only if it's not the initial startup.
    if (reason !== 'startup') {
      stats.reconnectCount += 1;
      stats.lastReconnectAt = new Date().toISOString();
      stats.lastReconnectReason = reason;
    }
    stats.reconnectFailures = 0;
    stats.currentConnectedSince = new Date().toISOString();
    reconnectAttempts = 0;
    console.log(`[${ts()}] Connected to ruflo: ${tools.tools.length} tools`);
  })();

  try {
    await connectingPromise;
  } finally {
    connectingPromise = null;
  }
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return;
  const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)];
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectToRuflo(reason);
    } catch (err) {
      stats.reconnectFailures += 1;
      console.error(`[${ts()}] Reconnect failed:`, err?.message || err);
      scheduleReconnect(reason);
    }
  }, delay);
}

await connectToRuflo('startup');
startRssWatchdog();

// Call with one transparent retry if the stdio child just died.
async function callToolReliably(name, args) {
  inFlight += 1;
  try {
    return await client.callTool({ name, arguments: args });
  } catch (err) {
    const msg = String(err?.message || err);
    if (connectionState !== 'ready' || /Not connected|Connection closed/i.test(msg)) {
      // Force a reconnect attempt right now and retry once.
      try {
        await connectToRuflo('callTool-failure');
        return await client.callTool({ name, arguments: args });
      } catch (retryErr) {
        scheduleReconnect('callTool-failure');
        throw retryErr;
      }
    }
    throw err;
  } finally {
    inFlight -= 1;
    // If the watchdog asked for a respawn and we just went idle, do it now.
    if (inFlight === 0 && respawnPendingSince !== null && !respawning) {
      maybeRespawnChild('idle');
    }
  }
}

// --- RSS watchdog ---

// Read the child's resident set size (MB) from /proc. The child runs in the same
// PID namespace as this proxy (we spawned it), so its pid maps directly.
function readChildRssMb() {
  const pid = currentTransport?.pid;
  if (!pid) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
    const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  } catch {
    return null; // not Linux / proc unavailable / child gone — skip silently
  }
}

// Which memory regime is the current child in?
//
// In ruflo 3.14.2 the AgentDB bridge opens `memory.db` itself through native
// better-sqlite3 and switches it to WAL. So a child that holds an fd on
// `memory.db-wal` has a live native connection — memory operations cost
// milliseconds. A child whose bridge init failed latches `bridgeAvailable=false`
// for its whole lifetime and every operation falls back to the sql.js
// whole-image path (~10-21 s on a 340 MB file). The two regimes look identical
// from outside, which is why "ruflo is slow" has been so hard to pin down —
// so surface it: `native` vs `fallback`.
//
// Caveat: graph-edge-writer also opens memory.db natively, so a WAL fd proves
// "some native connection exists", which in practice tracks the bridge but is
// not a formal proof of it. Returns null when /proc is unavailable.
function childMemoryRegime() {
  const pid = currentTransport?.pid;
  if (!pid) return null;
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue; // fd closed while we were looking
      }
      if (target.endsWith('/memory.db-wal')) return 'native';
    }
    return 'fallback';
  } catch {
    return null; // not Linux / child gone
  }
}

// Respawn the leaking child by reconnecting (connectToRuflo kills the old child
// before spawning a fresh one, dropping all its leaked native buffers).
async function maybeRespawnChild(trigger) {
  if (respawning || connectingPromise) return;
  respawning = true;
  const rssMB = readChildRssMb();
  const msg = `[${ts()}] RSS watchdog: respawning ruflo child (trigger: ${trigger}, RSS: ${rssMB ?? '?'} МБ > ${CHILD_MAX_RSS_MB} МБ)`;
  console.warn(msg);
  if (stderrLog) stderrLog.write(`\n--- ${msg} ---\n`);
  try {
    await connectToRuflo('rss-threshold');
    stats.childRespawnCount += 1;
    stats.lastChildRespawnAt = new Date().toISOString();
    stats.lastChildRespawnRssMB = rssMB;
  } catch (err) {
    console.error(`[${ts()}] RSS watchdog respawn failed:`, err?.message || err);
    scheduleReconnect('rss-threshold');
  } finally {
    respawnPendingSince = null;
    respawning = false;
  }
}

// Periodic check: if the child's RSS crosses the threshold, flag a respawn and
// carry it out once the child is idle (inFlight === 0). If traffic never lets it
// go idle within RESPAWN_IDLE_TIMEOUT_MS, force the respawn anyway.
function startRssWatchdog() {
  if (CHILD_MAX_RSS_MB <= 0) {
    console.log(`[${ts()}] RSS watchdog disabled (RUFLO_CHILD_MAX_RSS_MB=0)`);
    return;
  }
  console.log(`[${ts()}] RSS watchdog: threshold ${CHILD_MAX_RSS_MB} МБ, interval ${WATCHDOG_INTERVAL_MS} ms`);
  setInterval(() => {
    if (respawning || connectingPromise) return;
    const rssMB = readChildRssMb();
    if (rssMB === null) return;

    if (rssMB > CHILD_MAX_RSS_MB) {
      if (respawnPendingSince === null) {
        respawnPendingSince = Date.now();
        console.warn(`[${ts()}] RSS watchdog: child at ${rssMB} МБ > ${CHILD_MAX_RSS_MB} МБ — respawn pending (waiting for idle)`);
      }
      const waited = Date.now() - respawnPendingSince;
      if (inFlight === 0) {
        maybeRespawnChild('idle');
      } else if (waited >= RESPAWN_IDLE_TIMEOUT_MS) {
        console.warn(`[${ts()}] RSS watchdog: idle wait exceeded ${RESPAWN_IDLE_TIMEOUT_MS} ms (inFlight=${inFlight}) — forcing respawn`);
        maybeRespawnChild('idle-timeout');
      }
    } else if (respawnPendingSince !== null && rssMB <= CHILD_MAX_RSS_MB) {
      // RSS dropped back on its own (e.g. an external reconnect happened).
      respawnPendingSince = null;
    }
  }, WATCHDOG_INTERVAL_MS).unref();
}

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

        const result = await callToolReliably(name, args);
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
  const body = {
    status: connectionState === 'ready' ? 'ok' : 'unavailable',
    state: connectionState,
    tools: toolsResult.tools.length,
    serverStartedAt: stats.startedAt,
    currentConnectedSince: stats.currentConnectedSince,
    reconnectCount: stats.reconnectCount,
    reconnectFailures: stats.reconnectFailures,
    lastReconnectAt: stats.lastReconnectAt,
    lastReconnectReason: stats.lastReconnectReason,
    childRssMB: readChildRssMb(),
    childMaxRssMB: CHILD_MAX_RSS_MB,
    // 'native' = AgentDB bridge holds memory.db in WAL (memory ops ~ms);
    // 'fallback' = bridge init failed for this child, every op rewrites the
    // whole DB image (~10-21 s on a large file). null = /proc unavailable.
    childMemoryRegime: childMemoryRegime(),
    childRespawnCount: stats.childRespawnCount,
    lastChildRespawnAt: stats.lastChildRespawnAt,
    lastChildRespawnRssMB: stats.lastChildRespawnRssMB,
    inFlight,
  };
  if (connectionState !== 'ready') {
    body.reason = 'ruflo stdio transport down — reconnect in progress';
    res.status(503).json(body);
  } else {
    res.json(body);
  }
});

// Call an MCP tool with a hard timeout. Returns null if the tool hangs or errors.
function callToolWithTimeout(name, args, timeoutMs = 2000) {
  return Promise.race([
    callToolReliably(name, args).catch(() => null),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
}

// GET /stats — summary for statusline clients (no auth, like /health).
// Uses strict per-tool timeouts so a busy MCP stdio queue cannot block the endpoint.
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

  // Disk size — compute FIRST without MCP so it's always accurate regardless of stdio queue.
  summary.dbSizeKB = 0;
  try {
    const files = readdirSync('/app/.swarm');
    for (const fname of files) {
      try {
        const s = statSync(join('/app/.swarm', fname));
        if (s.isFile()) summary.dbSizeKB += Math.round(s.size / 1024);
      } catch { /* ignore per-file */ }
    }
  } catch { /* dir missing — dbSizeKB stays 0 */ }

  // Entry-count probes — opt-in, see STATS_MEMORY_PROBE above. Skipping them
  // leaves vectorCount 0 with dbSizeKB intact, which statusline handles.
  if (!STATS_MEMORY_PROBE) {
    summary.source = 'skipped-memory-probe';
  } else {
    // memory_stats (2s timeout — if MCP stdio is busy, skip rather than block)
    {
      const result = await callToolWithTimeout('memory_stats', {}, 2000);
      const text = result?.content?.[0]?.text || '';
      const parsed = extractCount(text);
      if (parsed) {
        summary.vectorCount = parsed.count;
        summary.namespaces = parsed.namespaces;
        summary.source = 'memory_stats';
      }
    }

    // Fallback: memory_list
    if (summary.vectorCount === 0) {
      const result = await callToolWithTimeout('memory_list', {}, 2000);
      const text = result?.content?.[0]?.text || '';
      const parsed = extractCount(text);
      if (parsed) {
        summary.vectorCount = parsed.count;
        if (!summary.namespaces) summary.namespaces = parsed.namespaces;
        summary.source = summary.source === 'none' ? 'memory_list' : summary.source;
      }
    }
  }

  // Swarm status
  summary.swarm = { active: false, agentCount: 0, maxAgents: 0, topology: null };
  {
    const result = await callToolWithTimeout('swarm_status', {}, 2000);
    const text = result?.content?.[0]?.text || '';
    try {
      const parsed = JSON.parse(text);
      summary.swarm.active = parsed.status === 'running' || parsed.status === 'active';
      summary.swarm.agentCount = Number(parsed.agentCount) || 0;
      summary.swarm.maxAgents = Number(parsed.maxAgents) || 0;
      summary.swarm.topology = parsed.topology || null;
    } catch { /* ignore */ }
  }

  // Real agent count (swarm_status.agentCount may lag behind agent_spawn)
  {
    const result = await callToolWithTimeout('agent_list', {}, 2000);
    const text = result?.content?.[0]?.text || '';
    try {
      const parsed = JSON.parse(text);
      let count = 0;
      if (Array.isArray(parsed)) count = parsed.length;
      else if (Array.isArray(parsed?.agents)) count = parsed.agents.length;
      else if (typeof parsed?.total === 'number') count = parsed.total;
      if (count > summary.swarm.agentCount) summary.swarm.agentCount = count;
    } catch { /* ignore */ }
  }

  // Intelligence score (best effort — try only one tool with short timeout, skip fancy loops)
  summary.intelligence = { score: 0, source: 'none' };
  {
    const result = await callToolWithTimeout('neural_status', {}, 1500);
    const text = result?.content?.[0]?.text || '';
    try {
      const parsed = JSON.parse(text);
      const score = parsed?.intelligence?.score
                 ?? parsed?.score
                 ?? parsed?.intelligenceScore
                 ?? parsed?.stats?.intelligence_score
                 ?? parsed?.accuracy
                 ?? 0;
      if (score > 0) {
        summary.intelligence.score = Math.min(100, Math.floor(Number(score) * (score <= 1 ? 100 : 1)));
        summary.intelligence.source = 'neural_status';
      }
    } catch { /* ignore */ }
  }

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

// GET /bundle.tar.gz — stream tar.gz of skills + agents + commands
// Consumed by /setup; can be used standalone to mirror ruflo init output.
app.get('/bundle.tar.gz', (_req, res) => {
  if (!existsSync(BUNDLE_DIR)) {
    return res.status(404).json({ error: 'bundle_not_available' });
  }
  res.type('application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="ruflo-bundle.tar.gz"');
  const tar = spawn('tar', ['-czf', '-', '-C', BUNDLE_DIR, '.']);
  tar.stdout.pipe(res);
  tar.stderr.on('data', (d) => console.error(`[${ts()}] tar: ${d.toString().trim()}`));
  tar.on('error', (err) => {
    console.error(`[${ts()}] tar spawn error:`, err.message);
    if (!res.headersSent) res.status(500).json({ error: 'tar_failed' });
  });
});

// GET /update-bundle — return a shell script that updates the bundle
// (skills/agents/commands) and refreshes hook helpers in .claude/helpers/.
// Usage: curl http://ruflo-hub:PORT/update-bundle | bash
//    or: curl http://ruflo-hub:PORT/update-bundle | bash -s /path/to/project
//    or: curl "http://ruflo-hub:PORT/update-bundle?force=1" | bash  (overwrite existing bundle entries)
// Hook helpers are always overwritten — they are server-managed.
app.get('/update-bundle', (req, res) => {
  const serverHost = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${proto}://${serverHost}`;
  const force = ['1', 'true', 'yes', 'on'].includes(String(req.query.force || '').toLowerCase());

  const script = `#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  RuFlo Hub — Bundle Update (skills + agents + commands) ║
# ║  Server: ${baseUrl.padEnd(41)}║
# ╚══════════════════════════════════════════════════════╝
set -euo pipefail

PROJECT_DIR="\${1:-\$(pwd)}"
FORCE="${force ? '1' : '0'}"

echo ""
echo "  RuFlo Bundle Update"
echo "  Server:  ${baseUrl}"
echo "  Project: \$PROJECT_DIR"
echo "  Force:   ${force ? 'yes (overwrite existing files)' : 'no (preserve existing files)'}"
echo ""

if [ ! -d "\$PROJECT_DIR" ]; then
  echo "Error: \$PROJECT_DIR is not a directory"
  echo "Usage: curl ${baseUrl}/update-bundle | bash -s /path/to/project"
  exit 1
fi

mkdir -p "\$PROJECT_DIR/.claude/helpers"
TMP_BUNDLE="\$(mktemp -t ruflo-bundle.XXXXXX.tar.gz)"

if ! curl -sf "${baseUrl}/bundle.tar.gz" -o "\$TMP_BUNDLE"; then
  rm -f "\$TMP_BUNDLE"
  echo "  ✗ Failed to download bundle from ${baseUrl}/bundle.tar.gz"
  exit 1
fi

if [ "\$FORCE" = "1" ]; then
  tar -xzf "\$TMP_BUNDLE" -C "\$PROJECT_DIR/.claude"
else
  # -k: do not overwrite existing files (preserves user customizations)
  tar -xzkf "\$TMP_BUNDLE" -C "\$PROJECT_DIR/.claude" 2>/dev/null || true
fi
rm -f "\$TMP_BUNDLE"

# Refresh hook helpers (always overwrite — they are server-managed)
for file in auto-memory-hook.mjs hook-handler.cjs intelligence-bridge.cjs statusline.cjs; do
  curl -sf "${baseUrl}/templates/\$file" -o "\$PROJECT_DIR/.claude/helpers/\$file" \\
    && echo "  ✓ .claude/helpers/\$file" \\
    || echo "  ✗ .claude/helpers/\$file (skipped)"
done

echo "  ✓ .claude/skills   (\$(ls "\$PROJECT_DIR/.claude/skills"   2>/dev/null | wc -l | tr -d ' ') entries)"
echo "  ✓ .claude/agents   (\$(ls "\$PROJECT_DIR/.claude/agents"   2>/dev/null | wc -l | tr -d ' ') entries)"
echo "  ✓ .claude/commands (\$(ls "\$PROJECT_DIR/.claude/commands" 2>/dev/null | wc -l | tr -d ' ') entries)"
echo ""
echo "  Done. Restart Claude Code to load new skills and helpers."
echo ""
`;

  res.type('text/plain').send(script);
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
// Usage: curl http://ruflo-hub:PORT/setup | bash
//    or: curl http://ruflo-hub:PORT/setup?project=/path/to/project | bash
app.get('/setup', (req, res) => {
  const serverHost = req.headers.host || `localhost:${PORT}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${proto}://${serverHost}`;
  const token = req.query.token || '';
  const name = req.query.name || 'ruflo';
  // Skills/agents bundle is installed by default. Disable with ?skills=0 or ?skills=false.
  const skillsEnabled = !['0', 'false', 'no', 'off'].includes(String(req.query.skills || '').toLowerCase());

  const script = `#!/bin/bash
# ╔══════════════════════════════════════════════════════╗
# ║  RuFlo Server — Project Setup                       ║
# ║  Server: ${baseUrl.padEnd(41)}║
# ╚══════════════════════════════════════════════════════╝
set -euo pipefail

RUFLO_URL="${baseUrl}/mcp"
RUFLO_TOKEN="${token}"
RUFLO_NAME="${name}"
SKILLS_ENABLED="${skillsEnabled ? '1' : '0'}"
PROJECT_DIR="\${1:-\$(pwd)}"

echo ""
echo "  RuFlo Setup"
echo "  Server:  ${baseUrl}"
echo "  Name:    ${name}"
echo "  Token:   ${token ? '***' + token.slice(-4) : '(none)' }"
echo "  Skills:  ${skillsEnabled ? 'yes (skills + agents + commands)' : 'no (disabled via ?skills=0)'}"
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
for file in auto-memory-hook.mjs hook-handler.cjs intelligence-bridge.cjs statusline.cjs; do
  if curl -sf "${baseUrl}/templates/\$file" -o "\$PROJECT_DIR/.claude/helpers/\$file"; then
    echo "    ✓ .claude/helpers/\$file"
  else
    echo "    ✗ .claude/helpers/\$file (skipped)"
  fi
done

# Download skills/agents/commands bundle (default on; disable with ?skills=0)
if [ "\$SKILLS_ENABLED" = "1" ]; then
  echo ""
  echo "  Downloading skills bundle..."
  TMP_BUNDLE="\$(mktemp -t ruflo-bundle.XXXXXX.tar.gz)"
  if curl -sf "${baseUrl}/bundle.tar.gz" -o "\$TMP_BUNDLE"; then
    mkdir -p "\$PROJECT_DIR/.claude"
    # -k: do not overwrite existing files (preserves user customizations)
    if tar -xzkf "\$TMP_BUNDLE" -C "\$PROJECT_DIR/.claude" 2>/dev/null; then
      :
    else
      # Fallback: BSD tar may error on -k when collisions exist; force extract
      tar -xzf "\$TMP_BUNDLE" -C "\$PROJECT_DIR/.claude" 2>/dev/null || true
    fi
    rm -f "\$TMP_BUNDLE"
    echo "    ✓ .claude/skills   (\$(ls "\$PROJECT_DIR/.claude/skills"   2>/dev/null | wc -l | tr -d ' ') entries)"
    echo "    ✓ .claude/agents   (\$(ls "\$PROJECT_DIR/.claude/agents"   2>/dev/null | wc -l | tr -d ' ') entries)"
    echo "    ✓ .claude/commands (\$(ls "\$PROJECT_DIR/.claude/commands" 2>/dev/null | wc -l | tr -d ' ') entries)"
  else
    rm -f "\$TMP_BUNDLE"
    echo "    ✗ bundle (server did not return one — skipped)"
  fi
fi

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
