// Familista — two aggregations of one match must not collide.
//
// PlayerMatchStats is unique on (matchId, playerId). Aggregation upserts on that
// pair, and a Prisma upsert whose `create` carries a nested `connect` cannot
// compile to INSERT … ON CONFLICT — it is a SELECT then an INSERT. So when the
// worker draining the event-ingest outbox and somebody asking for a rebuild ran
// at the same moment on a match whose stats did not exist yet, both read "no
// row", both inserted, and all but one lost with P2002. Eight concurrent calls
// used to leave seven failures.
//
// The source assertions below always run. The behaviour — which is the part that
// actually matters, and which cannot be observed without a database — runs when
// TEST_DATABASE_URL is set, the convention the rest of this suite uses.

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const STATS = read('src/player-stats/player-stats.service.ts');
const WORKER = read('src/workers/stats-aggregator.worker.ts');
const SCHEMA = read('prisma/schema.prisma');

describe('aggregation runs one at a time, per match', () => {
  it('takes a lock inside the transaction that does the writing', () => {
    expect(STATS).toContain('async function withStatsLock');
    const lock = STATS.slice(STATS.indexOf('async function withStatsLock'));
    const body = lock.slice(0, lock.indexOf('\n}'));
    expect(body).toContain('prisma.$transaction');
    expect(body).toContain('pg_advisory_xact_lock(hashtextextended(${key}, 0))');
    // The lock is the first thing the transaction does; taking it after any read
    // would leave the read outside the lock and the race half-open.
    expect(body.indexOf('pg_advisory_xact_lock')).toBeLessThan(body.indexOf('return fn(tx)'));
  });

  it('holds it for the transaction, so a crash cannot leave a match locked', () => {
    // _xact_, not the session-scoped pg_advisory_lock, which would need an
    // explicit unlock and would leak one on any throw.
    expect(STATS).toContain('pg_advisory_xact_lock');
    expect(STATS).not.toMatch(/pg_advisory_lock\(/);
    expect(STATS).not.toContain('pg_advisory_unlock');
  });

  it('keys the lock per match, and namespaces it', () => {
    expect(STATS).toContain('withStatsLock(`stats:match:${matchId}`');
    // Two subsystems locking the same uuid must not contend, so the key is not
    // the bare id.
    expect(STATS).not.toMatch(/withStatsLock\(`?\$\{matchId\}/);
  });

  it('does the whole rebuild through the transaction client', () => {
    const fn = STATS.slice(STATS.indexOf('export async function computeMatchStats'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    // Every read and write inside the lock is on `tx`; a stray `prisma.` call
    // would run outside the transaction and outside the lock with it.
    expect(body).not.toMatch(/\bprisma\.[a-z]/);
    expect(body).toContain('tx.matchEvent.findMany');
    expect(STATS).toContain('async function buildPlayerMatchStats(\n  tx: Prisma.TransactionClient,');
    const build = STATS.slice(STATS.indexOf('async function buildPlayerMatchStats'));
    expect(build.slice(0, build.indexOf('\n}\n'))).not.toMatch(/\bprisma\.[a-z]/);
  });

  it('locks the season rollup too — the worker calls it concurrently', () => {
    expect(STATS).toContain('withStatsLock(\n    `stats:season:${playerId}:${clubId}:${season}:${competitionId ?? \'\'}`');
    const roll = STATS.slice(STATS.indexOf('async function _rollupSeasonStats'));
    expect(roll.slice(0, roll.indexOf('\n}\n'))).not.toMatch(/\bprisma\.[a-z]/);
  });

  it('writes each player once per rebuild', () => {
    // A starter with events used to be built twice — once from the events loop
    // and once from the starting-XI loop — which also double-counted `rebuilt`.
    const fn = STATS.slice(STATS.indexOf('export async function computeMatchStats'));
    expect(fn).toContain('const byPlayer = new Map<');
    expect((fn.slice(0, fn.indexOf('\n}\n')).match(/await buildPlayerMatchStats\(/g) || []).length).toBe(1);
  });

  it('does not solve it by weakening the constraint', () => {
    const model = SCHEMA.slice(SCHEMA.indexOf('model PlayerMatchStats {'));
    expect(model.slice(0, model.indexOf('\n}'))).toContain('@@unique([matchId, playerId])');
    const season = SCHEMA.slice(SCHEMA.indexOf('model PlayerSeasonStats {'));
    expect(season.slice(0, season.indexOf('\n}'))).toContain('@@unique([playerId, clubId, season, competitionId])');
  });
});

describe('the worker does not fight itself', () => {
  it('aggregates a match once however many messages asked for it', () => {
    // Ingest enqueues one message per event, so a five-event match produces five
    // identical instructions. Twenty transactions queuing on one lock, each
    // holding a pool connection, is how a fix for a race becomes a stall.
    expect(WORKER).toContain('const byMatch = new Map<string,');
    expect(WORKER).toContain('_processMatch(matchId, group)');
    expect(WORKER).not.toContain('rows.map((row) => _processRow(row))');
  });

  it('marks every message in the group processed, together', () => {
    const fn = WORKER.slice(WORKER.indexOf('async function _processMatch'));
    expect(fn).toContain('prisma.eventOutbox.updateMany');
    expect(fn).toContain('id: { in: group.map((r) => r.id) }');
  });

  it('keeps the retry budget per message', () => {
    // Grouping must not hand a message that has already failed twice a fresh
    // allowance because a newer one arrived for the same match.
    const fn = WORKER.slice(WORKER.indexOf('async function _processMatch'));
    expect(fn).toContain('const nextRetry = row.retryCount + 1;');
    expect(fn).toContain('if (nextRetry >= MAX_RETRIES)');
  });
});

// ── The race itself, where there is a database to run it against ─────────────
const DB = !!process.env.TEST_DATABASE_URL;
(DB ? describe : describe.skip)('concurrent aggregation, against a real database', () => {
  const CONCURRENCY = 12;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any; let stats: any; let matchId: string; let created: string[] = [];

  beforeAll(async () => {
    prisma = (await import('../src/config/database')).prisma;
    stats = await import('../src/player-stats/player-stats.service');

    // A match with a squad and no events of its own, so the counts below are
    // this test's and nothing has to be deleted to make room for them.
    const match = await prisma.match.findFirst({
      where: { teamId: { not: null }, events: { none: {} }, team: { players: { some: {} } } },
      select: { id: true, clubId: true, teamId: true },
    });
    expect(match).toBeTruthy();
    matchId = match.id;
    const squad = await prisma.player.findMany({ where: { teamId: match.teamId }, take: 3, select: { id: true } });

    for (let i = 0; i < squad.length; i++) {
      const row = await prisma.matchEvent.create({
        data: {
          clubId: match.clubId, matchId, teamId: match.teamId, playerId: squad[i].id,
          relatedPlayerId: squad[(i + 1) % squad.length].id,
          periodIndex: 1, minute: 10 + i * 5, minuteMs: BigInt((10 + i * 5) * 60_000), second: 0,
          type: 'GOAL', outcome: 'GOAL', x: 88, y: 50, xg: 0.4,
        },
        select: { id: true },
      });
      created.push(row.id);
    }
  }, 60000);

  afterAll(async () => {
    if (created.length) await prisma.matchEvent.deleteMany({ where: { id: { in: created } } });
    await prisma.playerMatchStats.deleteMany({ where: { matchId } });
    await prisma.$disconnect();
  }, 30000);

  const snapshot = async () =>
    (await prisma.playerMatchStats.findMany({
      where: { matchId },
      select: { playerId: true, goals: true, assists: true, shots: true, minutesPlayed: true, isStarting: true, ratingFamilista: true, xg: true, xa: true },
      orderBy: { playerId: 'asc' },
    })).map((r: unknown) => JSON.stringify(r));

  it('survives many rebuilds starting at once, from cold', async () => {
    // Cold is the case that used to break: with no rows yet, every caller
    // inserts. Once rows exist every upsert takes the update branch and nothing
    // contends, which is why the bug hid.
    await prisma.playerMatchStats.deleteMany({ where: { matchId } });

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => stats.computeMatchStats(matchId)),
    );
    const failed = results.filter((r) => r.status === 'rejected');
    expect(failed.map((r) => String((r as PromiseRejectedResult).reason).slice(0, 120))).toEqual([]);
    expect(results.length).toBe(CONCURRENCY);
  }, 120000);

  it('leaves one row per player and no duplicates', async () => {
    const dupes = await prisma.$queryRaw`
      SELECT "playerId", COUNT(*) FROM "PlayerMatchStats"
      WHERE "matchId" = ${matchId} GROUP BY "playerId" HAVING COUNT(*) > 1`;
    expect(dupes).toEqual([]);
    expect(await prisma.playerMatchStats.count({ where: { matchId } })).toBe(3);
  }, 30000);

  it('leaves exactly what one aggregation on its own would leave', async () => {
    // The point of the fix is not that nothing throws. Both callers read the
    // same immutable events, so the racing result must equal the sequential one
    // field for field.
    const concurrent = await snapshot();
    await prisma.playerMatchStats.deleteMany({ where: { matchId } });
    await stats.computeMatchStats(matchId);
    expect(concurrent).toEqual(await snapshot());
  }, 60000);

  it('is safe when a rebuild overlaps the aggregation ingest triggers', async () => {
    await prisma.playerMatchStats.deleteMany({ where: { matchId } });
    const both = await Promise.allSettled([
      stats.computeMatchStats(matchId),                       // the worker's call
      stats.computeMatchStats(matchId),                       // the API's call
      stats.computeMatchStats(matchId),
    ]);
    expect(both.filter((r) => r.status === 'rejected')).toEqual([]);

    const rows = await prisma.playerMatchStats.findMany({ where: { matchId }, select: { goals: true, assists: true } });
    expect(rows.length).toBe(3);
    // Every goal recorded is counted once, and every goal carries its assist.
    expect(rows.reduce((s: number, r: { goals: number }) => s + r.goals, 0)).toBe(3);
    expect(rows.reduce((s: number, r: { assists: number }) => s + r.assists, 0)).toBe(3);
  }, 120000);

  it('rolls a season up concurrently without colliding either', async () => {
    const row = await prisma.playerMatchStats.findFirst({ where: { matchId }, select: { playerId: true, clubId: true } });
    const season = '2026/27';
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => stats.rollupSeasonStats(row.playerId, row.clubId, season)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    // One row for the tuple that was rolled up. Scoped to competitionId: null,
    // because a competition-scoped rollup of the same player and season is a
    // different, legitimate row — the key includes the competition.
    const seasonRows = await prisma.playerSeasonStats.count({
      where: { playerId: row.playerId, clubId: row.clubId, season, competitionId: null },
    });
    expect(seasonRows).toBe(1);
  }, 120000);

  it('finds its own season row when there is no competition on it', async () => {
    // The reason six rollups used to leave six rows: the unique key includes
    // competitionId, NULL is not equal to NULL in Postgres so the index permits
    // duplicates, and the lookup asked for '' which never matches a stored NULL.
    // Rolling up twice in a row must still leave one.
    const row = await prisma.playerMatchStats.findFirst({ where: { matchId }, select: { playerId: true, clubId: true } });
    const season = '2026/27';
    await stats.rollupSeasonStats(row.playerId, row.clubId, season);
    await stats.rollupSeasonStats(row.playerId, row.clubId, season);
    expect(await prisma.playerSeasonStats.count({
      where: { playerId: row.playerId, clubId: row.clubId, season, competitionId: null },
    })).toBe(1);
  }, 60000);
});
