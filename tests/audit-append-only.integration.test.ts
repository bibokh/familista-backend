/**
 * Cyber Defense, R9 — the audit evidence is append-only, proven on real PostgreSQL
 *
 * A freshly migrated database (every migration, including
 * 20261003100000_audit_append_only). The application's own role then tries to
 * rewrite, delete and truncate the evidence, and the database refuses — while
 * appending still works and the hash chain still verifies.
 *
 * Runs when AUDIT_DB_DATABASE_URL names a server the test may create and drop
 * a database on. CI sets AUDIT_DB_REQUIRED=1, so a missing URL fails there
 * rather than skipping:
 *
 *   AUDIT_DB_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx jest --runInBand tests/audit-append-only.integration.test.ts
 */

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

const ADMIN_URL = process.env.AUDIT_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.AUDIT_DB_REQUIRED === '1') {
  throw new Error('AUDIT_DB_REQUIRED=1 but AUDIT_DB_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

suite('audit evidence is append-only in the database itself', () => {
  const db = `fam_audit_${randomBytes(4).toString('hex')}`;
  const url = ADMIN_URL ? withDatabase(ADMIN_URL, db) : '';
  let admin: PrismaClient;
  let pg: PrismaClient;
  let chain: typeof import('../src/security/audit-chain.service');
  const CLUB = 'club-audit-it';
  const refused = /append-only|refused/;

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 180_000,
    });
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${migrate.status}): ${migrate.stderr}`);
    pg = new PrismaClient({ datasources: { db: { url } } });
    // The audit chain uses the application's client: point it at this database.
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    chain = require('../src/security/audit-chain.service');
    for (let i = 0; i < 3; i += 1) {
      await chain.appendAuditEvent({ actor: { userId: null, clubId: CLUB, ipAddress: null, userAgent: null }, action: `TEST_${i}`, payload: { i } });
    }
  }, 240_000);

  afterAll(async () => {
    await pg?.$disconnect();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await require('../src/config/database').prisma.$disconnect().catch(() => undefined);
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$disconnect();
  });

  it('appending still works and the hash chain verifies', async () => {
    const v = await chain.verifyAuditChain(CLUB);
    expect(v).toMatchObject({ ok: true, totalChecked: 3 });
  });

  it('the hash-chained trail cannot be updated, deleted or truncated', async () => {
    await expect(pg.$executeRawUnsafe(`UPDATE "SecurityAuditEvent" SET "action" = 'REWRITTEN'`)).rejects.toThrow(refused);
    await expect(pg.$executeRawUnsafe(`DELETE FROM "SecurityAuditEvent"`)).rejects.toThrow(refused);
    await expect(pg.$executeRawUnsafe(`TRUNCATE "SecurityAuditEvent"`)).rejects.toThrow(refused);
    await expect(pg.securityAuditEvent.deleteMany({})).rejects.toThrow(refused);
    expect(await pg.securityAuditEvent.count({ where: { clubId: CLUB } })).toBe(3);
    expect((await chain.verifyAuditChain(CLUB)).ok).toBe(true);
  });

  it('AIAudit and DeviceSecurityEvent are append-only too', async () => {
    await pg.aIAudit.create({ data: { action: 'X', category: 'DECISION' } });
    await pg.deviceSecurityEvent.create({ data: { kind: 'DEVICE_REJECTED' } });
    await expect(pg.aIAudit.updateMany({ data: { action: 'Y' } })).rejects.toThrow(refused);
    await expect(pg.aIAudit.deleteMany({})).rejects.toThrow(refused);
    await expect(pg.deviceSecurityEvent.updateMany({ data: { severity: 'INFO' } })).rejects.toThrow(refused);
    await expect(pg.deviceSecurityEvent.deleteMany({})).rejects.toThrow(refused);
  });

  it('a security event is never updated, and only one older than 90 days may be purged', async () => {
    const recent = await pg.securityEvent.create({ data: { kind: 'LOGIN_FAILED' } });
    const old = await pg.securityEvent.create({ data: { kind: 'LOGIN_FAILED', createdAt: new Date(Date.now() - 100 * 86_400_000) } });
    await expect(pg.securityEvent.update({ where: { id: recent.id }, data: { severity: 'CRITICAL' } })).rejects.toThrow(refused);
    await expect(pg.securityEvent.delete({ where: { id: recent.id } })).rejects.toThrow(refused);
    await expect(pg.securityEvent.delete({ where: { id: old.id } })).resolves.toMatchObject({ id: old.id });
    await expect(pg.$executeRawUnsafe(`TRUNCATE "SecurityEvent"`)).rejects.toThrow(refused);
  });

  it('an AI egress record is completed once, changing only its outcome, and never deleted', async () => {
    const r = await pg.aiEgressRecord.create({ data: { caller: 'it', purpose: 'agent', dataClasses: ['INTERNAL'], outcome: 'STARTED' } });
    await expect(pg.aiEgressRecord.update({ where: { id: r.id }, data: { outcome: 'OK', caller: 'someone-else' } })).rejects.toThrow(refused);
    await expect(pg.aiEgressRecord.update({ where: { id: r.id }, data: { outcome: 'OK', tokensIn: 10, tokensOut: 5, durationMs: 3 } })).resolves.toMatchObject({ outcome: 'OK' });
    await expect(pg.aiEgressRecord.update({ where: { id: r.id }, data: { outcome: 'FAILED' } })).rejects.toThrow(refused);
    await expect(pg.aiEgressRecord.delete({ where: { id: r.id } })).rejects.toThrow(refused);
  });

  it('logs that cascade from a club are not frozen: deleting a club still works', async () => {
    const club = await pg.club.create({ data: { name: 'Audit IT FC', city: 'Testville' } });
    const action = (await pg.$queryRawUnsafe<Array<{ v: string }>>(`SELECT unnest(enum_range(NULL::"MembershipAuditAction"))::text AS v LIMIT 1`))[0].v;
    await pg.membershipAuditLog.create({ data: { clubId: club.id, action: action as never } });
    await expect(pg.club.delete({ where: { id: club.id } })).resolves.toMatchObject({ id: club.id });
  });
});
