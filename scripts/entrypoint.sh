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

# Wait for PostgreSQL to be ready (with timeout)
echo "Waiting for PostgreSQL..."
ATTEMPTS=0
MAX_ATTEMPTS=60
until pg_isready -q 2>/dev/null; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "${ATTEMPTS}" -ge "${MAX_ATTEMPTS}" ]; then
    echo "ERROR: PostgreSQL not available after ${MAX_ATTEMPTS}s"
    exit 1
  fi
  sleep 1
done
echo "PostgreSQL is ready."

# Initialize RuVector schema if not already done
TABLE_EXISTS=$(psql -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'claude_flow');" 2>/dev/null || echo "false")

if [ "${TABLE_EXISTS}" = "f" ] || [ "${TABLE_EXISTS}" = "false" ]; then
  echo "Initializing RuVector schema..."
  npx ruflo ruvector init \
    --database "${POSTGRES_DB}" \
    --user "${POSTGRES_USER}" \
    --host "${POSTGRES_HOST}" \
    --port "${POSTGRES_PORT}" \
    || echo "RuVector init skipped (may need manual setup)"
else
  echo "RuVector schema already exists."
fi

# MCP proxy: Express + Streamable HTTP wrapping ruflo stdio
echo "Starting Ruflo MCP proxy on port ${RUFLO_PORT}..."
exec node /app/server.mjs
