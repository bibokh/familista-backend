// Familista — an assist belongs to whoever made it, even if that is all they did.
//
// PlayerMatchStats was built from the players who had an event of their own,
// plus the starting XI. `relatedPlayerId` — the other end of an event, which is
// the assist provider on a goal and the partner in a substitution — was read
// when computing a player's row but never used to decide that the player should
// have one. So a substitute who came on and set up a goal, with no event under
// their own name and no place in the starting eleven, got no row, and their
// assist vanished before the Familista League's assists board ever saw it.
//
// The source assertions run always; the scenario itself needs a database and
// follows the repository's TEST_DATABASE_URL convention.

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const STATS = fs.readFileSync(path.join(ROOT, 'src/player-stats/player-stats.service.ts'), 'utf8');

describe('who gets a stats row', () => {
  it('collects the other end of an event, not only the actor', () => {
    const fn = STATS.slice(STATS.indexOf('export async function computeMatchStats'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("relatedPlayerId: { not: null }");
    expect(body).toContain("distinct: ['relatedPlayerId']");
  });

  it('still collects actors and the starting XI', () => {
    const fn = STATS.slice(STATS.indexOf('export async function computeMatchStats'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain("playerId: { not: null }");
    expect(body).toContain("type: 'STARTING_XI'");
    expect(body).toContain('starters.has(playerId)');
  });

  it('files a related player under their own club, not the recording one', () => {
    // The event's clubId is the side that recorded it — right for the actor,
    // wrong for anyone on the other side. A statistic under the wrong club is
    // worse than a missing one.
    const fn = STATS.slice(STATS.indexOf('const relatedIds ='));
    const body = fn.slice(0, fn.indexOf('\n    }\n'));
    expect(body).toContain('tx.player.findMany');
    expect(body).toContain('select: { id: true, clubId: true, teamId: true }');
    expect(body).toContain('byPlayer.set(p.id, { playerId: p.id, clubId: p.clubId');
  });

  it('invents nothing for an id that resolves to nobody', () => {
    // A dangling relatedPlayerId is a broken reference, not a player.
    const fn = STATS.slice(STATS.indexOf('const relatedIds ='));
    expect(fn.slice(0, 1200)).toContain('if (!p.clubId) continue;');
    expect(fn.slice(0, 1200)).toContain('where:  { id: { in: relatedIds } }');
  });

  it('cannot produce a duplicate', () => {
    // Everything funnels through one map keyed by player, and a related player
    // is only added when the map does not already hold them.
    const fn = STATS.slice(STATS.indexOf('export async function computeMatchStats'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('!byPlayer.has(id)');
    expect((body.match(/await buildPlayerMatchStats\(/g) || []).length).toBe(1);
  });

  it('leaves the concurrency fix in place', () => {
    // The collection happens inside the same locked transaction; adding a query
    // outside it would put a read back outside the lock.
    const fn = STATS.slice(STATS.indexOf('export async function computeMatchStats'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('withStatsLock(`stats:match:${matchId}`');
    expect(body).not.toMatch(/\bprisma\.[a-z]/);
  });
});

// ── The scenario, where there is a database to run it in ─────────────────────
const DB = !!process.env.TEST_DATABASE_URL;
(DB ? describe : describe.skip)('a substitute who only assists', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any; let stats: any;
  let matchId: string; let scorer: string; let assister: string; let spare: string;
  const created: string[] = [];

  beforeAll(async () => {
    prisma = (await import('../src/config/database')).prisma;
    stats = await import('../src/player-stats/player-stats.service');

    const match = await prisma.match.findFirst({
      where: { teamId: { not: null }, events: { none: {} }, team: { players: { some: {} } } },
      select: { id: true, clubId: true, teamId: true },
    });
    expect(match).toBeTruthy();
    matchId = match.id;

    const squad = await prisma.player.findMany({ where: { teamId: match.teamId }, take: 3, select: { id: true } });
    [scorer, assister, spare] = squad.map((p: { id: string }) => p.id);

    const add = async (data: Record<string, unknown>) => {
      const row = await prisma.matchEvent.create({
        data: {
          clubId: match.clubId, matchId, teamId: match.teamId,
          periodIndex: 2, second: 0, x: 86, y: 49, ...data,
        },
        select: { id: true },
      });
      created.push(row.id);
    };

    // `spare` starts. `assister` comes on for them at 60' and sets up the goal at
    // 71'. `assister` has no event of their own and is not in the starting XI —
    // exactly the case that lost the assist.
    await add({ type: 'STARTING_XI', playerId: spare, periodIndex: 1, minute: 0, minuteMs: BigInt(0) });
    await add({ type: 'STARTING_XI', playerId: scorer, periodIndex: 1, minute: 0, minuteMs: BigInt(0) });
    await add({ type: 'SUBSTITUTION', playerId: spare, relatedPlayerId: assister, minute: 60, minuteMs: BigInt(60 * 60_000) });
    await add({ type: 'GOAL', outcome: 'GOAL', playerId: scorer, relatedPlayerId: assister, minute: 71, minuteMs: BigInt(71 * 60_000), xg: 0.4 });
  }, 60000);

  afterAll(async () => {
    if (created.length) await prisma.matchEvent.deleteMany({ where: { id: { in: created } } });
    await prisma.playerMatchStats.deleteMany({ where: { matchId } });
    await prisma.$disconnect();
  }, 30000);

  const rowFor = async (playerId: string) =>
    prisma.playerMatchStats.findUnique({
      where: { matchId_playerId: { matchId, playerId } },
      select: { playerId: true, clubId: true, goals: true, assists: true, isStarting: true, ratingFamilista: true },
    });

  it('gets a stats row at all', async () => {
    await prisma.playerMatchStats.deleteMany({ where: { matchId } });
    await stats.computeMatchStats(matchId);
    expect(await rowFor(assister)).not.toBeNull();
  }, 60000);

  it('with the right assist count, and no goals it did not score', async () => {
    const row = await rowFor(assister);
    expect(row.assists).toBe(1);
    expect(row.goals).toBe(0);
    expect(row.isStarting).toBe(false);
  }, 30000);

  it('and does not disturb the scorer', async () => {
    const row = await rowFor(scorer);
    expect(row.goals).toBe(1);
    expect(row.assists).toBe(0);
    expect(row.isStarting).toBe(true);
  }, 30000);

  it('is filed under the player’s own club', async () => {
    const row = await rowFor(assister);
    const player = await prisma.player.findUnique({ where: { id: assister }, select: { clubId: true } });
    expect(row.clubId).toBe(player.clubId);
  }, 30000);

  it('keeps the starting XI, including a starter who did nothing', async () => {
    // `spare` started and was substituted off without an event of their own.
    const row = await rowFor(spare);
    expect(row).not.toBeNull();
    expect(row.isStarting).toBe(true);
  }, 30000);

  it('writes one row per player and no duplicates', async () => {
    const dupes = await prisma.$queryRaw`
      SELECT "playerId" FROM "PlayerMatchStats" WHERE "matchId" = ${matchId}
      GROUP BY "playerId" HAVING COUNT(*) > 1`;
    expect(dupes).toEqual([]);
    expect(await prisma.playerMatchStats.count({ where: { matchId } })).toBe(3);
  }, 30000);

  it('is still safe when rebuilds race, and still complete', async () => {
    await prisma.playerMatchStats.deleteMany({ where: { matchId } });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => stats.computeMatchStats(matchId)),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await prisma.playerMatchStats.count({ where: { matchId } })).toBe(3);
    expect((await rowFor(assister)).assists).toBe(1);
  }, 120000);
});
