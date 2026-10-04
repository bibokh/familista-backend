#!/usr/bin/env node
/*
 * Familista — READ-ONLY audit of seeded/demo login accounts (no pgcrypto needed)
 * ─────────────────────────────────────────────────────────────────────────────
 * Run from a checkout of familista-backend (it uses that repository's own
 * @prisma/client and bcryptjs), with the connection string in the environment:
 *
 *   cd familista-backend   # repository root, after `npm ci` and `npx prisma generate`
 *   DATABASE_URL='<production owner connection string>' node /path/to/seed-credential-audit.js
 *
 * What it does
 *   1. Opens ONE transaction and makes it READ ONLY before any query; it aborts
 *      unless PostgreSQL itself reports transaction_read_only = on.
 *   2. Reads only the seeded/demo accounts that can sign in, and only the
 *      fields needed. Emails are used solely as WHERE-clause inputs; they are
 *      never selected.
 *   3. Compares each account's bcrypt hash with the two passwords the
 *      repository publishes (prisma/seed.ts, README.md) using bcryptjs, in
 *      memory. Each hash is reduced to true/false and discarded.
 *   4. Always ends with ROLLBACK, even on success.
 *
 * It never prints or logs a password, a password hash, an email, a token, an
 * MFA secret or an IP address — not even in an error: errors are reported by
 * code only. It creates nothing, installs nothing and writes nothing.
 */
'use strict';

// Loaded from the repository you run this in (its own versions), not from
// wherever this file sits.
const fromRepo = (m) => require(require.resolve(m, { paths: [process.cwd()] }));
let PrismaClient, bcrypt;
try {
  ({ PrismaClient } = fromRepo('@prisma/client'));
  bcrypt = fromRepo('bcryptjs');
} catch {
  console.error('Run this from the root of a familista-backend checkout after `npm ci` and `npx prisma generate`.');
  process.exit(2);
}

// The only passwords the repository has ever hardcoded (git history checked).
// Already public; used here only as comparison inputs, never printed.
const PUBLISHED = [
  { label: 'prisma/seed admin', password: 'Familista2024!' },
  { label: 'prisma/seed coach', password: 'Coach2024!' },
];
// prisma/seed.ts accounts; plus every @fcfamilista.local account
// (src/launch/seed-fc-familista — passwords from env vars, never published,
// included so the inventory is complete); plus the Tier A candidate.
const PRISMA_SEED_EMAILS = ['khatab@familista.io', 'admin@familista.io', 'coach@familista.io'];
const CANDIDATE_ID = 'f73ed2ce-19d4-421e-bb11-42fc9c773729';

class RollbackOnPurpose extends Error {}

function safeError(err) {
  // Never echo a message: Prisma messages can carry query text or hosts.
  const code = err && (err.code || err.name) ? String(err.code || err.name) : 'UNKNOWN';
  return `audit failed (${code}); nothing was written — the transaction is read-only and rolled back`;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Set DATABASE_URL in the environment (it is never printed).');
    process.exit(2);
  }
  const prisma = new PrismaClient({ log: [] });
  let rows = null;

  try {
    await prisma.$transaction(async (tx) => {
      // Must be the first statement of the transaction.
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const ro = await tx.$queryRawUnsafe('SHOW transaction_read_only');
      if (!Array.isArray(ro) || !ro[0] || ro[0].transaction_read_only !== 'on') {
        throw new Error('READ_ONLY_NOT_CONFIRMED');
      }
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '120s'");
      // A cross-club read by design, named as backups are.
      await tx.$executeRawUnsafe("SET LOCAL familista.rls_mode = 'system'");

      rows = await tx.$queryRaw`
        SELECT
          u.id                                       AS user_id,
          CASE
            WHEN lower(u.email) = ANY(${PRISMA_SEED_EMAILS}::text[]) THEN 'prisma/seed.ts'
            WHEN lower(u.email) LIKE '%@fcfamilista.local'           THEN 'seed-fc-familista'
            ELSE 'audit candidate'
          END                                        AS seed_source,
          u.role::text                               AS role,
          u."clubId"                                 AS club_id,
          u."isActive"                               AS is_active,
          u."lastLoginAt"                            AS last_login_at,
          u."passwordHash"                           AS h,
          EXISTS (SELECT 1 FROM "Membership" m WHERE m."userId" = u.id AND m."isActive")                    AS has_active_membership,
          (SELECT count(*) FROM "RefreshToken" r WHERE r."userId" = u.id)::int                              AS refresh_rows,
          (SELECT count(*) FROM "RefreshToken" r WHERE r."userId" = u.id AND r."expiresAt" > now())::int    AS live_refresh_rows,
          (SELECT count(*) FROM "SecurityEvent" s WHERE s."actorId" = u.id AND s.kind = 'LOGIN_SUCCESS')::int AS login_success_events,
          (SELECT count(*) FROM "LoginAttempt" la
             WHERE la."emailHash" = encode(sha256(convert_to(lower(trim(u.email)), 'UTF8')), 'hex')
               AND la.success)::int                                                                          AS login_success_attempts,
          EXISTS (SELECT 1 FROM "PlatformAdmin" pa WHERE pa."userId" = u.id AND pa."isActive")              AS is_active_platform_admin,
          (SELECT count(*) FROM "Membership" m
             WHERE m."userId" = u.id AND m.role = 'CLUB_OWNER' AND m."isActive"
               AND NOT EXISTS (SELECT 1 FROM "Membership" o JOIN "User" ou ON ou.id = o."userId"
                               WHERE o."clubId" = m."clubId" AND o.role = 'CLUB_OWNER' AND o."isActive"
                                 AND ou."isActive" AND o."userId" <> u.id))::int                            AS sole_active_president_of_clubs
        FROM "User" u
        WHERE u."passwordHash" ~ '^\\$2[aby]\\$'
          AND (lower(u.email) = ANY(${PRISMA_SEED_EMAILS}::text[])
               OR lower(u.email) LIKE '%@fcfamilista.local'
               OR u.id = ${CANDIDATE_ID})
        ORDER BY 2, u."createdAt"`;

      // Roll back on purpose: nothing here was ever meant to persist.
      throw new RollbackOnPurpose();
    }, { maxWait: 20_000, timeout: 180_000 });
  } catch (err) {
    if (!(err instanceof RollbackOnPurpose)) {
      console.error(safeError(err));
      await prisma.$disconnect().catch(() => {});
      process.exit(1);
    }
  }
  await prisma.$disconnect();

  // In-memory bcrypt comparison; each hash becomes a boolean and is dropped.
  const report = [];
  for (const r of rows) {
    let matched = null;
    for (const p of PUBLISHED) {
      // bcryptjs accepts $2a$/$2b$/$2y$ hashes.
      if (await bcrypt.compare(p.password, r.h)) { matched = p.label; break; }
    }
    r.h = undefined;
    report.push({
      user_id: r.user_id,
      seed_source: r.seed_source,
      role: r.role,
      club_id: r.club_id,
      is_active: r.is_active ? 'yes' : 'no',
      active_membership: r.has_active_membership ? 'yes' : 'no',
      uses_published_seed_credential: matched ? 'yes' : 'no',
      matched_credential: matched ?? '',
      refresh_tokens: r.refresh_rows,
      live_refresh_tokens: r.live_refresh_rows,
      login_evidence: r.login_success_events + r.login_success_attempts,
      last_login_at: r.last_login_at ? new Date(r.last_login_at).toISOString() : '',
      active_platform_admin: r.is_active_platform_admin ? 'yes' : 'no',
      sole_active_president_of_clubs: r.sole_active_president_of_clubs,
    });
  }

  const hasLoginEvidence = (x) => x.login_evidence > 0 || x.last_login_at !== '';
  const totals = {
    total_seed_login_accounts: report.length,
    active_seed_accounts: report.filter((x) => x.is_active === 'yes').length,
    active_still_using_published_credentials: report.filter((x) => x.is_active === 'yes' && x.uses_published_seed_credential === 'yes').length,
    accounts_with_live_sessions: report.filter((x) => x.live_refresh_tokens > 0).length,
    accounts_with_login_evidence: report.filter(hasLoginEvidence).length,
  };

  console.log('== Aggregate counts ==');
  console.table([totals]);
  console.log('== Per account (no email, name, password, hash, token, MFA secret or IP) ==');
  if (report.length) console.table(report); else console.log('(no seeded/demo login accounts found)');
  console.log('Read-only transaction confirmed and rolled back. Nothing was written.');
}

main().catch((err) => { console.error(safeError(err)); process.exit(1); });
