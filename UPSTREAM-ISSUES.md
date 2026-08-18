# Upstream findings for `ruvnet/ruflo` (claude-flow)

Seven filable reports, collected while diagnosing a production install that had grown
`memory.db` to 348 MB and made every memory operation cost ~10 s. Each item below is
stated with the evidence that produced it, so it can be pasted into an issue with
minimal editing. Versions: production ran `ruflo@3.14.2` / `@claude-flow/cli@3.14.2`;
comparisons are against `@claude-flow/cli@3.38.9` and `3.38.11`.

Context and measurements: `MEMORY-DB-BLOAT-INVESTIGATION.md` in this repository.

---

## 1. `ensureSchemaColumns()` marks the image dirty on every call, doubling every operation

**Severity:** high — doubles the cost of *every* memory read and write on the sql.js path.

`memory-initializer.js`:

```js
if (columnsAdded.includes('status') || existingColumns.has('status')) {
    try { db.run(`UPDATE memory_entries SET status = 'active' WHERE status IS NULL`);
          modified = true; }        // set from the column EXISTING, not from rows changing
    catch { }
}
…
if (modified) { const data = db.export(); writeFileRestricted(dbPath, Buffer.from(data), …); }
```

Any database that already has a `status` column takes this branch, so `modified` is always
true and the whole image is exported and rewritten even when the `UPDATE` changed 0 rows.
All six sql.js entry points (`storeEntry`, `getEntry`, `listEntries`, `searchEntries`,
`deleteEntry`, `purgeNamespace`) call it first, so each of them pays two full
read-modify-write cycles instead of one.

Measured on a 302 MB image (same shape as production: 35 979 rows, 384-dim embeddings as
JSON text), warm cache: one cycle = 4 862 ms, of which the fsync'd 302 MB write is
3 872 ms. So a single `memory_retrieve` costs ~10 s.

**Fix:** gate on `db.getRowsModified() > 0` rather than on the column existing.

---

## 2. The advisory lock's stale threshold is shorter than one whole-image operation

**Severity:** high — reopens the silent row loss that #2878 introduced the lock to prevent.

```js
const MEMORY_DB_LOCK_STALE_MS = 10_000;
const MEMORY_DB_LOCK_ACQUIRE_TIMEOUT_MS = 15_000;
```

The lock file's mtime is written once at creation and never refreshed. On a large database a
single whole-image cycle takes longer than 10 s (measured 4.9 s per cycle, and every operation
performs two), so another caller declares the lock stale, unlinks it and proceeds concurrently —
which is exactly the read-modify-write clobber the lock exists to prevent. Both callers report
success and the loser's rows are gone, with `PRAGMA integrity_check` still clean.

**Fix:** refresh the lock file's mtime while the critical section runs (heartbeat), or scale the
stale threshold with the image size.

---

## 3. Embeddings are stored as JSON text, and are read even when only their presence is needed

**Severity:** medium — 5× storage amplification, and it multiplies the cost of items 1 and 2.

`embeddingJson = JSON.stringify(embResult.embedding)` writes 384 floats as float64 decimal
expansions into a TEXT column: ~8 KB per row against ~1.5 KB for a binary `Float32Array`.
On the production database this was 276 MB of 334 MB.

Separately, `listEntries()` (and therefore `memory_stats`) includes `embedding` in its
`SELECT` while using only `hasEmbedding`. Measured: 278 MB of embedding text materialised in
JS to answer a count.

**Fix:** store embeddings as a BLOB; drop `embedding` from the `SELECT` where only its
presence is used.

---

## 4. An AgentDB init failure latches silently and reports itself as healthy

**Severity:** high — the failure mode is invisible from both the API and the logs.

`ControllerRegistry.initAgentDB()` catches any error, emits `agentdb:unavailable` (nothing
listens), sets `this.agentdb = null` — and does **not** throw. `registry.initialize()`
therefore succeeds, so `bridgeAvailable = true` and `bridgeFailureReason = null` while
`getDb(registry)` returns null and every `bridge*()` call falls through to the sql.js path.
`isBridgeAvailable()` reports `true` for a bridge that serves nothing.

The one line that would name the mode — `[AgentDB] better-sqlite3 not available, using sql.js
WASM` — is written with `console.log` (stdout, which is the protocol channel under `mcp start`)
and is additionally filtered out twice: by the `suppressFilter` inside `initAgentDB` and by
`INIT_LOG_NOISE` in `memory-bridge.js`. So the log is silent whichever way it went.

Consequence in the field: identical installs behave 1000× apart depending on which
process generation is running, with nothing to distinguish them.

**Fix:** have `isBridgeAvailable()` consider `getAgentDB()?.database`; record the reason even
when `initialize()` does not throw; never suppress a degradation notice, and write it to stderr.

---

## 5. `memory_bridge_status` is the most expensive operation in the system

**Severity:** medium — the diagnostic tool is unusable exactly when it is needed.

The handler calls `listEntries()` nine times (all entries, `claude-memories`, and seven
namespaces). On the sql.js path each call runs `ensureSchemaColumns()` first, so on a 334 MB
database `memory_bridge_status` costs nine whole-image rewrites — roughly 90 s and ~3 GB of
writes. A diagnostic must not be the heaviest thing in the process.

**Fix:** answer from a single `SELECT namespace, COUNT(*) … GROUP BY namespace`.

---

## 6. The #2431 fix narrowed the dual-write race instead of removing it

**Severity:** high — silent corruption, and it is the item we would most like reviewed.

`graph-edge-writer.js` opens `memory.db` itself with native better-sqlite3 and sets
`journal_mode = WAL`, while `storeEntry` / `getEntry` / `listEntries` / `searchEntries` /
`deleteEntry` in the same version keep doing `db.export()` + atomic `rename` over that same
path. The module's own header states the intent:

> Fix posture: use better-sqlite3 directly … WAL-native, no whole-file fsync, no race.
> … WAL mode enabled (which makes concurrent writers safe by SQLite's own design)

WAL makes concurrent *SQLite connections* safe. It does not make a non-SQLite whole-image
replacement of the same path safe: after the `rename` the native connection's fd points at an
unlinked inode, its WAL no longer matches the image, and rows committed through it are
discarded without an error. In 3.14.2 the bridge itself is the primary native writer, so this
is the normal path, not an edge case.

Observed in production 2026-08-16: the `mcp start` child holding
`/app/.swarm/memory.db-wal (deleted)` and `-shm (deleted)`.

**Fix:** one writer discipline — either every writer is a native SQLite connection, or every
writer goes through the whole-image path. Mixing them cannot be made safe by journal mode.

---

## 7. The 3.15+ split to `agentdb-memory.db` strands existing data, silently

**Severity:** high — a routine upgrade makes accumulated memory unreachable and reports it as
"no such key".

From 3.15 (#2786) the bridge opens a separate `agentdb-memory.db` instead of `memory.db`:

```js
dbPath: dbPath || getAgentDbPath(),   // …/agentdb-memory.db
```

Nothing migrates the existing rows, and `bridgeGetEntry()` returns a truthy
`{success: true, found: false}` on a miss, so the caller never falls back to `memory.db`.
Everything stored before the upgrade becomes invisible, and the symptom is indistinguishable
from an empty key.

Rehearsed on a copy of a production database with `@claude-flow/cli@3.38.11`, running the real
MCP server:

```
memory_list  namespace=woo-crm            -> entries: [], total: 0
memory_retrieve chan/filters/to-teamlead  -> found: false
agentdb-memory.db created; memory.db untouched
```

An `ATTACH` + `INSERT OR REPLACE … SELECT` of the active rows restores it (verified: the same
`memory_retrieve` then returns the real content). Note that a naive `SELECT *` breaks, because
databases created by older schemas have no `provenance_type` column.

**Fix:** migrate on first open, or refuse to start with a clear message when a populated
`memory.db` sits next to an empty `agentdb-memory.db`. Failing silently on read is the worst
of the three options.

---

## Not filed (unverified)

`ruflo memory export --output <file>` produced no file and no error in a clean container on
3.14.2, so the documented export/import migration path could not be used and the migration was
done in SQL instead. Not filed because the cause was not investigated — noted here so it is not
lost.
