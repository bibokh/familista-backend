/**
 * AI cost control — the execution gate's ledger, proven on real PostgreSQL
 *
 * A freshly migrated database (every migration, including
 * 20261028120000_ai_execution_gate) whose default TimeZone is deliberately NOT
 * UTC. Then, through the application's own ledger and gateway:
 *
 *   no switch row is OFF: a call is refused and recorded, nothing is sent
 *   the switch is the owner's, and each change writes a PlatformAuditLog row
 *   in the same transaction
 *   the database refuses a second switch row and a negative amount
 *   twenty-five reservations at once cannot overspend a daily budget, and
 *   ten at once cannot exceed the concurrency limit — the advisory lock holds
 *   the SQL snapshot equals snapshotOf on the same rows, in a non-UTC session
 *   settlement counts reported usage, and the whole reservation when none
 *   a successful call through the gateway records its reservation and its
 *   estimated cost from the configured price
 *   the owner's report names no club
 *
 * Runs when AI_GATE_DB_DATABASE_URL names a server where the test may create
 * and drop a database. CI sets AI_GATE_DB_REQUIRED=1, so a missing URL fails
 * there rather than skipping:
 *
 *   AI_GATE_DB_DATABASE_URL=postgresql://postgres@localhost:5432/postgres \
 *     npx jest --runInBand tests/ai-execution-gate.integration.test.ts
 */

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { asUser, TEST_PRICING } from './helpers/ai-gate';

const ADMIN_URL = process.env.AI_GATE_DB_DATABASE_URL ?? '';
if (!ADMIN_URL && process.env.AI_GATE_DB_REQUIRED === '1') {
  throw new Error('AI_GATE_DB_REQUIRED=1 but AI_GATE_DB_DATABASE_URL is not set');
}
const suite = ADMIN_URL ? describe : describe.skip;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

const HOUR = 3_600_000;

suite('the AI execution gate on real PostgreSQL', () => {
  const db = `fam_aigate_${randomBytes(4).toString('hex')}`;
  const url = ADMIN_URL ? withDatabase(ADMIN_URL, db) : '';
  let admin: PrismaClient;
  let pg: PrismaClient;
  let gate: typeof import('../src/platform/intelligence/execution-gate');
  let ledger: typeof import('../src/platform/intelligence/ai-ledger');
  let gateway: typeof import('../src/platform/intelligence/gateway');
  let sent = 0;

  const base = {
    caller: 'it', purpose: 'agent', clubId: 'club-a', model: 'familista-default', provider: 'anthropic',
    dataClasses: ['INTERNAL' as const], pseudonymised: 0, outcome: 'STARTED' as const,
  };

  beforeAll(async () => {
    admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    // A half-hour zone: a window computed in this session's zone would be off by 5h30.
    await admin.$executeRawUnsafe(`ALTER DATABASE "${db}" SET timezone TO 'Asia/Kolkata'`);
    const migrate = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'], {
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url }, encoding: 'utf8', timeout: 180_000,
    });
    if (migrate.status !== 0) throw new Error(`prisma migrate deploy failed (exit ${migrate.status}): ${migrate.stderr}`);
    pg = new PrismaClient({ datasources: { db: { url } } });
    process.env.DATABASE_URL = url;
    process.env.DIRECT_URL = url;
    process.env.AI_MODEL_PRICING = TEST_PRICING;
    /* eslint-disable @typescript-eslint/no-var-requires */
    gate = require('../src/platform/intelligence/execution-gate');
    ledger = require('../src/platform/intelligence/ai-ledger');
    gateway = require('../src/platform/intelligence/gateway');
    /* eslint-enable @typescript-eslint/no-var-requires */
  }, 240_000);

  afterAll(async () => {
    delete process.env.AI_MODEL_PRICING;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    await (require('../src/config/database') as typeof import('../src/config/database')).prisma.$disconnect().catch(() => undefined);
    await pg?.$disconnect();
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    // The record is append-only (its guard refuses DELETE). This throwaway
    // database lifts the guard for the reset alone, and puts it straight back.
    await pg.$transaction([
      pg.$executeRawUnsafe('ALTER TABLE "AiEgressRecord" DISABLE TRIGGER "AiEgressRecord_append_only"'),
      pg.$executeRawUnsafe('DELETE FROM "AiEgressRecord"'),
      pg.$executeRawUnsafe('ALTER TABLE "AiEgressRecord" ENABLE TRIGGER "AiEgressRecord_append_only"'),
    ]);
    await pg.$executeRawUnsafe('DELETE FROM "AiExecutionControl"');
    gateway.resetGateway();
    sent = 0;
    gateway.registerProvider({ id: 'anthropic', available: () => true, complete: async () => { sent += 1; return { text: 'ok', usage: { inputTokens: 120, outputTokens: 30 } }; } });
    gateway.registerModel({ id: 'familista-default', provider: 'anthropic', providerModel: 'test-model', purposes: ['agent'] });
  });

  const limits = (over: Partial<import('../src/platform/intelligence/execution-gate').AiLimits> = {}) => ({ ...gate.aiPolicyConfig({}).limits, ...over });
  const ask = (tokens: number, over: Partial<import('../src/platform/intelligence/execution-gate').ReservationAsk> = {}) =>
    ({ tokens, costMicros: tokens, workflowId: null, agentRunId: null, ...over });

  it('the migration adds the switch table and the reservation columns, and refuses a second switch row or a negative amount', async () => {
    const cols = await pg.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'AiEgressRecord'`);
    expect(cols.map((c) => c.column_name)).toEqual(expect.arrayContaining(
      ['reservedTokens', 'reservedCostMicros', 'costMicros', 'workflowId', 'agentRunId', 'agent', 'origin']));
    await expect(pg.aiExecutionControl.create({ data: { id: 'second', enabled: true } })).rejects.toThrow();
    await expect(pg.aiEgressRecord.create({ data: { ...base, reservedTokens: -1 } })).rejects.toThrow();
    await expect(pg.aiEgressRecord.create({ data: { ...base, tokensOut: -5 } })).rejects.toThrow();
  });

  it('a settlement records the outcome but can never shrink the reservation or move the call', async () => {
    const row = await pg.aiEgressRecord.create({ data: { ...base, reservedTokens: 900, reservedCostMicros: 2_700, agentRunId: 'job-1' } });
    await expect(pg.aiEgressRecord.update({ where: { id: row.id }, data: { outcome: 'OK', reservedTokens: 1 } })).rejects.toThrow(/refused/);
    await expect(pg.aiEgressRecord.update({ where: { id: row.id }, data: { outcome: 'OK', agentRunId: 'job-2' } })).rejects.toThrow(/refused/);
    await pg.aiEgressRecord.update({ where: { id: row.id }, data: { outcome: 'OK', tokensIn: 100, tokensOut: 20, costMicros: 600 } });
    await expect(pg.aiEgressRecord.update({ where: { id: row.id }, data: { tokensIn: 1 } })).rejects.toThrow(/refused/);
    await expect(pg.$executeRawUnsafe(`DELETE FROM "AiEgressRecord" WHERE id = '${row.id}'`)).rejects.toThrow(/refused/);
  });

  it('no switch row is OFF: the call is refused, recorded as refused, and nothing is sent', async () => {
    expect(await ledger.prismaAiLedger.executionEnabled()).toBe(false);
    const out = await asUser('u-1', () => gateway.complete({ caller: 'it', purpose: 'agent', prompt: 'hi', dataClasses: ['INTERNAL'] }));
    expect(out).toMatchObject({ ok: false, refusal: 'disabled' });
    expect(sent).toBe(0);
    const rows = await pg.aiEgressRecord.findMany();
    expect(rows.map((r) => [r.outcome, r.reason])).toEqual([['REFUSED', 'disabled']]);
  });

  it('switching is audited in the same transaction, both ways', async () => {
    await ledger.setExecutionControl({ enabled: true, reason: 'approved trial', actorUserId: 'owner-1' });
    expect(await ledger.prismaAiLedger.executionEnabled()).toBe(true);
    await ledger.setExecutionControl({ enabled: false, reason: 'trial over', actorUserId: 'owner-1' });
    expect(await ledger.readExecutionControl()).toMatchObject({ enabled: false, reason: 'trial over' });
    const audit = await pg.platformAuditLog.findMany({ where: { resourceType: 'AiExecutionControl' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => [a.action, a.category, a.userId, a.message])).toEqual([
      ['AI_EXECUTION_ENABLED', 'LIMITS', 'owner-1', 'approved trial'],
      ['AI_EXECUTION_DISABLED', 'LIMITS', 'owner-1', 'trial over'],
    ]);
  });

  it('twenty-five reservations at once cannot overspend a daily budget of ten', async () => {
    await ledger.setExecutionControl({ enabled: true, reason: 'test', actorUserId: 'owner-1' });
    const L = limits({ dailyTokens: 10_000, maxConcurrent: 1_000 });
    const results = await Promise.all(Array.from({ length: 25 }, () => ledger.prismaAiLedger.reserve({ ...base }, ask(1_000), L)));
    const won = results.filter((r) => 'id' in r);
    expect(won).toHaveLength(10);
    expect(results.filter((r) => 'refused' in r && r.refused.refusal === 'daily-budget')).toHaveLength(15);
    const agg = await pg.aiEgressRecord.aggregate({ where: { outcome: 'STARTED' }, _sum: { reservedTokens: true } });
    expect(agg._sum.reservedTokens).toBe(10_000);
  });

  it('ten at once cannot exceed the concurrency limit of three', async () => {
    await ledger.setExecutionControl({ enabled: true, reason: 'test', actorUserId: 'owner-1' });
    const results = await Promise.all(Array.from({ length: 10 }, () => ledger.prismaAiLedger.reserve({ ...base }, ask(10), limits({ maxConcurrent: 3 }))));
    expect(results.filter((r) => 'id' in r)).toHaveLength(3);
    expect(results.filter((r) => 'refused' in r && r.refused.refusal === 'concurrency')).toHaveLength(7);
  });

  it('after OFF commits, the next reservation is refused', async () => {
    await ledger.setExecutionControl({ enabled: true, reason: 'test', actorUserId: 'owner-1' });
    expect('id' in await ledger.prismaAiLedger.reserve({ ...base }, ask(10), limits())).toBe(true);
    await ledger.setExecutionControl({ enabled: false, reason: 'stop', actorUserId: 'owner-1' });
    const r = await ledger.prismaAiLedger.reserve({ ...base }, ask(10), limits());
    expect('refused' in r && r.refused.refusal).toBe('disabled');
  });

  it('the SQL snapshot equals snapshotOf on the same rows, in a non-UTC session', async () => {
    const now = new Date();
    const { day, month } = gate.budgetWindows(now);
    const mk = (at: Date, over: Record<string, unknown>) => pg.aiEgressRecord.create({ data: { ...base, createdAt: at, ...over } });
    await mk(new Date(day.getTime() - 60_000), { outcome: 'OK', tokensIn: 500, tokensOut: 100, costMicros: 3_000 });   // yesterday, 23:59 UTC
    await mk(new Date(day.getTime() + 60_000), { outcome: 'OK', tokensIn: 50, tokensOut: 10, reservedTokens: 900, costMicros: 300, reservedCostMicros: 4_000 });
    await mk(new Date(now.getTime() - 60_000), { outcome: 'STARTED', reservedTokens: 700, reservedCostMicros: 2_100 });
    await mk(new Date(now.getTime() - 10 * 60_000), { outcome: 'STARTED', reservedTokens: 300, reservedCostMicros: 900 });  // stale: charged, no slot
    await mk(new Date(now.getTime() - 120_000), { outcome: 'FAILED', reservedTokens: 400, reservedCostMicros: 1_200, workflowId: 'wf-1', clubId: 'club-b' });
    await mk(new Date(now.getTime() - 30_000), { outcome: 'REFUSED', reason: 'daily-budget' });
    await mk(new Date(month.getTime() - HOUR), { outcome: 'OK', tokensIn: 9_000, tokensOut: 1_000, agentRunId: 'job-1' }); // last month
    await mk(new Date(now.getTime() - 5_000), { outcome: 'OK', tokensIn: 20, tokensOut: 5, agentRunId: 'job-1' });

    const rows = (await pg.aiEgressRecord.findMany()).map((r) => ({
      createdAt: r.createdAt, clubId: r.clubId, workflowId: r.workflowId, agentRunId: r.agentRunId, outcome: r.outcome,
      tokensIn: r.tokensIn, tokensOut: r.tokensOut, reservedTokens: r.reservedTokens, costMicros: r.costMicros, reservedCostMicros: r.reservedCostMicros,
    }));
    for (const q of [
      { clubId: 'club-a', workflowId: null, agentRunId: null },
      { clubId: 'club-b', workflowId: 'wf-1', agentRunId: 'job-1' },
      { clubId: null, workflowId: 'none', agentRunId: 'none' },
    ]) {
      const sql = await ledger.readUsageSnapshot(q, now);
      expect(sql).toEqual(gate.snapshotOf(rows, q, false, now));
    }
    const a = await ledger.readUsageSnapshot({ clubId: 'club-a', workflowId: null, agentRunId: 'job-1' }, now);
    // Today: 60 reported (not its 900 reservation), 700 + 300 reserved, 400 failed (club-b), 25 → 1,485.
    expect(a.dayTokens).toBe(60 + 700 + 300 + 400 + 25);
    expect(a.clubDayTokens).toBe(60 + 700 + 300 + 25);
    expect(a.inFlight).toBe(1);
    expect(a.agentRunTokens).toBe(10_000 + 25);
  });

  it('a call through the gateway reserves its most possible usage, then settles to the reported usage at the configured price', async () => {
    await ledger.setExecutionControl({ enabled: true, reason: 'test', actorUserId: 'owner-1' });
    const out = await asUser('u-1', () => gateway.complete({ caller: 'it', purpose: 'agent', prompt: 'héllo', maxOutputTokens: 200, dataClasses: ['INTERNAL'] }));
    expect(out).toMatchObject({ ok: true, text: 'ok' });
    const [row] = await pg.aiEgressRecord.findMany();
    expect(row).toMatchObject({
      outcome: 'OK', origin: 'request', tokensIn: 120, tokensOut: 30,
      reservedTokens: Buffer.byteLength('héllo') + gate.FRAMING_OVERHEAD_TOKENS + 200,
      costMicros: 120 * 3 + 30 * 15,
    });
    expect(row.reservedCostMicros).toBe((Buffer.byteLength('héllo') + gate.FRAMING_OVERHEAD_TOKENS) * 3 + 200 * 15);
  });

  it('a failure without reported usage keeps the whole reservation as the charge', async () => {
    await ledger.setExecutionControl({ enabled: true, reason: 'test', actorUserId: 'owner-1' });
    gateway.registerProvider({ id: 'anthropic', available: () => true, complete: async () => { throw Object.assign(new Error('x'), { category: 'timeout' }); } });
    const out = await asUser('u-1', () => gateway.complete({ caller: 'it', purpose: 'agent', prompt: 'hi', maxOutputTokens: 100, dataClasses: ['INTERNAL'] }));
    expect(out.refusal).toBe('provider');
    const [row] = await pg.aiEgressRecord.findMany();
    expect(row).toMatchObject({ outcome: 'FAILED', reason: 'timeout', tokensIn: null, tokensOut: null });
    const s = await ledger.readUsageSnapshot({ clubId: null, workflowId: null, agentRunId: null });
    expect(s.dayTokens).toBe(row.reservedTokens);
  });

  it('the owner\'s report is platform-wide and names no club', async () => {
    await ledger.setExecutionControl({ enabled: true, reason: 'test', actorUserId: 'owner-1' });
    await pg.aiEgressRecord.create({ data: { ...base, clubId: 'club-secret-a', outcome: 'OK', tokensIn: 10, tokensOut: 5, costMicros: 105, agent: 'TACTICAL' } });
    await pg.aiEgressRecord.create({ data: { ...base, clubId: 'club-secret-b', outcome: 'REFUSED', reason: 'daily-budget' } });
    const report = await ledger.usageReport(gate.BUDGET_LIMIT_REFUSALS);
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/club-secret|clubId/);
    expect(report.byAgent).toEqual([{ agent: 'TACTICAL', calls: 1, tokens: 15, costMicros: 105 }]);
    expect(report.refusals).toEqual([{ reason: 'daily-budget', count: 1 }]);
    expect(report.budgetEvents.map((e) => e.reason)).toEqual(['daily-budget']);
  });
});
