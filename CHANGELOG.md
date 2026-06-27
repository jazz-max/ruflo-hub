# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

The image is published to Docker Hub: `jazzmax/ruflo-hub:<version>` (per release), `:latest` (always the latest `main`), `:<git-sha>` (for tracing).

Russian version: [`docs/ru/CHANGELOG.md`](docs/ru/CHANGELOG.md).

## [Unreleased]

### Docs
- **Security & leak notes updated to the actually-shipped version (3.14.2).** v1.3.0 ships ruflo 3.14.2 (upstream leak fix #2432), but the README honesty notes still cited the previous `3.12.4` / `302 tools`. Re-verified 3.14.2 and updated README (en + ru): the leak note now credits the upstream root-cause fix (`closePriorIfAny` in `@claude-flow/memory@3.0.0-alpha.21`) with the RSS watchdog kept as a backstop; the security note was re-audited against the shipped tree — no `preinstall` hooks anywhere, `install` scripts are standard native builds only (better-sqlite3/argon2/bcrypt), the `postinstall` scripts (agentdb, `@claude-flow/cli`, protobufjs) are benign (read in full — no obfuscation/network/eval), and all **305** live tool descriptions scanned clean (0 hidden/bidi unicode; deterministic + 8-way adversarial semantic sweep found 0 injections); `/health` examples corrected to `tools: 305`.

## [1.3.0] — 2026-06-26

### Fixed
- **Upstream memory leak (#2432) resolved by ruflo 3.14.2.** ruvnet confirmed the real root cause is `@claude-flow/memory` `ControllerRegistry.initController()` replacing map entries without closing the prior controller (each re-init orphaned a `SqlJsRvfBackend`/`SQL.Database` → a `dbfile_*` in the sql.js MEMFS). Fixed in `@claude-flow/memory@3.0.0-alpha.21` (`closePriorController()` before `controllers.set()`). Building on `ruflo@latest` picks it up; the RSS watchdog (1.2.0) is now a harmless safety net rather than the primary defense. Note: the 1.2.1 `createDatabase` cache patch targeted the wrong layer (ruvnet confirmed `createDatabase` was fine) — kept as a harmless best-effort no-op.

### Added
- **Pre-bake the ONNX embeddings model into the image.** ruflo downloads `all-MiniLM-L6-v2` (~90 MB) from HuggingFace on first run, caching it under `/root/.ruvector/models` — a path that is NOT a volume, so every container recreate lost it and re-downloaded. On a flaky network the download couldn't finish within the 60 s MCP connect timeout, so `server.mjs` crash-looped (each restart killed the partial download). The Dockerfile now warms the model at build time so startup is instant and recreate-safe.

### Docs
- **Honest repositioning of README + docs.** An independent audit ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1sckiy8/)) showed most of ruflo's 300+ MCP tools are non-functional stubs; the genuinely-working part is the memory layer. README (en + ru) now leads with that: a new "What this actually is" section states what's real (memory: embeddings + HNSW + SQLite + auto-memory) vs theater (swarm/neural/agent stubs), and that `ruflo-hub` deliberately uses only the memory layer. Added honesty notes on the leak (#2432 + RSS watchdog), the #1375 security history (version-bounded to ≤3.5.2; verified clean in the shipped 3.12.4), and WAL-safe backups. Dropped "250+ tools" as a selling point; `/health` tool count corrected to 302. `docs/swarm-management.md` (en + ru) got a banner clarifying swarm/hive-mind are coordination records, not real execution, and the project doesn't rely on them.

## [1.2.1] — 2026-06-21

### Added
- **Build-time root-cause patch for the leak** (`scripts/patch-sqljs-leak.cjs`, wired into the Dockerfile after `npm install -g ruflo`). A heap-snapshot retainer analysis pinned the leak: the sql.js Emscripten MEMFS accumulates `dbfile_<random>` files (one full `memory.db` image — 11 MB locally, 60 MB in prod — per database open), because `@claude-flow/memory`'s `createDatabase()` has no instance cache and re-loads the whole DB into a new `SQL.Database` per call; the discarded wrapper is GC'd but its MEMFS file is only freed by `db.close()`, which is never called. The patch wraps `createDatabase()` with a per-`(path|provider|dimensions)` promise cache so a single backend is opened once and reused — eliminating the repeated full-DB loads. Idempotent and best-effort: if upstream changes the file it logs a warning and the RSS watchdog (1.2.0) still contains the leak.
- Filed upstream as [ruvnet/ruflo#2432](https://github.com/ruvnet/ruflo/issues/2432); full diagnosis in [`UPSTREAM-ISSUE-sqljs-memfs-leak.md`](UPSTREAM-ISSUE-sqljs-memfs-leak.md).

### Verified
- Patched image: `memory_store` / `memory_search` work (384-dim embeddings, `stored: true`) on a fresh DB; sql.js backend healthy, 302 tools. The patch does not alter DB bytes — a pre-existing `database disk image is malformed` on the (empty) local personal DB is unrelated corruption from earlier ungraceful child kills.

## [1.2.0] — 2026-06-19

### Added
- **RSS watchdog for the `ruflo mcp start` child in `server.mjs`** — containment for a load-correlated memory leak in upstream claude-flow. Diagnosis (see [`LEAK-INVESTIGATION-HANDOFF.md`](LEAK-INVESTIGATION-HANDOFF.md)): the leak is **not** in our proxy and **not** in the V8 JS heap. `process.memoryUsage()` on the live child showed `heapTotal ≈ 24 MB` (flat) but `external ≈ 1.3 GB` / `arrayBuffers ≈ 1.1 GB` and climbing — native buffers (embeddings / HNSW / result buffers) accumulating per tool call, ~160 MB/h under load. `memory.db` on disk is only 11 MB, so it is leaked buffers, not the DB image.
  - The watchdog samples the child's RSS from `/proc/<pid>/status` (via the SDK's `transport.pid`) every `RUFLO_WATCHDOG_INTERVAL_MS` (default 60 s). When RSS crosses `RUFLO_CHILD_MAX_RSS_MB` it flags a respawn and carries it out **once the child is idle** (`inFlight === 0`), reusing `connectToRuflo()` — which kills the old child before spawning a fresh one, dropping all leaked native memory at once. If traffic never lets it idle within `RUFLO_RESPAWN_IDLE_TIMEOUT_MS` (default 30 s), the respawn is forced (in-flight calls are covered by `callToolReliably`'s transparent retry).
  - `RUFLO_CHILD_MAX_RSS_MB=0` disables the watchdog. Defaults wired in compose: `2500` for `ruflo-my` (4 GB cap), `3000` for `ruflo` (8 GB cap) — both below the cgroup `mem_limit`, so the watchdog acts before the OOM backstop.
  - `/health` gained `childRssMB`, `childMaxRssMB`, `childRespawnCount`, `lastChildRespawnAt`, `lastChildRespawnRssMB`, `inFlight`. `lastReconnectReason` can now be `rss-threshold`.
  - Verified end-to-end against a live container (low test threshold): respawn fires on threshold, serves tools after respawn, and the child process count stays at exactly 1 across cycles — no orphan accumulation (the single-flight reconnect from 1.1.2 holds).

### Notes
- **Not fixed: the root cause.** `ruflo@3.12.4` (latest at release time) is byte-identical to `3.12.3` except `package.json` (version bump + new `agentic-flow` dep), so pinning a newer `ruflo` does not help. `--max-old-space-size` is useless here because the leak is native (`arrayBuffers`/`external`), not the V8 old space. The real fix belongs upstream in `ruvnet/ruflo`; this release only bounds the symptom.

## [1.1.2] — 2026-05-01

### Fixed
- **stdio child leak in `server.mjs` (`ruflo mcp start` zombies).** The 1.1.0 auto-reconnect (`transport.onclose` + `callTool-failure` retry) was not single-flight: N concurrent HTTP requests that hit `Not connected` each called `connectToRuflo()` in parallel and spawned N fresh `ruflo mcp start` processes. The global `client` was overwritten by the last winner, but the previous children kept running — their stdio pipes were held by transport objects no longer referenced anywhere. Over 4 days in production this accumulated to **123 orphaned processes and 4.2 GB of RAM** (cgroup `anon`).
- **Single-flight `connectToRuflo`** via `connectingPromise` — concurrent callers all await the same in-flight promise.
- **Explicit SIGTERM of the previous child** before spawning a new one: `transport.close()` is fire-and-forget so the SDK's 0–4 s grace period never blocks reconnect.
- **Stale-transport `onclose` is now ignored** (`transport !== currentTransport`) — otherwise the death-throes of an orphaned child triggered an extra reconnect.
- Stress test: 5 rounds × 8 concurrent requests + `kill -9` the child mid-flight. Each round produced exactly 1 reconnect, 1 child, RAM steady at 79 MiB. Pre-patch the same scenario leaked 4–5 orphans per round.

## [1.1.1] — 2026-04-29

### Fixed
- **Docs: missing volumes in embedding examples.** All three variants in the README (en + ru) mounted only `ruflo-pgdata`, omitting `ruflo-memory:/app/.swarm` and `ruflo-state:/app/.claude-flow`. As a result, `docker compose pull && up -d` recreated the container and lost `memory.db`. Volume mappings were added to all variants, plus a prominent WARNING block at the top of the "Embedding as a service" section.
- New section [Migrating an existing deployment to volumes](README.md#migrating-an-existing-deployment-to-volumes) — a step-by-step migration plan that moves live data into a named volume without loss, for users who already deployed without volumes.

### Added
- **Runtime warning in `entrypoint.sh`**: uses `mountpoint -q` to verify that `/app/.swarm` and `/app/.claude-flow` are mounted from a volume. If not, it prints a prominent block to the container's `stderr` with the exact YAML snippet to paste into compose. Runs on every start.

## [1.1.0] — 2026-04-27

### Added
- **SONA pattern bridge** in the client bundle (`templates/intelligence-bridge.cjs` + hooks in `hook-handler.cjs`). Every Claude Code action (`Edit` / `Bash` / `task-complete` / `session-end`) is written as a pattern in the `pattern` namespace via `hooks_intelligence_pattern-store`. An aggregated summary is stored on `session-end`.
- **Auto-reconnect** for the stdio child `ruflo mcp start` in `server.mjs`. When the child dies (`transport.onclose`), a back-off timer between 0.5 and 5 s respawns it automatically. `callTool` retries transparently on `Not connected` / `Connection closed`.
- **Persistent stderr log** for the ruflo CLI: `/app/.swarm/ruflo-stderr.log` (on a volume, survives container restarts). Each reconnect attempt is recorded there with its reason.
- **Extended `/health`**: now includes `state`, `serverStartedAt`, `currentConnectedSince`, `reconnectCount`, `reconnectFailures`, `lastReconnectAt`, `lastReconnectReason`. Returns `503` when the transport is not in `ready` state (the Docker healthcheck no longer lies).
- **Stub files for `system_health`**: `/app/.claude-flow/{config.json,memory/store.json}` are created by `entrypoint.sh` so clients stop suggesting `ruflo init`. Alongside them sits the migration marker `.migrated-to-sqlite` — without it, `memory_store` crashes with a null-deref on the empty stub.
- **`intelligence-bridge.cjs` is shipped** through `/setup` and `/update-bundle`. `/update-bundle` now always overwrites helpers (they are server-owned).
- **Operational notes** in the README (en + ru): known quirks of `system_health`, `claude_flow.embeddings`, `memory_bridge_status`, and the background controllers.

### Fixed
- **Crash `memory_store: Cannot convert undefined or null to object`** — the `.migrated-to-sqlite` migration marker disables the code path in `memory-tools.js` that treated the stub `store.json` as a legacy dump and called `Object.keys(legacyStore.entries).length` on `undefined`.
- **Lost writes when the stdio child crashes**: prior to 1.1.0, the container could spend 13+ hours replying `Not connected` to every MCP call while `/health` returned `200 OK` (using the `tools/list` cache from startup). The child is now auto-restarted and `/health` signals degraded state.
- **Documentation inaccuracies**: references to `supergateway` were removed (not used in this build — we have our own Express proxy `server.mjs`). `all-MiniLM-L6-v2 384-dim` was corrected to `1536-dim (RuVector)`, with a note about the active sql.js (768-dim) backend.
- **Backup instructions** rewritten (en + ru): the volume to back up is `<service>-memory`, not a `pg_dump` — the primary memory lives in `/app/.swarm/memory.db`, while PostgreSQL is normally empty and used only for `ruvector import/export`.

### Reported upstream
- [ruvnet/ruflo#1647](https://github.com/ruvnet/ruflo/issues/1647): the `trajectory-*` API does not persist tracking data to SQLite, plus null-derefs in `hooks_intelligence_stats` / `memory_bridge_status` / migration code in `memory_store`.

## [1.0.0] — 2026-04-22

First tracked version. Main features at this point:

- Docker wrapper around the `ruflo` CLI: `server.mjs` (Express + MCP stdio client) + Dockerfile + docker-compose.
- `/mcp` (Streamable HTTP JSON-RPC), `/health`, `/stats` (with `dbSizeKB` and intelligence metrics).
- `/setup` and `/update-bundle` — self-configuring shell scripts that install `.claude/helpers/{auto-memory-hook.mjs,hook-handler.cjs,statusline.cjs}` + `.claude/{skills,agents,commands}` into the target project.
- Memory bridge: `auto-memory-hook.mjs` — imports patterns from ruflo-personal on `SessionStart`, syncs on `Stop`.
- Optional PostgreSQL/pgvector (lean mode if PG is unavailable). Auto-initialises the `claude_flow` schema via `ruvector init`.
- Multi-instance support (several containers on different ports, each with its own PG database — `ruflo_alpha`, `ruflo_beta`).
- CI: GitHub Actions builds the image on every push to `main` and weekly (Mon 06:00 UTC), pushes `latest` + `<sha>` to Docker Hub.
- Bilingual documentation (en + ru).

[Unreleased]: https://github.com/jazz-max/ruflo-hub/compare/v1.1.2...HEAD
[1.1.2]: https://github.com/jazz-max/ruflo-hub/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/jazz-max/ruflo-hub/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/jazz-max/ruflo-hub/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jazz-max/ruflo-hub/releases/tag/v1.0.0
