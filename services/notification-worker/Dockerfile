# Byggs från repo-roten: docker build -f services/notification-worker/Dockerfile .
# Samma struktur som services/booking-api/Dockerfile — se dess kommentarer
# för resonemanget (pnpm deploy --prod, icke-root runtime, m.m.).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
WORKDIR /repo

# --- deps: installera hela workspace-grafen, maximerar lagercache ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/domain/package.json shared/domain/
COPY shared/observability/package.json shared/observability/
COPY shared/auth/package.json shared/auth/
COPY shared/db/package.json shared/db/
COPY shared/rabbit/package.json shared/rabbit/
COPY shared/redis/package.json shared/redis/
COPY shared/schemas/package.json shared/schemas/
COPY shared/analytics/package.json shared/analytics/
COPY shared/types/package.json shared/types/
COPY services/booking-api/package.json services/booking-api/
COPY services/realtime-gateway/package.json services/realtime-gateway/
COPY services/scheduler-worker/package.json services/scheduler-worker/
COPY services/notification-worker/package.json services/notification-worker/
COPY services/payment-mock/package.json services/payment-mock/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# --- source: full källkod för notification-worker och dess workspace-beroenden ---
FROM deps AS source
COPY tsconfig.base.json tsup.base.ts ./
COPY shared/ shared/
COPY services/notification-worker/ services/notification-worker/

# --- build: bunta notification-worker med tsup ---
FROM source AS build
RUN pnpm --filter @tickets/notification-worker build

# --- prod-deps: notification-workers egna produktionsberoenden ---
FROM source AS prod-deps
RUN pnpm --filter @tickets/notification-worker deploy --prod /app

# --- runtime: minimal, icke-root ---
FROM node:22-alpine AS runtime
RUN addgroup -S -g 10001 app && adduser -S -D -u 10001 -G app app
WORKDIR /app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=prod-deps --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /repo/services/notification-worker/dist ./dist

USER 10001
ENV NODE_ENV=production
EXPOSE 3011
CMD ["node", "dist/index.js"]
