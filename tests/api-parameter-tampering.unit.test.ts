/**
 * tests/api-parameter-tampering.unit.test.ts
 *
 * Changing an id in a URL, a query string or a body does not change the answer.
 *
 * The other suites prove the rule inside the services that own it. This one
 * attacks the boundary the way somebody actually would: take a valid session,
 * put another team's id — or another club's — into every place a request can
 * carry one, and demand a 403 rather than a payload.
 *
 * The cast, one club with three teams and one member per posture, plus a
 * second club nobody here belongs to.
 */

import { MembershipRole, TeamKind } from '@prisma/client';

const CLUB = 'club-harta-berlin';
const OTHER_CLUB = 'club-elsewhere';

const TEAMS = [
  { id: 'team-first', clubId: CLUB, name: 'First Team', kind: TeamKind.SENIOR, isActive: true },
  { id: 'team-u10', clubId: CLUB, name: 'HARTA U8-U10', kind: TeamKind.ACADEMY_U13, isActive: true },
  { id: 'team-u16', clubId: CLUB, name: 'HARTA U14-U16', kind: TeamKind.ACADEMY_U17, isActive: true },
  { id: 'team-outside', clubId: OTHER_CLUB, name: 'Elsewhere First Team', kind: TeamKind.SENIOR, isActive: true },
];

const MEMBERSHIPS = [
  { userId: 'u-first', clubId: CLUB, teamId: 'team-first', role: MembershipRole.HEAD_COACH, isActive: true },
  { userId: 'u-u10', clubId: CLUB, teamId: 'team-u10', role: MembershipRole.HEAD_COACH, isActive: true },
  { userId: 'u-u16', clubId: CLUB, teamId: 'team-u16', role: MembershipRole.HEAD_COACH, isActive: true },
  { userId: 'u-owner', clubId: CLUB, teamId: null, role: MembershipRole.CLUB_OWNER, isActive: true },
  { userId: 'u-member', clubId: CLUB, teamId: null, role: MembershipRole.PARENT, isActive: true },
];

const PLAYERS = [
  { id: 'p-first', clubId: CLUB, teamId: 'team-first' },
  { id: 'p-u10', clubId: CLUB, teamId: 'team-u10' },
  { id: 'p-u16', clubId: CLUB, teamId: 'team-u16' },
  { id: 'p-outside', clubId: OTHER_CLUB, teamId: 'team-outside' },
];

const MATCHES = [
  { id: 'm-first', clubId: CLUB, teamId: 'team-first' },
  { id: 'm-u16', clubId: CLUB, teamId: 'team-u16' },
  { id: 'm-outside', clubId: OTHER_CLUB, teamId: 'team-outside' },
];

jest.mock('../src/security/security-event.service', () => ({ logSecurityEvent: jest.fn() }));

jest.mock('../src/config/database', () => ({
  prisma: {
    team: { findUnique: async ({ where }: any) => TEAMS.find((t) => t.id === where.id) ?? null },
    membership: {
      findMany: async ({ where }: any) => MEMBERSHIPS
        .filter((m) => m.userId === where.userId && m.clubId === where.clubId && m.isActive === where.isActive)
        .map((m) => ({ teamId: m.teamId, role: m.role })),
    },
    player: { findUnique: async ({ where }: any) => PLAYERS.find((p) => p.id === where.id) ?? null },
    match: { findUnique: async ({ where }: any) => MATCHES.find((m) => m.id === where.id) ?? null },
    deviceSession: { findUnique: async () => null },
    camera: { findUnique: async () => null },
    aIAlert: { findUnique: async () => null },
    aIAgentJob: { findUnique: async () => null },
    aIApprovalRequest: { findUnique: async () => null },
  },
}));

import express, { Router } from 'express';
import request from 'supertest';
import { guardTeamScopedRouter } from '../src/middleware/team-scope.middleware';
import { errorHandler } from '../src/middleware/error.middleware';

/**
 * A router shaped like the real ones: a session is attached the way
 * `authenticate` attaches it, then the guard is installed exactly as every
 * protected router installs it, then handlers that would return private data.
 */
function appFor(userId: string | null, clubId = CLUB) {
  const app = express();
  app.use(express.json());
  const api = Router();
  api.use((req, _res, next) => {
    if (userId) {
      (req as unknown as { user: unknown }).user =
        { id: userId, email: `${userId}@example.test`, clubId, role: 'HEAD_COACH' };
    }
    next();
  });
  guardTeamScopedRouter(api);
  const secret = (_req: express.Request, res: express.Response) => res.json({ secret: 'squad, tactics, medical' });
  api.get('/teams/:teamId/analysis', secret);
  api.post('/teams/:teamId/jobs', secret);
  api.get('/players/:playerId/analytics', secret);
  api.get('/matches/:matchId/video', secret);
  api.get('/report', secret);                 // teamId arrives in the query
  api.post('/report', secret);                // …or in the body
  app.use('/api', api);
  app.use(errorHandler);
  return app;
}

const get = (user: string | null, path: string, club = CLUB) => request(appFor(user, club)).get(`/api${path}`);
const post = (user: string | null, path: string, body: unknown = {}) =>
  request(appFor(user)).post(`/api${path}`).send(body as object);

describe('a team id in the URL', () => {
  it('1 · First Team staff asking for an Academy team is refused', async () => {
    await expect(get('u-first', '/teams/team-u10/analysis').expect(403)).resolves.toBeTruthy();
    await expect(get('u-first', '/teams/team-u16/analysis').expect(403)).resolves.toBeTruthy();
  });

  it('2 · one Academy team asking for another is refused', async () => {
    await get('u-u10', '/teams/team-u16/analysis').expect(403);
    await get('u-u16', '/teams/team-u10/analysis').expect(403);
  });

  it('3 · an Academy coach asking for the First Team is refused', async () => {
    await get('u-u10', '/teams/team-first/analysis').expect(403);
  });

  it('4 · a club member assigned to no team is refused', async () => {
    await get('u-member', '/teams/team-u10/analysis').expect(403);
    await get('u-member', '/teams/team-first/analysis').expect(403);
  });

  it('5 · another club\'s team is refused', async () => {
    await get('u-owner', '/teams/team-outside/analysis').expect(403);
    await get('u-first', '/teams/team-outside/analysis').expect(403);
  });

  it('6 · and the team\'s own staff are served', async () => {
    await get('u-first', '/teams/team-first/analysis').expect(200);
    await get('u-u10', '/teams/team-u10/analysis').expect(200);
    await get('u-u16', '/teams/team-u16/analysis').expect(200);
  });

  it('7 · the club owner keeps club-wide authority', async () => {
    for (const teamId of ['team-first', 'team-u10', 'team-u16']) {
      await get('u-owner', `/teams/${teamId}/analysis`).expect(200);
      await post('u-owner', `/teams/${teamId}/jobs`).expect(200);
    }
  });

  it('and writing takes an assignment to manage, not merely to read', async () => {
    await post('u-u10', '/teams/team-u10/jobs').expect(200);
    await post('u-u10', '/teams/team-u16/jobs').expect(403);
    await post('u-member', '/teams/team-u10/jobs').expect(403);
  });
});

describe('a player or match id in the URL', () => {
  it('reaches only the teams the caller works on', async () => {
    await get('u-first', '/players/p-u10/analytics').expect(403);
    await get('u-u10', '/players/p-first/analytics').expect(403);
    await get('u-u10', '/players/p-u16/analytics').expect(403);
    await get('u-u10', '/players/p-u10/analytics').expect(200);
    await get('u-owner', '/players/p-first/analytics').expect(200);

    await get('u-u10', '/matches/m-first/video').expect(403);
    await get('u-u16', '/matches/m-u16/video').expect(200);
  });

  it('and a row from another club never resolves at all', async () => {
    await get('u-owner', '/players/p-outside/analytics').expect(403);
    await get('u-owner', '/matches/m-outside/video').expect(403);
  });
});

describe('a team id smuggled past the URL', () => {
  it('in the query string is checked the same way', async () => {
    await get('u-u10', '/report?teamId=team-u16').expect(403);
    await get('u-u10', '/report?teamId=team-first').expect(403);
    await get('u-member', '/report?teamId=team-u10').expect(403);
    await get('u-u10', '/report?teamId=team-u10').expect(200);
    await get('u-owner', '/report?teamId=team-first').expect(200);
  });

  it('in the body is checked the same way', async () => {
    await post('u-u10', '/report', { teamId: 'team-u16' }).expect(403);
    await post('u-u10', '/report', { teamId: 'team-u10' }).expect(200);
    await post('u-member', '/report', { teamId: 'team-first' }).expect(403);
  });

  it('and naming no team at all is left exactly as it was', async () => {
    // A club-wide read that names no team is not a team request, and the guard
    // does not invent one — this is what keeps Home and the club shell working.
    await get('u-member', '/report').expect(200);
    await get('u-first', '/report').expect(200);
  });
});

describe('the refusal itself', () => {
  it('carries no private payload', async () => {
    const res = await get('u-u10', '/teams/team-first/analysis').expect(403);
    expect(JSON.stringify(res.body)).not.toContain('squad, tactics, medical');
    expect(res.body.success).toBe(false);
  });
});


describe('the boundary is installed where it can actually see an id', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const ROOT = path.join(__dirname, '..');
  const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  it('every router that names a team, a player or a match carries the guard', () => {
    const dir = path.join(ROOT, 'src', 'routes');
    // Two are deliberately not team-private, and are named here so that adding
    // a third by accident fails this test rather than shipping.
    const PUBLIC_BY_DESIGN = new Set(['familista-league.routes.ts', 'transfer-market.routes.ts']);
    const unguarded: string[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.routes.ts'))) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      if (!/:(teamId|playerId|matchId)/.test(src)) continue;
      if (PUBLIC_BY_DESIGN.has(file)) continue;
      if (!src.includes('team-scope.middleware')) unguarded.push(file);
    }
    expect(unguarded).toEqual([]);
  });

  it('the guard installs through router.param, because req.params is empty before a route matches', () => {
    const SRC = read('src/middleware/team-scope.middleware.ts');
    expect(SRC).toContain("router.param('teamId'");
    expect(SRC).toContain("router.param('playerId'");
    expect(SRC).toContain("router.param('matchId'");
    // The club boundary is the existing tenantGuard, called rather than rewritten.
    expect(SRC).toContain("import { tenantGuard } from './tenant-guard.middleware'");
    expect(SRC).toContain('tenantGuard(req, res,');
  });

  it('and the same guard is mounted at the API edge', () => {
    const APP = read('src/app.ts');
    expect(APP).toContain('app.use(`/api/${config.apiVersion}`, tenantGuard, routes)');
    expect(APP).toContain("import { tenantGuard } from './middleware/tenant-guard.middleware'");
  });
});
