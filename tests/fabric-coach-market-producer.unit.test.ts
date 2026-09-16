/**
 * tests/fabric-coach-market-producer.unit.test.ts
 *
 * The Coach Market as a Data Fabric producer, and the separation that is the
 * whole point of it.
 *
 * TWO MARKETS, TWO SOURCES
 *
 * Familista moves footballers under `transfers` and staff under `coach-market`.
 * They share a shape — a shortlist, an offer, a negotiation, a completion — and
 * nothing else, and the shared shape is exactly why they are easy to merge by
 * accident. So the separation is asserted STRUCTURALLY here rather than
 * trusted: no `coach.*` or `staff.*` name is owned by `transfers`, no
 * `transfer.*` name by `coach-market`, and neither service reaches the other's
 * producer.
 *
 * WHAT NEVER TRAVELS
 *
 * A staff approach is made almost entirely of money and private words: a
 * salary, a compensation figure owed to the club he is leaving, a release
 * clause, bonuses, a duration, a start date and a free-text message. Beside it
 * sits a shortlist entry holding a club's private note about a person, and an
 * engagement holding a renewal status somebody typed. All of it is planted
 * below and searched for in every representation.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB_A = '11111111-1111-4111-8111-111111111111';   // recruiting
const CLUB_B = '22222222-2222-4222-8222-222222222222';   // employing
const COACH = '33333333-3333-4333-8333-333333333333';
const ACTOR = 'u-actor';

/** Everything a staff approach holds that must never leave the module. */
const SECRETS = {
  salary: 480000,
  compensation: 250000,
  releaseClause: 1200000,
  bonuses: 'Promotion bonus 120k, top-four bonus 60k, paid on the final whistle',
  message: 'We will double what Hertha pay him. Do not let his agent see this before Friday.',
  clubNote: 'His wife will not move north — lead with the relocation package, not the money.',
  renewalStatus: 'In talks with Bayern, wants out by June',
  email: 'tomas.muller-fernandez@example.test',
  phone: '+49 170 9998877',
  coachName: 'Tomás Müller-Fernández',
  needNote: 'Replacing the GK coach quietly before anyone notices he has gone',
};

const state = {
  users: [] as Row[], profiles: [] as Row[], approaches: [] as Row[],
  messages: [] as Row[], shortlist: [] as Row[], needs: [] as Row[],
  engagements: [] as Row[], memberships: [] as Row[], clubs: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((o) => match(row, o));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
    }
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const copy = <T>(row: T): T => {
  if (row == null) return row;
  return JSON.parse(
    JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    (_k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v),
  ) as T;
};

/** Attach the relations a service asked for by `include`. */
const withIncludes = (row: Row | null | undefined, include: Row | undefined) => {
  if (!row || !include) return row ?? null;
  const out = { ...row };
  if (include.staffUser) out.staffUser = state.users.find((u) => u.id === row.staffUserId) ?? null;
  if (include.fromClub) out.fromClub = state.clubs.find((c) => c.id === row.fromClubId) ?? null;
  if (include.messages) out.messages = state.messages.filter((m) => m.approachId === row.id);
  if (include.user) out.user = state.users.find((u) => u.id === row.userId) ?? null;
  if (include.club) out.club = state.clubs.find((c) => c.id === row.clubId) ?? null;
  // A profile is read with its record hanging off it. Empty is the honest
  // answer for a fixture that has not filled one in.
  for (const rel of ['licences', 'trophies', 'seasons', 'engagements']) {
    if (include[rel]) out[rel] = [];
  }
  return out;
};

const table = (rows: () => Row[], prefix: string, defaults: Row = {}) => ({
  findUnique: async ({ where, include }: Row) => {
    const key = where.clubId_staffUserId;
    if (key) {
      return copy(rows().find((r) => r.clubId === key.clubId && r.staffUserId === key.staffUserId) ?? null);
    }
    if (where.userId) return copy(withIncludes(rows().find((r) => r.userId === where.userId), include));
    if (where.email) return copy(rows().find((r) => r.email === where.email) ?? null);
    return copy(withIncludes(rows().find((r) => r.id === where.id), include));
  },
  findFirst: async ({ where = {}, include }: Row = {}) => copy(withIncludes(rows().find((r) => match(r, where)), include)),
  findMany: async ({ where = {}, include }: Row = {}) => copy(rows().filter((r) => match(r, where)).map((r) => withIncludes(r, include))),
  count: async ({ where = {} }: Row = {}) => rows().filter((r) => match(r, where)).length,
  create: async ({ data }: Row) => {
    const row = { id: data.id ?? `${prefix}-${rows().length + 1}`, createdAt: new Date(), ...defaults, ...data };
    // Nested creates the services use (`staffProfile: { create: {...} }`).
    for (const [k, v] of Object.entries(row)) {
      if (v && typeof v === 'object' && 'create' in (v as Row)) {
        if (k === 'staffProfile') state.profiles.push({ id: `sp-${state.profiles.length + 1}`, userId: row.id, ...(v as Row).create });
        delete row[k];
      } else if (v && typeof v === 'object' && 'connect' in (v as Row)) {
        row[`${k}Id`] = (v as Row).connect.id; delete row[k];
      }
    }
    rows().push(row); return copy(row);
  },
  update: async ({ where, data }: Row) => {
    const r = rows().find((x) => x.id === where.id) ?? rows().find((x) => x.userId === where.userId)!;
    for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v;
    return copy(r);
  },
  updateMany: async ({ where = {}, data }: Row = {}) => {
    const hits = rows().filter((r) => match(r, where));
    hits.forEach((r) => { for (const [k, v] of Object.entries(data)) if (v !== undefined) r[k] = v; });
    return { count: hits.length };
  },
  deleteMany: async ({ where = {} }: Row = {}) => {
    const keep = rows().filter((r) => !match(r, where));
    const removed = rows().length - keep.length;
    rows().length = 0; rows().push(...keep);
    return { count: removed };
  },
  upsert: async ({ where, create, update }: Row) => {
    const key = where.clubId_staffUserId;
    const found = key
      ? rows().find((r) => r.clubId === key.clubId && r.staffUserId === key.staffUserId)
      : rows().find((r) => (where.userId ? r.userId === where.userId : r.id === where.id));
    if (found) { for (const [k, v] of Object.entries(update)) if (v !== undefined) found[k] = v; return copy(found); }
    const row = { id: `${prefix}-${rows().length + 1}`, createdAt: new Date(), ...defaults, ...create };
    rows().push(row); return copy(row);
  },
});

const db: Row = {
  user: table(() => state.users, 'u'),
  // The array columns a profile read spreads. Empty is the honest answer for a
  // fixture nobody has filled in, and an absent column is not the same as one.
  staffProfile: table(() => state.profiles, 'sp', {
    availability: 'EMPLOYED', careerIntent: 'NOT_LOOKING',
    specialities: [], philosophy: [], dominantPhilosophy: [], trainingMethods: [],
    secondaryFormations: [], preferredRoles: [], preferredCountries: [], preferredLeagues: [],
    languages: [],
  }),
  staffApproach: table(() => state.approaches, 'ap', { status: 'DRAFT' }),
  staffApproachMessage: table(() => state.messages, 'msg'),
  staffShortlist: table(() => state.shortlist, 'sl'),
  staffNeed: table(() => state.needs, 'need', { isActive: true, priority: 'NORMAL' }),
  staffEngagement: table(() => state.engagements, 'eng', { isActive: true }),
  membership: table(() => state.memberships, 'm', { isActive: true }),
  club: table(() => state.clubs, 'club'),
  staffLicence: table(() => [], 'lic'),
  staffTrophy: table(() => [], 'tr'),
  staffSeason: table(() => [], 'se'),
  staffClubNote: table(() => [], 'note'),
  team: table(() => [], 'team'),
  platformAuditEvent: { create: async ({ data }: Row) => data },
  auditEvent: { create: async ({ data }: Row) => data },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import { resetFabricSelfHealth } from '../src/fabric/producers/system.producer';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor } from '../src/fabric/pulse/pulse.service';
import { resolveSubjects } from '../src/fabric/pulse/subject-resolver.service';
import { fabricEvent, fabricEventsForSource } from '../src/fabric/registry/event-registry';
import { visibleFabricSources, sourceLanes, fabricSource } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import { makeEvent } from '../src/fabric/event-envelope';
import '../src/fabric/producers/coach-market.producer';
import '../src/fabric/producers/transfers.producer';

import * as market from '../src/staff-market/staff-market.service';

let published: FamilistaEvent[] = [];

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const A = { userId: ACTOR, clubId: CLUB_A };   // the recruiting club
const B = { userId: 'u-b', clubId: CLUB_B };   // the employing club

beforeEach(() => {
  published = [];
  setEventTransport(transport);
  resetFabricSelfHealth();
  state.users = [{
    id: COACH, firstName: 'Tomás', lastName: 'Müller-Fernández',
    email: SECRETS.email, phone: SECRETS.phone, isActive: true, clubId: CLUB_B,
  }];
  state.profiles = [];
  state.approaches = [];
  state.messages = [];
  state.shortlist = [];
  state.needs = [];
  state.engagements = [];
  // Employed by SV Nord. That is what makes CLUB_A's approach a two-club
  // conversation and gives every event a counterparty to name.
  state.memberships = [{
    id: 'm-b', userId: COACH, clubId: CLUB_B, role: 'HEAD_COACH',
    isActive: true, joinedAt: new Date('2024-01-01T00:00:00Z'), teamId: null,
  }];
  state.clubs = [
    { id: CLUB_A, name: 'FC Familista', country: 'DE' },
    { id: CLUB_B, name: 'SV Nord', country: 'NO' },
  ];
});

afterEach(async () => { await settle(); });
afterAll(async () => { await settle(); setEventTransport(null); });

const types = () => published.map((e) => e.eventType).sort();
const one = (type: string) => {
  const hits = published.filter((e) => e.eventType === type);
  expect(`${type} count: ${hits.length}`).toBe(`${type} count: 1`);
  return hits[0];
};

/** An approach with every figure and every private word a real one carries. */
const FULL_APPROACH = {
  staffUserId: COACH, proposedRole: 'HEAD_COACH',
  salary: SECRETS.salary, compensation: SECRETS.compensation,
  releaseClause: SECRETS.releaseClause, bonuses: SECRETS.bonuses,
  message: SECRETS.message, durationMonths: 36, startDate: '2026-07-01T00:00:00Z',
};

// ══════════════════════════════════════════════════════════════════════════════
// 1 · A SOURCE OF ITS OWN
// ══════════════════════════════════════════════════════════════════════════════

describe('the Coach Market is its own source', () => {
  it('registers `coach-market`, dash-separated as the registry requires', () => {
    const src = fabricSource('coach-market');
    expect(src).toBeTruthy();
    expect(src!.name).toBe('Coach Market');
    expect(src!.eventDomains).toEqual(['coach', 'staff']);
    expect(src!.showInLiveDataFlow).toBe(true);
  });

  it('draws one lane, beside Transfers and not inside it', () => {
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Coach Market', 'Medical', 'Media', 'AI', 'System',
    ]);
  });

  it('adds no card for any Coach Market screen', () => {
    const ids = visibleFabricSources().map((s) => s.id);
    for (const screen of ['coaches', 'available', 'free-agents', 'shortlisted',
      'staff-needs', 'negotiations', 'activity', 'staff-market']) {
      expect(`${screen} is a source: ${ids.includes(screen)}`).toBe(`${screen} is a source: false`);
    }
    expect(ids).toContain('coach-market');
  });

  it('adds no card per staff role', () => {
    const ids = visibleFabricSources().map((s) => s.id);
    // `medical` is left out on purpose: the Medical DOMAIN is a real source of
    // its own, and a medical staff member being recruited is Coach Market.
    for (const role of ['head-coach', 'assistant', 'gk-coach', 'fitness', 'analyst',
      'physio', 'scout', 'medical-staff']) {
      expect(`${role} is a source: ${ids.includes(role)}`).toBe(`${role} is a source: false`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2 · SEPARATION FROM PLAYER TRANSFERS
// ══════════════════════════════════════════════════════════════════════════════

describe('Coach Market and Transfers never mix', () => {
  it('no coach or staff name is owned by the Transfers source', () => {
    for (const spec of fabricEventsForSource('transfers')) {
      expect(`${spec.type}: ${/^(coach|staff)\./.test(spec.type)}`).toBe(`${spec.type}: false`);
      expect(`${spec.type} source: ${spec.source}`).toBe(`${spec.type} source: transfers`);
    }
  });

  it('no transfer name is owned by the Coach Market source', () => {
    for (const spec of fabricEventsForSource('coach-market')) {
      expect(`${spec.type}: ${spec.type.startsWith('transfer.')}`).toBe(`${spec.type}: false`);
      expect(`${spec.type} source: ${spec.source}`).toBe(`${spec.type} source: coach-market`);
      expect(`${spec.type} lane: ${sourceLaneFor(spec.type)}`).toBe(`${spec.type} lane: Coach Market`);
    }
  });

  it('the two services do not reach each other’s producer', () => {
    const root = path.join(__dirname, '..', 'src');
    const staff = fs.readFileSync(path.join(root, 'staff-market', 'staff-market.service.ts'), 'utf8');
    expect(`staff-market imports transfers.producer: ${staff.includes('transfers.producer')}`)
      .toBe('staff-market imports transfers.producer: false');
    expect(`staff-market calls publishTransfer*: ${/publishTransfer[A-Z]/.test(staff)}`)
      .toBe('staff-market calls publishTransfer*: false');

    for (const file of fs.readdirSync(path.join(root, 'transfer-market')).filter((f) => f.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(root, 'transfer-market', file), 'utf8');
      expect(`${file} imports coach-market.producer: ${src.includes('coach-market.producer')}`)
        .toBe(`${file} imports coach-market.producer: false`);
      expect(`${file} calls publishCoach*: ${/publishCoach[A-Z]/.test(src)}`)
        .toBe(`${file} calls publishCoach*: false`);
    }
  });

  it('a staff approach produces no transfer.* event at all', async () => {
    await market.approach(A as never, FULL_APPROACH as never);
    await settle();

    expect(published.length).toBeGreaterThan(0);
    for (const e of published) {
      expect(`${e.eventType} is a transfer event: ${e.eventType.startsWith('transfer.')}`)
        .toBe(`${e.eventType} is a transfer event: false`);
      expect(sourceLaneFor(e.eventType)).toBe('Coach Market');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3 · THE APPROACH LIFECYCLE
// ══════════════════════════════════════════════════════════════════════════════

describe('an approach', () => {
  it('publishes exactly one coach.offer.created when it is SENT', async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await settle();

    expect(types()).toEqual(['coach.offer.created']);
    const e = one('coach.offer.created');
    expect(e.clubId).toBe(CLUB_A);
    expect(e.subjectType).toBe('STAFF');
    expect(e.subjectId).toBe(COACH);
    expect(e.payload).toEqual({
      approachId: a.id, staffRole: 'HEAD_COACH',
      counterpartyClubId: CLUB_B, stage: 'APPROACH',
    });
  });

  it('a DRAFT announces nothing — private preparation is not an offer', async () => {
    await market.approach(A as never, { ...FULL_APPROACH, submit: false } as never);
    await settle();

    expect(types()).toEqual([]);
    expect(state.approaches).toHaveLength(1);
    expect(state.approaches[0].status).toBe('DRAFT');
  });

  it('a counter publishes the offer change AND the start of a negotiation, once each', async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await settle();
    published = [];

    await market.counterApproach(B as never, a.id, {
      body: SECRETS.message, salary: SECRETS.salary, compensation: SECRETS.compensation,
    } as never);
    await settle();

    expect(types()).toEqual(['coach.negotiation.started', 'coach.offer.updated']);
    expect(one('coach.negotiation.started').clubId).toBe(CLUB_B);
  });

  it('a SECOND counter is an offer change and not a second start', async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await market.counterApproach(B as never, a.id, { salary: 1 } as never);
    await settle();
    published = [];

    await market.counterApproach(A as never, a.id, { salary: 2 } as never);
    await settle();
    expect(types()).toEqual(['coach.offer.updated']);
  });

  it('a rejection publishes one coach.offer.rejected, on the club that refused', async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await settle();
    published = [];

    await market.rejectApproach(B as never, a.id);
    await settle();
    expect(types()).toEqual(['coach.offer.rejected']);
    expect(one('coach.offer.rejected').clubId).toBe(CLUB_B);
  });

  it('a withdrawal publishes one coach.negotiation.cancelled', async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await settle();
    published = [];

    await market.withdrawApproach(A as never, a.id);
    await settle();
    expect(types()).toEqual(['coach.negotiation.cancelled']);
  });

  it('an interview invitation is a persisted negotiation step', async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await settle();
    published = [];

    await market.inviteToInterview(A as never, a.id, '2026-07-01T10:00:00Z', SECRETS.message);
    await settle();

    expect(types()).toEqual(['coach.negotiation.updated']);
    expect((one('coach.negotiation.updated').payload as Row).step).toBe('INTERVIEW_PROPOSED');
    // the proposed time and the note are in the message body and stay there
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('2026-07-01');
    expect(wire).not.toContain(SECRETS.message);
  });

  it('a refused action publishes nothing', async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await settle();
    published = [];

    // the approaching club cannot reject its own approach
    await expect(market.rejectApproach(A as never, a.id)).rejects.toThrow();
    // a third club is in neither side of it
    await expect(market.withdrawApproach({ userId: 'x', clubId: 'club-c' } as never, a.id)).rejects.toThrow();
    // and an approach that is not there cannot move
    await expect(market.counterApproach(A as never, 'nope', {} as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('a club cannot approach somebody it already employs, and announces nothing', async () => {
    state.memberships = [{ id: 'm-1', userId: COACH, clubId: CLUB_A, role: 'HEAD_COACH', isActive: true, joinedAt: new Date(), teamId: null }];
    await expect(market.approach(A as never, FULL_APPROACH as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4 · THE HIRE
// ══════════════════════════════════════════════════════════════════════════════

describe('completing a move', () => {
  const upToOffer = async () => {
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await settle();
    published = [];
    return a;
  };

  it('publishes acceptance, the hire and the availability move — each exactly once', async () => {
    const a = await upToOffer();
    await market.acceptApproach(B as never, a.id);
    await settle();

    expect(types()).toEqual([
      'coach.availability.changed', 'coach.hired', 'coach.offer.accepted',
    ]);
    one('coach.offer.accepted');
    one('coach.hired');
    one('coach.availability.changed');
  });

  it('the three are different facts, not three names for one', async () => {
    const a = await upToOffer();
    await market.acceptApproach(B as never, a.id);
    await settle();

    expect((one('coach.offer.accepted').payload as Row).stage).toBe('APPROACH');
    expect((one('coach.hired').payload as Row).stage).toBe('HIRE');
    expect((one('coach.availability.changed').payload as Row).stage).toBe('PROFILE');
    // and the hire names the club he joined and the club he left
    const hired = one('coach.hired');
    expect(hired.clubId).toBe(CLUB_A);
    expect((hired.payload as Row).counterpartyClubId).toBe(CLUB_B);
    expect((one('coach.availability.changed').payload as Row).to).toBe('EMPLOYED');
  });

  it('publishes only after the transaction — the engagement and membership exist', async () => {
    const a = await upToOffer();
    await market.acceptApproach(B as never, a.id);
    await settle();

    expect(state.engagements.some((e) => e.clubId === CLUB_A && e.isActive)).toBe(true);
    expect(state.memberships.some((m) => m.clubId === CLUB_A && m.isActive)).toBe(true);
    expect(state.approaches[0].status).toBe('COMPLETED');
  });

  it('completing twice publishes once — the second call is refused', async () => {
    const a = await upToOffer();
    await market.acceptApproach(B as never, a.id);
    await settle();
    published = [];

    await expect(market.acceptApproach(B as never, a.id)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('carries no salary, compensation, clause, bonus or message', async () => {
    const a = await upToOffer();
    await market.acceptApproach(B as never, a.id);
    await settle();

    const wire = JSON.stringify(published);
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: ${wire.includes(String(secret))}`).toBe(`${name}: false`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5 · THE SHORTLIST
// ══════════════════════════════════════════════════════════════════════════════

describe('the shortlist', () => {
  it('adding publishes exactly one coach.shortlisted, after the row exists', async () => {
    await market.addToShortlist(A as never, COACH, SECRETS.clubNote);
    await settle();

    expect(types()).toEqual(['coach.shortlisted']);
    expect(state.shortlist).toHaveLength(1);
    expect(one('coach.shortlisted').clubId).toBe(CLUB_A);
  });

  it('adding twice announces nothing the second time', async () => {
    await market.addToShortlist(A as never, COACH);
    await settle();
    published = [];

    await market.addToShortlist(A as never, COACH);
    await settle();
    expect(types()).toEqual([]);
    expect(state.shortlist).toHaveLength(1);
  });

  it('removing publishes one coach.unshortlisted; removing nothing publishes nothing', async () => {
    await market.addToShortlist(A as never, COACH);
    await settle();
    published = [];

    await market.removeFromShortlist(A as never, COACH);
    await settle();
    expect(types()).toEqual(['coach.unshortlisted']);
    published = [];

    await market.removeFromShortlist(A as never, COACH);
    await settle();
    expect(types()).toEqual([]);
  });

  it('never carries the club’s private note about a person', async () => {
    await market.addToShortlist(A as never, COACH, SECRETS.clubNote);
    await settle();
    expect(JSON.stringify(published)).not.toContain(SECRETS.clubNote);
    expect(Object.keys(one('coach.shortlisted').payload as Row).sort())
      .toEqual(['counterpartyClubId', 'staffRole', 'stage']);
  });

  it('shortlisting somebody who does not exist publishes nothing', async () => {
    await expect(market.addToShortlist(A as never, 'nobody')).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 · STAFF NEEDS
// ══════════════════════════════════════════════════════════════════════════════

describe('staff needs', () => {
  const create = () => market.createNeed(A as never, {
    role: 'GOALKEEPING_COACH' as never, priority: 'URGENT',
    salaryMin: 60000, salaryMax: 90000, note: SECRETS.needNote,
    languages: ['de', 'en'], minLicence: 'UEFA A',
  } as never);

  it('creating publishes one staff.need.created, on the CLUB', async () => {
    const n = await create();
    await settle();

    expect(types()).toEqual(['staff.need.created']);
    const e = one('staff.need.created');
    expect(e.subjectType).toBe('CLUB');
    expect(e.subjectId).toBe(CLUB_A);
    expect(e.payload).toEqual({
      needId: n.id, priority: 'URGENT', staffRole: 'GOALKEEPING_COACH',
      counterpartyClubId: null, stage: 'NEED',
    });
  });

  it('never carries the salary band, the licence, the languages or the note', async () => {
    await create();
    await settle();
    const wire = JSON.stringify(published);
    for (const s of [SECRETS.needNote, '60000', '90000', 'UEFA A']) {
      expect(`${s}: ${wire.includes(s)}`).toBe(`${s}: false`);
    }
  });

  it('closing publishes one staff.need.closed', async () => {
    const n = await create();
    await settle();
    published = [];

    await market.closeNeed(A as never, n.id);
    await settle();
    expect(types()).toEqual(['staff.need.closed']);
    expect(state.needs[0].isActive).toBe(false);
  });

  it('closing another club’s need publishes nothing', async () => {
    const n = await create();
    await settle();
    published = [];

    await expect(market.closeNeed(B as never, n.id)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('a non-technical role is refused and publishes nothing', async () => {
    await expect(market.createNeed(A as never, { role: 'PLAYER' as never } as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
    expect(state.needs).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7 · THE PROFESSIONAL RECORD
// ══════════════════════════════════════════════════════════════════════════════

describe('the record', () => {
  const employ = () => { state.memberships = [{
    id: 'm-a', userId: COACH, clubId: CLUB_A, role: 'HEAD_COACH',
    isActive: true, joinedAt: new Date('2024-01-01T00:00:00Z'), teamId: null,
  }]; };

  it('an update publishes the umbrella with a COUNT and no field names', async () => {
    employ();
    await market.upsertProfile(A as never, COACH, { nationality: 'DE', preferredClubLevel: 'ELITE' });
    await settle();

    expect(types()).toEqual(['coach.profile.updated']);
    const e = one('coach.profile.updated');
    expect((e.payload as Row).changedFieldCount).toBe(2);
    expect((e.payload as Row).changedFields).toBeUndefined();
    expect(project(e).changedFields).toEqual([]);
  });

  it('availability and career intent publish only when they actually move', async () => {
    employ();
    // Seeded directly, so it needs the array columns a profile read spreads —
    // the table defaults only apply to rows the services create.
    state.profiles.push({
      id: 'sp-1', userId: COACH, availability: 'EMPLOYED', careerIntent: 'NOT_LOOKING',
      specialities: [], philosophy: [], dominantPhilosophy: [], trainingMethods: [],
      secondaryFormations: [], preferredRoles: [], preferredCountries: [], preferredLeagues: [],
      languages: [],
    });

    await market.upsertProfile(A as never, COACH, {
      availability: 'LISTED', careerIntent: 'ACTIVELY_LOOKING',
    });
    await settle();
    expect(types()).toEqual([
      'coach.availability.changed', 'coach.career_intent.changed', 'coach.profile.updated',
    ]);
    expect(one('coach.availability.changed').payload).toMatchObject({ from: 'EMPLOYED', to: 'LISTED' });
    published = [];

    // resent, unchanged
    await market.upsertProfile(A as never, COACH, {
      availability: 'LISTED', careerIntent: 'ACTIVELY_LOOKING',
    });
    await settle();
    expect(types()).toEqual(['coach.profile.updated']);
  });

  it('a renewal status change says THAT it moved and never the wording', async () => {
    employ();
    state.engagements.push({ id: 'eng-1', userId: COACH, clubId: CLUB_A, role: 'HEAD_COACH', isActive: true });

    await market.upsertProfile(A as never, COACH, { renewalStatus: SECRETS.renewalStatus });
    await settle();

    expect(types()).toEqual(['coach.contract.status.changed', 'coach.profile.updated']);
    const wire = JSON.stringify(published);
    expect(wire).not.toContain(SECRETS.renewalStatus);
    expect(wire).not.toContain('Bayern');
  });

  it('a club that does not employ him cannot edit, and publishes nothing', async () => {
    await expect(market.upsertProfile(A as never, COACH, { nationality: 'DE' })).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('adding an external staff member publishes one coach.profile.created with no name', async () => {
    await market.addExternalStaff(A as never, {
      firstName: 'Ana', lastName: 'Ruiz', email: 'ana.ruiz@example.test',
      role: 'GOALKEEPING_COACH' as never, nationality: 'ES',
    } as never);
    await settle();

    expect(types()).toEqual(['coach.profile.created']);
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('Ana');
    expect(wire).not.toContain('Ruiz');
    expect(wire).not.toContain('ana.ruiz@example.test');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8 · NOTHING PRIVATE REACHES OBSERVABILITY
// ══════════════════════════════════════════════════════════════════════════════

describe('redaction', () => {
  it('no figure, message, note or contact detail survives any representation', async () => {
    await market.addToShortlist(A as never, COACH, SECRETS.clubNote);
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await market.counterApproach(B as never, a.id, {
      body: SECRETS.message, salary: SECRETS.salary, compensation: SECRETS.compensation,
    } as never);
    await market.acceptApproach(B as never, a.id);
    await market.createNeed(A as never, {
      role: 'GOALKEEPING_COACH' as never, note: SECRETS.needNote, salaryMin: 60000,
    } as never);
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const catalogue = fabricEventsForSource('coach-market');
    const blob = JSON.stringify({ published, frames, catalogue });

    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: ${blob.includes(String(secret))}`).toBe(`${name}: false`);
    }
    expect(blob).not.toContain('Müller');
    expect(blob).not.toContain('Tomás');
  });

  it('a frame carries no payload and names nobody', async () => {
    await market.addToShortlist(A as never, COACH);
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const frame = frames[0] as Row;
    expect(frame.payload).toBeUndefined();
    // STAFF is deliberately NOT a safe subject kind, so the id is withheld and
    // the resolver does not know how to name one either.
    expect(frame.subjectId).toBeNull();
    expect(frame.subjectType).toBe('STAFF');
    expect(frame.subjectLabel).toBeNull();
    expect(frame.source).toBe('Coach Market');
  });

  it('every Coach Market payload validates against its strict schema', async () => {
    await market.addToShortlist(A as never, COACH);
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await market.counterApproach(B as never, a.id, { salary: 1 } as never);
    await market.acceptApproach(B as never, a.id);
    const n = await market.createNeed(A as never, { role: 'GOALKEEPING_COACH' as never } as never);
    await market.closeNeed(A as never, n.id);
    await settle();

    expect(published.length).toBeGreaterThanOrEqual(8);
    for (const e of published) {
      const check = validateEventPayload(e.eventType, 1, e.payload);
      expect(`${e.eventType}: ${check.ok ? 'ok' : JSON.stringify((check as Row).issues)}`)
        .toBe(`${e.eventType}: ok`);
    }
  });

  it('a strict schema refuses a salary, a message or a note added later', () => {
    expect(validateEventPayload('coach.offer.created', 1, {
      approachId: 'ap-1', staffRole: 'HEAD_COACH', counterpartyClubId: CLUB_B,
      stage: 'APPROACH', salary: SECRETS.salary,
    }).ok).toBe(false);
    expect(validateEventPayload('coach.offer.created', 1, {
      approachId: 'ap-1', staffRole: 'HEAD_COACH', counterpartyClubId: CLUB_B,
      stage: 'APPROACH', message: SECRETS.message,
    }).ok).toBe(false);
    expect(validateEventPayload('coach.shortlisted', 1, {
      staffRole: 'HEAD_COACH', counterpartyClubId: null, stage: 'SHORTLIST',
      note: SECRETS.clubNote,
    }).ok).toBe(false);
    expect(validateEventPayload('coach.contract.status.changed', 1, {
      staffRole: 'HEAD_COACH', counterpartyClubId: null, stage: 'PROFILE',
      renewalStatus: SECRETS.renewalStatus,
    }).ok).toBe(false);
  });

  it('no payload field in the producer could hold free text somebody typed', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'fabric', 'producers', 'coach-market.producer.ts'), 'utf8',
    );
    // The declared FIELD NAMES, not the prose that explains what they exclude:
    // every `describes` in the file names the things it refuses to carry, and
    // matching those would be matching the explanation rather than the schema.
    const declared = [...raw.matchAll(/schema: z\.object\(\{([^}]*)\}\)/g)]
      .flatMap((m) => m[1].split(','))
      .map((f) => f.split(':')[0].trim().replace(/^\.\.\./, ''))
      .filter(Boolean);
    expect(declared.length).toBeGreaterThan(0);
    for (const field of declared) {
      expect(`${field}`).not.toMatch(
        /salary|compensation|clause|bonus|message|note|email|phone|address|wage|fee/i,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9 · THE CATALOGUE
// ══════════════════════════════════════════════════════════════════════════════

describe('the catalogue', () => {
  const PRODUCED = [
    'coach.profile.created', 'coach.profile.updated',
    'coach.availability.changed', 'coach.career_intent.changed',
    'coach.contract.status.changed',
    'coach.shortlisted', 'coach.unshortlisted',
    'coach.offer.created', 'coach.offer.updated', 'coach.offer.accepted', 'coach.offer.rejected',
    'coach.negotiation.started', 'coach.negotiation.updated', 'coach.negotiation.cancelled',
    'coach.hired',
    'staff.need.created', 'staff.need.closed',
  ];

  it('registers every produced type under coach-market, all CONFIDENTIAL', () => {
    for (const type of PRODUCED) {
      const spec = fabricEvent(type);
      expect(`${type} registered: ${!!spec}`).toBe(`${type} registered: true`);
      expect(`${type} source: ${spec!.source}`).toBe(`${type} source: coach-market`);
      expect(`${type} class: ${spec!.classification}`).toBe(`${type} class: CONFIDENTIAL`);
      expect(`${type} produced: ${spec!.produced}`).toBe(`${type} produced: true`);
      expect(validateEventPayload(type, 1, null).ok).toBe(false);
    }
  });

  it('says plainly which names are declared and not yet published', () => {
    const declared = fabricEventsForSource('coach-market')
      .filter((s) => !s.produced).map((s) => s.type).sort();
    expect(declared).toEqual([
      // `coach.assignment.changed` is no longer here. `moveStaffMember` moves a
      // staff member's team, role or both inside one club, and the comment that
      // said nothing did so was never checked against the code.
      'coach.contact.started',
      'coach.invitation.accepted', 'coach.invitation.created', 'coach.invitation.rejected',
      'coach.negotiation.completed', 'staff.need.updated',
    ]);
  });

  it('and everything else under the source IS published by this build', () => {
    const produced = fabricEventsForSource('coach-market')
      .filter((s) => s.produced).map((s) => s.type).sort();
    expect(produced).toEqual([...PRODUCED, 'coach.assignment.changed'].sort());
  });

  it('a name the registry accepts is a name the envelope can emit', () => {
    // A BUG this producer found. `career_intent` has an underscore, which the
    // registry's name pattern allows in a segment after the first and
    // `makeEvent` did not. The type could therefore be registered — with a
    // schema, a source and a lane — and then never published, because
    // `makeEvent` threw and the detached publisher swallowed the rejection:
    // the event did not arrive and nothing said why.
    //
    // Pinned from BOTH sides, so the two patterns cannot drift apart again.
    const underscored = fabricEventsForSource('coach-market')
      .map((s) => s.type).filter((t) => t.includes('_'));
    expect(underscored).toContain('coach.career_intent.changed');
    for (const type of underscored) {
      expect(() => makeEvent({ eventType: type })).not.toThrow();
    }
    // and the medical names that were registered under the same rule
    expect(() => makeEvent({ eventType: 'medical.return_to_play.cleared' })).not.toThrow();
    // The first segment is still a single word, because that is what maps a
    // name to a source domain.
    expect(() => makeEvent({ eventType: 'coach_market.thing.happened' })).toThrow();
    expect(() => makeEvent({ eventType: 'Coach.Thing.Happened' })).toThrow();
  });

  it('every declared-but-unproduced type has a strict schema to be built against', () => {
    for (const spec of fabricEventsForSource('coach-market').filter((s) => !s.produced)) {
      expect(`${spec.type} has a schema: ${validateEventPayload(spec.type, 1, null).ok === false}`)
        .toBe(`${spec.type} has a schema: true`);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10 · THE FABRIC MUST NOT BE ABLE TO BREAK THE MARKET
// ══════════════════════════════════════════════════════════════════════════════

describe('when the fabric is broken', () => {
  it('a transport that throws does not fail a shortlist, an approach or a hire', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox is down'); },
      async read() { return []; },
    } as EventTransport);

    await market.addToShortlist(A as never, COACH);
    const a = await market.approach(A as never, FULL_APPROACH as never);
    await market.acceptApproach(B as never, a.id);
    await settle();

    expect(state.shortlist).toHaveLength(1);
    expect(state.approaches[0].status).toBe('COMPLETED');
    expect(state.engagements.some((e) => e.clubId === CLUB_A && e.isActive)).toBe(true);
    setEventTransport(transport);
  });
});
