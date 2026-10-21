#!/usr/bin/env bash
# Kör migrations mot BÅDA shardarna i tur och ordning (docs/plan.md
# "Deploy": "migrations-Job mot båda shardarna"). Körs som ett eget
# Kubernetes Job med Postgres advisory lock — se docs/forsvar.md "Varför
# körs migrations som ett eget Job och inte som init-container?".
#
# Globala tabeller (users, venues, config — docs/plan.md "Databas") ligger
# BARA på shard-0, men shardade tabeller (seats, reservations, ...) ska
# finnas på båda. Det är därför två separata migrations-mappar: en som
# bara körs mot shard-0, och en som körs mot båda. Varje mapp får sitt
# eget --migrations-table, annars skulle node-pg-migrates egen bokföring
# av körda migrationer krocka mellan de två mapparna på shard-0.
#
# Låsningen sköts av node-pg-migrate självt (--lock, påslaget som
# standard, är en pg_advisory_lock internt) — ingen egen låskod behövs.
#
# Kräver DATABASE_URL_SHARD_0 och DATABASE_URL_SHARD_1 i miljön
# (samma namn som .env.example och Kubernetes-Jobbets env).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ -z "${DATABASE_URL_SHARD_0:-}" ] || [ -z "${DATABASE_URL_SHARD_1:-}" ]; then
  echo "DATABASE_URL_SHARD_0 och DATABASE_URL_SHARD_1 måste vara satta." >&2
  exit 1
fi

run_migrations() {
  local var_name="$1"
  local dir="$2"
  local table="$3"
  echo "→ Migrerar ${var_name} (${dir})"
  # ./node_modules/.bin direkt, inte "pnpm exec" — körtidsimagen
  # (Dockerfile) har bara den deployade node_modules, inte pnpm själv.
  ./node_modules/.bin/node-pg-migrate up \
    --database-url-var "${var_name}" \
    --migrations-dir "${dir}" \
    --migrations-table "${table}" \
    --migration-file-language ts
}

run_migrations DATABASE_URL_SHARD_0 migrations/global pgmigrations_global
run_migrations DATABASE_URL_SHARD_0 migrations/sharded pgmigrations_sharded
run_migrations DATABASE_URL_SHARD_1 migrations/sharded pgmigrations_sharded

echo "✓ Båda shardarna migrerade."
