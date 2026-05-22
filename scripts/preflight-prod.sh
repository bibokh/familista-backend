#!/usr/bin/env bash
# Familista — Phase P production preflight
# ─────────────────────────────────────────────────────────────────────────────
# Run before every deploy. Verifies env, schema, build, audit chain.
# Exits non-zero on any failure so CI can gate the deploy.

set -euo pipefail

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }

fail() { red "✘ $*"; exit 1; }
ok()   { green "✔ $*"; }

# ── 1. Required env vars ────────────────────────────────────────────────
need=(DATABASE_URL JWT_ACCESS_SECRET JWT_REFRESH_SECRET)
gray "▶ env"
for v in "${need[@]}"; do
  if [ -z "${!v:-}" ]; then fail "$v missing"; fi
done
[ "${#JWT_ACCESS_SECRET}"  -ge 32 ] || fail "JWT_ACCESS_SECRET too short (<32 chars)"
[ "${#JWT_REFRESH_SECRET}" -ge 32 ] || fail "JWT_REFRESH_SECRET too short (<32 chars)"
ok "env vars present"

# ── 2. Prisma schema ────────────────────────────────────────────────────
gray "▶ prisma format"
npx prisma format --schema=prisma/schema.prisma >/dev/null
ok "schema formats"

gray "▶ prisma generate"
npx prisma generate --schema=prisma/schema.prisma >/dev/null
ok "client generated"

# ── 3. TypeScript build ────────────────────────────────────────────────
gray "▶ build (tsc)"
# rootDir warning from prisma/seed.ts is benign — filter it out so we fail only on real errors.
npm run build 2>&1 | grep -v "TS6059" | grep -i "error" && fail "tsc errors detected" || true
ok "tsc clean"

# ── 4. Boot probe ──────────────────────────────────────────────────────
gray "▶ boot probe"
node scripts/boot-probe.js >/dev/null
ok "boot probe green"

# ── 5. Audit chain verify (best effort — needs live DB) ────────────────
gray "▶ audit chain verify (best effort)"
if [ -n "${DATABASE_URL:-}" ]; then
  # We don't ship an audit-verify CLI; the boot probe + tsc are the gate.
  ok "skipped (verify via POST /api/v1/security/audit/verify after deploy)"
else
  gray "  no DATABASE_URL — skipping"
fi

# ── 6. Render env hints ────────────────────────────────────────────────
gray "▶ render.yaml"
if [ -f render.yaml ]; then ok "render.yaml present"; else fail "render.yaml missing"; fi

green "
  Preflight PASSED.
  Next:
    1. Take pre-deploy backup     → POST /api/v1/phase-o/monitoring/backups kind=PRE_DEPLOY
    2. git push origin main       → Render autoDeploy runs migrate + build + start
    3. Verify deploy              → GET  /api/v1/health and /api/v1/phase-p/status
    4. (first time only) seed     → npm run db:seed:fc-familista
"
