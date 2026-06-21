# Swarm Management in ruflo

How ruflo manages swarms and agents. Practical observations on ruflo@3.5.80 plus an explanation of what counts as what in the statusline and why it matters.

> ⚠️ **Read this first.** ruflo's "swarm / hive-mind / agent orchestration" is **not real multi-agent execution** — they're coordination *records*, no processes get spawned (this doc explains exactly that, and independent audits confirm it). `ruflo-hub` does **not** rely on any of it; the project's actual value is the memory layer. This page is kept as an accurate description of how the swarm bookkeeping behaves, **not** as an endorsement of it as a working feature. See README → [What this actually is](../README.md#what-this-actually-is).

---

## Key concept: swarm and agent are records, not processes

In ruflo, **swarm** and **agent** are **coordination records in the server database** (sql.js `memory.db`). No background processes are started. CPU is not consumed. Memory inside the container does not grow.

```
swarm_init  → INSERT INTO swarms(id, topology, maxAgents, strategy, status='running')
agent_spawn → INSERT INTO agents(id, type, model, status='idle', health=1)
```

This is similar to a "ticket in a queue": the record exists, but it only starts working when someone picks it up. An agent in `idle` status does nothing; it waits for Claude Code (or `claude -p`) to go and execute a task **on its behalf**.

Therefore:
- **Old swarms and idle agents do not consume CPU** — they can be left in place without technical harm.
- **But they accumulate junk in the DB** — if every session spawns new ones without cleanup, within a month there will be hundreds of entries in `agent_list`.
- **The `autoScaling: true` flag in the swarm config** is not a daemon but a recommendation for Claude Code. The server does not create agents on its own.

---

## Lifecycle

```
┌────────────┐  swarm_init({ topology, maxAgents, strategy })
│   (none)   │──────────────────────────────────────────────→┐
└────────────┘                                               │
                                                             ▼
                                                       ┌───────────┐
                                                       │  running  │
                                                       └─────┬─────┘
                                                             │ agent_spawn({ agentType })
                                                             ▼
                                                       ┌───────────┐
                                                       │   idle    │←──┐
                                                       └─────┬─────┘   │
                                                             │         │ work finished
                       Claude Code Task tool / claude -p     │         │
                                                             ▼         │
                                                       ┌───────────┐   │
                                                       │  working  │───┘
                                                       └─────┬─────┘
                                                             │ agent_terminate
                                                             ▼
                                                       ┌───────────┐
                                                       │terminated │
                                                       └───────────┘

swarm_shutdown → status = 'shutdown', maxAgents is zeroed for new spawns
```

Important:
- An agent does not move from `idle` to `working` on its own — it is activated by **Claude Code via the Task tool** or `claude -p`.
- An agent does not "terminate automatically" — it stays `idle` forever until `agent_terminate` is called.
- After `swarm_shutdown`, the swarm remains in history as completed, and `totalSwarms` does not decrease.

---

## How work is actually performed

Ruflo **does not execute anything itself**. MCP tools like `agent_spawn` only register a role in the DB. The work is done by Claude Code:

```
User: "write code via an agent"
            ↓
Claude Code uses the Task tool with the "coder" role
            ↓
Claude Code calls `agent_spawn({ agentType: "coder" })` → ruflo creates a record
            ↓
Claude Code itself launches the subprocess `claude -p "write code"` with a prompt that accounts for the role
            ↓
The subprocess returns a result → Claude Code sends it to the user
            ↓
Optionally: Claude Code writes `task_complete(agentId, result)` to ruflo → the record in the DB is updated
```

Key point: an "agent" is a **role + routing hint for the model** (haiku/sonnet/opus), not an autonomous executor.

Therefore, the question "how many agents are actually working" does not make sense in the usual way — **all agents are either `idle` or being executed by Claude Code as a subprocess**. There cannot be more simultaneously "working" agents than parallel Task tool calls.

---

## Main MCP commands

### Creation and management

| Command | What it does | Example arguments |
|---------|--------------|-------------------|
| `swarm_init` | Creates a swarm (coordination container) | `{ topology: "mesh", maxAgents: 5, strategy: "balanced" }` |
| `agent_spawn` | Registers an agent | `{ agentType: "researcher", task: "..." }` |
| `agent_list` | Returns all agents (supports `includeTerminated`) | `{}` |
| `agent_terminate` | Removes an agent | `{ agentId: "agent-..." }` |
| `swarm_status` | Status of the latest (or by `swarmId`) swarm | `{}` |
| `swarm_shutdown` | Terminates a swarm | `{ swarmId: "swarm-...", graceful: true }` |

### Topologies (`topology`)

| Value | Idea | When to use |
|-------|------|-------------|
| `hierarchical` | Queen → workers | Centralized tasks |
| `mesh` | Everyone with everyone | Independent parallel tasks |
| `hierarchical-mesh` | Hybrid | Large projects with subgroups |
| `ring` | Sequential handoff | Pipeline processing |
| `star` | Central broker | Aggregation |
| `hybrid` | Auto-selection | Unclear task |
| `adaptive` | Changes on the fly | Long lifecycles |

In practice, topology affects **how Claude Code will think about coordination**. On the server, it is simply recorded as a string; CPU/memory does not depend on it.

### Strategies (`strategy`)

| Value | Meaning |
|-------|---------|
| `specialized` | Narrow roles (researcher, coder, tester) do not overlap |
| `balanced` | Agents are generalists |
| `adaptive` | Chosen at spawn time |

---

## What the statusline shows (`🤖 Swarm`)

Format: `🤖 Swarm ◉↻ [agentCount/maxAgents]`

Source: the `/stats` endpoint on ruflo-hub:
```json
{
  "swarm": {
    "active": true,
    "agentCount": 5,
    "maxAgents": 5,
    "topology": "mesh"
  }
}
```

How it is built on the server (`server.mjs /stats`):
1. Calls `swarm_status` → takes `maxAgents`, `topology`, `active`
2. Calls `agent_list` → counts records (excluding `terminated`)
3. Takes `max(swarm_status.agentCount, agent_list.length)` — because `swarm_status.agentCount` often lags reality (ruflo bug)

**The number changes only in response to explicit commands:**
- `agent_spawn` → +1
- `agent_terminate` → −1
- `swarm_shutdown` → does not touch agent_list directly, but afterwards new spawns are not bound to the closed swarm

**The number does NOT change automatically**, even if Claude Code uses the Task tool (agents go `idle → working → idle` — the counter stays the same).

The `◉↻` indicator:
- `◉` (green) — swarm active
- `○` (gray) — no active swarm
- `↻` — data from ruflo-hub (not from local project files)

---

## Known quirks of ruflo@3.5.80

1. **`swarm_status.agentCount` lags.** Often shows 0 even right after `agent_spawn`. Use `agent_list.total` for the truth.

2. **`totalSwarms` does not reset.** Even after shutdown, the counter remains. This is the number of swarms created over the entire lifetime of the DB.

3. **Agents survive shutdown.** `swarm_shutdown` does not terminate agents; they remain `idle` and are counted in the overall `agent_list`. They must be terminated separately.

4. **A single "active swarm".** Multiple `swarm_init` calls create multiple records, but `swarm_status` without a `swarmId` always returns the latest one.

5. **`autoScaling: true` does not spawn.** This is a flag for Claude Code, not for the server.

6. **Persistence.** Swarm state is written to `/app/.claude-flow/swarm/swarm-state.json` inside the container. Persistence works **only** if the `/app/.claude-flow` volume is mounted in compose (see `docker-compose.yml`).

---

## Cleaning up old records

A quick manual cycle via Claude Code:

```
> Show me all agents in ruflo and shutdown all swarms older than 24 hours.
```

Claude will sequentially:
1. `mcp__ruflo__agent_list({ includeTerminated: false })` → an array of agents
2. For each idle agent older than the threshold: `mcp__ruflo__agent_terminate({ agentId })`
3. `mcp__ruflo__swarm_status()` for the latest swarm
4. `mcp__ruflo__swarm_shutdown({ swarmId, graceful: true })`

Via curl (without MCP):
```bash
# List agents
curl -X POST http://server:3201/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"agent_list","arguments":{}},"id":1}' \
  | jq -r '.result.content[0].text' | jq '.agents[].agentId'

# Terminate a specific one
curl -X POST http://server:3201/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"agent_terminate","arguments":{"agentId":"agent-..."}},"id":1}'
```

Recommendation: set up a cron job inside the `ruflo-hub` container that clears agents older than 7 days once a day. Not implemented yet — done manually for now.

---

## Examples

### Mini-swarm for a single task

```typescript
// 1. Initialization
await mcp.swarm_init({ topology: 'mesh', maxAgents: 3, strategy: 'specialized' });

// 2. Three agents
await mcp.agent_spawn({ agentType: 'researcher', task: 'find best practices' });
await mcp.agent_spawn({ agentType: 'coder', task: 'implement the module' });
await mcp.agent_spawn({ agentType: 'tester', task: 'cover with tests' });

// 3. Work — via the Claude Code Task tool (ruflo itself does nothing)
//    Claude Code uses roles and models from agent_list

// 4. Cleanup
const { agents } = await mcp.agent_list({});
for (const a of agents) {
  await mcp.agent_terminate({ agentId: a.agentId });
}
const status = await mcp.swarm_status({});
await mcp.swarm_shutdown({ swarmId: status.swarmId });
```

### Just "check the status"

```bash
curl http://server:3201/stats
# {"swarm":{"active":true,"agentCount":3,"maxAgents":3,"topology":"mesh"}}
```

---

## Summary in one paragraph

In ruflo, swarm and agent are **coordination metadata in the DB**, not autonomous processes. `swarm_init` and `agent_spawn` are cheap operations (a few bytes in the DB). The actual work is performed by Claude Code via its Task tool, using agent records as hints about models and roles. The statusline shows the number of **registered** agents, and this number changes **only** in response to explicit `agent_spawn`/`agent_terminate` calls. Old idle records need to be cleaned up periodically — they do not consume resources, but they clutter `agent_list`.
