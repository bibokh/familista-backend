/**
 * Player smoke tests — exercise the auth guard, input validation, and
 * authorization layer for /api/v1/players without (and with) a live DB.
 *
 * ── No-DB tests (always run) ──────────────────────────────────────────────
 *   Auth guard: every player route rejects unauthenticated or malformed
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
 *   TEST_CLUB_ADMIN_EMAIL       = email of a CLUB_ADMIN user (for delete-hard + audit)
 *   TEST_CLUB_ADMIN_PASSWORD    = password for that user
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { Application } from 'express';

const DB_AVAILABLE   = !!process.env.TEST_DATABASE_URL;
const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET!;

// Canonical UUID constants used across every test.
const CLUB_ID        = '00000000-0000-0000-0000-000000000001';
const USER_ID        = '00000000-0000-0000-0000-000000000002';
const PLAYER_ID      = '00000000-0000-0000-0000-000000000099';

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

describe('GET /api/v1/players — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get('/api/v1/players');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('Authorization header without Bearer prefix → 401', async () => {
    const res = await request(app)
      .get('/api/v1/players')
      .set('Authorization', 'Token something');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('malformed JWT string → 401', async () => {
    const res = await request(app)
      .get('/api/v1/players')
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
      .get('/api/v1/players')
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
      .get('/api/v1/players')
      .set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('access_token cookie with malformed JWT → 401', async () => {
    const res = await request(app)
      .get('/api/v1/players')
      .set('Cookie', 'access_token=not.a.valid.jwt');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('access_token cookie with wrong-secret JWT → 401', async () => {
    const badCookieToken = jwt.sign(
      { sub: USER_ID, email: 'x@x.com', role: 'HEAD_COACH', clubId: CLUB_ID },
      'wrong-secret-for-cookie'
    );
    const res = await request(app)
      .get('/api/v1/players')
      .set('Cookie', `access_token=${badCookieToken}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /api/v1/players — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).post('/api/v1/players').send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('malformed JWT → 401', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set('Authorization', 'Bearer garbage')
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('PATCH /api/v1/players/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .send({ condition: 80 });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('DELETE /api/v1/players/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).delete(`/api/v1/players/${PLAYER_ID}`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('DELETE /api/v1/players/:id/hard — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).delete(`/api/v1/players/${PLAYER_ID}/hard`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/v1/players/:id/audit — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(`/api/v1/players/${PLAYER_ID}/audit`);
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INPUT VALIDATION — DB required (auth middleware calls prisma.user.findFirst
// after JWT verification; without a real user row the middleware returns 401/500)
// ─────────────────────────────────────────────────────────────────────────────

const dbSuite = DB_AVAILABLE ? describe : describe.skip;

dbSuite('POST /api/v1/players — input validation (DB required)', () => {
  let headCoachToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email:    process.env.TEST_USER_EMAIL    ?? '',
        password: process.env.TEST_USER_PASSWORD ?? '',
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // Use cookie-based auth: extract the access_token cookie value
    const cookies = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieArr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
    const ac = cookieArr.find(c => c.startsWith('access_token='));
    if (ac) {
      headCoachToken = ac.split(';')[0]; // "access_token=<value>"
    }
  });

  it('empty body → 400 with validation errors', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set('Cookie', headCoachToken)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/validation|required/i);
  });

  it('invalid position enum → 400', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set('Cookie', headCoachToken)
      .send({
        firstName: 'John', lastName: 'Doe', number: 9,
        position: 'STRIKER', // not a valid enum value
        nationality: 'German', flag: '🇩🇪',
        dateOfBirth: '1998-01-01', height: 180, weight: 75,
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('date of birth in the future → 400', async () => {
    const futureDate = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await request(app)
      .post('/api/v1/players')
      .set('Cookie', headCoachToken)
      .send({
        firstName: 'John', lastName: 'Doe', number: 9,
        position: 'ST', nationality: 'German', flag: '🇩🇪',
        dateOfBirth: futureDate, height: 180, weight: 75,
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('date of birth producing age < 5 years → 400', async () => {
    // 3 years ago
    const tooYoung = new Date(Date.now() - 3 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await request(app)
      .post('/api/v1/players')
      .set('Cookie', headCoachToken)
      .send({
        firstName: 'John', lastName: 'Doe', number: 9,
        position: 'ST', nationality: 'German', flag: '🇩🇪',
        dateOfBirth: tooYoung, height: 180, weight: 75,
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid email format → 400', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set('Cookie', headCoachToken)
      .send({
        firstName: 'John', lastName: 'Doe', number: 9,
        position: 'ST', nationality: 'German', flag: '🇩🇪',
        dateOfBirth: '1998-01-01', height: 180, weight: 75,
        email: 'not-an-email',
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('shirt number out of range (0) → 400', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set('Cookie', headCoachToken)
      .send({
        firstName: 'John', lastName: 'Doe', number: 0,
        position: 'ST', nationality: 'German', flag: '🇩🇪',
        dateOfBirth: '1998-01-01', height: 180, weight: 75,
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('overallRating out of range (> 140) → 400', async () => {
    const res = await request(app)
      .post('/api/v1/players')
      .set('Cookie', headCoachToken)
      .send({
        firstName: 'John', lastName: 'Doe', number: 9,
        position: 'ST', nationality: 'German', flag: '🇩🇪',
        dateOfBirth: '1998-01-01', height: 180, weight: 75,
        overallRating: 999,
      });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

dbSuite('PATCH /api/v1/players/:id — input validation (DB required)', () => {
  let headCoachToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email:    process.env.TEST_USER_EMAIL    ?? '',
        password: process.env.TEST_USER_PASSWORD ?? '',
      });
    if (res.status === 200) {
      const cookies = res.headers['set-cookie'] as string[] | string | undefined;
      const cookieArr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
      const ac = cookieArr.find(c => c.startsWith('access_token='));
      if (ac) headCoachToken = ac.split(';')[0];
    }
  });

  it('empty body (no fields to update) → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set('Cookie', headCoachToken)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('condition out of range (> 100) → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set('Cookie', headCoachToken)
      .send({ condition: 150 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid medicalStatus enum → 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/players/${PLAYER_ID}`)
      .set('Cookie', headCoachToken)
      .send({ medicalStatus: 'DEAD' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

dbSuite('GET /api/v1/players — query validation (DB required)', () => {
  let headCoachToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({
        email:    process.env.TEST_USER_EMAIL    ?? '',
        password: process.env.TEST_USER_PASSWORD ?? '',
      });
    if (res.status === 200) {
      const cookies = res.headers['set-cookie'] as string[] | string | undefined;
      const cookieArr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
      const ac = cookieArr.find(c => c.startsWith('access_token='));
      if (ac) headCoachToken = ac.split(';')[0];
    }
  });

  it('invalid position filter → 400', async () => {
    const res = await request(app)
      .get('/api/v1/players?position=STRIKER')
      .set('Cookie', headCoachToken);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid sortBy key → 400', async () => {
    const res = await request(app)
      .get('/api/v1/players?sortBy=badKey')
      .set('Cookie', headCoachToken);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid isActive value → 400', async () => {
    const res = await request(app)
      .get('/api/v1/players?isActive=yes')
      .set('Cookie', headCoachToken);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHORIZATION — DB required
// ─────────────────────────────────────────────────────────────────────────────

dbSuite('Player routes — role authorization (DB required)', () => {
  // HEAD_COACH session (allowed to list/create/update/delete, but NOT hard-delete)
  let headCoachCookie: string;
  // CLUB_ADMIN session (allowed everything including hard-delete + audit)
  let clubAdminCookie: string;

  beforeAll(async () => {
    const [hcRes, caRes] = await Promise.all([
      request(app).post('/api/v1/auth/login').send({
        email:    process.env.TEST_USER_EMAIL          ?? '',
        password: process.env.TEST_USER_PASSWORD       ?? '',
      }),
      request(app).post('/api/v1/auth/login').send({
        email:    process.env.TEST_CLUB_ADMIN_EMAIL    ?? '',
        password: process.env.TEST_CLUB_ADMIN_PASSWORD ?? '',
      }),
    ]);

    const extractCookie = (res: request.Response) => {
      const cookies = res.headers['set-cookie'] as string[] | string | undefined;
      const arr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
      const ac = arr.find(c => c.startsWith('access_token='));
      return ac ? ac.split(';')[0] : '';
    };

    if (hcRes.status === 200) headCoachCookie  = extractCookie(hcRes);
    if (caRes.status === 200) clubAdminCookie = extractCookie(caRes);
  });

  it('HEAD_COACH cannot hard-delete a player → 403', async () => {
    const res = await request(app)
      .delete(`/api/v1/players/${PLAYER_ID}/hard`)
      .set('Cookie', headCoachCookie);
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('CLUB_ADMIN can access audit endpoint → not 403', async () => {
    // Expect 200 or 404 (player doesn't exist) but never 403
    const res = await request(app)
      .get(`/api/v1/players/${PLAYER_ID}/audit`)
      .set('Cookie', clubAdminCookie);
    expect([200, 404]).toContain(res.status);
  });

  it('HEAD_COACH can access audit endpoint → not 403', async () => {
    const res = await request(app)
      .get(`/api/v1/players/${PLAYER_ID}/audit`)
      .set('Cookie', headCoachCookie);
    expect([200, 404]).toContain(res.status);
  });
});
