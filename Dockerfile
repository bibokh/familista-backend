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
# `prisma generate` must run BEFORE `tsc` because the TS code imports types
# from `@prisma/client` that depend on the generated artefacts.
RUN npx prisma generate --schema=prisma/schema.prisma \
 && npm run build \
 && npm prune --omit=dev

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
CMD ["node","dist/server.js"]
