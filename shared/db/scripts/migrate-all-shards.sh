#!/usr/bin/env bash
# Kör migrations mot BÅDA shardarna i tur och ordning (docs/plan.md
# "Deploy": "migrations-Job mot båda shardarna"). Körs som ett eget
# Kubernetes Job med Postgres advisory lock — se docs/forsvar.md "Varför
# körs migrations som ett eget Job och inte som init-container?".
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

for var_name in DATABASE_URL_SHARD_0 DATABASE_URL_SHARD_1; do
  echo "→ Migrerar ${var_name}"
  # ./node_modules/.bin direkt, inte "pnpm exec" — körtidsimagen
  # (Dockerfile) har bara den deployade node_modules, inte pnpm själv.
  ./node_modules/.bin/node-pg-migrate up \
    --database-url-var "${var_name}" \
    --migrations-dir migrations \
    --migration-file-language ts
done

echo "✓ Båda shardarna migrerade."
