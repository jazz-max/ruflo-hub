#!/usr/bin/env node
/**
 * patch-sqljs-leak.cjs — build-time patch for the upstream claude-flow memory leak.
 *
 * Root cause (see UPSTREAM-ISSUE-sqljs-memfs-leak.md): `createDatabase()` in
 * @claude-flow/memory has no instance cache, so it builds a fresh sql.js backend
 * per call. Each `new SQL.Database(<full memory.db>)` writes an N-MB `dbfile_<random>`
 * into the sql.js Emscripten MEMFS; only `db.close()` (FS.unlink) frees it, and the
 * MEMFS is a process-singleton — so GC of the discarded wrapper leaks the file.
 * Native `arrayBuffers` grow ~sizeof(memory.db) per open, unbounded.
 *
 * Fix: wrap createDatabase with a per-(path|provider|dimensions) promise cache so a
 * single backend is opened once and reused, eliminating repeated full-DB loads.
 *
 * Idempotent and best-effort: if the target signature is not found (upstream changed
 * the file), it logs a warning and exits 0 — the RSS watchdog in server.mjs still
 * contains the leak. Run after `npm install -g ruflo@latest`.
 */
const { execSync } = require('child_process');
const fs = require('fs');

const MARKER = '__createDatabaseUncached';
const ORIG = 'export async function createDatabase(path, options = {}) {';
const RENAMED = 'async function __createDatabaseUncached(path, options = {}) {';
const WRAPPER = `
// ---- ruflo-hub patch: cache sql.js backends per path (stops MEMFS dbfile_* leak) ----
const __rufloDbCache = new Map();
export async function createDatabase(path, options = {}) {
  const __key = String(path) + '|' + ((options && options.provider) || 'auto') + '|' + ((options && options.dimensions) || 1536);
  const __hit = __rufloDbCache.get(__key);
  if (__hit) return __hit;
  const __p = __createDatabaseUncached(path, options);
  __rufloDbCache.set(__key, __p);
  try { return await __p; } catch (e) { __rufloDbCache.delete(__key); throw e; }
}
`;

function findTargets() {
  // Locate the global node_modules root, then all copies of the file.
  let root;
  try {
    root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  } catch {
    root = '/usr/local/lib/node_modules';
  }
  let out = '';
  try {
    out = execSync(
      `find ${root}/ruflo -path '*@claude-flow/memory/dist/database-provider.js' 2>/dev/null`,
      { encoding: 'utf8' }
    );
  } catch { /* find may exit non-zero if nothing matches */ }
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

const targets = findTargets();
if (targets.length === 0) {
  console.warn('[patch-sqljs-leak] WARNING: no database-provider.js found — leak patch NOT applied (watchdog still active).');
  process.exit(0);
}

let patched = 0;
for (const file of targets) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (src.includes(MARKER)) { console.log(`[patch-sqljs-leak] already patched: ${file}`); patched++; continue; }
  if (!src.includes(ORIG)) { console.warn(`[patch-sqljs-leak] WARNING: target signature not found in ${file} — skipped.`); continue; }
  const next = src.replace(ORIG, RENAMED) + WRAPPER;
  fs.writeFileSync(file, next);
  // sanity: file still contains exactly one createDatabase export and the renamed impl
  const check = fs.readFileSync(file, 'utf8');
  if (check.includes(MARKER) && check.includes('export async function createDatabase')) {
    console.log(`[patch-sqljs-leak] patched: ${file}`);
    patched++;
  } else {
    console.warn(`[patch-sqljs-leak] WARNING: post-patch sanity check failed for ${file}`);
  }
}

if (patched === 0) {
  console.warn('[patch-sqljs-leak] WARNING: 0 files patched — leak patch NOT applied (watchdog still active).');
} else {
  console.log(`[patch-sqljs-leak] done: ${patched} file(s) patched.`);
}
process.exit(0);
