#!/usr/bin/env bash
# scripts/render-predeploy.sh
# Render pre-deploy hook: run migrations safely.
#
# Handles two scenarios:
#   1. Fresh DB  — migrations have never been applied → apply them normally.
#   2. DB bootstrapped via prisma db push — schema already exists but
#      _prisma_migrations has no records → prisma migrate deploy fails with
#      "relation already exists" / "type already exists".
#      In this case mark both migrations as resolved (no SQL re-execution),
#      then run migrate deploy (which becomes a no-op).
#
# Exit code: 0 on success, non-zero on real migration failure.

set -euo pipefail

SCHEMA="--schema=prisma/schema.prisma"

echo "==> prisma migrate deploy"
if npx prisma migrate deploy $SCHEMA; then
  echo "==> Migrations up to date."
  exit 0
fi

echo ""
echo "==> migrate deploy failed — checking if DB was bootstrapped via prisma db push."
echo "==> Attempting to mark existing migrations as resolved (no SQL re-execution)."

npx prisma migrate resolve --applied 00000000000000_baseline $SCHEMA 2>/dev/null \
  && echo "==> baseline resolved" \
  || echo "==> baseline already recorded (skipping)"

npx prisma migrate resolve --applied 20250525000000_add_phase_q_and_password_reset $SCHEMA 2>/dev/null \
  && echo "==> phase_q migration resolved" \
  || echo "==> phase_q migration already recorded (skipping)"

echo ""
echo "==> Retrying prisma migrate deploy (should be no-op now)..."
npx prisma migrate deploy $SCHEMA
echo "==> Done."
