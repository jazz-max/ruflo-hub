#!/bin/bash
# Creates additional databases for multi-instance ruflo setup.
# Mounted into postgres via docker-entrypoint-initdb.d/
# Only runs on first container init (empty data volume).

set -e

# Add extra databases here (one per line)
EXTRA_DBS="ruflo_my"

for db in $EXTRA_DBS; do
  echo "Creating database: $db"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE "$db" OWNER "$POSTGRES_USER";
EOSQL
done
