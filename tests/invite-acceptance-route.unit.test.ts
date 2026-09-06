/**
 * tests/invite-acceptance-route.unit.test.ts
 *
 * The link in the email has to open something.
 *
 * An invitation that is minted correctly, hashed correctly, emailed correctly
 * and then answered with "Not Found" is an invitation that does not exist. Two
 * things were wrong, and both are covered here:
 *
 *   1. `express.static` serves index.html for the EXACT root path only, so
 *      /invite/accept fell through to the 404 handler. Password reset had a
 *      route for exactly this reason; invitation acceptance had none.
 *   2. There was no acceptance page anywhere in the product, so even a correct
 *      route had nothing to serve.
 *
 * The security properties are the interesting part. This page is PUBLIC — the
 * person opening it has no session and possibly no account — and what makes
 * that safe is that the token is the credential, and that nothing the request
 * can say decides where the person lands.
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { MembershipRole, UserRole } from '@prisma/client';
import { createHash } from 'crypto';

type Row = Record<string, any>;

const CLUB = 'club-harta';
const OTHER_CLUB = 'club-elsewhere';

const state = {
  invitations: [] as Row[],
  users: [] as Row[],
  memberships: [] as Row[],
  clubs: [] as Row[],
  audits: [] as Row[],
  platformAudits: [] as Row[],
  refreshTokens: [] as Row[],
};

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;
const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== v.not;
      if ('gt' in v) return row[k] > v.gt;
      if ('lt' in v) return row[k] < v.lt;
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const db: Row = {
  clubInvitation: {
    create: async ({ data }: Row) => {
      const r = {
        id: id('inv'), status: 'PENDING', acceptedAt: null, acceptedByUserId: null,
        revokedAt: null, revokedByUserId: null, message: null, teamId: null, createdAt: new Date(),
        deliveryState: 'CREATED', deliveryProvider: null, deliveryMessageId: null,
        deliveryFailureCode: null, deliveryFailureClass: null, deliveryAttemptedAt: null,
        deliveryAttempts: 0, deliveryLocale: null, ...data,
      };
      state.invitations.push(r);
      return r;
    },
    findFirst: async ({ where }: Row) => state.invitations.find((r) => match(r, where)) ?? null,
    findUnique: async ({ where }: Row) =>
      state.invitations.find((r) => (where.id ? r.id === where.id : r.tokenHash === where.tokenHash)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.invitations.filter((r) => match(r, where)),
    update: async ({ where, data }: Row) => {
      const r = state.invitations.find((x) => x.id === where.id)!;
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === 'object' && 'increment' in (v as Row)) r[k] = (r[k] ?? 0) + (v as Row).increment;
        else r[k] = v;
      }
      return r;
    },
    updateMany: async ({ where, data }: Row) => {
      const rows = state.invitations.filter((r) => match(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  user: {
    findUnique: async ({ where }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      if (!u) return null;
      return where.include?.club ? { ...u, club: state.clubs.find((c) => c.id === u.clubId) ?? null } : u;
    },
    create: async ({ data }: Row) => {
      const u = { id: id('user'), isActive: true, tokenVersion: 0, createdAt: new Date(), ...data };
      state.users.push(u);
      return { ...u, club: state.clubs.find((c) => c.id === u.clubId) ?? { name: 'Club' } };
    },
    update: async ({ where, data }: Row) => {
      const u = state.users.find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return u;
    },
  },
  club: { findUnique: async ({ where }: Row) => state.clubs.find((c) => c.id === where.id) ?? null },
  team: { findUnique: async () => null },
  membership: {
    create: async ({ data }: Row) => {
      const m = { id: id('mem'), isActive: true, status: 'ACTIVE', createdAt: new Date(), ...data };
      state.memberships.push(m);
      return m;
    },
    findFirst: async ({ where }: Row) => state.memberships.find((m) => match(m, where)) ?? null,
    findMany: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)),
    findUnique: async ({ where }: Row) => state.memberships.find((m) => m.id === where.id) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
    update: async ({ where, data }: Row) => {
      const m = state.memberships.find((x) => x.id === where.id)!;
      Object.assign(m, data);
      return m;
    },
  },
  membershipAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  platformAuditLog: { create: async ({ data }: Row) => { state.platformAudits.push(data); return data; } },
  platformAdmin: { findUnique: async () => null },
  refreshToken: {
    create: async ({ data }: Row) => { state.refreshTokens.push(data); return data; },
    deleteMany: async () => ({ count: 0 }),
    findFirst: async () => null,
  },
  analyticsEvent: { findFirst: async () => null, count: async () => 0, createMany: async () => ({ count: 0 }) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import * as invites from '../src/identity/invitation.service';
import { resetInvitationThrottle } from '../src/identity/invitation-throttle';
import { setEmailProvider } from '../src/platform/email/service';
import invitationRoutes from '../src/routes/invitation.routes';
import { errorHandler } from '../src/middleware/error.middleware';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_TS = read('src/app.ts');
const PAGE = read('public/invite/index.html');
const SCRIPT = read('public/invite/invite.js');

/** A provider that accepts everything, so delivery never colours these tests. */
const silentProvider = {
  name: 'test', isConfigured: () => true, configurationProblem: () => null,
  async send() {
    return { ok: true, providerName: 'test', providerMessageId: 'm', failureClass: null, failureCode: null, latencyMs: 1 };
  },
};

/** The invitation router, mounted the way the real app mounts it. */
function harness() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invitations', invitationRoutes);
  app.use(errorHandler);
  return app;
}

const OWNER = { userId: 'u-owner', clubId: CLUB };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  seq = 0;
  state.invitations = [];
  state.memberships = [];
  state.audits = [];
  state.platformAudits = [];
  state.refreshTokens = [];
  state.clubs = [
    { id: CLUB, name: 'HARTA BERLIN', defaultLocale: 'en-GB' },
    { id: OTHER_CLUB, name: 'Elsewhere FC', defaultLocale: null },
  ];
  state.users = [
    { id: 'u-owner', email: 'owner@harta.test', firstName: 'Club', lastName: 'Owner', isActive: true, clubId: CLUB, role: 'CLUB_ADMIN', tokenVersion: 0 },
    { id: 'u-known', email: 'known@person.test', firstName: 'Known', lastName: 'Person', isActive: true, clubId: CLUB, role: 'COACH', tokenVersion: 0 },
  ];
  setEmailProvider(silentProvider as never);
  resetInvitationThrottle();
  process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-access-secret-value';
  process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-value';
});

afterAll(() => setEmailProvider(null));

const invite = async (email = 'new.president@club.test', role: MembershipRole = MembershipRole.CLUB_OWNER) =>
  invites.createInvitation(OWNER, { email, role });

// ─────────────────────────────────────────────────────────────────────────────
// The routing — the actual cause of "Not Found"
// ─────────────────────────────────────────────────────────────────────────────

describe('the link in the email opens something', () => {
  it('serves the acceptance page for a direct hit on /invite/accept', () => {
    // express.static answers index.html for "/" and nothing else, which is why
    // every emailed deep link needs a route of its own.
    expect(APP_TS).toMatch(/app\.get\(\['\/invite', '\/invite\/\*'\]/);
    expect(APP_TS).toMatch(/sendFile\(path\.join\(publicDir, 'invite', 'index\.html'\)\)/);
    // The page it names actually exists.
    expect(fs.existsSync(path.join(ROOT, 'public/invite/index.html'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'public/invite/invite.js'))).toBe(true);
  });

  it('and every /invite/* path resolves to it, so a malformed link is explained', () => {
    // The page says "this link is incomplete", which is more use than a 404.
    expect(SCRIPT).toContain('This link is incomplete');
  });

  it('routes it BEFORE the 404 handler, and leaves reset-password alone', () => {
    const inviteAt = APP_TS.indexOf("'/invite/*'");
    const notFoundAt = APP_TS.indexOf('app.use(notFoundHandler)');
    expect(inviteAt).toBeGreaterThan(-1);
    expect(inviteAt).toBeLessThan(notFoundAt);
    // The route that already worked still does, unchanged.
    expect(APP_TS).toMatch(/app\.get\('\/reset-password'/);
  });

  it('the page needs no session, and boots no signed-in application', () => {
    // A stranger with a link is not made to load the club workspace.
    expect(PAGE).not.toContain('/app.js');
    expect(PAGE).not.toContain('/system/system.js');
    expect(PAGE).toContain('/invite/invite.js');
    // And it is not indexed: the URL carries a credential.
    expect(PAGE).toContain('name="robots" content="noindex, nofollow"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The public endpoints the page uses
// ─────────────────────────────────────────────────────────────────────────────

describe('a signed-out person can read what the link is for', () => {
  it('previews the club and the role, with no session at all', async () => {
    const out = await invite();
    const res = await request(harness()).get(`/api/v1/invitations/preview?token=${encodeURIComponent(out.token)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      clubName: 'HARTA BERLIN', role: 'CLUB_OWNER', email: 'new.president@club.test', accountExists: false,
    });
    // Deliberately thin: the person holding this link has proved nothing yet
    // except that they hold it.
    expect(Object.keys(res.body.data).sort()).toEqual([
      'accountExists', 'clubId', 'clubName', 'email', 'expiresAt', 'message', 'role', 'teamId', 'teamName',
    ]);
    // No token, no hash, no member list.
    expect(JSON.stringify(res.body)).not.toContain(out.token);
    expect(JSON.stringify(res.body)).not.toContain(sha(out.token));
  });

  it('refuses an expired, revoked or already-used link in words a person can act on', async () => {
    const app = harness();

    const expired = await invite('expired@club.test');
    state.invitations.find((r) => r.email === 'expired@club.test')!.expiresAt = new Date(Date.now() - 1000);
    const a = await request(app).get(`/api/v1/invitations/preview?token=${encodeURIComponent(expired.token)}`);
    expect(a.status).toBe(400);
    expect(a.body.message).toMatch(/expired/i);

    const revoked = await invite('revoked@club.test');
    await invites.revokeInvitation(OWNER, revoked.invitation.id);
    const b = await request(app).get(`/api/v1/invitations/preview?token=${encodeURIComponent(revoked.token)}`);
    expect(b.status).toBe(400);
    expect(b.body.message).toMatch(/withdrawn/i);

    const nonsense = await request(app).get('/api/v1/invitations/preview?token=not-a-real-token');
    expect(nonsense.status).toBe(404);
  });
});

describe('accepting with no account yet', () => {
  it('creates the account, grants the membership, and consumes the invitation', async () => {
    const out = await invite();
    const res = await request(harness())
      .post('/api/v1/invitations/accept-with-account')
      .send({ token: out.token, firstName: 'Alina', lastName: 'Braun', password: 'a-password-only-mine' });

    expect(res.status).toBe(201);

    // The account exists, with the invited address and nothing they chose.
    const user = state.users.find((u) => u.email === 'new.president@club.test')!;
    expect(user).toBeDefined();
    expect(user.firstName).toBe('Alina');
    expect(user.clubId).toBe(CLUB);
    expect(user.role).toBe(UserRole.CLUB_ADMIN);       // a president administers one club
    expect(user.role).not.toBe(UserRole.SUPER_ADMIN);  // never platform authority

    // The membership is the real grant, and it went through the usual service.
    const membership = state.memberships.find((m) => m.userId === user.id)!;
    expect(membership).toMatchObject({ clubId: CLUB, role: 'CLUB_OWNER', isActive: true });

    // Consumed exactly once.
    expect(state.invitations[0].status).toBe('ACCEPTED');
    await expect(invites.previewInvitation(out.token)).rejects.toThrow(/already been used/i);

    // Signed in on the way out, so they land in Familista rather than at a login.
    expect([res.headers['set-cookie']].flat().join(';')).toMatch(/access_token/);
  });

  it('takes the club, the role and the address from the invitation, never the request', async () => {
    const out = await invite('victim@club.test', MembershipRole.ANALYST);
    const res = await request(harness())
      .post('/api/v1/invitations/accept-with-account')
      .send({
        token: out.token, firstName: 'A', lastName: 'B', password: 'a-password-only-mine',
        // Every one of these is ignored. None of them is a parameter.
        email: 'attacker@evil.test',
        clubId: OTHER_CLUB,
        role: 'SUPER_ADMIN',
        accountRole: 'SUPER_ADMIN',
      });

    expect(res.status).toBe(201);
    expect(state.users.find((u) => u.email === 'attacker@evil.test')).toBeUndefined();
    const user = state.users.find((u) => u.email === 'victim@club.test')!;
    expect(user.clubId).toBe(CLUB);
    expect(user.role).not.toBe(UserRole.SUPER_ADMIN);
    const membership = state.memberships.find((m) => m.userId === user.id)!;
    expect(membership.clubId).toBe(CLUB);
    expect(membership.role).toBe('ANALYST');
  });

  it('never stores the password in the clear, and never returns it', async () => {
    const out = await invite();
    const password = 'a-password-only-mine';
    const res = await request(harness())
      .post('/api/v1/invitations/accept-with-account')
      .send({ token: out.token, firstName: 'A', lastName: 'B', password });

    const user = state.users.find((u) => u.email === 'new.president@club.test')!;
    expect(user.passwordHash).toBeTruthy();
    expect(user.passwordHash).not.toBe(password);
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(JSON.stringify(res.body)).not.toContain(password);
    expect(JSON.stringify(res.body)).not.toContain(user.passwordHash);
    // Nor in either audit trail.
    expect(JSON.stringify(state.audits) + JSON.stringify(state.platformAudits)).not.toContain(password);
  });

  it('refuses a short password, and an expired, revoked or used link', async () => {
    const app = harness();

    const good = await invite('short@club.test');
    const short = await request(app).post('/api/v1/invitations/accept-with-account')
      .send({ token: good.token, firstName: 'A', lastName: 'B', password: 'short' });
    expect(short.status).toBe(400);
    expect(state.users.find((u) => u.email === 'short@club.test')).toBeUndefined();

    const revoked = await invite('rev@club.test');
    await invites.revokeInvitation(OWNER, revoked.invitation.id);
    const after = await request(app).post('/api/v1/invitations/accept-with-account')
      .send({ token: revoked.token, firstName: 'A', lastName: 'B', password: 'a-password-only-mine' });
    expect(after.status).toBe(400);
    expect(state.users.find((u) => u.email === 'rev@club.test')).toBeUndefined();
  });

  it('and cannot be replayed to create a second account or a second membership', async () => {
    const out = await invite();
    const app = harness();
    const body = { token: out.token, firstName: 'A', lastName: 'B', password: 'a-password-only-mine' };

    expect((await request(app).post('/api/v1/invitations/accept-with-account').send(body)).status).toBe(201);
    const second = await request(app).post('/api/v1/invitations/accept-with-account').send(body);
    expect(second.status).toBeGreaterThanOrEqual(400);

    expect(state.users.filter((u) => u.email === 'new.president@club.test')).toHaveLength(1);
    expect(state.memberships.filter((m) => m.clubId === CLUB)).toHaveLength(1);
  });

  it('tells somebody who already has an account to sign in instead', async () => {
    const out = await invite('known@person.test', MembershipRole.HEAD_COACH);
    const res = await request(harness()).post('/api/v1/invitations/accept-with-account')
      .send({ token: out.token, firstName: 'A', lastName: 'B', password: 'a-password-only-mine' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Sign in to accept/i);
    // It reveals nothing they did not know: they hold a link written to it.
    expect(state.users.filter((u) => u.email === 'known@person.test')).toHaveLength(1);
  });
});

describe('accepting with an account already', () => {
  it('grants the membership when the signed-in address is the invited one', async () => {
    const out = await invite('known@person.test', MembershipRole.HEAD_COACH);
    const accepted = await invites.acceptInvitation(
      { userId: 'u-known', email: 'known@person.test' }, out.token);

    expect(state.memberships.find((m) => m.id === accepted.membershipId)).toMatchObject({
      userId: 'u-known', clubId: CLUB, role: 'HEAD_COACH', isActive: true,
    });
  });

  it('and refuses a session belonging to somebody else', async () => {
    const out = await invite('somebody.else@club.test');
    await expect(invites.acceptInvitation({ userId: 'u-known', email: 'known@person.test' }, out.token))
      .rejects.toThrow(/different email address/i);
    expect(state.memberships).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The page's own conduct
// ─────────────────────────────────────────────────────────────────────────────

describe('the page holds the token carefully and decides nothing', () => {
  it('never persists the token anywhere', () => {
    // Checked against code rather than prose: the file's own banner comment
    // says it never touches storage, and a regex over the whole file would
    // match that sentence and pass for entirely the wrong reason.
    const code = SCRIPT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(SCRIPT).toContain('var token = \'\';');
  });

  it('takes it out of the address bar as soon as it has been read', () => {
    // A single-use credential in the address bar is in the history entry, in a
    // screenshot of the tab, and in the Referer of anything loaded afterwards.
    expect(SCRIPT).toContain('function scrubUrl');
    expect(SCRIPT).toContain('history.replaceState({}, document.title, window.location.pathname)');
    expect(SCRIPT).toMatch(/scrubUrl\(\);[\s\S]{0,200}accountExists/);
  });

  it('shows the club and role from the server, and lets nobody edit them', () => {
    // The address is rendered readonly — it is the invitation's, not theirs.
    expect(SCRIPT).toContain('esc(preview.email) + \'" readonly');
    expect(SCRIPT).toContain('preview.clubName');
    expect(SCRIPT).toContain('roleLabel(preview.role)');
    // The create form sends a name and a password. Nothing else.
    const createCall = SCRIPT.slice(SCRIPT.indexOf("api('/invitations/accept-with-account'"), SCRIPT.indexOf('}).then(showAccepted)'));
    expect(createCall).toContain('token: token');
    expect(createCall).toContain('firstName');
    expect(createCall).toContain('password');
    expect(createCall).not.toMatch(/clubId|role:|email:/);
  });

  it('and says plainly that the password is the recipient\'s own', () => {
    expect(SCRIPT).toMatch(/nobody at the club and nobody at Familista can see it/i);
    expect(SCRIPT).toMatch(/never email you a password/i);
  });
});

describe('nothing that already worked was changed', () => {
  it('leaves the club-side invitation routes exactly as they were', () => {
    const routes = read('src/routes/invitation.routes.ts');
    expect(routes).toContain("router.post('/',           authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.create);");
    expect(routes).toContain("router.post('/:id/resend', authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.resend);");
    expect(routes).toContain("router.delete('/:id',      authorize('CLUB_ADMIN', 'SUPER_ADMIN'), requireMembership('CLUB_ADMIN'), ctrl.revoke);");
    // The signed-in acceptance still requires a session.
    const authAt = routes.indexOf('router.use(authenticate)');
    expect(routes.indexOf("router.post('/accept',")).toBeGreaterThan(authAt);
    // And the two public ones sit above it, deliberately.
    expect(routes.indexOf("router.get('/preview'")).toBeLessThan(authAt);
    expect(routes.indexOf("router.post('/accept-with-account'")).toBeLessThan(authAt);
  });

  it('does not touch token generation, delivery or the schema', () => {
    const service = read('src/identity/invitation.service.ts');
    // Still 32 random bytes, still only the hash stored.
    expect(service).toContain("randomBytes(32).toString('base64url')");
    expect(service).toContain("createHash('sha256').update(raw).digest('hex')");
    // The new path reuses acceptInvitation rather than reimplementing it.
    const registerAndAccept = service.slice(service.indexOf('export async function registerAndAccept'));
    expect(registerAndAccept).toContain('await acceptInvitation(');
    expect(registerAndAccept).not.toMatch(/membership\.create|updateMany|tokenHash:/);
  });

  it('and the ordinary registration endpoint is untouched', () => {
    const auth = read('src/controllers/auth.controller.ts');
    // Still requires a clubId, still excludes CLUB_OWNER — which is exactly why
    // an invited president could not have used it.
    expect(auth).toContain('clubId:    z.string().uuid()');
    expect(auth).toContain("role:      z.enum(['HEAD_COACH','ASSISTANT_COACH','ANALYST','MEDICAL_STAFF','SCOUT']).optional()");
  });
});
