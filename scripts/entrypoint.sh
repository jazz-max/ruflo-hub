#!/bin/bash
set -e

echo "=== Ruflo MCP Server ==="
echo "Port: ${RUFLO_PORT}"
echo "PostgreSQL: ${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"

# Export PG* variables so all tools (psql, ruflo ruvector) use the correct host
export PGHOST="${POSTGRES_HOST}"
export PGPORT="${POSTGRES_PORT}"
export PGDATABASE="${POSTGRES_DB}"
export PGUSER="${POSTGRES_USER}"
export PGPASSWORD="${POSTGRES_PASSWORD}"

# Wait for PostgreSQL — but don't block if PG is disabled (lean mode)
# Short probe first: if PG is not reachable within 5s, skip and run PG-less.
echo "Probing PostgreSQL..."
if pg_isready -q -t 5 2>/dev/null; then
  echo "PostgreSQL is ready."

  # Initialize RuVector schema if not already done
  TABLE_EXISTS=$(psql -tAc \
    "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'claude_flow');" 2>/dev/null || echo "false")

  if [ "${TABLE_EXISTS}" = "f" ] || [ "${TABLE_EXISTS}" = "false" ]; then
    echo "Initializing RuVector schema..."
    ruflo ruvector init \
      --database "${POSTGRES_DB}" \
      --user "${POSTGRES_USER}" \
      --host "${POSTGRES_HOST}" \
      --port "${POSTGRES_PORT}" \
      || echo "RuVector init skipped (may need manual setup)"
  else
    echo "RuVector schema already exists."
  fi
else
  echo "PostgreSQL not reachable at ${POSTGRES_HOST}:${POSTGRES_PORT} — running in lean mode (sql.js only)."
  echo "Enable PG: set COMPOSE_PROFILES=pg in .env or run 'docker compose --profile pg up'"
fi

# Health-check stubs: create marker files at the paths system_health probes,
# so other Claude instances stop suggesting `ruflo init` / `memory init`.
# The real backend lives in /app/.swarm/memory.db (volume); these files are formal only.
#
# CAUTION: If `store.json` exists but `.migrated-to-sqlite` does NOT, ruflo's
# memory_store handler treats store.json as a legacy JSON dump and tries to
# migrate it on every call. A `{}` payload makes that migration crash with
# "Cannot convert undefined or null to object" because `legacyStore.entries`
# is undefined. We always write the migration marker alongside store.json
# to short-circuit that code path.
mkdir -p /app/.claude-flow/memory
[ -f /app/.claude-flow/memory/store.json ] || echo '{}' > /app/.claude-flow/memory/store.json
[ -f /app/.claude-flow/memory/.migrated-to-sqlite ] || echo "{\"migratedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"version\":\"3.0.0\"}" > /app/.claude-flow/memory/.migrated-to-sqlite
[ -f /app/.claude-flow/config.json ] || echo '{}' > /app/.claude-flow/config.json

# Warn loudly if /app/.swarm or /app/.claude-flow is NOT a mount point.
# The real memory store lives at /app/.swarm/memory.db, and a missing volume
# means the next `docker compose up -d` will silently wipe everything.
mkdir -p /app/.swarm
for path in /app/.swarm /app/.claude-flow; do
  if ! mountpoint -q "$path" 2>/dev/null; then
    echo "" >&2
    echo "============================================================" >&2
    echo "WARNING: $path is NOT mounted from a Docker volume." >&2
    echo "Memory written to $path will live inside the container's R/W" >&2
    echo "layer and WILL BE LOST on the next \`docker compose up -d\`." >&2
    echo "" >&2
    echo "Fix: add to your docker-compose.yml:" >&2
    echo "  services:" >&2
    echo "    ruflo:" >&2
    echo "      volumes:" >&2
    echo "        - ruflo-memory:/app/.swarm" >&2
    echo "        - ruflo-state:/app/.claude-flow" >&2
    echo "  volumes:" >&2
    echo "    ruflo-memory:" >&2
    echo "    ruflo-state:" >&2
    echo "" >&2
    echo "See README \"Memory persistence\" for the migration procedure." >&2
    echo "============================================================" >&2
    echo "" >&2
  fi
done

# MCP proxy: Express + Streamable HTTP wrapping ruflo stdio
echo "Starting Ruflo MCP proxy on port ${RUFLO_PORT}..."
exec node /app/server.mjs
