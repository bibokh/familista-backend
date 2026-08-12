#!/usr/bin/env bash
# scripts/render-start.sh
# Render start hook — the free-plan replacement for preDeployCommand.
#
# Pre-Deploy Command is a paid-instance feature, so on the free plan there is no
# hook between "build finished" and "server starts". Migrations therefore have to
# run as the first thing the start command does. That is the whole of this
# script: run the migration/recovery logic that already exists, prove the schema
# the running code needs is actually there, and only then hand over to the
# server.
#
# The order matters. A server that starts against a schema its Prisma client
# does not match does not fail loudly — it answers 500 to every query that
# touches the missing column, and the app quietly falls back to browser-local
# data. Refusing to start is the safer failure: Render keeps the previous
# instance serving and the deploy is marked failed, which is visible.
#
# This script only ever migrates forward. It never resets, never drops, never
# seeds, never rewrites history — all of that lives in scripts it does not call.
# Running it twice against the same database is a no-op the second time.

set -euo pipefail

echo "════════════════════════════════════════════════════════════"
echo "  Familista — startup migration gate"
echo "════════════════════════════════════════════════════════════"

# ── 1 · migrations ───────────────────────────────────────────────────────────
# The existing, already-tested recovery script: `migrate deploy`, and if the
# historical chain trips (the known VideoAsset.durationSec break), mark the
# baseline migrations resolved and retry. Nothing here is new behaviour.
if bash scripts/render-predeploy.sh; then
  echo "✅ migrations: up to date"
else
  echo ""
  echo "❌ migrations FAILED — refusing to start the API."
  echo "   The database schema does not match the code being deployed."
  echo "   Nothing was reset, dropped or seeded; the previous instance keeps"
  echo "   serving. Fix the migration and redeploy."
  exit 1
fi

# ── 2 · schema gate ──────────────────────────────────────────────────────────
# Migrations reporting success is not the same as the schema being right: a
# database bootstrapped by `db push` can carry migrations marked resolved whose
# SQL never ran. So check for the objects this build actually queries.
echo ""
echo "── verifying required schema ──"
node <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const [col] = await prisma.$queryRaw`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'Player' and column_name = 'form'`;
  const [tbl] = await prisma.$queryRaw`
    select tablename from pg_tables
     where schemaname = 'public' and tablename = 'ClubTransferBalance'`;
  const migs = await prisma.$queryRaw`
    select migration_name from _prisma_migrations
     where finished_at is not null
       and migration_name in ('20260812000000_add_club_transfer_balance',
                              '20260812010000_add_player_form')`;
  const recorded = new Set(migs.map((m) => m.migration_name));

  const line = (ok, label) => console.log(`   ${ok ? '✅' : '❌'} ${label}`);
  line(!!col, 'Player.form column');
  line(!!tbl, 'ClubTransferBalance table');
  // The ledger is bookkeeping, not schema. A database bootstrapped with
  // `db push` legitimately has the objects without the rows, so a missing
  // entry is worth saying out loud but is not a reason to refuse to start.
  for (const name of ['20260812000000_add_club_transfer_balance',
                      '20260812010000_add_player_form']) {
    console.log(`   ${recorded.has(name) ? '✅' : 'ℹ️ '} migration ${name}` +
                (recorded.has(name) ? ' recorded' : ' not in ledger (schema check governs)'));
  }

  // Only the structural facts gate the boot — they are what the running code
  // dereferences on every roster read.
  if (!col || !tbl) {
    console.error('\n❌ schema gate FAILED — the API will not start against an ' +
                  'incompatible schema.');
    console.error('   Missing: ' + [!col && 'Player.form', !tbl && 'ClubTransferBalance']
      .filter(Boolean).join(', '));
    process.exit(1);
  }
  console.log('✅ schema: compatible');
})()
  .catch((e) => { console.error('❌ schema check errored:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
NODE

# ── 3 · the server ───────────────────────────────────────────────────────────
echo ""
echo "── starting API ──"
exec node dist/server.js
