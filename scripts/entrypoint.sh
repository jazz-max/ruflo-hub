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

# MCP proxy: Express + Streamable HTTP wrapping ruflo stdio
echo "Starting Ruflo MCP proxy on port ${RUFLO_PORT}..."
exec node /app/server.mjs
