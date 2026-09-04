#!/usr/bin/env bash
# scripts/render-predeploy.sh
# Render pre-deploy hook: apply Prisma migrations — the single, clean mechanism.
#
#   - Normal case: `prisma migrate deploy` applies every pending migration
#     (including 20260531000000_club_profile_fields) and records it. It runs
#     through scripts/db-migrate.js, which waits for the database to answer
#     before starting and retries a connection-level failure — the production
#     database is a Neon compute that suspends when idle and takes longer to
#     wake than Prisma's default five-second connect timeout allows, which is
#     the P1002 the deploy log showed. A genuine migration error is NOT
#     retried: it is handed straight back to the recovery path below.
#   - DB bootstrapped via `prisma db push` (schema already exists but
#     _prisma_migrations is empty): the first deploy fails with
#     "relation/type already exists" → mark the baseline migrations resolved
#     (no SQL re-run), then retry. Subsequent deploys are a clean no-op.
#
# Exit code: 0 on success, non-zero only on an unrecoverable migration error.

set -euo pipefail

SCHEMA="--schema=prisma/schema.prisma"

echo "==> prisma migrate deploy (with wake-up wait and connection retry)"
if node scripts/db-migrate.js; then
  echo "==> Migrations up to date."
  exit 0
fi

echo ""
echo "==> migrate deploy failed — resolving baseline migrations (db push bootstrap)."
npx prisma migrate resolve --applied 00000000000000_baseline $SCHEMA 2>/dev/null \
  && echo "==> baseline resolved" || echo "==> baseline already recorded (skipping)"
npx prisma migrate resolve --applied 20250525000000_add_phase_q_and_password_reset $SCHEMA 2>/dev/null \
  && echo "==> phase_q resolved" || echo "==> phase_q already recorded (skipping)"
# Player-UUID remap and ScoutProspect: may already exist in the DB from a
# prior db push.  Marking resolved lets the retry skip to 20260612 which
# uses CREATE TABLE IF NOT EXISTS and is always safe to run.
npx prisma migrate resolve --applied 20260603000000_player_uuid_id_migration $SCHEMA 2>/dev/null \
  && echo "==> player_uuid_id resolved" || echo "==> player_uuid_id already recorded (skipping)"
npx prisma migrate resolve --applied 20260611000000_add_scout_prospect $SCHEMA 2>/dev/null \
  && echo "==> add_scout_prospect resolved" || echo "==> add_scout_prospect already recorded (skipping)"

echo "==> Retrying prisma migrate deploy..."
node scripts/db-migrate.js
echo "==> Done."
