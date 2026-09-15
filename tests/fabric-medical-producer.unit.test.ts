/**
 * tests/fabric-medical-producer.unit.test.ts
 *
 * The Medical domain as a Data Fabric producer, and the only suite here written
 * primarily to prove a NEGATIVE.
 *
 * THE METHOD
 *
 * Every fixture below is planted with a real clinical value — a diagnosis, a
 * body part, a mechanism, a severity, a physiotherapist's note, a medication, a
 * test result, a child's name, a date of birth, a guardian's telephone number,
 * a safeguarding note. Each is then searched for in FOUR places, because a
 * privacy rule that holds in one representation and not another has not held:
 *
 *   1. the published event, as it is written to the outbox
 *   2. the frame `project()` builds for the live board
 *   3. the frame after `resolveSubjects()` has filled in its labels
 *   4. the event catalogue the Fabric routes return
 *
 * The third is the one that matters most and is easiest to forget. A frame
 * carries no payload, so a diagnosis cannot reach it — but the resolver used to
 * put the PLAYER'S NAME on any frame whose subject was a player, and a name
 * beside `injury.created` is a health disclosure about an identifiable child
 * assembled from two fields that are each harmless alone.
 *
 * WHAT MEDICAL DOES DIFFERENTLY
 *
 * No `changedFields`. Every other producer reports the NAMES of what moved and
 * the board draws them; "severity" and "bodyLocation" on an operations board
 * are clinical hints, so Medical reports a COUNT under a different key.
 *
 * No safe subject id. `TRANSFER` was added to the board's safe kinds so a
 * negotiation could be followed; `PLAYER` stays out, so every medical subject
 * id is redacted.
 *
 * No team id on the envelope. A team id beside a medical event narrows its
 * subject to one squad. `teamKind` travels in the payload instead.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const CLUB = '11111111-1111-4111-8111-111111111111';
const OTHER_CLUB = '22222222-2222-4222-8222-222222222222';
const SENIOR_TEAM = '33333333-3333-4333-8333-333333333333';
const ACADEMY_TEAM = '44444444-4444-4444-8444-444444444444';
const PLAYER = '55555555-5555-4555-8555-555555555555';
const ACADEMY_PLAYER = '66666666-6666-4666-8666-666666666666';
const ATHLETE = 'athlete-0001';
const ACTOR = 'u-actor';

/** Everything a medical record holds that must never leave the module. */
const SECRETS = {
  diagnosis: 'Grade II tear of the anterior cruciate ligament',
  bodyLocation: 'Left knee',
  bodyLocationCode: 'KNEE-L',
  osicsCategory: 'KJXS',
  mechanism: 'NON_CONTACT_DECELERATION',
  severity: 'SEVERE',
  physioNote: 'Mother reports he has been limping at home for a fortnight and hid it from the coach',
  medication: 'Ibuprofen 400mg three times daily with food',
  testResult: 'MRI 2026-03-04: full-thickness ACL disruption, grade I MCL sprain',
  rtpReasoning: 'Hold him back — hop test asymmetry still 18 per cent at week fourteen',
  safeguarding: 'Social services case reference SG-2026-118, do not contact the father',
  childName: 'Tomás Müller-Fernández',
  dateOfBirth: '2011-04-19',
  guardianPhone: '+49 170 9998877',
  medicalStatusValue: 'RECOVERING',
};

const state = {
  players: [] as Row[], injuries: [] as Row[], workload: [] as Row[],
  histories: [] as Row[], links: [] as Row[], clubs: [] as Row[],
  teams: [] as Row[], audit: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== (v as Row).not;
    }
    if (v === null) return row[k] == null;
    return row[k] === v;
  });

/**
 * Detach a row, the way Prisma does — and hand back real Dates.
 *
 * A JSON round trip turns a Date into a string, and the service under test
 * calls `.getTime()` on one. A harness that quietly changes a column's type is
 * a harness that tests something other than the code.
 */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const copy = <T>(row: T): T => {
  if (row == null) return row;
  return JSON.parse(
    JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    (_k, v) => (typeof v === 'string' && ISO.test(v) ? new Date(v) : v),
  ) as T;
};

/** Attach the joins the medical context resolver asks for, by `select`. */
const withJoins = (row: Row, select: Row | undefined) => {
  if (!row) return null;
  const out = { ...row };
  if (select?.team) {
    const team = state.teams.find((t) => t.id === row.teamId);
    out.team = team ? { kind: team.kind } : null;
  }
  return copy(out);
};

const table = (rows: () => Row[], prefix: string, defaults: Row = {}) => ({
  findUnique: async ({ where, select }: Row) => withJoins(rows().find((r) => r.id === where.id)!, select),
  findFirst: async ({ where = {}, select }: Row = {}) => withJoins(rows().find((r) => match(r, where))!, select),
  findMany: async ({ where = {} }: Row = {}) => copy(rows().filter((r) => match(r, where))),
  count: async ({ where = {} }: Row = {}) => rows().filter((r) => match(r, where)).length,
  create: async ({ data }: Row) => {
    const row = { id: `${prefix}-${rows().length + 1}`, createdAt: new Date(), ...defaults, ...data };
    rows().push(row); return copy(row);
  },
  update: async ({ where, data }: Row) => {
    const r = rows().find((x) => x.id === where.id)!;
    Object.assign(r, data); return copy(r);
  },
  updateMany: async ({ where = {}, data }: Row = {}) => {
    const hits = rows().filter((r) => match(r, where));
    hits.forEach((r) => Object.assign(r, data));
    return { count: hits.length };
  },
  delete: async ({ where }: Row) => {
    const i = rows().findIndex((x) => x.id === where.id);
    return i >= 0 ? copy(rows().splice(i, 1)[0]) : null;
  },
});

const db: Row = {
  player: table(() => state.players, 'p'),
  injuryRecord: table(() => state.injuries, 'inj'),
  athleteMedicalHistory: table(() => state.histories, 'mh'),
  athleteIdentityLink: table(() => state.links, 'link'),
  club: table(() => state.clubs, 'club'),
  team: table(() => state.teams, 'team'),
  workloadRecord: {
    findUnique: async () => copy(state.workload[0] ?? null),
    findMany: async () => copy(state.workload),
  },
  playerAuditLog: { create: async ({ data }: Row) => { state.audit.push(data); return data; } },
  platformAuditEvent: { create: async ({ data }: Row) => data },
  auditEvent: { create: async ({ data }: Row) => data },
  eventOutbox: { create: async ({ data }: Row) => data, findMany: async () => [] },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(db) : Promise.all(arg)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { setEventTransport, type EventTransport } from '../src/fabric/event-bus';
import type { FamilistaEvent } from '../src/fabric/event-envelope';
import { project, sourceLaneFor } from '../src/fabric/pulse/pulse.service';
import { resolveSubjects } from '../src/fabric/pulse/subject-resolver.service';
import { fabricEvent, fabricEventsForSource } from '../src/fabric/registry/event-registry';
import { visibleFabricSources, sourceLanes } from '../src/fabric/registry/source-registry';
import { validateEventPayload } from '../src/fabric/registry/schema-registry';
import '../src/fabric/producers/medical.producer';

import * as workload from '../src/workload/workload-science.service';
import * as identity from '../src/identity/universal-identity.service';
import * as playerService from '../src/services/player.service';

let published: FamilistaEvent[] = [];

/** Detached, and the medical context resolves up to two joins on the way. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r));
};

const transport: EventTransport = {
  name: 'RECORDING',
  async append(event: FamilistaEvent) { published.push(event); return 'STORED'; },
  async read() { return []; },
} as EventTransport;

const MEDIC = { userId: ACTOR, clubId: CLUB, role: 'MEDICAL_STAFF' };

beforeEach(() => {
  published = [];
  setEventTransport(transport);
  state.teams = [
    { id: SENIOR_TEAM, clubId: CLUB, kind: 'SENIOR' },
    { id: ACADEMY_TEAM, clubId: CLUB, kind: 'ACADEMY_U17' },
  ];
  state.players = [
    {
      id: PLAYER, clubId: CLUB, teamId: SENIOR_TEAM, isActive: true,
      firstName: 'Tomás', lastName: 'Müller-Fernández',
      number: 9, position: 'ST', medicalStatus: 'HEALTHY', paymentStatus: 'PAID',
      isInjured: false, condition: 90, notes: SECRETS.physioNote,
      dateOfBirth: new Date(SECRETS.dateOfBirth), parentPhone: SECRETS.guardianPhone,
      parentName: 'Ana Müller', parentEmail: 'ana@example.test', avatar: null,
    },
    {
      id: ACADEMY_PLAYER, clubId: CLUB, teamId: ACADEMY_TEAM, isActive: true,
      firstName: 'Tomás', lastName: 'Müller-Fernández',
      number: 17, position: 'CM', medicalStatus: 'HEALTHY', paymentStatus: 'PAID',
      isInjured: false, condition: 88, notes: SECRETS.safeguarding,
      dateOfBirth: new Date(SECRETS.dateOfBirth), parentPhone: SECRETS.guardianPhone,
      parentName: 'Ana Müller', parentEmail: 'ana@example.test', avatar: null,
    },
  ];
  state.clubs = [{ id: CLUB, name: 'FC Familista' }, { id: OTHER_CLUB, name: 'SV Nord' }];
  state.injuries = [];
  state.histories = [];
  state.links = [{ id: 'link-1', athleteId: ATHLETE, playerId: ACADEMY_PLAYER, clubId: CLUB }];
  state.workload = [];
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

/** A full injury, with every clinical field a record can hold. */
const FULL_INJURY = {
  playerId: PLAYER,
  injuryDate: '2026-03-01T10:00:00Z',
  bodyLocation: SECRETS.bodyLocation,
  bodyLocationCode: SECRETS.bodyLocationCode,
  osicsCategory: SECRETS.osicsCategory,
  mechanism: SECRETS.mechanism,
  severity: SECRETS.severity,
  isContactInjury: false,
  isRecurrence: true,
  notes: `${SECRETS.diagnosis}. ${SECRETS.physioNote}. ${SECRETS.medication}. ${SECRETS.testResult}`,
};

// ══════════════════════════════════════════════════════════════════════════════
// 1 · INJURIES — one event per committed action
// ══════════════════════════════════════════════════════════════════════════════

describe('an injury record', () => {
  it('publishes exactly one injury.created, after the row exists, with no clinical field', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();

    expect(types()).toEqual(['injury.created']);
    const e = one('injury.created');
    expect(state.injuries).toHaveLength(1);
    expect(e.clubId).toBe(CLUB);
    expect(e.subjectType).toBe('PLAYER');
    expect(e.subjectId).toBe(PLAYER);
    expect(e.actorUserId).toBe(ACTOR);
    expect(e.dataClassification).toBe('RESTRICTED');
    expect(e.payload).toEqual({
      injuryId: row.id, injuryContext: 'UNSPECIFIED', teamKind: 'SENIOR',
    });
    // The envelope names no squad. `teamKind` is in the payload, which the
    // board cannot read; a team id would be on the frame.
    expect(e.teamId).toBeNull();
  });

  it('says where it happened as a token, and never which match or session', async () => {
    await workload.recordInjury(MEDIC, { ...FULL_INJURY, matchId: 'match-77' } as never);
    await settle();
    expect((one('injury.created').payload as Row).injuryContext).toBe('MATCH');
    expect(JSON.stringify(published)).not.toContain('match-77');

    published = [];
    await workload.recordInjury(MEDIC, { ...FULL_INJURY, trainingId: 'session-88' } as never);
    await settle();
    expect((one('injury.created').payload as Row).injuryContext).toBe('TRAINING');
    expect(JSON.stringify(published)).not.toContain('session-88');
  });

  it('an amendment publishes one injury.updated carrying a COUNT and no field names', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    published = [];

    await workload.updateInjury(MEDIC, row.id, {
      severity: 'MODERATE', notes: SECRETS.rtpReasoning, bodyLocation: 'Right knee',
    } as never);
    await settle();

    expect(types()).toEqual(['injury.updated']);
    const e = one('injury.updated');
    expect(e.payload).toEqual({ injuryId: row.id, changedFieldCount: 3, teamKind: 'SENIOR' });
    // `changedFields` is the ONE key `project()` lifts out of a payload. A
    // medical event must not use it, whatever it would put there.
    expect((e.payload as Row).changedFields).toBeUndefined();
    expect(project(e).changedFields).toEqual([]);
  });

  it('a return date closes the record — one update, one close, neither carrying a date', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    published = [];

    await workload.updateInjuryReturn(MEDIC, row.id, '2026-09-01T00:00:00Z');
    await settle();

    expect(types()).toEqual(['injury.closed', 'injury.updated']);
    expect(one('injury.closed').payload).toEqual({ injuryId: row.id, teamKind: 'SENIOR' });
    // Not the date, and not how long he was out — a duration is a diagnosis to
    // anyone who knows the sport.
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('2026-09-01');
    expect(wire).not.toContain(String(state.injuries[0].daysAbsent));
  });

  it('closing twice closes once — a record already closed publishes only the amendment', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    await workload.updateInjuryReturn(MEDIC, row.id, '2026-09-01T00:00:00Z');
    await settle();
    published = [];

    await workload.updateInjuryReturn(MEDIC, row.id, '2026-09-08T00:00:00Z');
    await settle();
    expect(types()).toEqual(['injury.updated']);
  });

  it('clearing a return date REOPENS the injury and closes nothing', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    await workload.updateInjuryReturn(MEDIC, row.id, '2026-09-01T00:00:00Z');
    await settle();
    published = [];

    await workload.updateInjury(MEDIC, row.id, { returnDate: null } as never);
    await settle();
    expect(types()).toEqual(['injury.updated']);
  });

  it('an amendment that sets a return date for the first time also closes it', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    published = [];

    await workload.updateInjury(MEDIC, row.id, { returnDate: '2026-09-01T00:00:00Z' } as never);
    await settle();
    expect(types()).toEqual(['injury.closed', 'injury.updated']);
  });

  it('deleting a medical record is itself recorded, and marked audit-relevant', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    published = [];

    await workload.deleteInjury(MEDIC, row.id);
    await settle();

    expect(types()).toEqual(['injury.deleted']);
    expect(one('injury.deleted').payload).toEqual({ injuryId: row.id, teamKind: 'SENIOR' });
    expect(fabricEvent('injury.deleted')!.auditRelevant).toBe(true);
    expect(state.injuries).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2 · A FAILED OPERATION PUBLISHES NOTHING
// ══════════════════════════════════════════════════════════════════════════════

describe('a medical operation that does not succeed', () => {
  it('publishes no event when required fields are missing', async () => {
    await expect(workload.recordInjury(MEDIC, { playerId: PLAYER } as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
    expect(state.injuries).toHaveLength(0);
  });

  it('publishes no event for a player who does not exist', async () => {
    await expect(
      workload.recordInjury(MEDIC, { ...FULL_INJURY, playerId: 'nobody' } as never),
    ).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('publishes no event when the player belongs to another club', async () => {
    state.players[0].clubId = OTHER_CLUB;
    await expect(workload.recordInjury(MEDIC, FULL_INJURY as never)).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('publishes no event when an amendment names a record that is not there', async () => {
    await expect(workload.updateInjury(MEDIC, 'no-such-injury', { severity: 'MILD' } as never))
      .rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('publishes no event when a return date is not a date', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    published = [];

    await expect(workload.updateInjuryReturn(MEDIC, row.id, 'not-a-date')).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
  });

  it('publishes no event when a role may not write medical history', async () => {
    await expect(
      identity.recordMedical({ userId: ACTOR, clubId: CLUB, role: 'PLAYER' }, ATHLETE, 'INJURY',
        { diagnosis: SECRETS.diagnosis } as never, {} as never),
    ).rejects.toThrow();
    await settle();
    expect(types()).toEqual([]);
    expect(state.histories).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3 · THE MEDICAL HISTORY STORE
// ══════════════════════════════════════════════════════════════════════════════

describe('the athlete medical history', () => {
  it('publishes one medical.record.created carrying neither the payload, its hash nor its kind', async () => {
    const row = await identity.recordMedical(
      MEDIC, ATHLETE, 'SURGERY',
      { diagnosis: SECRETS.diagnosis, medication: SECRETS.medication } as never,
      { region: 'LOWER_LIMB' } as never,
    );
    await settle();

    expect(types()).toEqual(['medical.record.created']);
    const e = one('medical.record.created');
    expect(e.payload).toEqual({ recordId: row.id, teamKind: 'ACADEMY_U17' });
    const wire = JSON.stringify(published);
    expect(wire).not.toContain('SURGERY');
    expect(wire).not.toContain(SECRETS.diagnosis);
    expect(wire).not.toContain(SECRETS.medication);
    expect(wire).not.toContain(row.payloadHash);
  });

  it('resolves the squad kind through the identity link, not from the record', async () => {
    await identity.recordMedical(MEDIC, ATHLETE, 'ASSESSMENT', {} as never, {} as never);
    await settle();
    expect((one('medical.record.created').payload as Row).teamKind).toBe('ACADEMY_U17');

    published = [];
    state.links = [];
    await identity.recordMedical(MEDIC, ATHLETE, 'ASSESSMENT', {} as never, {} as never);
    await settle();
    // No link, no kind. Not a guess.
    expect((one('medical.record.created').payload as Row).teamKind).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4 · STATUS AND AVAILABILITY — and no duplication with Players
// ══════════════════════════════════════════════════════════════════════════════

describe('a medical status change', () => {
  it('publishes one medical.status.updated that says neither the old status nor the new', async () => {
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER,
      { medicalStatus: SECRETS.medicalStatusValue } as never,
    );
    await settle();

    const e = one('medical.status.updated');
    expect(e.payload).toEqual({ teamKind: 'SENIOR' });
    expect(e.subjectType).toBe('PLAYER');
    expect(e.dataClassification).toBe('RESTRICTED');
    const wire = JSON.stringify(published);
    expect(wire).not.toContain(SECRETS.medicalStatusValue);
    expect(wire).not.toContain('HEALTHY');
  });

  it('sits on the MEDICAL lane while the Players event stays on the Players lane', async () => {
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER,
      { medicalStatus: 'INJURED' } as never,
    );
    await settle();

    expect(sourceLaneFor('medical.status.updated')).toBe('Medical');
    expect(sourceLaneFor('medical.availability.changed')).toBe('Medical');
    expect(sourceLaneFor('player.status.changed')).toBe('Players');
    // The Players event is untouched: field NAMES, and nothing medical in it.
    expect(one('player.status.changed').payload).toEqual({
      changedFields: ['medicalStatus'], teamKind: 'SENIOR',
    });
  });

  it('publishes availability only when the boolean actually flips', async () => {
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { medicalStatus: 'INJURED' } as never,
    );
    await settle();
    expect(one('medical.availability.changed').payload)
      .toEqual({ available: false, teamKind: 'SENIOR' });

    // INJURED → RECOVERING is a real medical transition and no change at all in
    // whether he can be selected.
    published = [];
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { medicalStatus: 'RECOVERING' } as never,
    );
    await settle();
    expect(types()).toContain('medical.status.updated');
    expect(types()).not.toContain('medical.availability.changed');
  });

  it('publishes nothing medical when the status is resent unchanged', async () => {
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { medicalStatus: 'HEALTHY' } as never,
    );
    await settle();
    expect(types().filter((t) => t.startsWith('medical.'))).toEqual([]);
  });

  it('publishes nothing medical for an update that touches no medical field', async () => {
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { position: 'CM' } as never,
    );
    await settle();
    expect(types().filter((t) => t.startsWith('medical.'))).toEqual([]);
  });

  it('a suspension makes him unavailable without making him injured', async () => {
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { medicalStatus: 'SUSPENDED' } as never,
    );
    await settle();
    // The same event a torn ligament produces. Unavailability cannot be read
    // back as a health fact, which is what makes the boolean safe to publish.
    expect((one('medical.availability.changed').payload as Row).available).toBe(false);
    expect(JSON.stringify(published)).not.toContain('SUSPENDED');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5 · ACADEMY
// ══════════════════════════════════════════════════════════════════════════════

describe('an academy medical event', () => {
  it('uses the same source and is told apart by teamKind alone', async () => {
    await workload.recordInjury(MEDIC, { ...FULL_INJURY, playerId: ACADEMY_PLAYER } as never);
    await settle();

    const e = one('injury.created');
    expect((e.payload as Row).teamKind).toBe('ACADEMY_U17');
    expect(sourceLaneFor(e.eventType)).toBe('Medical');
    expect(fabricEvent(e.eventType)!.source).toBe('medical');
  });

  it('carries no name, no date of birth, no guardian and no safeguarding note', async () => {
    await workload.recordInjury(MEDIC, { ...FULL_INJURY, playerId: ACADEMY_PLAYER } as never);
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const blob = JSON.stringify({ published, frames });
    for (const key of ['childName', 'dateOfBirth', 'guardianPhone', 'safeguarding'] as const) {
      expect(`${key}: ${blob.includes(SECRETS[key])}`).toBe(`${key}: false`);
    }
    expect(blob).not.toContain('Müller');
    expect(blob).not.toContain('Tomás');
  });

  it('adds no academy source card', () => {
    const ids = visibleFabricSources().map((s) => s.id);
    for (const invented of ['injuries', 'treatments', 'assessments', 'availability',
      'rehabilitation', 'return_to_play', 'clearance', 'academy-medical']) {
      expect(`${invented} is a source: ${ids.includes(invented)}`).toBe(`${invented} is a source: false`);
    }
    expect(ids).toContain('medical');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6 · NOTHING CLINICAL REACHES OBSERVABILITY
// ══════════════════════════════════════════════════════════════════════════════

describe('redaction', () => {
  /**
   * Every representation a MEDICAL value could escape through.
   *
   * Scoped to the medical source on purpose. A squad edit that happens to touch
   * `medicalStatus` also produces `player.updated` and `player.status.changed`,
   * and those frames ARE labelled with the player's name — that is how the
   * Players lane has always worked and is not this change's to alter. The claim
   * under test is narrower and sharper: nothing medical, in any of its four
   * representations, carries a clinical value or names a person.
   */
  const everywhere = async () => {
    const medical = published.filter((e) => fabricEvent(e.eventType)?.source === 'medical');
    expect(medical.length).toBeGreaterThan(0);
    const frames = medical.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const catalogue = fabricEventsForSource('medical');
    return JSON.stringify({ medical, frames, catalogue });
  };

  it('no diagnosis, body part, mechanism, severity, note, medication or result survives', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    await workload.updateInjury(MEDIC, row.id, { notes: SECRETS.rtpReasoning } as never);
    await identity.recordMedical(MEDIC, ATHLETE, 'SURGERY',
      { diagnosis: SECRETS.diagnosis } as never, { region: 'LOWER_LIMB' } as never);
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { medicalStatus: 'INJURED' } as never,
    );
    await settle();

    const blob = await everywhere();
    for (const [name, secret] of Object.entries(SECRETS)) {
      expect(`${name}: ${blob.includes(secret)}`).toBe(`${name}: false`);
    }
  });

  it('a frame carries no payload, so a count is the most a board ever sees', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    published = [];
    await workload.updateInjury(MEDIC, row.id, { severity: SECRETS.severity } as never);
    await settle();

    const frame = project(published[0], 'STORED') as Row;
    expect(frame.payload).toBeUndefined();
    expect(frame.metadata).toBeUndefined();
    expect(frame.changedFields).toEqual([]);
    // The subject id is withheld: PLAYER is not a safe subject kind, and this
    // change deliberately did not make it one.
    expect(frame.subjectId).toBeNull();
    expect(frame.subjectType).toBe('PLAYER');
    expect(frame.teamId).toBeNull();
  });

  it('the subject resolver never names the person a medical event is about', async () => {
    await workload.recordInjury(MEDIC, { ...FULL_INJURY, playerId: ACADEMY_PLAYER } as never);
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    expect(frames[0].subjectLabel).toBeNull();
    // The club is still named — a club is not a person, and an operator needs
    // to know whose platform the event came from.
    expect(frames[0].clubLabel).toBe('FC Familista');
    // and the server-side lookup id is gone from every frame
    expect((frames[0] as Row).resolveId).toBeUndefined();
  });

  it('but a NON-medical event about the same player is still named, as it always was', async () => {
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { position: 'CM' } as never,
    );
    await settle();

    const frames = published.map((e) => project(e, 'STORED'));
    await resolveSubjects(frames);
    const updated = frames.find((f) => f.eventType === 'player.updated')!;
    expect(updated.subjectLabel).toBe('Tomás Müller-Fernández');
  });

  it('every medical payload validates against its strict schema', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    await workload.updateInjury(MEDIC, row.id, { returnDate: '2026-09-01T00:00:00Z' } as never);
    await identity.recordMedical(MEDIC, ATHLETE, 'INJURY', {} as never, {} as never);
    await playerService.updatePlayer(
      { userId: ACTOR, clubId: CLUB } as never, PLAYER, { medicalStatus: 'INJURED' } as never,
    );
    await settle();
    await workload.deleteInjury(MEDIC, row.id);
    await settle();

    const medical = published.filter((e) => fabricEvent(e.eventType)?.source === 'medical');
    expect(medical.length).toBeGreaterThanOrEqual(7);
    for (const e of medical) {
      const check = validateEventPayload(e.eventType, 1, e.payload);
      expect(`${e.eventType}: ${check.ok ? 'ok' : JSON.stringify((check as Row).issues)}`)
        .toBe(`${e.eventType}: ok`);
    }
  });

  it('a strict schema refuses a diagnosis somebody adds later', () => {
    expect(validateEventPayload('injury.created', 1, {
      injuryId: 'inj-1', injuryContext: 'MATCH', teamKind: 'SENIOR',
      bodyLocation: SECRETS.bodyLocation,
    }).ok).toBe(false);
    expect(validateEventPayload('medical.status.updated', 1, {
      teamKind: 'SENIOR', status: SECRETS.medicalStatusValue,
    }).ok).toBe(false);
    expect(validateEventPayload('injury.updated', 1, {
      injuryId: 'inj-1', changedFieldCount: 2, teamKind: 'SENIOR',
      changedFields: ['severity', 'bodyLocation'],
    }).ok).toBe(false);
  });

  it('no schema in the Medical source declares a field that could hold clinical text', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'fabric', 'producers', 'medical.producer.ts'), 'utf8',
    );
    // Read from the source rather than from a payload, so a field added later
    // fails here even if no test happens to publish it.
    const declared = [...src.matchAll(/^\s{4}schema: z\.object\(\{([^}]*)\}\)/gm)]
      .flatMap((m) => m[1].split(','))
      .map((f) => f.split(':')[0].trim().replace(/^\.\.\./, ''))
      .filter(Boolean);
    expect(declared.length).toBeGreaterThan(0);
    for (const field of declared) {
      expect(`${field}`).not.toMatch(
        /diagnos|symptom|body|location|osics|mechanism|severity|treatment|medicat|note|result|reason|status|absent|return|dob|birth|parent|guardian|name/i,
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7 · THE CATALOGUE
// ══════════════════════════════════════════════════════════════════════════════

describe('the catalogue', () => {
  const PRODUCED = [
    'injury.created', 'injury.updated', 'injury.closed', 'injury.deleted',
    'medical.record.created', 'medical.status.updated', 'medical.availability.changed',
  ];

  it('registers every produced type under the medical source, RESTRICTED, about a PLAYER', () => {
    for (const type of PRODUCED) {
      const spec = fabricEvent(type);
      expect(`${type} registered: ${!!spec}`).toBe(`${type} registered: true`);
      expect(`${type} source: ${spec!.source}`).toBe(`${type} source: medical`);
      expect(`${type} class: ${spec!.classification}`).toBe(`${type} class: RESTRICTED`);
      expect(`${type} entity: ${spec!.entityType}`).toBe(`${type} entity: PLAYER`);
      expect(`${type} produced: ${spec!.produced}`).toBe(`${type} produced: true`);
      expect(sourceLaneFor(type)).toBe('Medical');
    }
  });

  it('says plainly which names are declared and not yet published', () => {
    const declared = fabricEventsForSource('medical').filter((s) => !s.produced).map((s) => s.type).sort();
    expect(declared).toEqual([
      'medical.clearance.updated',
      'medical.injury.created', 'medical.injury.resolved',
      'medical.record.updated',
      'medical.rehabilitation.completed', 'medical.rehabilitation.started',
      'medical.rehabilitation.updated',
      'medical.return_to_play.cleared', 'medical.return_to_play.started',
      'medical.return_to_play.updated',
    ]);
  });

  it('and everything else under the source IS published by this build', () => {
    const produced = fabricEventsForSource('medical').filter((s) => s.produced).map((s) => s.type).sort();
    expect(produced).toEqual([...PRODUCED].sort());
  });

  it('every declared-but-unproduced type still has a strict schema to be built against', () => {
    for (const spec of fabricEventsForSource('medical').filter((s) => !s.produced)) {
      // The two legacy `medical.injury.*` names predate the registry and have
      // no schema of their own; everything this producer declared has one.
      if (spec.type.startsWith('medical.injury.')) continue;
      expect(`${spec.type} has a schema: ${validateEventPayload(spec.type, 1, null).ok === false}`)
        .toBe(`${spec.type} has a schema: true`);
    }
  });

  it('adds no source card — the board still draws exactly ten lanes', () => {
    expect(sourceLanes()).toEqual([
      'Clubs', 'Users', 'Players', 'Training', 'Matches',
      'Transfers', 'Medical', 'Media', 'AI', 'System',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8 · THE FABRIC MUST NOT BE ABLE TO BREAK A MEDICAL OPERATION
// ══════════════════════════════════════════════════════════════════════════════

describe('when the fabric is broken', () => {
  it('a transport that throws does not fail the medical write that caused it', async () => {
    setEventTransport({
      name: 'BROKEN',
      async append() { throw new Error('outbox is down'); },
      async read() { return []; },
    } as EventTransport);

    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await workload.updateInjury(MEDIC, row.id, { severity: 'MILD' } as never);
    const history = await identity.recordMedical(MEDIC, ATHLETE, 'INJURY', {} as never, {} as never);
    await settle();

    // Every business outcome stands.
    expect(row.id).toBeTruthy();
    expect(history.id).toBeTruthy();
    expect(state.injuries).toHaveLength(1);
    expect(state.injuries[0].severity).toBe('MILD');
    expect(state.histories).toHaveLength(1);
    setEventTransport(transport);
  });

  it('a context lookup that throws still records the event, without a squad kind', async () => {
    const row = await workload.recordInjury(MEDIC, FULL_INJURY as never);
    await settle();
    published = [];

    const original = db.player.findUnique;
    db.player.findUnique = async () => { throw new Error('database is unwell'); };
    try {
      await workload.updateInjury(MEDIC, row.id, { severity: 'MILD' } as never);
      await settle();
    } finally {
      db.player.findUnique = original;
    }

    expect(types()).toEqual(['injury.updated']);
    expect((one('injury.updated').payload as Row).teamKind).toBeNull();
  });
});
