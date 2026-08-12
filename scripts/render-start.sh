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

SCHEMA="--schema=prisma/schema.prisma"

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
  # ── reconciling a database that was bootstrapped by `db push` ──────────────
  # This database's schema was created directly from the Prisma models, so it
  # already contains objects that the migration history would otherwise create.
  # Replaying those migrations fails on the first CREATE, and the ledger has no
  # row saying they are done. The fix Prisma provides for exactly this is
  # baselining: mark such a migration applied instead of running it.
  #
  # The script above does that for four migrations it names by hand, which is
  # why it stops the moment a fifth one turns out to be already present. This
  # loop does the same thing without the guesswork, and only ever on proof: it
  # marks a migration applied when Postgres itself says the object already
  # exists. Any other failure — a table that is missing rather than present, a
  # constraint violation, anything ambiguous — stops the boot with the database
  # untouched, because that is a schema that genuinely does not match and is not
  # something a deploy script should paper over.
  echo ""
  echo "── migrate deploy stopped · reconciling an existing schema ──"

  # Postgres codes that mean "this object is already here", and nothing else:
  # duplicate object/type, column, table, schema, function.
  ALREADY_PRESENT="42710 42701 42P07 42P06 42723"
  reconciled=0
  ok=0

  for _attempt in $(seq 1 25); do
    if out="$(npx prisma migrate deploy $SCHEMA 2>&1)"; then
      ok=1
      break
    fi

    # Whichever way the run reports the problem — P3018 for a migration that
    # failed just now, P3009 for one a previous run left behind — Prisma records
    # the same thing in the ledger: an unfinished row whose `logs` hold the
    # Postgres error. Read the verdict from there rather than from the wording
    # of this particular error message.
    failures="$(node <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.$queryRaw`
    select migration_name, coalesce(logs, '') as logs from _prisma_migrations
     where finished_at is null and rolled_back_at is null
     order by started_at`;
  for (const r of rows) {
    const code = (r.logs.match(/Database error code:\s*(\S+)/) || [])[1] || '';
    const msg  = (r.logs.match(/^ERROR:\s*(.+)$/m) || [])[1] || '';
    console.log([r.migration_name, code, msg].join('\t'));
  }
})().catch(() => process.exit(3)).finally(() => prisma.$disconnect());
NODE
)" || failures=""

    if [ -z "$failures" ]; then
      echo "❌ migration failed, and the ledger records no failed migration to"
      echo "   reconcile — this is not the 'schema already exists' case:"
      echo "$out" | tail -25
      echo ""
      echo "   Database untouched. Refusing to start."
      exit 1
    fi

    while IFS=$'\t' read -r name code msg; do
      [ -n "$name" ] || continue
      if [ -z "$code" ] || [[ " $ALREADY_PRESENT " != *" $code "* ]]; then
        echo "❌ $name failed with ${code:-an unrecorded error}: ${msg:-see the deploy log}"
        echo "   That is not an 'already exists' error, so the schema genuinely"
        echo "   does not match this migration. Nothing was resolved, nothing was"
        echo "   changed. Refusing to start."
        exit 1
      fi
      echo "   ↻ $name — $msg"
      echo "     already present, marking applied (no SQL is run)"
      if ! npx prisma migrate resolve --applied "$name" $SCHEMA >/dev/null 2>&1; then
        echo "❌ could not mark $name applied. Refusing to start."
        exit 1
      fi
      reconciled=$((reconciled + 1))
    done <<<"$failures"
  done

  if [ "$ok" != "1" ]; then
    echo "❌ migrations still not settled after 25 attempts. Refusing to start."
    exit 1
  fi
  echo "✅ migrations: up to date (reconciled $reconciled pre-existing migration(s))"
fi

# ── 2 · schema gate ──────────────────────────────────────────────────────────
# A migration recorded in the ledger is not proof that its schema exists. This
# database has both of Phase 2's migrations marked applied while neither object
# is present — the rows were reconciled as "already there" when in fact they were
# not, and `migrate deploy` will now never revisit them because it sees nothing
# pending. Recorded-but-absent is a repair, not a success.
#
# So the schema is inspected physically, and if either object is genuinely
# missing it is created here from the exact SQL its own migration carries —
# nothing more. Both statements are IF NOT EXISTS, so an object that does exist
# is left exactly as it is; no table is dropped, no row is touched, no column is
# rewritten. Then the schema is inspected again, and only a physical pass lets
# the API start.
echo ""
echo "── verifying required schema ──"
node <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Resolved through the connection's own search_path rather than a hard-coded
// "public", so the check looks where Prisma actually writes.
const hasColumn = async () => {
  const rows = await prisma.$queryRaw`
    select 1 from information_schema.columns
     where table_schema = current_schema()
       and table_name = 'Player' and column_name = 'form'`;
  return rows.length > 0;
};
const hasTable = async () => {
  const rows = await prisma.$queryRaw`select to_regclass('"ClubTransferBalance"')::text as t`;
  return !!rows[0]?.t;
};

(async () => {
  let col = await hasColumn();
  let tbl = await hasTable();
  const line = (ok, label) => console.log(`   ${ok ? '✅' : '❌'} ${label}`);
  line(col, 'Player.form column');
  line(tbl, 'ClubTransferBalance table');

  const migs = await prisma.$queryRaw`
    select migration_name from _prisma_migrations
     where finished_at is not null
       and migration_name in ('20260812000000_add_club_transfer_balance',
                              '20260812010000_add_player_form')`;
  const recorded = new Set(migs.map((m) => m.migration_name));
  for (const name of ['20260812000000_add_club_transfer_balance',
                      '20260812010000_add_player_form']) {
    console.log(`   ${recorded.has(name) ? '✅' : 'ℹ️ '} migration ${name}` +
                (recorded.has(name) ? ' recorded' : ' not in ledger'));
  }

  if (!col || !tbl) {
    console.log('');
    console.log('── repairing missing objects (recorded as applied, physically absent) ──');

    if (!col) {
      // verbatim from 20260812010000_add_player_form
      console.log('   + Player.form');
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "form" INTEGER;');
    }
    if (!tbl) {
      // verbatim from 20260812000000_add_club_transfer_balance
      console.log('   + ClubTransferBalance (+ unique clubId, + clubId index)');
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "ClubTransferBalance" (
            "id"        TEXT NOT NULL,
            "clubId"    TEXT NOT NULL,
            "budgetEur" BIGINT NOT NULL DEFAULT 50000000,
            "earnedEur" BIGINT NOT NULL DEFAULT 0,
            "spentEur"  BIGINT NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "ClubTransferBalance_pkey" PRIMARY KEY ("id")
        );`);
      await prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "ClubTransferBalance_clubId_key" ON "ClubTransferBalance"("clubId");');
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "ClubTransferBalance_clubId_idx" ON "ClubTransferBalance"("clubId");');
    }

    // physical re-inspection — the repair proves itself or the boot stops
    col = await hasColumn();
    tbl = await hasTable();
    console.log('');
    console.log('── re-verifying ──');
    line(col, 'Player.form column');
    line(tbl, 'ClubTransferBalance table');
  }

  if (!col || !tbl) {
    console.error('\n❌ schema gate FAILED — the API will not start against an ' +
                  'incompatible schema.');
    console.error('   Still missing after repair: ' +
      [!col && 'Player.form', !tbl && 'ClubTransferBalance'].filter(Boolean).join(', '));
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
