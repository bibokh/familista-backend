/**
 * tests/fabric-players-producer.unit.test.ts
 *
 * The Players domain as a Data Fabric producer.
 *
 * This is the second domain migrated and the first with an EXISTING producer to
 * replace, which makes one property matter more than any other here:
 *
 * ONE — NOTHING IS PUBLISHED TWICE. `player.service.ts` has emitted through the
 * raw `emit()` since the fabric existed. Those calls were rerouted, not added
 * to. A test that only checked "the new event appears" would pass just as well
 * against a service that published everything twice, so every assertion below
 * is on the EXACT SET of events an action produced, never on membership.
 *
 * TWO — A SPECIFIC EVENT MEANS THAT SPECIFIC THING MOVED. `player.updated` is
 * the umbrella and fires for every successful update. The specialised events —
 * position, status, squad, team — fire only when that field actually changed
 * VALUE. Resending a player's existing position in a PUT is not a transfer to a
 * new position, and an event saying otherwise is a lie a consumer would act on.
 *
 * THREE — A CHILD'S DATA DOES NOT TRAVEL. A player row holds a date of birth, a
 * parent's name, email and telephone, a medical status, a wage and free-text
 * notes. The tests drive the REAL service with all of it populated and then
 * search every event and every frame for every value.
 *
 * FOUR — ACADEMY AND FIRST TEAM ARE ONE SOURCE, TOLD APART. Both land on the
 * Players lane; `teamKind` is what distinguishes `ACADEMY_U17` from `SENIOR`.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const SENIOR_TEAM = '33333333-3333-4333-8333-333333333333';
const ACADEMY_TEAM = '44444444-4444-4444-8444-444444444444';
const PLAYER = '55555555-5555-4555-8555-555555555555';
const ACTOR = 'u-actor';

/** Every one of these is on the player row and must never travel. */
const SECRETS = {
  dateOfBirth: '2012-06-04',
  parentName: 'Ingrid Müller-Fernández',
  parentEmail: 'ingrid.muller@example.com',
  parentPhone: '+49 151 23456789',
  email: 'tomas.junior@example.com',
  notes: 'Struggles after his parents’ separation — handle with care',
  medicalStatus: 'INJURED',
  avatar: 'https://cdn.example.com/portraits/tomas.jpg',
  weeklyWage: '48500',
};

const state = { players: [] as Row[], teams: [] as Row[], audit: [] as Row[] };

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
    }
    return row[k] === v;
  });

/** Prisma hands back detached rows; so does this. */
const copy = <T>(row: T): T => (row == null ? row : JSON.parse(JSON.stringify(row)) as T);

const db: Row = {
  player: {
    findUnique: async ({ where, select }: Row) => {
      const p = state.players.find((x) => x.id === where.id);
      if (!p) return null;
      if (select?.team) {
        const team = state.teams.find((t) => t.id === p.teamId);
        return copy({ ...p, team: team ? { kind: team.kind } : null });
      }
      return copy(p);
    },
    findFirst: async ({ where = {} }: Row = {}) => copy(state.players.find((p) => match(p, where)) ?? null),
    findMany: async ({ where = {} }: Row = {}) => copy(state.players.filter((p) => match(p, where))),
    count: async ({ where = {} }: Row = {}) => state.players.filter((p) => match(p, where)).length,
    create: async ({ data }: Row) => {
      const row = { id: `p-${state.players.length + 1}`, isActive: true, teamId: null, ...data };
      state.players.push(row);
      return copy(row);
    },
    update: async ({ where, data }: Row) => {
      const p = state.players.find((x) => x.id === where.id)!;
      Object.assign(p, data);
      return copy(p);
    },
    delete: async ({ where }: Row) => {
      const i = state.players.findIndex((x) => x.id === where.id);
      return i >= 0 ? copy(state.players.splice(i, 1)[0]) : null;
    },
  },
  team: {
    findUnique: async ({ where }: Row) => copy(state.teams.find((t) => t.id === where.id) ?? null),
    findFirst: async ({ where = {} }: Row = {}) => copy(state.teams.find((t) => match(t, where)) ?? null),
  },
  playerAuditLog: {
    create: async ({ data }: Row) => { state.audit.push(data); return data; },
    findMany: async () => [],
    count: async () => 0,
  },
  playerAttribute: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor, pulseTopology } from '../src/fabric/pulse/pulse.service';
import { fabricEvent, fabricEventsForSource, isRegisteredEventType } from '../src/fabric/registry/event-registry';
import { sourceLanes, visibleFabricSources } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { registryHealth, resetRegistryHealth } from '../src/fabric/registry/unknown-events';
import '../src/fabric/producers/players.producer';

import * as playerService from '../src/services/player.service';

let published: FamilistaEvent[] = [];

/** Publishing is detached; three turns drains the whole chain comfortably. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) await new Promise((r) => setImmediate(r));
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
  state.players = [{
    id: PLAYER,
    clubId: CLUB,
    teamId: SENIOR_TEAM,
    firstName: 'Tomás',
    lastName: 'Müller-Fernández',
    number: 9,
    position: 'CF',
    nationality: 'DE',
    dateOfBirth: new Date(SECRETS.dateOfBirth),
    isActive: true,
    medicalStatus: SECRETS.medicalStatus,
    paymentStatus: 'PAID',
    avatar: SECRETS.avatar,
    email: SECRETS.email,
    parentName: SECRETS.parentName,
    parentEmail: SECRETS.parentEmail,
    parentPhone: SECRETS.parentPhone,
    notes: SECRETS.notes,
    weeklyWage: Number(SECRETS.weeklyWage),
  }];
  state.audit = [];
});

afterEach(async () => { await settle(); });
afterAll(async () => { await settle(); setEventTransport(null); });

const types = () => published.map((e) => e.eventType).sort();
const one = (type: string) => {
  const hits = published.filter((e) => e.eventType === type);
  expect(`${type} count: ${hits.length}`).toBe(`${type} count: 1`);
  return hits[0];
};

// ── one action, one set of events ────────────────────────────────────────────

describe('a successful Players action publishes exactly the right events', () => {
  it('createPlayer → player.created, once, carrying the squad kind', async () => {
    await playerService.createPlayer(ACTOR_CTX, {
      firstName: 'Ana', lastName: 'Silva', number: 7, position: 'LW',
      nationality: 'PT', dateOfBirth: '2013-01-02', teamId: ACADEMY_TEAM,
      parentEmail: 'someone@example.com',
    } as never);
    await settle();

    expect(types()).toEqual(['player.created']);
    const e = one('player.created');
    expect(e).toMatchObject({ clubId: CLUB, teamId: ACADEMY_TEAM, subjectType: 'PLAYER' });
    expect(e.payload).toEqual({ teamKind: 'ACADEMY_U17' });
    expect(validateEventPayload('player.created', 1, e.payload).ok).toBe(true);
  });

  it('an update of one ordinary field is ONE event', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { number: 11 } as never);
    await settle();

    expect(types()).toEqual(['player.updated']);
    expect(one('player.updated').payload).toEqual({
      changedFields: ['number'], teamKind: 'SENIOR',
    });
  });

  it('a position change is the umbrella AND the specific fact, each once', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { position: 'CB' } as never);
    await settle();

    expect(types()).toEqual(['player.position.changed', 'player.updated']);
    expect(one('player.position.changed').payload).toEqual({
      from: 'CF', to: 'CB', teamKind: 'SENIOR',
    });
  });

  it('resending the SAME position changes nothing and says nothing', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { position: 'CF' } as never);
    await settle();
    // The umbrella still fires — the caller did ask for an update — but no
    // position event, because the position did not move.
    expect(types()).toEqual(['player.updated']);
  });

  it('a personal detail is RESTRICTED and named, never valued', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, {
      parentPhone: '+49 151 99999999', lastName: 'Müller',
    } as never);
    await settle();

    expect(types()).toEqual(['player.profile.updated', 'player.updated']);
    const e = one('player.profile.updated');
    expect(e.dataClassification).toBe('RESTRICTED');
    expect(e.payload).toEqual({
      changedFields: ['parentPhone', 'lastName'], teamKind: 'SENIOR',
    });
    expect(JSON.stringify(e)).not.toContain('99999999');
  });

  it('a medical change names the field and never the diagnosis', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { medicalStatus: 'FIT' } as never);
    await settle();

    // The Players half is unchanged. The same commit is also told to the
    // MEDICAL source, which is a different fact for a different consumer —
    // see `fabric/producers/medical.producer.ts`.
    expect(types()).toEqual([
      'medical.availability.changed', 'medical.status.updated',
      'player.status.changed', 'player.updated',
    ]);
    const e = one('player.status.changed');
    expect(e.dataClassification).toBe('RESTRICTED');
    expect(e.payload).toEqual({ changedFields: ['medicalStatus'], teamKind: 'SENIOR' });
    // Neither the status he had nor the one he now has — on ANY of the four.
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('INJURED');
    expect(wire).not.toContain('FIT');
  });

  it('moving between squads is team.changed, not added or removed', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { teamId: ACADEMY_TEAM } as never);
    await settle();

    expect(types()).toEqual(['player.team.changed', 'player.updated']);
    expect(one('player.team.changed').payload).toEqual({ from: 'SENIOR', to: 'ACADEMY_U17' });
  });

  it('joining a squad from none is squad.added', async () => {
    state.players[0].teamId = null;
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { teamId: ACADEMY_TEAM } as never);
    await settle();

    expect(types()).toEqual(['player.squad.added', 'player.updated']);
    expect(one('player.squad.added').payload).toEqual({ teamKind: 'ACADEMY_U17' });
  });

  it('leaving a squad without leaving the club is squad.removed', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { teamId: null } as never);
    await settle();

    expect(types()).toEqual(['player.squad.removed', 'player.updated']);
    expect(one('player.squad.removed').payload).toEqual({ teamKind: 'SENIOR' });
  });

  it('a photograph is its own RESTRICTED event, beside the profile one', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { avatar: 'media:abc123' } as never);
    await settle();

    expect(types()).toEqual(['player.photo.attached', 'player.profile.updated', 'player.updated']);
    expect(one('player.photo.attached').dataClassification).toBe('RESTRICTED');
    expect(one('player.updated').dataClassification).toBe('CONFIDENTIAL');
  });

  it('several facts in one call produce several events, each exactly once', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, {
      position: 'GK', teamId: ACADEMY_TEAM, medicalStatus: 'FIT', firstName: 'Tomas',
    } as never);
    await settle();

    expect(types()).toEqual([
      'medical.availability.changed', 'medical.status.updated',
      'player.position.changed', 'player.profile.updated',
      'player.status.changed', 'player.team.changed', 'player.updated',
    ]);
  });

  it('softDeletePlayer → status.changed, once', async () => {
    await playerService.softDeletePlayer(ACTOR_CTX, PLAYER);
    await settle();
    expect(types()).toEqual(['player.status.changed']);
    expect(one('player.status.changed').payload).toEqual({
      changedFields: ['isActive'], teamKind: 'SENIOR',
    });
  });

  it('reactivatePlayer → status.changed, once', async () => {
    state.players[0].isActive = false;
    await playerService.reactivatePlayer(ACTOR_CTX, PLAYER);
    await settle();
    expect(types()).toEqual(['player.status.changed']);
  });
});

// ── a failed action publishes nothing ────────────────────────────────────────

describe('a Players action that fails publishes no success event', () => {
  it('creating with a team from another club publishes nothing', async () => {
    await expect(playerService.createPlayer(ACTOR_CTX, {
      firstName: 'A', lastName: 'B', number: 21, position: 'CM',
      nationality: 'DE', dateOfBirth: '2010-01-01', teamId: 'other-team',
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('creating with a team that does not exist publishes nothing', async () => {
    await expect(playerService.createPlayer(ACTOR_CTX, {
      firstName: 'A', lastName: 'B', number: 22, position: 'CM',
      nationality: 'DE', dateOfBirth: '2010-01-01', teamId: 'no-such-team',
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('creating on a shirt number already taken publishes nothing', async () => {
    await expect(playerService.createPlayer(ACTOR_CTX, {
      firstName: 'A', lastName: 'B', number: 9, position: 'CM',
      nationality: 'DE', dateOfBirth: '2010-01-01',
    } as never)).rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('updating a player of another club publishes nothing', async () => {
    state.players.push({ id: 'p-other', clubId: OTHER_CLUB, teamId: null, isActive: true, position: 'CM' });
    await expect(playerService.updatePlayer(ACTOR_CTX, 'p-other', { number: 5 } as never))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('moving a player into another club’s team publishes nothing', async () => {
    await expect(playerService.updatePlayer(ACTOR_CTX, PLAYER, { teamId: 'other-team' } as never))
      .rejects.toBeDefined();
    await settle();
    expect(published).toHaveLength(0);
  });

  it('soft-deleting an already inactive player publishes nothing', async () => {
    state.players[0].isActive = false;
    await playerService.softDeletePlayer(ACTOR_CTX, PLAYER);
    await settle();
    expect(published).toHaveLength(0);
  });

  it('reactivating an already active player publishes nothing', async () => {
    await playerService.reactivatePlayer(ACTOR_CTX, PLAYER);
    await settle();
    expect(published).toHaveLength(0);
  });
});

// ── no double publishing ─────────────────────────────────────────────────────

describe('nothing is published twice', () => {
  it('the service publishes through the fabric producer and NOT through raw emit', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/player.service.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

    // The legacy road is gone. Leaving it beside the new one is the single most
    // likely way a migration like this doubles every event on the board.
    expect(code).not.toMatch(/\bemit\(\s*\{/);
    expect(code).not.toMatch(/from '\.\.\/fabric'/);
    expect(code).toMatch(/from '\.\.\/fabric\/producers\/players\.producer'/);
  });

  it('routes every player event through the one adapter', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/player.service.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const adapter = code.slice(code.indexOf('function emitPlayerEvent('), code.indexOf('const PROFILE_FIELDS'));

    // Every `publishPlayer*` call sits inside `emitPlayerEvent`, so the source
    // scan that proves nothing is published inside a transaction covers them
    // all by covering one name. The import block names them too, which is not
    // a call — dropped before the search rather than loosening the pattern.
    const body = code.slice(code.indexOf("} from '../fabric/producers/players.producer';"));
    expect(body.replace(adapter, '')).not.toMatch(/publishPlayer[A-Z]/);
  });

  it('publishes one transfer per settlement, from one place', () => {
    const events = fs.readFileSync(path.join(__dirname, '..', 'src/transfer-market/transfer-events.ts'), 'utf8');
    expect(events).toMatch(/function publishTransferToFabric/);
    // Three settlement routes, one fabric call between them.
    for (const f of ['transfer-market.service.ts', 'transfer-negotiation.service.ts', 'transfer-auction.service.ts']) {
      const body = fs.readFileSync(path.join(__dirname, '..', 'src/transfer-market', f), 'utf8');
      expect(`${f} publishes directly: ${/publishPlayerTransferred/.test(body)}`)
        .toBe(`${f} publishes directly: false`);
    }
  });

  it('never publishes inside a transaction', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/services/player.service.ts'), 'utf8')
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
      expect(`span ${spans}: ${inside.includes('emitPlayerEvent(') ? 'EMIT INSIDE' : 'clean'}`)
        .toBe(`span ${spans}: clean`);
      spans += 1; from = end;
    }
    expect(spans).toBeGreaterThanOrEqual(2);
  });
});

// ── nothing private travels ──────────────────────────────────────────────────

describe('no player secret reaches the fabric or the board', () => {
  async function everything(): Promise<void> {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, {
      firstName: 'Tomas', parentPhone: '+49 151 00000000', medicalStatus: 'FIT',
      position: 'GK', teamId: ACADEMY_TEAM, avatar: 'media:xyz', notes: 'new note',
      weeklyWage: 99000,
    } as never);
    await playerService.softDeletePlayer(ACTOR_CTX, PLAYER);
    await settle();
  }

  it('carries no value from the player row', async () => {
    await everything();
    expect(published.length).toBeGreaterThan(0);

    const wire = JSON.stringify(published);
    for (const [name, value] of Object.entries(SECRETS)) {
      expect(`${name} in events: ${wire.includes(value)}`).toBe(`${name} in events: false`);
    }
    // Nor the values the caller just supplied.
    for (const v of ['+49 151 00000000', 'new note', '99000', 'media:xyz']) {
      expect(`"${v}" in events: ${wire.includes(v)}`).toBe(`"${v}" in events: false`);
    }
  });

  it('draws frames with no secret and no personal identifier', async () => {
    await everything();
    for (const event of published) {
      const frame = project(event);
      const wire = JSON.stringify(frame);
      for (const [name, value] of Object.entries(SECRETS)) {
        expect(`${name} in ${event.eventType} frame: ${wire.includes(value)}`)
          .toBe(`${name} in ${event.eventType} frame: false`);
      }
      // A PLAYER subject is a person — often a child. The id never travels.
      expect(`${event.eventType} subjectId: ${frame.subjectId}`)
        .toBe(`${event.eventType} subjectId: null`);
      expect(wire).not.toContain('payload');
    }
  });

  it('carries only names, tokens and booleans in every payload', async () => {
    await everything();
    for (const event of published) {
      for (const value of Object.values(event.payload as Record<string, unknown>)) {
        const values = Array.isArray(value) ? value : [value];
        for (const v of values) {
          if (v === null || typeof v === 'boolean') continue;
          expect(`${event.eventType} carries "${v}": ${/^[A-Za-z][\w.-]{0,39}$/.test(String(v))}`)
            .toBe(`${event.eventType} carries "${v}": true`);
        }
      }
    }
  });

  it('every payload satisfies its own schema', async () => {
    await everything();
    for (const event of published) {
      const check = validateEventPayload(event.eventType, event.schemaVersion, event.payload);
      expect(`${event.eventType}: ${JSON.stringify(check)}`)
        .toBe(`${event.eventType}: ${JSON.stringify({ ok: true, validated: true })}`);
    }
    // The new schemas are strict, so a stray field is caught.
    expect(validateEventPayload('player.status.changed', 1, {
      changedFields: ['medicalStatus'], teamKind: 'SENIOR', medicalStatus: 'INJURED',
    }).ok).toBe(false);
  });
});

// ── academy and first team ───────────────────────────────────────────────────

describe('Academy and First Team are one source, told apart', () => {
  it('both land on the Players lane', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { number: 12 } as never);
    state.players[0].teamId = ACADEMY_TEAM;
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { number: 13 } as never);
    await settle();

    expect(published).toHaveLength(2);
    for (const e of published) expect(project(e).source).toBe('Players');
  });

  it('distinguishes them by teamKind, not by lane', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { number: 12 } as never);
    await settle();
    expect((published[0].payload as Row).teamKind).toBe('SENIOR');

    published = [];
    state.players[0].teamId = ACADEMY_TEAM;
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { number: 13 } as never);
    await settle();
    expect((published[0].payload as Row).teamKind).toBe('ACADEMY_U17');
  });

  it('a player in no squad reports teamKind null rather than guessing', async () => {
    state.players[0].teamId = null;
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, { number: 14 } as never);
    await settle();
    expect((published[0].payload as Row).teamKind).toBeNull();
  });
});

// ── a broken fabric does not break a squad edit ──────────────────────────────

describe('observability cannot break a Players operation', () => {
  it('survives a transport that throws on every append', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('storage is down'); },
      async read() { return []; },
    } as EventTransport);

    const updated = await playerService.updatePlayer(ACTOR_CTX, PLAYER, { number: 15 } as never);
    await settle();
    expect(updated.number).toBe(15);
    expect(state.audit).toHaveLength(1);
  });

  it('survives an unregistered name, and still routes it to Players', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({ eventType: 'player.telepathy.detected' });
    expect(result.registered).toBe(false);
    expect(result.stored).toBe(true);
    expect(registryHealth().unknownEventTypes).toContain('player.telepathy.detected');
    expect(sourceLaneFor('player.telepathy.detected')).toBe('Players');
  });

  it('quarantines an invalid payload without failing the caller', async () => {
    const { publishFabricEvent } = require('../src/fabric/registry/publisher');
    const result = await publishFabricEvent({
      eventType: 'player.status.changed',
      payload: { changedFields: ['medicalStatus'], teamKind: 'SENIOR', diagnosis: 'torn ACL' },
    });
    expect(result.schema.ok).toBe(false);
    expect(result.quarantined).toBe(true);
    expect(result.stored).toBe(true);
  });
});

// ── the board understands them with no UI change ─────────────────────────────

describe('Live Data Flow recognises the Players types automatically', () => {
  it('marks every produced event registered and routes it to Players', async () => {
    await playerService.updatePlayer(ACTOR_CTX, PLAYER, {
      position: 'GK', teamId: ACADEMY_TEAM, medicalStatus: 'FIT', firstName: 'Tomas',
    } as never);
    await settle();

    expect(published.length).toBe(7);
    const players = published.filter((e) => e.eventType.startsWith('player.'));
    const medical = published.filter((e) => e.eventType.startsWith('medical.'));
    expect(players).toHaveLength(5);
    // A medical status move is a medical fact and lands on the Medical lane,
    // not on this one. It is the same commit, not the same event.
    expect(medical).toHaveLength(2);

    for (const event of players) {
      const frame = project(event);
      expect(`${event.eventType} registered: ${frame.registered}`).toBe(`${event.eventType} registered: true`);
      expect(`${event.eventType} source: ${frame.source}`).toBe(`${event.eventType} source: Players`);
      expect(frame.destination).toBe('Operational Data');
      expect(frame.status).toBe('STORED');
    }
    for (const event of medical) {
      const frame = project(event);
      expect(`${event.eventType} registered: ${frame.registered}`).toBe(`${event.eventType} registered: true`);
      expect(`${event.eventType} source: ${frame.source}`).toBe(`${event.eventType} source: Medical`);
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

  it('a NEW Players feature adds no card either', () => {
    const { registerFabricEvent } = require('../src/fabric/registry/event-registry');
    registerFabricEvent({ type: 'player.contract.extended', entityType: 'PLAYER' });
    expect(sourceLanes()).toHaveLength(10);
    expect(fabricEvent('player.contract.extended')?.source).toBe('players');
  });

  it('needs no edit to the Live Data Flow page', () => {
    const client = fs.readFileSync(path.join(__dirname, '..', 'public/data-pulse.js'), 'utf8');
    for (const type of [
      'player.profile.updated', 'player.position.changed', 'player.status.changed',
      'player.team.changed', 'player.squad.added', 'player.squad.removed', 'player.transferred',
    ]) {
      expect(`${type} hard-coded in the page: ${client.includes(type)}`)
        .toBe(`${type} hard-coded in the page: false`);
    }
  });

  it('registers ten Players types, all of them under the players source', () => {
    const all = fabricEventsForSource('players').map((e) => e.type);
    for (const t of [
      'player.created', 'player.updated', 'player.photo.attached', 'player.transferred',
      'player.profile.updated', 'player.position.changed', 'player.status.changed',
      'player.team.changed', 'player.squad.added', 'player.squad.removed',
    ]) {
      expect(`${t} registered: ${isRegisteredEventType(t)}`).toBe(`${t} registered: true`);
      expect(`${t} under players: ${all.includes(t)}`).toBe(`${t} under players: true`);
      expect(`${t} lane: ${sourceLaneFor(t)}`).toBe(`${t} lane: Players`);
    }
  });
});
