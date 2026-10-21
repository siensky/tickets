# Byggs från repo-roten: docker build -f shared/db/Dockerfile .
# Litet, fristående image som bara kör migrations mot båda shardarna —
# se infra/k8s/base/migrations/job.yaml.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /repo

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/db/package.json shared/db/
RUN pnpm install --frozen-lockfile --filter @tickets/db...

FROM deps AS prod-deps
COPY shared/db/ shared/db/
RUN pnpm --filter @tickets/db deploy --prod /app

FROM node:22-alpine AS runtime
RUN apk add --no-cache bash && addgroup -S -g 10001 app && adduser -S -D -u 10001 -G app app
WORKDIR /app
COPY --from=prod-deps --chown=app:app /app ./

USER 10001
ENV NODE_ENV=production
CMD ["bash", "scripts/migrate-all-shards.sh"]
