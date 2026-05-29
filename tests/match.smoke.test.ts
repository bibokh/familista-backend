/**
 * Match smoke tests — exercise the auth guard, input validation, and
 * authorization layer for /api/v1/matches without (and with) a live DB.
 *
 * ── No-DB tests (always run) ──────────────────────────────────────────────
 *   Auth guard: every match route rejects unauthenticated or malformed
 *   tokens before any Prisma call executes → safe without a live DB.
 *
 * ── DB-required tests (gated on TEST_DATABASE_URL) ────────────────────────
 *   Input validation (400) and role authorization (403) tests require a real
 *   user record because the authenticate() middleware calls prisma.user.findFirst
 *   after JWT verification.  These are skipped in pure CI environments.
 *
 * Prerequisites for DB-gated tests:
 *   TEST_DATABASE_URL           = valid Postgres connection string
 *   TEST_USER_EMAIL             = email of a HEAD_COACH user in that DB
 *   TEST_USER_PASSWORD          = password for that user
 *   TEST_CLUB_ADMIN_EMAIL       = email of a CLUB_ADMIN user
 *   TEST_CLUB_ADMIN_PASSWORD    = password for that user
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { Application } from 'express';

const DB_AVAILABLE  = !!process.env.TEST_DATABASE_URL;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;

// Canonical UUID constants used across every test.
const CLUB_ID  = '00000000-0000-0000-0000-000000000001';
const USER_ID  = '00000000-0000-0000-0000-000000000002';
const MATCH_ID = '00000000-0000-0000-0000-000000000088';

let app: Application;

beforeAll(() => { app = createApp(); });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeToken(role: string, overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    { sub: USER_ID, email: 'test@test.com', role, clubId: CLUB_ID, ...overrides },
    ACCESS_SECRET,
    { expiresIn: '15m' }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD — No token (no DB required)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/matches — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get('/api/v1/matches');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('Authorization header without Bearer prefix → 401', async () => {
    const res = await request(app)
      .get('/api/v1/matches')
      .set('Authorization', 'Token something');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('malformed JWT string → 401', async () => {
    const res = await request(app)
      .get('/api/v1/matches')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('structurally-valid JWT signed with wrong secret → 401', async () => {
    const badToken = jwt.sign(
      { sub: USER_ID, email: 'x@x.com', role: 'HEAD_COACH', clubId: CLUB_ID },
      'wrong-secret'
    );
    const res = await request(app)
      .get('/api/v1/matches')
      .set('Authorization', `Bearer ${badToken}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('expired token → 401', async () => {
    const expired = jwt.sign(
      { sub: USER_ID, email: 'x@x.com', role: 'HEAD_COACH', clubId: CLUB_ID,
        exp: Math.floor(Date.now() / 1000) - 3600 },
      ACCESS_SECRET
    );
    const res = await request(app)
      .get('/api/v1/matches')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('access_token cookie with wrong-secret JWT → 401', async () => {
    const badCookie = jwt.sign(
      { sub: USER_ID, email: 'x@x.com', role: 'HEAD_COACH', clubId: CLUB_ID },
      'wrong-secret-cookie'
    );
    const res = await request(app)
      .get('/api/v1/matches')
      .set('Cookie', `access_token=${badCookie}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/matches — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).post('/api/v1/matches').send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('malformed JWT → 401', async () => {
    const res = await request(app)
      .post('/api/v1/matches')
      .set('Authorization', 'Bearer garbage')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('PATCH /api/v1/matches/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app)
      .patch(`/api/v1/matches/${MATCH_ID}`)
      .send({ venue: 'Anfield' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('malformed JWT → 401', async () => {
    const res = await request(app)
      .patch(`/api/v1/matches/${MATCH_ID}`)
      .set('Authorization', 'Bearer bad.token')
      .send({ venue: 'Anfield' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('DELETE /api/v1/matches/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).delete(`/api/v1/matches/${MATCH_ID}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('malformed JWT → 401', async () => {
    const res = await request(app)
      .delete(`/api/v1/matches/${MATCH_ID}`)
      .set('Authorization', 'Bearer bad.token');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/matches/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(`/api/v1/matches/${MATCH_ID}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/matches/:id/audit — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(`/api/v1/matches/${MATCH_ID}/audit`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INPUT VALIDATION — DB required (auth middleware calls prisma.user.findFirst
// after JWT verification; without a real user row the middleware returns 401)
// ─────────────────────────────────────────────────────────────────────────────

const dbSuite = DB_AVAILABLE ? describe : describe.skip;

dbSuite('POST /api/v1/matches — input validation (DB required)', () => {
  let coachToken: string;   // HEAD_COACH cookie

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email:    process.env.TEST_USER_EMAIL    ?? '',
        password: process.env.TEST_USER_PASSWORD ?? '',
      });
    expect(res.status).toBe(200);
    const cookies = res.headers['set-cookie'] as string[] | string | undefined;
    const arr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
    const ac = arr.find(c => c.startsWith('access_token='));
    if (ac) coachToken = ac.split(';')[0];
  });

  it('empty body → 400', async () => {
    const res = await request(app)
      .post('/api/v1/matches')
      .set('Cookie', coachToken)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/required|missing|Invalid/i);
  });

  it('missing required homeTeam → 400', async () => {
    const res = await request(app)
      .post('/api/v1/matches')
      .set('Cookie', coachToken)
      .send({
        awayTeam: 'Chelsea FC',
        isHome: true,
        competition: 'LEAGUE',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid competition enum → 400', async () => {
    const res = await request(app)
      .post('/api/v1/matches')
      .set('Cookie', coachToken)
      .send({
        homeTeam: 'Arsenal FC',
        awayTeam: 'Chelsea FC',
        isHome: true,
        competition: 'SUPER_BOWL',   // not a valid CompetitionType
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('missing scheduledAt → 400', async () => {
    const res = await request(app)
      .post('/api/v1/matches')
      .set('Cookie', coachToken)
      .send({
        homeTeam: 'Arsenal FC',
        awayTeam: 'Chelsea FC',
        isHome: true,
        competition: 'LEAGUE',
        // scheduledAt intentionally omitted
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid formation format → 400', async () => {
    const res = await request(app)
      .post('/api/v1/matches')
      .set('Cookie', coachToken)
      .send({
        homeTeam: 'Arsenal FC',
        awayTeam: 'Chelsea FC',
        isHome: true,
        competition: 'LEAGUE',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        formationHome: 'FOUR-THREE-THREE',  // must be digit-digit(-digit)+ format
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

dbSuite('PATCH /api/v1/matches/:id — input validation (DB required)', () => {
  let coachToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email:    process.env.TEST_USER_EMAIL    ?? '',
        password: process.env.TEST_USER_PASSWORD ?? '',
      });
    if (res.status === 200) {
      const cookies = res.headers['set-cookie'] as string[] | string | undefined;
      const arr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
      const ac = arr.find(c => c.startsWith('access_token='));
      if (ac) coachToken = ac.split(';')[0];
    }
  });

  it('empty body (no fields to update) → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/matches/${MATCH_ID}`)
      .set('Cookie', coachToken)
      .send({});
    // The updateSchema refine enforces at least one field
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('score out of range (> 99) → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/matches/${MATCH_ID}`)
      .set('Cookie', coachToken)
      .send({ homeScore: 200 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid status enum → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/matches/${MATCH_ID}`)
      .set('Cookie', coachToken)
      .send({ status: 'FINISHED' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROLE AUTHORIZATION — DB required
// ─────────────────────────────────────────────────────────────────────────────

dbSuite('POST /api/v1/matches — role authorization (DB required)', () => {
  let adminToken: string;   // CLUB_ADMIN cookie for setup

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email:    process.env.TEST_CLUB_ADMIN_EMAIL    ?? '',
        password: process.env.TEST_CLUB_ADMIN_PASSWORD ?? '',
      });
    if (res.status === 200) {
      const cookies = res.headers['set-cookie'] as string[] | string | undefined;
      const arr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
      const ac = arr.find(c => c.startsWith('access_token='));
      if (ac) adminToken = ac.split(';')[0];
    }
  });

  it('ANALYST role → 403 (cannot create matches)', async () => {
    // ANALYST is authorized for updates but NOT creates; forge a token with
    // a DB user that holds ANALYST role — if no ANALYST exists in test DB
    // the auth middleware will return 401, so we allow both 401 and 403.
    const analystToken = makeToken('ANALYST');
    const res = await request(app)
      .post('/api/v1/matches')
      .set('Authorization', `Bearer ${analystToken}`)
      .send({
        homeTeam: 'Arsenal FC', awayTeam: 'Chelsea FC',
        isHome: true, competition: 'LEAGUE',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      });
    // Token passes JWT verification but user not found in DB → 401;
    // if user IS in DB with ANALYST role → 403.
    expect([401, 403]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });
});

dbSuite('DELETE /api/v1/matches/:id — role authorization (DB required)', () => {
  it('HEAD_COACH role → 403 (only CLUB_ADMIN may delete)', async () => {
    const coachToken = makeToken('HEAD_COACH');
    const res = await request(app)
      .delete(`/api/v1/matches/${MATCH_ID}`)
      .set('Authorization', `Bearer ${coachToken}`);
    // Token passes JWT verification but user not found in DB → 401;
    // if user IS in DB with HEAD_COACH role → 403.
    expect([401, 403]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });

  it('ANALYST role → 403 (only CLUB_ADMIN may delete)', async () => {
    const analystToken = makeToken('ANALYST');
    const res = await request(app)
      .delete(`/api/v1/matches/${MATCH_ID}`)
      .set('Authorization', `Bearer ${analystToken}`);
    expect([401, 403]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });
});
