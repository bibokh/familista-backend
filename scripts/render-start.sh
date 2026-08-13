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
# A migration recorded in the ledger is not proof that its schema exists, and the
# reconciliation above is exactly how the two come apart: it marks a migration
# applied the moment Postgres says one of its objects is already there. Most of
# these migrations are a single statement, so that is sound. Some are not —
# 20260712000000_squad_player_fields adds six columns to Player with plain
# ADD COLUMN, and Postgres aborts the whole file on the first one that already
# exists. Marking it applied then skips the other five for good, and every
# `player.findMany()` afterwards fails with P2022 on a column the client selects
# and the database does not have. That is a 500 on the first call hydration
# makes, and no redeploy can clear it because deploy sees nothing pending.
#
# So the columns the running code actually reads are checked one by one, and any
# that is genuinely absent is added here from the exact statement its own
# migration carries — nothing more, every one nullable or defaulted, IF NOT
# EXISTS so an existing column is left untouched. Nothing is dropped, no row is
# written, no column is rewritten. Then the schema is inspected again, and only
# a physical pass starts the API.
echo ""
echo "── verifying required schema ──"
node <<'NODE'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Every column added by a migration this reconciliation can mark applied without
// running, with the statement that creates it. Verbatim from the migrations,
// guarded so a column that exists is not touched.
const REQUIRED_COLUMNS = [
  // 20260712000000_squad_player_fields
  ['Player', 'legacyId',         'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "legacyId" TEXT'],
  ['Player', 'roles',            'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "roles" TEXT'],
  ['Player', 'morale',           'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "morale" TEXT'],
  ['Player', 'isCaptain',        'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "isCaptain" BOOLEAN NOT NULL DEFAULT false'],
  ['Player', 'isViceCaptain',    'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "isViceCaptain" BOOLEAN NOT NULL DEFAULT false'],
  ['Player', 'trainedPositions', 'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "trainedPositions" TEXT'],
  // 20260812010000_add_player_form
  ['Player', 'form',             'ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "form" INTEGER'],
];

// 20260812000000_add_club_transfer_balance
const CLUB_TRANSFER_BALANCE = [
  `CREATE TABLE IF NOT EXISTS "ClubTransferBalance" (
      "id"        TEXT NOT NULL,
      "clubId"    TEXT NOT NULL,
      "budgetEur" BIGINT NOT NULL DEFAULT 50000000,
      "earnedEur" BIGINT NOT NULL DEFAULT 0,
      "spentEur"  BIGINT NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL,
      CONSTRAINT "ClubTransferBalance_pkey" PRIMARY KEY ("id")
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "ClubTransferBalance_clubId_key" ON "ClubTransferBalance"("clubId")',
  'CREATE INDEX IF NOT EXISTS "ClubTransferBalance_clubId_idx" ON "ClubTransferBalance"("clubId")',
];

// Resolved through the connection's own search_path rather than a hard-coded
// "public", so the check looks where Prisma actually writes.
async function missingColumns() {
  const out = [];
  for (const [table, column, ddl] of REQUIRED_COLUMNS) {
    const rows = await prisma.$queryRaw`
      select 1 from information_schema.columns
       where table_schema = current_schema()
         and table_name = ${table} and column_name = ${column}`;
    if (rows.length === 0) out.push({ table, column, ddl });
  }
  return out;
}
const hasTable = async () => {
  const rows = await prisma.$queryRaw`select to_regclass('"ClubTransferBalance"')::text as t`;
  return !!rows[0]?.t;
};

(async () => {
  let missing = await missingColumns();
  let tbl = await hasTable();
  const line = (ok, label) => console.log(`   ${ok ? '✅' : '❌'} ${label}`);
  for (const [table, column] of REQUIRED_COLUMNS) {
    line(!missing.some((m) => m.table === table && m.column === column), `${table}.${column}`);
  }
  line(tbl, 'ClubTransferBalance table');

  if (missing.length || !tbl) {
    console.log('');
    console.log('── repairing (recorded as applied, physically absent) ──');
    for (const m of missing) {
      console.log(`   + ${m.table}.${m.column}`);
      await prisma.$executeRawUnsafe(m.ddl);
    }
    if (!tbl) {
      console.log('   + ClubTransferBalance (+ unique clubId, + clubId index)');
      for (const ddl of CLUB_TRANSFER_BALANCE) await prisma.$executeRawUnsafe(ddl);
    }

    missing = await missingColumns();
    tbl = await hasTable();
    console.log('');
    console.log('── re-verifying ──');
    for (const [table, column] of REQUIRED_COLUMNS) {
      line(!missing.some((m) => m.table === table && m.column === column), `${table}.${column}`);
    }
    line(tbl, 'ClubTransferBalance table');
  }

  if (missing.length || !tbl) {
    console.error('\n❌ schema gate FAILED — the API will not start against an ' +
                  'incompatible schema.');
    console.error('   Still missing after repair: ' +
      missing.map((m) => `${m.table}.${m.column}`).concat(!tbl ? ['ClubTransferBalance'] : []).join(', '));
    process.exit(1);
  }
  console.log('✅ schema: compatible');
})()
  .catch((e) => { console.error('❌ schema check errored:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
NODE

# ── 3 · the generated client ─────────────────────────────────────────────────
# The schema gate above proves the database has the columns. This proves the
# Prisma Client the server will import was generated from the same schema file.
#
# They can disagree. This repository carries an older stand-alone schema.prisma
# at its root, and any `prisma generate` that runs without --schema resolves to
# that one, producing a client whose Player has no legacyId. The insert then
# fails client-side — "Unknown argument `legacyId`" — before it ever reaches a
# database whose column is right there. The column exists, the migration ran,
# and bootstrap still answers 500.
#
# `prisma generate` copies the schema it used next to the client, so the client
# says where it came from. Compare the two — but compare what a client is
# actually generated FROM: the declarations. Comments are dropped before
# hashing, because generate reformats whitespace and, on a schema this size,
# writes its copy in chunks that can mangle a multi-byte character inside a
# comment divider. A corrupted box-drawing character in a comment is not a
# different schema, and must not stop this API from starting.
echo ""
echo "── prisma client ──"
GENERATED="node_modules/.prisma/client/schema.prisma"
norm() { grep -v '^[[:space:]]*//' "$1" | tr -s '[:space:]' ' ' | md5sum | cut -d' ' -f1; }

if [ -f "$GENERATED" ] && [ "$(norm "$GENERATED")" = "$(norm prisma/schema.prisma)" ]; then
  echo "✅ client: generated from prisma/schema.prisma"
else
  if [ -f "$GENERATED" ]; then
    echo "⚠  client was generated from a different schema — regenerating"
  else
    echo "⚠  no generated client found — generating"
  fi
  npx prisma generate $SCHEMA
  if [ -f "$GENERATED" ] && [ "$(norm "$GENERATED")" = "$(norm prisma/schema.prisma)" ]; then
    echo "✅ client: regenerated from prisma/schema.prisma"
  else
    echo "❌ client gate FAILED — the generated client does not match" \
         "prisma/schema.prisma. The API will not start against a client that" \
         "disagrees with its own schema."
    exit 1
  fi
fi

# ── 4 · the server ───────────────────────────────────────────────────────────
echo ""
echo "── starting API ──"
exec node dist/server.js
