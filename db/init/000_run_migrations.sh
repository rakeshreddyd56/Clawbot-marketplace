#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# PostgreSQL init script — runs all migrations in order.
# This script is mounted at /docker-entrypoint-initdb.d/ in the postgres
# container and is executed automatically on first startup.
#
# NOTE: This is ONLY for Docker Compose local dev.
#       In production, use a proper migration runner (e.g., node-pg-migrate,
#       Flyway, or Liquibase) with explicit version tracking.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

MIGRATIONS_DIR="/docker-entrypoint-initdb.d/migrations"

echo "[init] Running Clawbot Marketplace database migrations..."

# Run migrations in numerical order
for migration in $(ls "${MIGRATIONS_DIR}"/*.sql | sort -V); do
  echo "[init] Applying: $(basename "$migration")"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$migration"
  echo "[init] Done: $(basename "$migration")"
done

echo "[init] All migrations applied successfully."
