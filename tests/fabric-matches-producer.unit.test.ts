/**
 * tests/fabric-matches-producer.unit.test.ts
 *
 * The Matches domain as a Data Fabric producer — the widest migration so far,
 * and the one where deduplication is the whole game.
 *
 * ONE — THE FUNNEL PUBLISHES ONCE. `startLive`, `setHalftime`,
 * `resumeSecondHalf` and `finalize` all delegate to `updateMatch`. If each
 * published, a single `finalize` would emit two `match.updated` events — one
 * from the helper and one from the funnel beneath it. Every assertion here is
 * on the EXACT SET an action produced, because a test checking "the event
 * appears" passes just as well against a service that publishes twice.
 *
 * TWO — A SPECIFIC EVENT MEANS THAT SPECIFIC THING MOVED. Resending a match's
 * existing venue is not a change of ground. Derived from before/after rows, not
 * from which fields were present in the request.
 *
 * THREE — ONE SOURCE, FOUR CONTEXTS. A club friendly, a Familista League
 * fixture, an academy match and a Match Centre reschedule all land on the
 * Matches lane, told apart by `teamKind`, `competition` and `competitionId`.
 *
 * FOUR — NOTHING PRIVATE TRAVELS. Opponent scouting notes, AI insights, lineup
 * positions, lineup notes, match-event descriptions and the venue itself are
 * all planted in the fixtures below and searched for in every event and frame.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const SENIOR_TEAM = '33333333-3333-4333-8333-333333333333';
const ACADEMY_TEAM = '44444444-4444-4444-8444-444444444444';
const MATCH = '55555555-5555-4555-8555-555555555555';
const COMP = 'comp-familista-league-2026';
const ACTOR = 'u-actor';

/** Everything on a match or a lineup that must never travel. */
const SECRETS = {
  venue: 'Bramall Lane, Sheffield S2 4SU',
  newVenue: '14 Church Road, Manchester M20 6RQ',
  opponentNotes: 'Their left back is slow; target him. Keep Tomás off set pieces — concussion protocol',
  lineupNotes: 'Start the U16 keeper, his father asked us not to play him at right back',
  eventDescription: 'Goal by Tomás Müller-Fernández, assisted by his cousin',
  competitionName: 'Sheffield & District Youth Association Cup',
};

const state = { matches: [] as Row[], teams: [] as Row[], players: [] as Row[], lineups: [] as Row[], fixtures: [] as Row[], audit: [] as Row[], events: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
    }
    return row[k] === v;
  });

const copy = <T>(row: T): T => (row == null ? row : JSON.parse(JSON.stringify(row)) as T);

const db: Row = {
  match: {
    findUnique: async ({ where }: Row) => copy(state.matches.find((m) => m.id === where.id) ?? null),
    findFirst: async ({ where = {} }: Row = {}) => copy(state.matches.find((m) => match(m, where)) ?? null),
    findMany: async ({ where = {} }: Row = {}) => copy(state.matches.filter((m) => match(m, where))),
    count: async ({ where = {} }: Row = {}) => state.matches.filter((m) => match(m, where)).length,
    create: async ({ data }: Row) => {
      const row = { id: `m-${state.matches.length + 1}`, homeScore: null, awayScore: null, result: null, teamId: null, venue: null, ...data };
      state.matches.push(row); return copy(row);
    },
    update: async ({ where, data }: Row) => {
      const m = state.matches.find((x) => x.id === where.id)!;
      Object.assign(m, data); return copy(m);
    },
    delete: async ({ where }: Row) => {
      const i = state.matches.findIndex((x) => x.id === where.id);
      return i >= 0 ? copy(state.matches.splice(i, 1)[0]) : null;
    },
  },
  team: { findUnique: async ({ where }: Row) => copy(state.teams.find((t) => t.id === where.id) ?? null) },
  fixture: {
    findFirst: async ({ where = {} }: Row = {}) => copy(state.fixtures.find((f) => match(f, where)) ?? null),
    findUnique: async ({ where }: Row) => copy(state.fixtures.find((f) => f.id === where.id) ?? null),
    update: async ({ where, data }: Row) => {
      const f = state.fixtures.find((x) => x.id === where.id)!;
      Object.assign(f, data); return copy(f);
    },
  },
  player: { findMany: async ({ where = {} }: Row = {}) => copy(state.players.filter((p) => match(p, where))) },
  matchLineup: {
    findUnique: async ({ where }: Row) => {
      const k = where.matchId_side ?? {};
      return copy(state.lineups.find((l) => l.matchId === k.matchId && l.side === k.side) ?? null);
    },
    findMany: async ({ where = {} }: Row = {}) => copy(state.lineups.filter((l) => match(l, where))),
    create: async ({ data }: Row) => {
      const row = { id: `l-${state.lineups.length + 1}`, ...data };
      state.lineups.push(row); return copy(row);
    },
    update: async ({ where, data }: Row) => {
      const l = state.lineups.find((x) => x.id === where.id)!;
      Object.assign(l, data); return copy(l);
    },
  },
  matchEvent: {
    create: async ({ data }: Row) => { state.events.push(data); return copy(data); },
    upsert: async ({ create }: Row) => { state.events.push(create); return copy(create); },
    findMany: async () => [],
  },
  matchAuditLog: { create: async ({ data }: Row) => { state.audit.push(data); return data; }, findMany: async () => [], count: async () => 0 },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));
jest.mock('../src/realtime/match-channel', () => ({ publish: () => {} }));
jest.mock('../src/competition/familista-league.admin.service', () => ({
  syncMatchToLeague: async () => ({ competitionId: null }),
}));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor, pulseTopology } from '../src/fabric/pulse/pulse.service';
import { fabricEvent, fabricEventsForSource, isRegisteredEventType } from '../src/fabric/registry/event-registry';
import { sourceLanes, visibleFabricSources } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { registryHealth, resetRegistryHealth } from '../src/fabric/registry/unknown-events';
import '../src/fabric/producers/matches.producer';

import * as matches from '../src/services/match.service';
import * as intel from '../src/services/match-intelligence.service';

let published: FamilistaEvent[] = [];

/** Detached, and resolving two joins on the way. Drain generously. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const ACTOR_CTX = { userId: ACTOR, clubId: CLUB } as never;

beforeEach(() => {
  published = [];
  resetRegistryHealth();
  setEventTransport(transport);

  state.teams = [
    { id: SENIOR_TEAM, clubId: CLUB, kind: 'SENIOR', isActive: true },
    { id: ACADEMY_TEAM, clubId: CLUB, kind: 'ACADEMY_U17', isActive: true },
    { id: 'other-team', clubId: OTHER_CLUB, kind: 'SENIOR', isActive: true },
  ];
  state.players = [{ id: 'p-1', clubId: CLUB }, { id: 'p-2', clubId: CLUB }];
  state.matches = [{
    id: MATCH, clubId: CLUB, teamId: SENIOR_TEAM,
    homeTeam: 'FC Familista', awayTeam: 'SV Nord', isHome: true,
    competition: 'LEAGUE', competitionName: SECRETS.competitionName,
    venue: SECRETS.venue, scheduledAt: new Date('2026-11-01T15:00:00Z'),
    status: 'SCHEDULED', homeScore: null, awayScore: null, result: null,
    formationHome: '4-3-3', formationAway: null,
    opponentNotes: SECRETS.opponentNotes, aiInsights: null,
    periodNow: null, liveMinute: null, playedAt: null,
  }];
  state.fixtures = [];
  state.lineups = [];
  state.audit = [];
  state.events = [];
});

afterEach(async () => { await settle(); });
afterAll(async () => { await settle(); setEventTransport(null); });

const types = () => published.map((e) => e.eventType).sort();
const one = (type: string) => {
  const hits = published.filter((e) => e.eventType === type);
  expect(`${type} count: ${hits.length}`).toBe(`${type} count: 1`);
  return hits[0];
};

// ── the funnel publishes once ────────────────────────────────────────────────

describe('every helper delegating to updateMatch publishes exactly once', () => {
  it('createMatch → match.created, once', async () => {
    await matches.createMatch(ACTOR_CTX, {
      homeTeam: 'A', awayTeam: 'B', isHome: true, competition: 'FRIENDLY',
      scheduledAt: '2026-12-01T15:00:00Z', teamId: ACADEMY_TEAM,
      opponentNotes: SECRETS.opponentNotes,
    } as never);
    await settle();

    expect(types()).toEqual(['match.created']);
    const e = one('match.created');
    expect(e.payload).toEqual({ teamKind: 'ACADEMY_U17', competition: 'FRIENDLY', competitionId: null });
    expect(e.subjectType).toBe('MATCH');
  });

  it('a plain edit is ONE event', async () => {
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeTeam: 'Renamed' } as never);
    await settle();
    expect(types()).toEqual(['match.updated']);
    expect(one('match.updated').payload).toEqual({
      changedFields: ['homeTeam'], teamKind: 'SENIOR', competition: 'LEAGUE', competitionId: null,
    });
  });

  it('startLive → exactly one match.updated, plus the transition and the milestone', async () => {
    await matches.startLive(ACTOR_CTX, MATCH);
    await settle();

    // ONE `match.updated`. Two would mean the helper and the funnel both spoke.
    expect(types()).toEqual(['match.started', 'match.status.changed', 'match.updated']);
    expect(one('match.status.changed').payload).toMatchObject({ from: 'SCHEDULED', to: 'LIVE' });
  });

  it('setHalftime → one match.updated, a transition, and no milestone', async () => {
    state.matches[0].status = 'LIVE';
    await matches.setHalftime(ACTOR_CTX, MATCH);
    await settle();
    expect(types()).toEqual(['match.status.changed', 'match.updated']);
  });

  it('resumeSecondHalf does NOT claim the match started again', async () => {
    state.matches[0].status = 'HALFTIME';
    await matches.resumeSecondHalf(ACTOR_CTX, MATCH);
    await settle();
    // HALFTIME → LIVE is a resumption, not a kickoff.
    expect(types()).toEqual(['match.status.changed', 'match.updated']);
  });

  it('finalize → one match.updated, the transition, the completion and the result', async () => {
    state.matches[0].status = 'LIVE';
    await matches.finalize(ACTOR_CTX, MATCH, 3, 1);
    await settle();

    expect(types()).toEqual([
      'match.completed', 'match.result.updated', 'match.status.changed', 'match.updated',
    ]);
    expect(one('match.completed').payload).toMatchObject({ homeScore: 3, awayScore: 1, result: 'WIN' });
    expect(one('match.result.updated').payload).toMatchObject({ homeScore: 3, awayScore: 1 });
  });

  it('a score edit with no status change is the umbrella and the result only', async () => {
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeScore: 2, awayScore: 2 } as never);
    await settle();
    expect(types()).toEqual(['match.result.updated', 'match.updated']);
  });

  it('a venue move is the umbrella and the venue fact', async () => {
    await matches.updateMatch(ACTOR_CTX, MATCH, { venue: SECRETS.newVenue } as never);
    await settle();
    expect(types()).toEqual(['match.updated', 'match.venue.changed']);
    const e = one('match.venue.changed');
    expect(e.dataClassification).toBe('RESTRICTED');
    expect(e.payload).toEqual({
      route: 'EDIT', teamKind: 'SENIOR', competition: 'LEAGUE', competitionId: null,
    });
  });

  it('a kickoff move is the umbrella and the time fact', async () => {
    await matches.updateMatch(ACTOR_CTX, MATCH, { scheduledAt: '2026-11-02T15:00:00Z' } as never);
    await settle();
    expect(types()).toEqual(['match.time.changed', 'match.updated']);
    expect(one('match.time.changed').payload).toMatchObject({ route: 'EDIT' });
  });

  it('resending the SAME venue and kickoff says nothing about a move', async () => {
    await matches.updateMatch(ACTOR_CTX, MATCH, {
      venue: SECRETS.venue, scheduledAt: '2026-11-01T15:00:00Z',
    } as never);
    await settle();
    expect(types()).toEqual(['match.updated']);
  });

  it('deleteMatch → match.deleted, once, without the reason', async () => {
    await matches.deleteMatch(ACTOR_CTX, MATCH, 'Opponent withdrew after a safeguarding complaint');
    await settle();
    expect(types()).toEqual(['match.deleted']);
    expect(JSON.stringify(published)).not.toContain('safeguarding');
  });

  it('abandonMatch publishes its own transition — it does not use the funnel', async () => {
    state.matches[0].status = 'LIVE';
    await matches.abandonMatch(ACTOR_CTX, MATCH, 'Waterlogged pitch');
    await settle();

    expect(types()).toEqual(['match.cancelled', 'match.status.changed']);
    expect(one('match.status.changed').payload).toMatchObject({ from: 'LIVE', to: 'ABANDONED' });
    expect(one('match.cancelled').payload).toMatchObject({ status: 'ABANDONED' });
    // No `match.updated`: it never went through `updateMatch`.
    expect(types()).not.toContain('match.updated');
  });

  it('routes every funnel publish through one adapter', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/match.service.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    // `updateMatch` itself must contain exactly one publish call, and it must
    // be the adapter rather than a producer helper.
    const fn = code.slice(code.indexOf('export async function updateMatch'), code.indexOf('export async function deleteMatch'));
    expect((fn.match(/emitMatchChange\(/g) ?? []).length).toBe(1);
    expect(fn).not.toMatch(/publishMatch[A-Z]/);
  });

  it('never publishes inside a transaction', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/match.service.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    let from = 0; let spans = 0;
    while ((from = src.indexOf('$transaction(', from)) !== -1) {
      const open = src.indexOf('{', from);
      let depth = 0; let end = open;
      for (; end < src.length; end += 1) {
        if (src[end] === '{') depth += 1;
        else if (src[end] === '}') { depth -= 1; if (depth === 0) break; }
      }
      const inside = src.slice(open, end);
      expect(`span ${spans}: ${/emitMatchChange\(|publishMatch[A-Z]/.test(inside) ? 'EMIT INSIDE' : 'clean'}`)
        .toBe(`span ${spans}: clean`);
      spans += 1; from = end;
    }
    expect(spans).toBeGreaterThanOrEqual(2);
  });
});

// ── failure publishes nothing ────────────────────────────────────────────────

describe('a Matches action that fails publishes no success event', () => {
  it('creating for another club’s team publishes nothing', async () => {
    await expect(matches.createMatch(ACTOR_CTX, {
      homeTeam: 'A', awayTeam: 'B', isHome: true, competition: 'LEAGUE',
      scheduledAt: '2026-12-01T15:00:00Z', teamId: 'other-team',
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('an ILLEGAL status transition publishes nothing', async () => {
    // SCHEDULED → HALFTIME is not a legal move. The rule is the platform's and
    // is not bypassed; the rejection must leave no trace on the board.
    await expect(matches.updateMatch(ACTOR_CTX, MATCH, { status: 'HALFTIME' } as never))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
    expect(state.matches[0].status).toBe('SCHEDULED');
  });

  it('finalizing a match that never kicked off publishes nothing', async () => {
    // SCHEDULED → FT is not a legal move: a match cannot end without starting.
    await expect(matches.finalize(ACTOR_CTX, MATCH, 1, 0)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
    expect(state.matches[0].status).toBe('SCHEDULED');
  });

  it('re-finalizing a finished match announces no second completion', async () => {
    // `assertStatusTransition` returns early when from === to, so a repeated
    // finalize is a permitted no-op rather than an error. The status did not
    // move, so neither the transition nor the completion is announced again —
    // which is the behaviour that matters: a match completes once.
    state.matches[0].status = 'FT';
    state.matches[0].homeScore = 1;
    state.matches[0].awayScore = 0;
    state.matches[0].result = 'WIN';
    await matches.finalize(ACTOR_CTX, MATCH, 1, 0);
    await settle();

    expect(types()).not.toContain('match.completed');
    expect(types()).not.toContain('match.status.changed');
    expect(types()).not.toContain('match.result.updated');
  });

  it('starting a match that is already finished publishes nothing', async () => {
    state.matches[0].status = 'FT';
    await expect(matches.startLive(ACTOR_CTX, MATCH)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('updating another club’s match publishes nothing', async () => {
    state.matches.push({ id: 'm-other', clubId: OTHER_CLUB, teamId: null, status: 'SCHEDULED', scheduledAt: new Date(), venue: null, competition: 'LEAGUE' });
    await expect(matches.updateMatch(ACTOR_CTX, 'm-other', { homeTeam: 'x' } as never))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('abandoning a match that is already finished publishes nothing', async () => {
    state.matches[0].status = 'FT';
    await expect(matches.abandonMatch(ACTOR_CTX, MATCH)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('moving a match to another club’s team publishes nothing', async () => {
    await expect(matches.updateMatch(ACTOR_CTX, MATCH, { teamId: 'other-team' } as never))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });
});

// ── lineups and the live feed ────────────────────────────────────────────────

describe('lineups and match events carry counts, not people', () => {
  it('setLineup → one event with a side and a COUNT', async () => {
    await intel.setLineup(ACTOR_CTX, MATCH, {
      side: 'HOME', formation: '4-4-2', notes: SECRETS.lineupNotes,
      positions: [{ playerId: 'p-1' }, { playerId: 'p-2' }],
    } as never);
    await settle();

    expect(types()).toEqual(['match.lineup.updated']);
    const e = one('match.lineup.updated');
    expect(e.payload).toEqual({
      side: 'HOME', players: 2, teamKind: 'SENIOR', competition: 'LEAGUE', competitionId: null,
    });
    // The notes were written to the lineup and reached no event.
    expect(state.lineups[0].notes).toBe(SECRETS.lineupNotes);
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('right back');
    expect(wire).not.toContain('p-1');
  });

  it('a lineup for a player of another club publishes nothing', async () => {
    state.players.push({ id: 'p-elsewhere', clubId: OTHER_CLUB });
    await expect(intel.setLineup(ACTOR_CTX, MATCH, {
      side: 'HOME', positions: [{ playerId: 'p-elsewhere' }],
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });
});

// ── nothing private travels ──────────────────────────────────────────────────

describe('no match secret reaches the fabric or the board', () => {
  async function everything(): Promise<void> {
    await matches.updateMatch(ACTOR_CTX, MATCH, {
      venue: SECRETS.newVenue, scheduledAt: '2026-11-03T15:00:00Z',
      opponentNotes: SECRETS.opponentNotes, competitionName: SECRETS.competitionName,
      aiInsights: { weakness: 'left flank' },
    } as never);
    await intel.setLineup(ACTOR_CTX, MATCH, {
      side: 'HOME', formation: '4-4-2', notes: SECRETS.lineupNotes,
      positions: [{ playerId: 'p-1' }],
    } as never);
    state.matches[0].status = 'LIVE';
    await matches.finalize(ACTOR_CTX, MATCH, 2, 0);
    await settle();
  }

  it('carries no value from the match, the lineup or the notes', async () => {
    await everything();
    expect(published.length).toBeGreaterThan(0);

    const wire = JSON.stringify(published);
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(`${name} in events: ${wire.includes(value)}`).toBe(`${name} in events: false`);
    }
    expect(wire).not.toContain('left flank');
  });

  it('draws frames with no secret in them', async () => {
    await everything();
    for (const event of published) {
      const wire = JSON.stringify(project(event));
      for (const [name, value] of Object.entries(SECRETS)) {
        expect(`${name} in ${event.eventType} frame: ${wire.includes(value)}`)
          .toBe(`${name} in ${event.eventType} frame: false`);
      }
      expect(wire).not.toContain('payload');
    }
  });

  it('DOES let the match id through, because a match is not a person', async () => {
    await everything();
    for (const event of published) {
      expect(`${event.eventType} subjectId: ${project(event).subjectId}`)
        .toBe(`${event.eventType} subjectId: ${MATCH}`);
    }
  });

  it('every payload satisfies its own strict schema', async () => {
    await everything();
    for (const event of published) {
      const check = validateEventPayload(event.eventType, event.schemaVersion, event.payload);
      expect(`${event.eventType}: ${JSON.stringify(check)}`)
        .toBe(`${event.eventType}: ${JSON.stringify({ ok: true, validated: true })}`);
    }
    // Strict, so smuggling a venue or a scorer onto an event is caught.
    expect(validateEventPayload('match.venue.changed', 1, {
      route: 'EDIT', teamKind: null, competition: null, competitionId: null, to: SECRETS.newVenue,
    }).ok).toBe(false);
    expect(validateEventPayload('match.event.recorded', 1, {
      kind: 'GOAL', period: 2, source: 'MANUAL', events: 1,
      teamKind: null, competition: null, competitionId: null, player: 'Tomás',
    }).ok).toBe(false);
  });
});

// ── contexts ─────────────────────────────────────────────────────────────────

describe('one source, four contexts', () => {
  it('first team and academy both land on the Matches lane', async () => {
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeTeam: 'A' } as never);
    state.matches[0].teamId = ACADEMY_TEAM;
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeTeam: 'B' } as never);
    await settle();

    expect(published).toHaveLength(2);
    for (const e of published) expect(project(e).source).toBe('Matches');
    expect((published[0].payload as Row).teamKind).toBe('SENIOR');
    expect((published[1].payload as Row).teamKind).toBe('ACADEMY_U17');
  });

  it('carries the competition type, so a friendly is not a league match', async () => {
    state.matches[0].competition = 'FRIENDLY';
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeTeam: 'A' } as never);
    await settle();
    expect((published[0].payload as Row).competition).toBe('FRIENDLY');
  });

  it('carries the Familista League competition id when played as a fixture', async () => {
    state.fixtures.push({ id: 'f-1', matchId: MATCH, competitionId: COMP });
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeTeam: 'A' } as never);
    await settle();
    expect((published[0].payload as Row).competitionId).toBe(COMP);
  });

  it('answers null for a club fixture that belongs to no competition', async () => {
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeTeam: 'A' } as never);
    await settle();
    expect((published[0].payload as Row).competitionId).toBeNull();
  });

  it('a match with no team reports teamKind null rather than guessing', async () => {
    state.matches[0].teamId = null;
    await matches.updateMatch(ACTOR_CTX, MATCH, { homeTeam: 'A' } as never);
    await settle();
    expect((published[0].payload as Row).teamKind).toBeNull();
  });

  it('every event carries the full context, whatever it is', async () => {
    state.fixtures.push({ id: 'f-1', matchId: MATCH, competitionId: COMP });
    state.matches[0].status = 'LIVE';
    await matches.finalize(ACTOR_CTX, MATCH, 1, 0);
    await settle();

    expect(published.length).toBe(4);
    for (const e of published) {
      const p = e.payload as Row;
      expect(`${e.eventType} ctx: ${p.teamKind}/${p.competition}/${p.competitionId}`)
        .toBe(`${e.eventType} ctx: SENIOR/LEAGUE/${COMP}`);
    }
  });
});

// ── a broken fabric does not break a match ───────────────────────────────────

describe('observability cannot break a Matches operation', () => {
  it('survives a transport that throws on every append', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('storage is down'); },
      async read() { return []; },
    } as EventTransport);

    state.matches[0].status = 'LIVE';
    const done = await matches.finalize(ACTOR_CTX, MATCH, 4, 0);
    await settle();
    expect(done.status).toBe('FT');
    expect(done.homeScore).toBe(4);
    expect(state.audit.length).toBeGreaterThan(0);
  });

  it('survives an unregistered name, and still routes it to Matches', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({ eventType: 'match.telepathy.detected' });
    expect(result.registered).toBe(false);
    expect(result.stored).toBe(true);
    expect(registryHealth().unknownEventTypes).toContain('match.telepathy.detected');
    expect(sourceLaneFor('match.telepathy.detected')).toBe('Matches');
  });

  it('quarantines an invalid payload without failing the caller', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({
      eventType: 'match.lineup.updated',
      payload: { side: 'HOME', players: 11, teamKind: null, competition: null, competitionId: null, notes: SECRETS.lineupNotes },
    });
    expect(result.schema.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    expect(result.stored).toBe(true);
  });
});

// ── the board understands them with no UI change ─────────────────────────────

describe('Live Data Flow recognises the Matches types automatically', () => {
  it('marks every produced event registered and routes it to Matches', async () => {
    state.matches[0].status = 'LIVE';
    await matches.finalize(ACTOR_CTX, MATCH, 2, 1);
    await settle();

    expect(published.length).toBe(4);
    for (const event of published) {
      const frame = project(event);
      expect(`${event.eventType} registered: ${frame.registered}`).toBe(`${event.eventType} registered: true`);
      expect(`${event.eventType} source: ${frame.source}`).toBe(`${event.eventType} source: Matches`);
      expect(frame.destination).toBe('Operational Data');
      expect(frame.status).toBe('STORED');
    }
  });

  it('adds no source card — the board still draws exactly ten lanes', () => {
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Medical', 'Media', 'AI', 'System',
    ]);
    expect(visibleFabricSources()).toHaveLength(10);
    expect(pulseTopology().sources).toHaveLength(10);
  });

  it('a FUTURE competition adds no card either', () => {
    // The whole point: a cup, a tournament, an international — all of it is a
    // property of a match, so none of it is a source.
    const { registerFabricEvent } = require('../src/fabric/registry/event-registry');
    registerFabricEvent({ type: 'match.tournament.seeded', entityType: 'MATCH' });
    expect(sourceLanes()).toHaveLength(10);
    expect(fabricEvent('match.tournament.seeded')?.source).toBe('matches');
  });

  it('needs no edit to the Live Data Flow page', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', 'public/data-pulse.js'), 'utf8');
    for (const type of [
      'match.created', 'match.updated', 'match.deleted', 'match.cancelled',
      'match.status.changed', 'match.time.changed', 'match.venue.changed',
      'match.lineup.updated', 'match.result.updated',
    ]) {
      expect(`${type} hard-coded in the page: ${client.includes(type)}`)
        .toBe(`${type} hard-coded in the page: false`);
    }
  });

  it('registers all twelve types under the matches source', () => {
    const all = fabricEventsForSource('matches').map((e) => e.type);
    for (const t of [
      'match.created', 'match.updated', 'match.deleted', 'match.started',
      'match.completed', 'match.cancelled', 'match.status.changed',
      'match.time.changed', 'match.venue.changed', 'match.lineup.updated',
      'match.result.updated', 'match.event.recorded',
    ]) {
      expect(`${t} registered: ${isRegisteredEventType(t)}`).toBe(`${t} registered: true`);
      expect(`${t} under matches: ${all.includes(t)}`).toBe(`${t} under matches: true`);
      expect(`${t} lane: ${sourceLaneFor(t)}`).toBe(`${t} lane: Matches`);
    }
  });

  it('keeps the legacy MATCH_EVENT bridge intact', () => {
    const { canonicalNameForLegacyKind } = require('../src/fabric/registry/event-registry');
    expect(canonicalNameForLegacyKind('MATCH_EVENT')).toBe('match.event.recorded');
  });
});
