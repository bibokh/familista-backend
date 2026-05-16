#!/usr/bin/env bash
# Familista — Pre-push preflight gate.
# Run from the production repo root BEFORE `git push`.
# Exits non-zero on any failure — Render build minutes are not free.
#
# Usage:
#   ./scripts/preflight.sh
#
# Required tooling on PATH: node, npm, npx (prisma + tsc via npx).

set -uo pipefail

PASS=0
FAIL=0
WARN=0

step() {
  local label="$1"; shift
  local cmd="$*"
  printf "  %-58s " "${label}"
  local out
  if out="$(bash -c "${cmd}" 2>&1)"; then
    echo "✓"
    PASS=$((PASS + 1))
  else
    echo "✗"
    echo "${out}" | sed 's/^/      /'
    FAIL=$((FAIL + 1))
  fi
}

soft() {
  local label="$1"; shift
  local cmd="$*"
  printf "  %-58s " "${label}"
  if bash -c "${cmd}" >/dev/null 2>&1; then
    echo "✓"
    PASS=$((PASS + 1))
  else
    echo "⚠ (non-blocking)"
    WARN=$((WARN + 1))
  fi
}

echo "── Repo state ──"
step "git working tree clean (no staged changes pending)"          "git diff --quiet --cached"
soft "no unstaged changes (warn only)"                              "git diff --quiet"
step "current branch is not 'main' OR you've confirmed direct push" "[ \"$(git rev-parse --abbrev-ref HEAD)\" != 'main' ] || [ -n \"${ALLOW_MAIN_PUSH:-}\" ]"

echo ""
echo "── Required deploy artefacts ──"
step "render.yaml present"                                         "test -f render.yaml"
step ".env.production.example present"                             "test -f .env.production.example"
step "prisma/schema.prisma present"                                "test -f prisma/schema.prisma"
step "src/ tree present"                                           "test -d src"
step "scripts/bootstrap.sh executable"                             "test -x scripts/bootstrap.sh"
step "scripts/verify-live.sh executable"                           "test -x scripts/verify-live.sh"

echo ""
echo "── package.json contract ──"
step "package.json has build script"                               "node -e \"process.exit(require('./package.json').scripts?.build?0:1)\""
step "package.json has start script"                               "node -e \"process.exit(require('./package.json').scripts?.start?0:1)\""
step "prisma in dependencies or devDependencies"                   "node -e \"const p=require('./package.json');process.exit((p.dependencies?.['@prisma/client']||p.devDependencies?.['prisma'])?0:1)\""

echo ""
echo "── Prisma schema ──"
step "prisma format (no drift)"                                    "npx --yes prisma format --schema prisma/schema.prisma"
step "prisma validate"                                             "npx --yes prisma validate --schema prisma/schema.prisma"

echo ""
echo "── TypeScript ──"
step "tsc --noEmit (zero errors required)"                         "npx --yes tsc --noEmit"

echo ""
echo "── Migration safety ──"
soft "prisma/migrations/ exists (otherwise migrate dev first)"     "test -d prisma/migrations"
soft "no destructive DROP TABLE in latest migration"               "! ls -t prisma/migrations/*/migration.sql 2>/dev/null | head -1 | xargs -r grep -qi 'drop table'"
soft "no destructive DROP COLUMN in latest migration"              "! ls -t prisma/migrations/*/migration.sql 2>/dev/null | head -1 | xargs -r grep -qi 'drop column'"

echo ""
echo "── Stripe wiring sanity ──"
soft "fanOutPaymentToEngines referenced in src/"                   "grep -r --include='*.ts' -l 'fanOutPaymentToEngines' src/ >/dev/null"
soft "shouldRespectStripeForClub referenced in src/"               "grep -r --include='*.ts' -l 'shouldRespectStripeForClub' src/ >/dev/null"

echo ""
echo "── Frontend integration ──"
step "public/familista-api-client.js present"                      "test -f public/familista-api-client.js"
step "public/whitelabel-bootstrap.client.js present"               "test -f public/whitelabel-bootstrap.client.js"
soft "HTML references API client"                                  "grep -q 'familista-api-client.js' familista_v5.html 2>/dev/null"

echo ""
echo "──────────────────────────────────────────────────────"
printf "  %d passed, %d warnings, %d failed\n" "${PASS}" "${WARN}" "${FAIL}"
echo "──────────────────────────────────────────────────────"

if [[ "${FAIL}" -gt 0 ]]; then
  echo ""
  echo "Preflight FAILED — do not push."
  exit 1
fi

echo ""
echo "Preflight OK — safe to git push."
