#!/usr/bin/env bash
# Familista — Phase O rollback to last green commit
# ─────────────────────────────────────────────────────────────────────────────
# Two-step rollback:
#   1. Code  → revert git to a known-good SHA + trigger Render deploy
#   2. Data  → not done here: a backup is restored into a fresh database and
#              verified first (docs/BACKUP_AND_RESTORE.md, Recovery)
#
# Required env:
#   ROLLBACK_TO_SHA           (git SHA of the last green commit)
#   RENDER_DEPLOY_HOOK_URL    (Render deploy hook URL)
#   PRE_DEPLOY_BACKUP_FILE    (refused — in-place restore is not supported)
#   CONFIRM=yes               (required)
#
# Usage:
#   ROLLBACK_TO_SHA=abc1234 RENDER_DEPLOY_HOOK_URL=https://api.render.com/... \
#     CONFIRM=yes ./scripts/rollback.sh

set -euo pipefail

: "${ROLLBACK_TO_SHA:?ROLLBACK_TO_SHA required}"
: "${RENDER_DEPLOY_HOOK_URL:?RENDER_DEPLOY_HOOK_URL required}"

if [ "${CONFIRM:-}" != "yes" ]; then
  echo "✘ CONFIRM=yes not set. Rollback aborts."
  exit 2
fi

CUR_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo 'detached')"
if [ "${CUR_BRANCH}" != "main" ]; then
  echo "✘ Not on main (current: ${CUR_BRANCH}). Aborting."
  exit 2
fi

echo "▶ Verifying SHA exists: ${ROLLBACK_TO_SHA}"
git cat-file -e "${ROLLBACK_TO_SHA}^{commit}"

if [ -n "${PRE_DEPLOY_BACKUP_FILE:-}" ]; then
  # Restoring over the live database is not supported: a backup is restored
  # into a fresh database first and verified, then the service is repointed.
  echo "✘ In-place database restore is not supported. Follow docs/BACKUP_AND_RESTORE.md (Recovery)."
  exit 2
fi

REVERT_MSG="rollback: revert main to ${ROLLBACK_TO_SHA} at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "▶ Creating revert commit on main"
git revert --no-edit "${ROLLBACK_TO_SHA}..HEAD" || {
  echo "Revert failed — falling back to reset (requires force-push)";
  echo "  Re-run manually: git reset --hard ${ROLLBACK_TO_SHA} && git push --force-with-lease";
  exit 3;
}
git push origin main

echo "▶ Triggering Render deploy"
curl -fsS -X POST "${RENDER_DEPLOY_HOOK_URL}" \
  -H 'content-type: application/json' \
  -d "{\"reason\":\"rollback-to-${ROLLBACK_TO_SHA}\"}"

echo "✔ Rollback initiated."
echo "  Watch deploy: Render dashboard → familista-backend → Events"
echo "  Verify endpoint: curl https://<your-render-url>/api/v1/health"
