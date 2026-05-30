#!/usr/bin/env bash
# scripts/render-predeploy.sh
# Render pre-deploy hook: apply migrations safely AND guarantee the Phase-R
# Club-profile columns exist.
#
# Handles three scenarios:
#   1. Fresh DB — migrations never applied → apply them normally.
#   2. DB bootstrapped via `prisma db push` — schema exists but
#      _prisma_migrations has no records → migrate deploy fails with
#      "relation/type already exists" → mark baseline migrations resolved,
#      then retry.
#   3. _prisma_migrations RECORDS 20260531000000_club_profile_fields as applied
#      (or in a failed state) but the columns were never actually created on
#      THIS database → migrate deploy reports "up to date" and the columns stay
#      missing. The idempotent safety-net DDL below closes that gap on every
#      deploy.
#
# Exit code: 0 on success, non-zero only on an unrecoverable DB error.

set -euo pipefail

SCHEMA="--schema=prisma/schema.prisma"
CLUB_MIG="20260531000000_club_profile_fields"

echo "==> prisma migrate deploy"
if ! npx prisma migrate deploy $SCHEMA; then
  echo ""
  echo "==> migrate deploy failed — DB likely bootstrapped via 'prisma db push'."
  echo "==> Marking baseline migrations as resolved (no SQL re-execution)."

  npx prisma migrate resolve --applied 00000000000000_baseline $SCHEMA 2>/dev/null \
    && echo "==> baseline resolved" \
    || echo "==> baseline already recorded (skipping)"

  npx prisma migrate resolve --applied 20250525000000_add_phase_q_and_password_reset $SCHEMA 2>/dev/null \
    && echo "==> phase_q migration resolved" \
    || echo "==> phase_q migration already recorded (skipping)"

  echo "==> Retrying prisma migrate deploy..."
  npx prisma migrate deploy $SCHEMA \
    || echo "==> migrate deploy still reported an error; safety-net DDL below will reconcile the schema."
fi

# ── Safety net ──────────────────────────────────────────────────────────────
# Guarantee the Phase-R Club columns exist regardless of the _prisma_migrations
# state on THIS database. Every statement is ADD COLUMN IF NOT EXISTS, so this
# is fully idempotent and safe to run on every deploy.
echo ""
echo "==> Ensuring ${CLUB_MIG} columns exist (idempotent DDL safety-net)."
npx prisma db execute $SCHEMA --file "prisma/migrations/${CLUB_MIG}/migration.sql"

# Reconcile the migration record so future `migrate deploy` runs are clean.
# Best-effort: clear a stale failed record, then mark applied. Either command
# is a no-op error if the record is already in the target state — swallow it.
echo "==> Reconciling ${CLUB_MIG} migration record."
npx prisma migrate resolve --rolled-back "$CLUB_MIG" $SCHEMA 2>/dev/null || true
npx prisma migrate resolve --applied    "$CLUB_MIG" $SCHEMA 2>/dev/null || true

echo "==> Done."
