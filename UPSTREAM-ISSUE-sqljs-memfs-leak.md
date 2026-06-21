# Unbounded native memory leak: orphaned sql.js MEMFS `dbfile_*` files (~11 MB each) accumulate per database open

**Filed:** ruvnet/ruflo#2432
**Affected:** `@claude-flow/memory` (sql.js backend path) as shipped in `ruflo` (claude-flow) v3.12.3 / v3.12.4
**Severity:** high — unbounded RSS growth proportional to MCP tool-call / session volume (~36 GB observed in production over 6 weeks; ~160 MB/h under sustained load)
**Type:** resource leak in the JS layer (not pure WASM growth) — fixable in JS

## Summary

Under the `mcp start` long-lived process, the resident memory of the sql.js
backend grows without bound. The growth is **not** in the V8 JS heap
(`heapTotal` stays ~24 MB) — it is in native `external` / `arrayBuffers`
(observed at 1.3 GB / 1.1 GB and climbing on one instance).

A heap-snapshot retainer analysis shows the memory is held by the
**sql.js Emscripten in-memory filesystem (MEMFS)**: it accumulates files named
`dbfile_<random>`, **11 558 912 bytes each** — exactly the size of the
on-disk `memory.db`. One full database image is orphaned in MEMFS **per
`new SQL.Database(buffer)` call that is never matched by `db.close()`**.

## Evidence (V8 heap snapshot of the live `ruflo mcp start` child)

```
process.memoryUsage():  heapTotal 24 MB   external 1286 MB   arrayBuffers 995 MB
```

Top retained objects: **203 × `native:system / JSArrayBufferData` @ 11.0 MB = 2233 MB**
(plus 204 × ~0.1 MB and a 52.8 MB buffer). Retainer path of each 11 MB buffer:

```
JSArrayBufferData (11.0 MB)
  <- ArrayBuffer
  <- Buffer
  <- <MEMFS node>.contents            (Emscripten MEMFS file node)
  <- <MEMFS node>.node
  <- Array  (FS.nodes of the sql.js Emscripten module — a process singleton)
  <- Context (sql.js Emscripten module closure: has WebAssembly.Memory, HEAPF32/HEAP32 views, createNode, lookup, /dev/tty …)
  <- SqlJsRvfBackend.db
  <- ReflexionMemory.vectorBackend
  <- ControllerRegistry.controllers (Map)
```

The MEMFS file names confirm the source — each is a distinct sql.js temp DB file:

```
dbfile_3079493243  (11.0 MB)
dbfile_3056784716  (11.0 MB)
dbfile_1155588019  (11.0 MB)
… 203 total, all unique, all = sizeof(memory.db) = 11 558 912 bytes
```

## Root cause

sql.js's `Database` constructor writes its input bytes into a MEMFS file via
`FS.createDataFile("/", "dbfile_" + random, data, …)`. That file is only
removed by `Database.prototype.close()` (which calls `FS.unlink`). Because the
sql.js Emscripten module is a **process-wide singleton**, the MEMFS file
outlives the JS `Database` wrapper: **garbage-collecting the wrapper does NOT
reclaim the MEMFS storage** — only an explicit `close()` does.

In `@claude-flow/memory/dist/database-provider.js`, `createDatabase()`:

- has **no instance cache / singleton** — every call builds a fresh backend;
- for the `sql.js` provider, `SqlJsBackend.initialize()`
  (`@claude-flow/memory/dist/sqljs-backend.js:68`) runs
  `this.db = new this.SQL.Database(new Uint8Array(buffer))` where `buffer` is
  the full ~11 MB `memory.db`;
- the returned backend is used and then dropped by its caller **without
  `backend.close()`** (which would call `db.close()` → `FS.unlink`).

So each `createDatabase()` for an existing DB orphans one 11 MB `dbfile_*` in
MEMFS. With `createDatabase()` invoked per operation/session, native memory
grows ~11 MB per open, unbounded.

(Note: the probe `testSqlJs()` correctly closes its test DB, so the dominant
leak is specifically the **returned backend** not being closed, and/or
`createDatabase()` being re-invoked instead of reusing a cached instance.)

## Reproduction

1. Run `ruflo mcp start` with a non-trivial `memory.db` (e.g. ~11 MB).
2. Drive MCP memory tools (or anything that triggers `createDatabase()` for the
   sql.js provider) repeatedly.
3. Watch `process.memoryUsage().arrayBuffers` / RSS climb by ~one `memory.db`
   size per open, while `heapTotal` stays flat.
4. A heap snapshot shows N × `dbfile_<random>` MEMFS files of `sizeof(memory.db)`.

## Proposed fix (any one, in order of preference)

1. **Cache/reuse a single backend instance** for the process lifetime instead
   of calling `createDatabase()` per operation — the sql.js DB should be opened
   once and kept open.
2. **Guarantee `close()`** on every backend obtained from `createDatabase()`
   (try/finally at the call site), so sql.js `FS.unlink`s the `dbfile_*`.
3. **Defensive cleanup**: after closing, or periodically, unlink stale
   `/dbfile_*` entries from the sql.js MEMFS.

## Containment (consumer side, already deployed in ruflo-hub)

`server.mjs` runs an RSS watchdog that gracefully respawns the `ruflo mcp start`
child when its RSS crosses a threshold (idle-gated). This bounds the symptom but
does not address the root cause above.
