# Familista — Phase O production Dockerfile
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage build:
#   1. deps    → install full dependencies (incl. devDeps for tsc)
#   2. build   → run prisma generate + tsc → dist/
#   3. runtime → slim node-alpine, prod-only deps, non-root user
#
# Pin to node:20.x because Prisma 5.x requires Node 18+; 20 LTS is current.
# This image is intended for parity with Render's runtime, but is portable to
# any container host (Fly.io, AWS ECS, GCP Cloud Run, K8s, etc.).

FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build, then prune devDeps, then generate the Prisma Client LAST.
# Ordering matters: `npm prune` (and npm install/ci) reset node_modules/.prisma/
# client to the package default, WIPING any client generated earlier — which is
# why the runtime client was missing the Phase-R Club fields ("Unknown field
# description"). `npm run build` runs its own `prisma generate` so tsc has the
# types; the FINAL generate (after prune) is what persists into the image.
# `prisma` is a runtime dependency, so it survives `npm prune --omit=dev`.
RUN npm run build \
 && npm prune --omit=dev \
 && npx prisma generate --schema=prisma/schema.prisma

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=10000 \
    NPM_CONFIG_LOGLEVEL=warn
# Install runtime system deps:
#   openssl     — Prisma binary engine
#   ca-certs    — HTTPS to S3 / external services
#   curl        — health-check probe
#   tini        — PID 1 signal handling
#   ffmpeg      — Phase S.1 video transcoding (libx264, aac, HLS muxer)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl tini ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -r app && useradd -r -g app -m -d /home/app app \
 && mkdir -p /var/data/uploads /var/data/video-tmp \
 && chown -R app:app /var/data
COPY --from=build --chown=app:app /app/dist          ./dist
COPY --from=build --chown=app:app /app/node_modules  ./node_modules
COPY --from=build --chown=app:app /app/prisma        ./prisma
COPY --from=build --chown=app:app /app/schema.prisma ./schema.prisma
COPY --from=build --chown=app:app /app/package.json  ./package.json
COPY --from=build --chown=app:app /app/scripts       ./scripts
USER app
EXPOSE 10000
# Tini reaps zombie processes and forwards signals cleanly.
ENTRYPOINT ["/usr/bin/tini","--"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/health" || exit 1
# Regenerate the Prisma Client from the in-image schema BEFORE starting, so the
# runtime client can never be stale relative to prisma/schema.prisma (npm run
# start = `prisma generate --schema=prisma/schema.prisma && node dist/server.js`).
# `prisma` is a runtime dependency (survives `npm prune --omit=dev`).
CMD ["npm","run","start"]
