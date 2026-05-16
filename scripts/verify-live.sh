#!/usr/bin/env bash
# Familista — Live endpoint verification
# Hits one critical read endpoint per engine plus the health check.
# Non-2xx responses are failures — open Render logs at the same timestamp.
#
# Usage:
#   BASE_URL="https://familista-backend.onrender.com" \
#   JWT="<platform-owner-JWT>" \
#   ./scripts/verify-live.sh

set -uo pipefail

BASE_URL="${BASE_URL:?Set BASE_URL=https://your-service.onrender.com}"
JWT="${JWT:?Set JWT=<platform-owner-JWT>}"

API="${BASE_URL%/}/api/v1"
AUTH=(-H "Authorization: Bearer ${JWT}")
PASS=0
FAIL=0

check() {
  local label="$1"; shift
  local method="$1"; shift
  local path="$1"; shift
  local public="${1:-no}"
  local args=(-sS -o /dev/null -w "%{http_code}" -X "${method}" "${API}${path}")
  if [[ "${public}" != "public" ]]; then
    args+=("${AUTH[@]}")
  fi
  local code
  code="$(curl "${args[@]}" 2>/dev/null || echo 000)"
  printf "  %-62s " "${label}"
  if [[ "${code}" =~ ^2 ]]; then
    echo "✓ ${code}"
    PASS=$((PASS + 1))
  else
    echo "✗ ${code}"
    FAIL=$((FAIL + 1))
  fi
}

echo "Verifying ${API}"
echo ""

echo "── Health ──"
check "GET  /health" GET "/health" "public"

echo "── White-label (public theme resolver) ──"
check "GET  /whitelabel/public/resolve?host=familista.app" GET \
      "/whitelabel/public/resolve?host=familista.app" "public"

echo "── Admin console ──"
check "GET  /admin/whitelabel/palettes"        GET "/admin/whitelabel/palettes"
check "GET  /admin/feature-flags"              GET "/admin/feature-flags"

echo "── Franchise ──"
check "GET  /franchise/territories?limit=5"    GET "/franchise/territories?limit=5"
check "GET  /franchise/network/health"         GET "/franchise/network/health"

echo "── Investor ──"
check "GET  /investor/entities"                GET "/investor/entities"

echo "── AI Decision Engine ──"
check "GET  /ai/models?activeOnly=true"        GET "/ai/models?activeOnly=true"

echo "── Vision Intelligence ──"
check "GET  /vision/audit?limit=1"             GET "/vision/audit?limit=1"

echo "── Executive OS ──"
check "GET  /executive/dashboard"              GET "/executive/dashboard"
check "GET  /executive/actions"                GET "/executive/actions"

echo ""
echo "──────────────────────────────────"
printf "  Total: %d passed, %d failed\n" "${PASS}" "${FAIL}"
echo "──────────────────────────────────"
if [[ "${FAIL}" -gt 0 ]]; then
  exit 1
fi
