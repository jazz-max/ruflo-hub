#!/usr/bin/env bash
# prune-memory-namespace.sh — offline cleanup of a bloated ruflo memory.db.
#
# WHY THIS EXISTS
#   On the sql.js fallback path every memory operation rewrites the ENTIRE
#   database file (twice — ensureSchemaColumns rewrites the image before the
#   operation itself does). At 336 MB that is ~10 s per memory_store /
#   memory_retrieve and ~1.3 GB of transient buffers per call. 99.6 % of those
#   rows are namespace `pattern`, written one-per-tool-call by the intelligence
#   hook with no TTL and no cap. Deleting them took a measured read cycle from
#   4 862 ms to 36 ms. See MEMORY-DB-BLOAT-INVESTIGATION.md.
#
# WHY OFFLINE, AND WHY A CHECKPOINT FIRST
#   memory.db has a live native better-sqlite3 WAL connection (graph-edge-writer
#   opens `memory.db` itself and sets journal_mode=WAL) alongside the whole-image
#   writers. Rows committed to the WAL are NOT in the main file. Deleting through
#   MCP would mean 35 830 whole-image writes; deleting with a sql.js-based tool
#   would silently discard the WAL. So: stop every writer, checkpoint the WAL
#   into the image with a NATIVE sqlite, then delete and VACUUM.
#
# WHAT IT DOES
#   report phase (default, non-destructive): backs up memory.db + -wal + -shm out
#     of the volume and prints per-namespace counts FROM THE BACKUP (WAL included,
#     so the numbers are not WAL-blind the way a plain `docker cp` snapshot is).
#   apply phase (--yes): stops the container, checkpoints, deletes the namespace,
#     VACUUMs, runs integrity_check, restarts the container, waits for /health.
#
# USAGE
#   ./scripts/prune-memory-namespace.sh                          # report only
#   ./scripts/prune-memory-namespace.sh --yes                    # do it
#   ./scripts/prune-memory-namespace.sh --container ruflo-my --namespace pattern
#
# Options:
#   --container NAME    container to operate on            (default: ruflo)
#   --namespace NAME    namespace to delete                (default: pattern)
#   --backup-dir DIR    where backups go                   (default: ./backups)
#   --sqlite-image IMG  image used to run sqlite3          (default: alpine:3.20,
#                       needs network for `apk add sqlite`; override with an
#                       image that already ships sqlite3 for an offline host)
#   --yes               actually perform the destructive phase
set -euo pipefail

CONTAINER=ruflo
NAMESPACE=pattern
BACKUP_ROOT="$(pwd)/backups"
SQLITE_IMAGE=alpine:3.20
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --container)    CONTAINER="$2"; shift 2 ;;
    --namespace)    NAMESPACE="$2"; shift 2 ;;
    --backup-dir)   BACKUP_ROOT="$2"; shift 2 ;;
    --sqlite-image) SQLITE_IMAGE="$2"; shift 2 ;;
    --yes)          APPLY=1; shift ;;
    -h|--help)      sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

case "$NAMESPACE" in
  ''|*[!A-Za-z0-9._-]*) echo "refusing unsafe namespace: '$NAMESPACE'" >&2; exit 2 ;;
esac

say()  { printf '  %s\n' "$*"; }
head_() { printf '\n=== %s ===\n' "$*"; }
die()  { printf '\n  ✗ %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "no such container: $CONTAINER"

# ─── Locate the volume backing /app/.swarm ────────────────────────────────────
VOLUME="$(docker inspect "$CONTAINER" \
  --format '{{range .Mounts}}{{if eq .Destination "/app/.swarm"}}{{.Name}}{{end}}{{end}}')"
[ -n "$VOLUME" ] || die "no volume mounted at /app/.swarm in $CONTAINER"

# Helper: run sqlite3 against the live volume.
sqlite_on_volume() {          # $1 = SQL
  docker run --rm -v "$VOLUME":/data "$SQLITE_IMAGE" sh -c \
    'command -v sqlite3 >/dev/null 2>&1 || apk add --no-cache sqlite >/dev/null 2>&1 || {
       echo "sqlite3 unavailable in '"$SQLITE_IMAGE"' and apk add failed (offline?) — use --sqlite-image" >&2; exit 1; }
     exec sqlite3 /data/memory.db' <<SQL
$1
SQL
}

# Helper: run sqlite3 against the backup copy (host path).
sqlite_on_backup() {          # $1 = SQL
  docker run --rm -v "$BACKUP_DIR":/backup "$SQLITE_IMAGE" sh -c \
    'command -v sqlite3 >/dev/null 2>&1 || apk add --no-cache sqlite >/dev/null 2>&1 || {
       echo "sqlite3 unavailable — use --sqlite-image" >&2; exit 1; }
     exec sqlite3 /backup/memory.db' <<SQL
$1
SQL
}

head_ "Target"
say "container:  $CONTAINER"
say "volume:     $VOLUME  (mounted at /app/.swarm)"
say "namespace:  $NAMESPACE  (rows in this namespace will be deleted in the apply phase)"
say "mode:       $([ "$APPLY" = 1 ] && echo 'APPLY — destructive' || echo 'report only (pass --yes to apply)')"

head_ "Files on the volume"
docker exec "$CONTAINER" ls -la /app/.swarm/ || die "cannot list /app/.swarm"

# Refuse early if the image is not a plaintext SQLite file (ruflo can write an
# encrypted image; sqlite3 could not open that, and we must not guess).
MAGIC="$(docker exec "$CONTAINER" head -c 15 /app/.swarm/memory.db 2>/dev/null || true)"
[ "$MAGIC" = "SQLite format 3" ] || die "memory.db is not a plaintext SQLite image (header: '$MAGIC') — encrypted? aborting"

# ─── Phase 1: report snapshot (always) ────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$BACKUP_ROOT/memory-$STAMP"
mkdir -p "$BACKUP_DIR"

snapshot_volume() {           # $1 = label for the log
  # tar out of the volume so the -wal/-shm sidecars come along. A bare
  # `docker cp memory.db` is WAL-blind: with an uncheckpointed WAL the main
  # image can be missing not just recent rows but entire tables (verified —
  # in a test snapshot the main file held only the header, all 200 rows and
  # every CREATE TABLE lived in the -wal).
  docker run --rm -v "$VOLUME":/data -v "$BACKUP_DIR":/backup "$SQLITE_IMAGE" \
    sh -c 'cd /data && tar cf /backup/'"$1"'.tar . &&
           cp -p memory.db /backup/ 2>/dev/null;
           cp -p memory.db-wal /backup/ 2>/dev/null || true;
           cp -p memory.db-shm /backup/ 2>/dev/null || true' \
    || die "snapshot failed"
}

head_ "Report snapshot → $BACKUP_DIR"
say "NOTE: the container is still running, so this copy may be torn. It is for"
say "counting only — the authoritative backup is taken after the stop below."
snapshot_volume swarm-live
ls -la "$BACKUP_DIR"

head_ "Contents (from the snapshot — WAL included, so not WAL-blind)"
sqlite_on_backup "
.mode column
.headers on
PRAGMA journal_mode;
SELECT namespace, COUNT(*) AS rows,
       ROUND(SUM(LENGTH(COALESCE(content,'')))/1048576.0, 1) AS content_mb,
       ROUND(SUM(LENGTH(COALESCE(embedding,'')))/1048576.0, 1) AS embedding_mb
  FROM memory_entries GROUP BY namespace ORDER BY rows DESC;
SELECT 'graph_edges' AS table_name, COUNT(*) AS rows FROM graph_edges;
" || say "(count query failed — inspect $BACKUP_DIR manually before going further)"

if [ "$APPLY" != 1 ]; then
  head_ "Report only — nothing changed"
  say "Snapshot kept at $BACKUP_DIR"
  say "Re-run with --yes to checkpoint the WAL, delete namespace '$NAMESPACE' and VACUUM."
  say "The apply phase STOPS $CONTAINER — coordinate the window with anyone using it."
  exit 0
fi

# ─── Phase 2: destructive ─────────────────────────────────────────────────────
head_ "Stopping $CONTAINER (all writers must be gone before touching the file)"
docker stop "$CONTAINER" >/dev/null
say "stopped"

# NOW take the backup that recovery would actually use: with every writer gone
# the file set is consistent. The pre-stop copy above was for counting only.
head_ "Authoritative backup (container stopped) → $BACKUP_DIR/swarm-consistent.tar"
snapshot_volume swarm-consistent
say "done"

head_ "Checkpoint WAL → image, delete namespace '$NAMESPACE', VACUUM"
# wal_checkpoint(TRUNCATE) folds WAL-committed rows into the main file. It must
# run on a NATIVE sqlite: sql.js ignores the WAL entirely and the next
# whole-image write would throw those rows away.
sqlite_on_volume "
PRAGMA busy_timeout = 10000;
PRAGMA wal_checkpoint(TRUNCATE);
BEGIN;
DELETE FROM memory_entries WHERE namespace = '$NAMESPACE';
DELETE FROM vector_indexes WHERE id = '$NAMESPACE';
COMMIT;
VACUUM;
PRAGMA integrity_check;
" || { say "cleanup FAILED — container is still stopped, backup at $BACKUP_DIR"; die "aborting before restart"; }

# The FTS mirror only exists on some installs (SqlJsBackend creates memory_fts,
# MEMORY_SCHEMA_V3 does not). Clean it opportunistically so it can't keep
# orphaned rows for entries we just deleted.
sqlite_on_volume "
DELETE FROM memory_fts WHERE id NOT IN (SELECT id FROM memory_entries);
" >/dev/null 2>&1 && say "memory_fts pruned" || say "no memory_fts table (expected on most installs)"

head_ "Result"
sqlite_on_volume "
.mode column
.headers on
SELECT namespace, COUNT(*) AS rows FROM memory_entries GROUP BY namespace ORDER BY rows DESC;
" || true

head_ "Starting $CONTAINER"
docker start "$CONTAINER" >/dev/null
PORT="$(docker inspect "$CONTAINER" --format \
  '{{range $p, $c := .NetworkSettings.Ports}}{{range $c}}{{.HostPort}} {{end}}{{end}}' | awk '{print $1}')"
for i in $(seq 1 30); do
  if [ -n "$PORT" ] && curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    say "healthy on port $PORT after ${i}s"; break
  fi
  sleep 1
  [ "$i" = 30 ] && say "WARNING: /health not ready after 30s — check 'docker logs $CONTAINER'"
done

docker exec "$CONTAINER" ls -la /app/.swarm/ || true

head_ "Done"
say "Backup (pre-cleanup, WAL included): $BACKUP_DIR"
say "Keep it until you have confirmed the surviving namespaces look right."
say ""
say "Note: the native writer will recreate memory.db-wal on the next hook call."
say "That is expected on 3.14.2. Do NOT upgrade ruflo past 3.14.x until the"
say "AgentDB bridge works — from 3.15 on, every sql.js memory operation refuses"
say "while -wal exists, and graph-edge-writer recreates it. See"
say "MEMORY-DB-BLOAT-INVESTIGATION.md."
