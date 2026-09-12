# syntax=docker/dockerfile:1.7
#
# Rode — single runtime image containing the API server, the alarm engine,
# the ingest module and the built web app. Multi-arch (amd64 + arm64).
#
# Build:   docker buildx build -f docker/server.Dockerfile -t rode .
# Digests: the base image tag is pinned by digest in phase 10 (docs/decisions.md).

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.28.1

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} --no-fund --no-audit
WORKDIR /app

# ---------------------------------------------------------------- deps
# Only manifests are copied here so the dependency layer is cached until a
# package.json or the lockfile actually changes.
FROM base AS deps
RUN apk add --no-cache python3 make g++
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/ingest/package.json apps/ingest/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/protocol/package.json packages/protocol/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN pnpm build \
 && pnpm --filter @rode/server --prod deploy --legacy /out

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ARG RODE_VERSION=dev
ENV NODE_ENV=production \
    RODE_VERSION=${RODE_VERSION} \
    RODE_DATA_DIR=/data \
    RODE_HOST=0.0.0.0 \
    RODE_PORT=8080 \
    RODE_WEB_DIR=/app/web
WORKDIR /app

COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./web

# The database volume mounts here; pre-create it owned by the runtime user so a
# fresh named volume inherits writable permissions.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

# readyz (not healthz) so a wedged alarm engine gets the container restarted.
# busybox wget: cheaper than spawning node every 30 s on a Pi.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/readyz >/dev/null || exit 1

CMD ["node", "dist/index.js"]
