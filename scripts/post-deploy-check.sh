#!/usr/bin/env bash
# Familista — Post-deploy assertion gate.
# Goes deeper than verify-live.sh: confirms the bootstrap actually populated
# the engines with expected row counts. A 2xx with empty body is NOT good enough.
#
# Run AFTER ./scripts/bootstrap.sh completes.
#
# Usage:
#   BASE_URL="https://familista-backend.onrender.com" \
#   JWT="<platform-owner-JWT>" \
#   ./scripts/post-deploy-check.sh

set -uo pipefail

BASE_URL="${BASE_URL:?Set BASE_URL=https://your-service.onrender.com}"
JWT="${JWT:?Set JWT=<platform-owner-JWT>}"

API="${BASE_URL%/}/api/v1"
AUTH=(-H "Authorization: Bearer ${JWT}")
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

PASS=0
FAIL=0

# assert_count_at_least <label> <path> <jsonpath-style-key> <minimum>
# Uses a tiny inline node script for JSON traversal so we don't require jq.
assert_count_at_least() {
  local label="$1"; shift
  local path="$1"; shift
  local key="$1"; shift
  local min="$1"; shift

  printf "  %-58s " "${label}"

  local code
  code="$(curl -sS -o "${TMP}" -w '%{http_code}' -X GET "${API}${path}" "${AUTH[@]}" 2>/dev/null || echo 000)"
  if [[ ! "${code}" =~ ^2 ]]; then
    echo "✗ HTTP ${code}"
    FAIL=$((FAIL + 1))
    return
  fi

  local actual
  actual="$(node -e "
    const fs = require('fs');
    const body = JSON.parse(fs.readFileSync('${TMP}', 'utf8'));
    const key = '${key}';
    let v = body;
    for (const part of key.split('.')) v = v?.[part];
    if (Array.isArray(v)) console.log(v.length);
    else if (typeof v === 'number') console.log(v);
    else console.log(0);
  " 2>/dev/null || echo 0)"

  if [[ "${actual}" -ge "${min}" ]]; then
    echo "✓ ${actual} >= ${min}"
    PASS=$((PASS + 1))
  else
    echo "✗ ${actual} < ${min} (bootstrap did not populate)"
    FAIL=$((FAIL + 1))
  fi
}

assert_2xx() {
  local label="$1"; shift
  local method="$1"; shift
  local path="$1"; shift
  local public="${1:-no}"
  local args=(-sS -o /dev/null -w '%{http_code}' -X "${method}" "${API}${path}")
  if [[ "${public}" != "public" ]]; then
    args+=("${AUTH[@]}")
  fi
  printf "  %-58s " "${label}"
  local code
  code="$(curl "${args[@]}" 2>/dev/null || echo 000)"
  if [[ "${code}" =~ ^2 ]]; then
    echo "✓ ${code}"
    PASS=$((PASS + 1))
  else
    echo "✗ ${code}"
    FAIL=$((FAIL + 1))
  fi
}

echo "Checking ${API}"
echo ""

echo "── Liveness ──"
assert_2xx  "GET  /health"                                "GET" "/health" "public"

echo ""
echo "── Bootstrap completeness (row counts) ──"
assert_count_at_least "palettes seeded (>= 10)"           "/admin/whitelabel/palettes"           "items"        10
assert_count_at_least "feature flags seeded (>= 7)"       "/admin/feature-flags"                 "items"        7
assert_count_at_least "territories seeded (>= 30)"        "/franchise/territories?limit=100"     "items"        30
assert_count_at_least "AI models seeded (>= 32)"          "/ai/models?activeOnly=true"           "items"        32
assert_count_at_least "investor entities present (>= 1)"  "/investor/entities"                   "items"        1

echo ""
echo "── Idempotency probe (re-run a bootstrap endpoint, must stay 2xx) ──"
assert_2xx  "POST /admin/whitelabel/palettes/seed-presets (re-run)" "POST" "/admin/whitelabel/palettes/seed-presets"
assert_2xx  "POST /admin/feature-flags/seed (re-run)"               "POST" "/admin/feature-flags/seed"
assert_2xx  "POST /franchise/seed/territories (re-run)"             "POST" "/franchise/seed/territories"
assert_2xx  "POST /ai/bootstrap/seed-models (re-run)"               "POST" "/ai/bootstrap/seed-models"

echo ""
echo "── Executive OS cross-engine wiring ──"
assert_2xx  "GET  /executive/dashboard"                              "GET"  "/executive/dashboard"
assert_2xx  "GET  /executive/actions"                                "GET"  "/executive/actions"

echo ""
echo "──────────────────────────────────────────────────────"
printf "  %d passed, %d failed\n" "${PASS}" "${FAIL}"
echo "──────────────────────────────────────────────────────"

if [[ "${FAIL}" -gt 0 ]]; then
  echo ""
  echo "Post-deploy check FAILED. Check Render logs for the failing endpoint."
  exit 1
fi

echo ""
echo "Post-deploy assertions OK. Platform is live and populated."
