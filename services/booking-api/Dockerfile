# Byggs från repo-roten: docker build -f services/booking-api/Dockerfile .
# Monorepo-paket (@tickets/*) buntas in av tsup (se tsup.config.ts); riktiga
# npm-paket (fastify, pino, prom-client) hålls externa och hämtas in här via
# "pnpm deploy --prod", som ger en självförsörjande node_modules utan att
# dra med devDependencies eller andra tjänsters beroenden.

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

# --- source: full källkod för booking-api och dess workspace-beroenden ---
FROM deps AS source
COPY tsconfig.base.json ./
COPY shared/domain/ shared/domain/
COPY shared/observability/ shared/observability/
COPY services/booking-api/ services/booking-api/

# --- build: bunta booking-api med tsup ---
FROM source AS build
RUN pnpm --filter @tickets/booking-api build

# --- prod-deps: booking-apis egna produktionsberoenden, baserat på
# "source" (inte "deps") så @tickets/domain och @tickets/observability
# har sin fulla källkod när pnpm deploy kopierar workspace-paketen ---
FROM source AS prod-deps
RUN pnpm --filter @tickets/booking-api deploy --prod /app

# --- runtime: minimal, icke-root ---
FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=prod-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=prod-deps --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /repo/services/booking-api/dist ./dist

USER app
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/index.js"]
