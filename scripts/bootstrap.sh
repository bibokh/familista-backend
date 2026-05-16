#!/usr/bin/env bash
# Familista — Post-deploy bootstrap script
# Idempotent — re-running is safe.
#
# Usage:
#   BASE_URL="https://familista-backend.onrender.com" \
#   JWT="<platform-owner-JWT>" \
#   ./scripts/bootstrap.sh

set -euo pipefail

BASE_URL="${BASE_URL:?Set BASE_URL=https://your-service.onrender.com}"
JWT="${JWT:?Set JWT=<platform-owner-JWT>}"

API="${BASE_URL%/}/api/v1"
AUTH=(-H "Authorization: Bearer ${JWT}" -H "Content-Type: application/json")

call() {
  local label="$1"; shift
  local method="$1"; shift
  local path="$1"; shift
  local data="${1:-}"
  printf "  %-58s " "${label}"
  local args=(-sS -o /tmp/familista-bootstrap.json -w "%{http_code}" -X "${method}" "${API}${path}" "${AUTH[@]}")
  if [[ -n "${data}" ]]; then
    args+=(-d "${data}")
  fi
  local code
  code="$(curl "${args[@]}" || echo 000)"
  if [[ "${code}" =~ ^2 ]]; then
    echo "✓ ${code}"
  else
    echo "✗ ${code}"
    cat /tmp/familista-bootstrap.json 2>/dev/null || true
    echo ""
  fi
}

echo "Bootstrapping ${API}"
echo ""

echo "── 1. White-label palette presets ──"
call "POST /admin/whitelabel/palettes/seed-presets" POST "/admin/whitelabel/palettes/seed-presets"

echo "── 2. Feature flags ──"
call "POST /admin/feature-flags/seed"              POST "/admin/feature-flags/seed"

echo "── 3. Franchise territories ──"
call "POST /franchise/seed/territories"            POST "/franchise/seed/territories"

echo "── 4. AI default models (32 models) ──"
call "POST /ai/bootstrap/seed-models"              POST "/ai/bootstrap/seed-models"

echo "── 5. Platform investment entity ──"
call "POST /investor/bootstrap/platform-entity"    POST "/investor/bootstrap/platform-entity"

echo ""
echo "Bootstrap complete."
echo ""
echo "Next steps:"
echo "  1. Verify each engine: ./scripts/verify-live.sh"
echo "  2. Create initial executive assignments (CEO/CFO/Board) via:"
echo "     PUT ${API}/executive/assignments"
echo "  3. Trigger initial risk sweep:"
echo "     POST ${API}/executive/risks/sweep"
