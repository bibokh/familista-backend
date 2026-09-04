/**
 * tests/team-scope-platform.unit.test.ts
 *
 * The team boundary, across the modules a club actually works in.
 *
 * The previous suite proved it for the Match Center, the Familista League and
 * the squad. This one proves it where the schema had to change to make it
 * provable at all — the training week — and for the club's match calendar,
 * and it does it the same way: real rows through a mocked database, reading
 * what the services and the route gates actually answer.
 *
 * The cast is one club with three teams and one member per posture:
 *
 *   u-first-coach   HEAD_COACH of the First Team
 *   u-u15-coach     HEAD_COACH of the Under-15s
 *   u-u17-analyst   ANALYST on the Under-17s — on the team, does not run it
 *   u-owner         CLUB_OWNER, club-wide
 *   u-parent        PARENT, club-wide, works on no team at all
 */

import { MembershipRole, TeamKind } from '@prisma/client';

const CLUB = 'club-harta-berlin';
const OTHER_CLUB = 'club-elsewhere';

const TEAMS = [
  { id: 'team-first', clubId: CLUB, name: 'First Team', shortName: 'FT', kind: TeamKind.SENIOR, isActive: true },
  { id: 'team-u15', clubId: CLUB, name: 'U15', shortName: 'U15', kind: TeamKind.ACADEMY_U15, isActive: true },
  { id: 'team-u17', clubId: CLUB, name: 'U17', shortName: 'U17', kind: TeamKind.ACADEMY_U17, isActive: true },
  { id: 'team-outside', clubId: OTHER_CLUB, name: 'First Team', shortName: 'FT', kind: TeamKind.SENIOR, isActive: true },
];

const MEMBERSHIPS = [
  { userId: 'u-first-coach', clubId: CLUB, teamId: 'team-first', role: MembershipRole.HEAD_COACH, isActive: true },
  { userId: 'u-u15-coach', clubId: CLUB, teamId: 'team-u15', role: MembershipRole.HEAD_COACH, isActive: true },
  { userId: 'u-u17-analyst', clubId: CLUB, teamId: 'team-u17', role: MembershipRole.ANALYST, isActive: true },
  { userId: 'u-owner', clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true },
  { userId: 'u-parent', clubId: CLUB, teamId: null, role: MembershipRole.PARENT, isActive: true },
];

const PLAYERS = [
  { id: 'p-first', clubId: CLUB, teamId: 'team-first', firstName: 'Senior', lastName: 'One', number: 9, position: 'ST', isActive: true },
  { id: 'p-u15', clubId: CLUB, teamId: 'team-u15', firstName: 'Fifteen', lastName: 'Two', number: 7, position: 'MC', isActive: true },
  { id: 'p-u17', clubId: CLUB, teamId: 'team-u17', firstName: 'Seventeen', lastName: 'Three', number: 4, position: 'DC', isActive: true },
];

const SESSIONS = [
  { id: 's-first', clubId: CLUB, teamId: 'team-first', title: 'First Team — pressing', status: 'planned', scheduledAt: new Date('2026-09-08T09:00:00Z'), attackForm: 12, defenseForm: 14, possession: 11, conditionForm: 13 },
  { id: 's-u15', clubId: CLUB, teamId: 'team-u15', title: 'U15 — rondos', status: 'planned', scheduledAt: new Date('2026-09-08T15:00:00Z'), attackForm: 10, defenseForm: 10, possession: 10, conditionForm: 10 },
  { id: 's-u17', clubId: CLUB, teamId: 'team-u17', title: 'U17 — transitions', status: 'planned', scheduledAt: new Date('2026-09-09T15:00:00Z'), attackForm: 11, defenseForm: 11, possession: 11, conditionForm: 11 },
  // The session the migration could not attribute: it stays the club's own.
  { id: 's-legacy', clubId: CLUB, teamId: null, title: 'Club session (pre-teams)', status: 'completed', scheduledAt: new Date('2026-08-01T09:00:00Z'), attackForm: 12, defenseForm: 14, possession: 11, conditionForm: 13 },
];

const MATCHES = [
  { id: 'm-first', clubId: CLUB, teamId: 'team-first', homeTeam: 'HARTA BERLIN', awayTeam: 'Elsewhere FC', scheduledAt: new Date('2026-09-12T13:00:00Z') },
  { id: 'm-u15', clubId: CLUB, teamId: 'team-u15', homeTeam: 'HARTA BERLIN U15', awayTeam: 'Elsewhere U15', scheduledAt: new Date('2026-09-13T09:00:00Z') },
];

const idIn = (v: unknown, value: string | null) =>
  v == null ? true
    : typeof v === 'string' ? v === value
    : Array.isArray((v as { in?: string[] }).in) ? (v as { in: (string | null)[] }).in.includes(value)
    : true;

const created: Array<Record<string, unknown>> = [];

const matchesSessionWhere = (row: typeof SESSIONS[number], where: any): boolean => {
  if (!where) return true;
  if (where.clubId && row.clubId !== where.clubId) return false;
  if (where.teamId !== undefined && !idIn(where.teamId, row.teamId)) return false;
  if (where.OR && !where.OR.some((c: any) => (c.teamId === null ? row.teamId === null : idIn(c.teamId, row.teamId)))) return false;
  if (where.AND && !where.AND.every((c: any) => matchesSessionWhere(row, c))) return false;
  return true;
};

jest.mock('../src/config/database', () => ({
  prisma: {
    team: {
      findUnique: async ({ where }: any) => TEAMS.find((t) => t.id === where.id) ?? null,
      findMany: async ({ where = {} }: any = {}) => TEAMS.filter((t) => (where.clubId ? t.clubId === where.clubId : true)),
    },
    membership: {
      findMany: async ({ where }: any) => MEMBERSHIPS
        .filter((m) => m.userId === where.userId && m.clubId === where.clubId && m.isActive === where.isActive)
        .map((m) => ({ teamId: m.teamId, role: m.role })),
    },
    player: {
      groupBy: async () => [],
      findUnique: async ({ where }: any) => PLAYERS.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where = {} }: any = {}) => PLAYERS.filter((p) =>
        (where.clubId ? p.clubId === where.clubId : true)
        && (where.teamId !== undefined ? idIn(where.teamId, p.teamId) : true)
        && (where.id ? idIn(where.id, p.id) : true)),
    },
    trainingSession: {
      findUnique: async ({ where }: any) => SESSIONS.find((s) => s.id === where.id) ?? null,
      findFirst: async ({ where = {} }: any = {}) => SESSIONS.filter((s) => matchesSessionWhere(s, where))
        .sort((a, b) => b.scheduledAt.getTime() - a.scheduledAt.getTime())[0] ?? null,
      findMany: async ({ where = {} }: any = {}) => SESSIONS.filter((s) => matchesSessionWhere(s, where)),
      count: async ({ where = {} }: any = {}) => SESSIONS.filter((s) => matchesSessionWhere(s, where)).length,
      create: async ({ data }: any) => { created.push(data); return { id: 's-new', ...data, playerStats: [] }; },
    },
    trainingAttendanceRecord: { findMany: async () => [] },
    match: {
      findUnique: async ({ where }: any) => MATCHES.find((m) => m.id === where.id) ?? null,
      findMany: async ({ where = {} }: any = {}) => MATCHES.filter((m) =>
        (where.clubId ? m.clubId === where.clubId : true)
        && (where.AND ? where.AND.every((c: any) =>
              !c.OR || c.OR.some((o: any) => (o.teamId === null ? m.teamId === null : idIn(o.teamId, m.teamId)))) : true)),
      count: async () => MATCHES.length,
    },
  },
}));

import * as teamAccess from '../src/identity/team-access.service';
import * as training from '../src/services/training.service';
import {
  requireTrainingSessionAccess, requireTeamManageForCreate, requireMatchTeamAccess,
  requirePlayerTeamAccess, requireTeamPrivate, requireAnyTeamPrivate, isAuthenticated,
} from '../src/middleware/team-scope.middleware';
import { getMatches } from '../src/services/match.service';

// The middlewares are Express handlers; the tests feed them plain objects, so
// the call is made through one cast in one place rather than at every site.
type Mw = (...args: never[]) => unknown;
const run = (mw: Mw, req: unknown): Promise<{ statusCode?: number } | undefined> =>
  new Promise((resolve) => {
    (mw as unknown as (a: unknown, b: unknown, c: (e?: unknown) => void) => void)(
      req, {}, (e?: unknown) => resolve(e as { statusCode?: number } | undefined),
    );
  });

const req = (userId: string, over: Record<string, unknown> = {}) => ({
  user: { id: userId, clubId: CLUB },
  method: 'GET', params: {}, query: {}, body: {}, ...over,
});

const actor = (userId: string) => ({ userId, clubId: CLUB });
const status = (e: { statusCode?: number } | undefined) => (e ? e.statusCode ?? 500 : 200);

describe('training belongs to a team, and the server knows which', () => {
  it('a coach reads their own team\'s week, not the club\'s calendar', async () => {
    const scope = await teamAccess.privateTeamScope(actor('u-u15-coach'));
    const mine = await training.getTrainingSessions(CLUB, { scope });
    expect(mine.sessions.map((s: { id: string }) => s.id).sort()).toEqual(['s-legacy', 's-u15']);
    // Not the First Team's, and not the Under-17s'.
    expect(mine.sessions.some((s: { id: string }) => s.id === 's-first')).toBe(false);
    expect(mine.total).toBe(2);
  });

  it('and naming another team returns that team\'s week only to its own people', async () => {
    const scope = await teamAccess.privateTeamScope(actor('u-first-coach'));
    const own = await training.getTrainingSessions(CLUB, { teamId: 'team-first', scope });
    expect(own.sessions.map((s: { id: string }) => s.id)).toEqual(['s-first']);
    // The gate, not the query, is what refuses a foreign team.
    const denied = await run(requireTeamPrivate(), req('u-first-coach', { query: { teamId: 'team-u15' } }));
    expect(status(denied)).toBe(403);
  });

  it('a session id from another team\'s week is refused, not answered', async () => {
    expect(status(await run(requireTrainingSessionAccess('id'), req('u-u15-coach', { params: { id: 's-first' } })))).toBe(403);
    expect(status(await run(requireTrainingSessionAccess('id'), req('u-first-coach', { params: { id: 's-u17' } })))).toBe(403);
    // Their own is answered.
    expect(status(await run(requireTrainingSessionAccess('id'), req('u-u15-coach', { params: { id: 's-u15' } })))).toBe(200);
  });

  it('and changing one takes an assignment to manage that team', async () => {
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      expect(status(await run(requireTrainingSessionAccess('id'),
        req('u-u15-coach', { method, params: { id: 's-u17' } })))).toBe(403);
    }
    // On the team without running it: the U17 analyst reads the U17 session
    // and cannot change it.
    expect(status(await run(requireTrainingSessionAccess('id'), req('u-u17-analyst', { params: { id: 's-u17' } })))).toBe(200);
    expect(status(await run(requireTrainingSessionAccess('id'),
      req('u-u17-analyst', { method: 'PATCH', params: { id: 's-u17' } })))).toBe(403);
    // Its own coach may.
    expect(status(await run(requireTrainingSessionAccess('id'),
      req('u-u15-coach', { method: 'PATCH', params: { id: 's-u15' } })))).toBe(200);
  });

  it('a session the migration could not attribute is the club\'s, not a team\'s', async () => {
    // Readable by anybody who works on one of the club's teams …
    expect(status(await run(requireTrainingSessionAccess('id'), req('u-u15-coach', { params: { id: 's-legacy' } })))).toBe(200);
    // … and changeable only by somebody who administers the club's teams.
    expect(status(await run(requireTrainingSessionAccess('id'),
      req('u-u15-coach', { method: 'PATCH', params: { id: 's-legacy' } })))).toBe(403);
    expect(status(await run(requireTrainingSessionAccess('id'),
      req('u-owner', { method: 'PATCH', params: { id: 's-legacy' } })))).toBe(200);
  });

  it('the club member who works on no team is refused the module entirely', async () => {
    expect(status(await run(requireAnyTeamPrivate(), req('u-parent')))).toBe(403);
    expect(status(await run(requireAnyTeamPrivate(), req('u-u15-coach')))).toBe(200);
    expect(status(await run(requireAnyTeamPrivate(), req('u-owner')))).toBe(200);
  });

  it('creating a session names a team, and the team is the caller\'s to name', async () => {
    // Another team's: refused before anything is written.
    expect(status(await run(requireTeamManageForCreate(),
      req('u-u15-coach', { method: 'POST', body: { teamId: 'team-first' } })))).toBe(403);
    // Their own: allowed.
    expect(status(await run(requireTeamManageForCreate(),
      req('u-u15-coach', { method: 'POST', body: { teamId: 'team-u15' } })))).toBe(200);
    // Naming none is naming their own, because they manage exactly one team —
    // and the resolution comes from the membership, never from the request.
    expect(status(await run(requireTeamManageForCreate(), req('u-u15-coach', { method: 'POST' })))).toBe(200);
    expect(await teamAccess.soleManagedTeamId(actor('u-u15-coach'))).toBe('team-u15');
    // The owner manages the club rather than one team, so for them a session
    // with no team is a club session and that is the authority it takes.
    expect(await teamAccess.soleManagedTeamId(actor('u-owner'))).toBeNull();
    expect(status(await run(requireTeamManageForCreate(), req('u-owner', { method: 'POST' })))).toBe(200);
    expect(status(await run(requireTeamManageForCreate(), req('u-parent', { method: 'POST' })))).toBe(403);
  });

  it('a created session carries its team, and only that team\'s players', async () => {
    created.length = 0;
    await training.createCleanSession(CLUB, {
      title: 'U15 — finishing', scheduledAt: '2026-09-15T15:00:00Z', duration: 75,
      teamId: 'team-u15', playerIds: ['p-u15'],
    });
    expect(created[0].teamId).toBe('team-u15');
    // A player from another team cannot be attached to it.
    await expect(training.createCleanSession(CLUB, {
      title: 'U15 — finishing', scheduledAt: '2026-09-15T15:00:00Z', duration: 75,
      teamId: 'team-u15', playerIds: ['p-first'],
    })).rejects.toThrow(/not in this team's squad/i);
    // And a team of another club is refused outright.
    await expect(training.createCleanSession(CLUB, {
      title: 'x', scheduledAt: '2026-09-15T15:00:00Z', duration: 75, teamId: 'team-outside',
    })).rejects.toThrow();
  });

  it('the attendance roster is the session\'s squad, not the club\'s', async () => {
    const u15 = await training.getTrainingAttendance('s-u15', CLUB);
    expect(u15.items.map((i: { playerId: string }) => i.playerId)).toEqual(['p-u15']);
    const first = await training.getTrainingAttendance('s-first', CLUB);
    expect(first.items.map((i: { playerId: string }) => i.playerId)).toEqual(['p-first']);
    // A legacy club session keeps the club roster it was recorded against.
    const legacy = await training.getTrainingAttendance('s-legacy', CLUB);
    expect(legacy.items).toHaveLength(PLAYERS.length);
  });

  it('and the form ring reads the team\'s own latest session', async () => {
    const scope = await teamAccess.privateTeamScope(actor('u-u15-coach'));
    const form = await training.getTrainingForm(CLUB, { teamId: 'team-u15', scope });
    expect(form.attackForm).toBe(10);
    const firstForm = await training.getTrainingForm(CLUB, { teamId: 'team-first' });
    expect(firstForm.attackForm).toBe(12);
  });
});

describe('the club calendar is scoped the same way', () => {
  it('a coach lists their own team\'s matches', async () => {
    const scope = await teamAccess.privateTeamScope(actor('u-u15-coach'));
    const res = await getMatches(CLUB, { teamScope: scope.teamIds });
    expect(res.matches.map((m: { id: string }) => m.id)).toEqual(['m-u15']);
  });

  it('and one match from another team\'s season is refused', async () => {
    expect(status(await run(requireMatchTeamAccess('id'), req('u-u15-coach', { params: { id: 'm-first' } })))).toBe(403);
    expect(status(await run(requireMatchTeamAccess('id'), req('u-u15-coach', { params: { id: 'm-u15' } })))).toBe(200);
    expect(status(await run(requireMatchTeamAccess('id'),
      req('u-u15-coach', { method: 'PATCH', params: { id: 'm-first' } })))).toBe(403);
    // The owner administers the club's teams.
    expect(status(await run(requireMatchTeamAccess('id'),
      req('u-owner', { method: 'PATCH', params: { id: 'm-first' } })))).toBe(200);
  });

  it('a request with no session is left to the route\'s own authentication', async () => {
    // The live SSE stream carries its token in the query string and
    // authenticates itself; a team gate must not answer 403 where the route
    // answers 401.
    expect(isAuthenticated({} as never)).toBe(false);
    expect(status(await run(requireMatchTeamAccess('id'),
      { method: 'GET', params: { id: 'm-first' }, query: {}, body: {} }))).toBe(200);
  });
});

describe('the same gate, the same answer, whichever module asks', () => {
  it('a player of another team is refused wherever he is addressed', async () => {
    expect(status(await run(requirePlayerTeamAccess('id'), req('u-u15-coach', { params: { id: 'p-first' } })))).toBe(403);
    expect(status(await run(requirePlayerTeamAccess('playerId'), req('u-first-coach', { params: { playerId: 'p-u15' } })))).toBe(403);
    expect(status(await run(requirePlayerTeamAccess('id'), req('u-u15-coach', { params: { id: 'p-u15' } })))).toBe(200);
    // The club owner reaches every team of the club, and nobody else's club.
    expect(status(await run(requirePlayerTeamAccess('id'), req('u-owner', { params: { id: 'p-first' } })))).toBe(200);
  });

  it('and the club member on no team reaches none of it', async () => {
    for (const mw of [requirePlayerTeamAccess('id')]) {
      expect(status(await run(mw, req('u-parent', { params: { id: 'p-u15' } })))).toBe(403);
    }
    expect(status(await run(requireTeamPrivate(), req('u-parent', { query: { teamId: 'team-u15' } })))).toBe(403);
    // What they may still see is the shell: the team exists, and is named.
    const contexts = await teamAccess.listTeamContexts(actor('u-parent'));
    expect(contexts.map((c) => c.name).sort()).toEqual(['First Team', 'U15', 'U17']);
    expect(contexts.every((c) => c.access.canView && !c.access.canViewPrivate)).toBe(true);
  });
});


describe('the migration that made this possible is additive, and does not guess', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const ROOT = path.join(__dirname, '..');
  const SQL = fs.readFileSync(
    path.join(ROOT, 'prisma/migrations/20260904090000_training_session_team/migration.sql'), 'utf8');
  const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');

  it('adds a nullable column and nothing else structural', () => {
    expect(SQL).toContain('ALTER TABLE "TrainingSession" ADD COLUMN IF NOT EXISTS "teamId" TEXT');
    // Additive only: no history is dropped, emptied or rewritten.
    expect(SQL).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM/i);
    // The column is nullable in the schema too, because an unattributable
    // session must be allowed to stay unattributed.
    const model = SCHEMA.slice(SCHEMA.indexOf('model TrainingSession'), SCHEMA.indexOf('model PlayerTrainingStat'));
    expect(model).toMatch(/teamId String\?/);
    expect(model).toMatch(/team\s+Team\?\s+@relation\(fields: \[teamId\], references: \[id\], onDelete: SetNull\)/);
    expect(model).toContain('@@index([clubId, teamId])');
  });

  it('and backfills only what the data already proves', () => {
    // Rule 1: one team across the squad, and nobody teamless. COUNT(teamId)
    // skips nulls, so the equality is the assertion that none is null.
    expect(SQL).toContain('HAVING COUNT(DISTINCT p."teamId") = 1');
    expect(SQL).toContain('AND COUNT(*) = COUNT(p."teamId")');
    // Never across a club boundary, whatever the squad rows say.
    expect(SQL).toMatch(/EXISTS \(SELECT 1 FROM "Team" t WHERE t\."id" = agreed\."teamId" AND t\."clubId" = ts\."clubId"\)/);
    // Rule 2: a club with exactly one team has nowhere else to put it.
    expect(SQL).toContain('HAVING COUNT(*) = 1');
    // Both rules only ever fill a NULL — a session already attributed is never
    // moved from one team to another.
    const updates = SQL.match(/UPDATE "TrainingSession"[\s\S]*?;/g) || [];
    expect(updates).toHaveLength(2);
    for (const u of updates) expect(u).toContain('"teamId" IS NULL');
  });
});
