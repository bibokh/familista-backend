// Familista — a match event has to survive JSON.
//
// `MatchEvent.minuteMs` is a BigInt column, and `JSON.stringify` throws on a
// BigInt rather than skipping it. So a response carrying a raw row was not a row
// with a field missing — it was a 500. Recording an event and listing a match's
// events were both that, for every match that had any, which took the Match
// Centre's timeline and the Familista League's event feed with them.
//
// The first test here is the bug itself, stated as an expectation: stringify a
// raw row and it throws. Everything after it is the fix holding.

import fs from 'fs';
import path from 'path';
import type { MatchEvent } from '@prisma/client';
import { toJsonSafeEvent } from '../src/match-events/match-event.service';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A row shaped like the one Prisma returns. Only the fields this projection
// touches matter; the rest ride along untouched and are checked as such.
const row = (over: Partial<MatchEvent> = {}): MatchEvent => ({
  id: 'e1000000-0000-4000-8000-000000000001',
  matchId: 'm1000000-0000-4000-8000-000000000001',
  clubId: 'c1000000-0000-4000-8000-000000000001',
  teamId: 't1000000-0000-4000-8000-000000000001',
  playerId: 'p1000000-0000-4000-8000-000000000001',
  relatedPlayerId: null,
  periodIndex: 1,
  minuteMs: BigInt(720000),          // 12'00 into the half
  minute: 12,
  second: 0,
  type: 'GOAL',
  outcome: 'GOAL',
  ...over,
} as unknown as MatchEvent);

describe('the defect', () => {
  it('a raw match event cannot be serialized — this is the 500', () => {
    expect(() => JSON.stringify(row())).toThrow(/BigInt/);
  });
});

describe('toJsonSafeEvent', () => {
  it('makes the event serializable', () => {
    expect(() => JSON.stringify(toJsonSafeEvent(row()))).not.toThrow();
  });

  it('preserves the value exactly, as a number', () => {
    const out = toJsonSafeEvent(row());
    expect(typeof out.minuteMs).toBe('number');
    expect(out.minuteMs).toBe(720000);
    // …and it survives the round trip a client actually makes.
    expect(JSON.parse(JSON.stringify(out)).minuteMs).toBe(720000);
  });

  it('is exact for every minute a match can reach', () => {
    // 130 minutes covers two halves, both periods of extra time and stoppage —
    // the range `periodIndex` 1–5 allows. All of it is far inside a double.
    for (const minute of [0, 1, 45, 46, 90, 105, 120, 130]) {
      const ms = minute * 60_000;
      const out = toJsonSafeEvent(row({ minuteMs: BigInt(ms), minute }));
      expect(`${minute}:${out.minuteMs}`).toBe(`${minute}:${ms}`);
    }
    expect(130 * 60_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('leaves an absent time absent, rather than turning it into zero', () => {
    expect(toJsonSafeEvent(row({ minuteMs: null })).minuteMs).toBeNull();
  });

  it('changes nothing else about the event', () => {
    const before = row({ type: 'SUBSTITUTION', relatedPlayerId: 'p2' });
    const after = toJsonSafeEvent(before);
    for (const key of Object.keys(before) as Array<keyof MatchEvent>) {
      if (key === 'minuteMs') continue;
      expect(`${key}=${String(after[key as keyof typeof after])}`)
        .toBe(`${key}=${String(before[key])}`);
    }
  });
});

describe('the fix is where the rows leave the service', () => {
  const SERVICE = read('src/match-events/match-event.service.ts');

  it('every function that returns a row returns it converted', () => {
    // recordEvent — both branches, the upsert and the create.
    expect((SERVICE.match(/return toJsonSafeEvent\(row\);/g) || []).length).toBe(2);
    // listEvents — the page of rows.
    expect(SERVICE).toContain('return { items: items.map(toJsonSafeEvent), total };');
    // …and the signatures say so, so a caller cannot be handed a BigInt by
    // accident and discover it at serialization time.
    expect(SERVICE).toContain('Promise<MatchEventJson>');
    expect(SERVICE).toContain('Promise<{ items: MatchEventJson[]; total: number }>');
  });

  it('does not touch how the value is stored', () => {
    // The column stays BigInt and the write still makes one: this is a
    // read-time projection, not a migration.
    expect(SERVICE).toContain('minuteMs:      BigInt(Math.round(dto.minuteMs ?? 0)),');
    const schema = read('prisma/schema.prisma');
    const model = schema.slice(schema.indexOf('model MatchEvent {'));
    expect(model.slice(0, model.indexOf('\n}'))).toMatch(/minuteMs\s+BigInt\?/);
  });

  it('does not patch JSON globally', () => {
    // A BigInt.prototype.toJSON would fix every symptom and hide the next one,
    // and it is not how this repository serializes — see `money()` in
    // staff-market.service.ts and chainPosition.toString() in
    // security.controller.ts, both explicit and both at the boundary.
    for (const file of ['src/match-events/match-event.service.ts', 'src/app.ts', 'src/server.ts', 'src/utils/response.ts']) {
      expect(`${file}:${/BigInt\.prototype/.test(read(file))}`).toBe(`${file}:false`);
    }
  });

  it('is the only BigInt on the table, so nothing else is left leaking', () => {
    const schema = read('prisma/schema.prisma');
    const model = schema.slice(schema.indexOf('model MatchEvent {'));
    const body = model.slice(0, model.indexOf('\n}'));
    const bigints = body.split('\n').filter((l) => /\bBigInt\b/.test(l)).map((l) => l.trim().split(/\s+/)[0]);
    expect(bigints).toEqual(['minuteMs']);
  });
});

// ── The round trip, when there is a database to make it against ──────────────
// Follows the repository's convention: DB-dependent tests gate on
// TEST_DATABASE_URL and skip themselves when it is absent.
const DB = !!process.env.TEST_DATABASE_URL;
(DB ? describe : describe.skip)('against a real database', () => {
  it('an event written with a BigInt reads back over the service as JSON', async () => {
    const { prisma } = await import('../src/config/database');
    const svc = await import('../src/match-events/match-event.service');

    const match = await prisma.match.findFirst({ select: { id: true, clubId: true, teamId: true } });
    expect(match).toBeTruthy();
    const actor = { userId: 'test', clubId: match!.clubId, role: 'SUPER_ADMIN' };

    const created = await svc.recordEvent(actor, {
      matchId: match!.id, periodIndex: 2, minute: 88, minuteMs: 88 * 60_000, second: 30,
      type: 'SHOT', outcome: 'SAVED', teamId: match!.teamId ?? undefined, x: 84, y: 46,
    });
    expect(typeof created.minuteMs).toBe('number');
    expect(() => JSON.stringify(created)).not.toThrow();

    const listed = await svc.listEvents(actor, match!.id, { limit: 500 });
    expect(() => JSON.stringify(listed)).not.toThrow();
    const mine = listed.items.find((e) => e.id === created.id);
    expect(mine?.minuteMs).toBe(88 * 60_000);

    // The stored column is still a BigInt — the projection is read-time only.
    const raw = await prisma.matchEvent.findUnique({ where: { id: created.id }, select: { minuteMs: true } });
    expect(typeof raw?.minuteMs).toBe('bigint');
    expect(raw?.minuteMs).toBe(BigInt(88 * 60_000));

    await prisma.matchEvent.delete({ where: { id: created.id } });
    await prisma.$disconnect();
  }, 30000);
});
