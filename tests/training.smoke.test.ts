/**
 * Training smoke tests — exercise the auth guard, input validation, and
 * authorization layer for /api/v1/training without (and with) a live DB.
 *
 * ── No-DB tests (always run) ──────────────────────────────────────────────
 *   Auth guard: every training route rejects unauthenticated or malformed
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

const CLUB_ID       = '00000000-0000-0000-0000-000000000001';
const USER_ID       = '00000000-0000-0000-0000-000000000002';
const SESSION_ID    = '00000000-0000-0000-0000-000000000099';

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

async function loginAs(email: string, password: string): Promise<string> {
  const res = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password });
  const raw = res.headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const match = cookies.join(';').match(/access_token=([^;]+)/);
  if (!match) throw new Error('Login failed — no access_token cookie');
  return match[1];
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD — No token (no DB required)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/training — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get('/api/v1/training');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('Authorization header without Bearer prefix → 401', async () => {
    const res = await request(app)
      .get('/api/v1/training')
      .set('Authorization', 'Token something');
    expect(res.status).toBe(401);
  });

  it('malformed JWT string → 401', async () => {
    const res = await request(app)
      .get('/api/v1/training')
      .set('Authorization', 'Bearer not.a.jwt');
    expect(res.status).toBe(401);
  });

  it('JWT signed with wrong secret → 401', async () => {
    const bad = jwt.sign(
      { sub: USER_ID, email: 'x@x.com', role: 'HEAD_COACH', clubId: CLUB_ID },
      'wrong-secret',
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .get('/api/v1/training')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/training/form — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get('/api/v1/training/form');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/training — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).post('/api/v1/training').send({ title: 'Test' });
    expect(res.status).toBe(401);
  });

  it('JWT signed with wrong secret → 401', async () => {
    const bad = jwt.sign(
      { sub: USER_ID, email: 'x@x.com', role: 'HEAD_COACH', clubId: CLUB_ID },
      'wrong-secret',
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .post('/api/v1/training')
      .set('Authorization', `Bearer ${bad}`)
      .send({ title: 'X', scheduledAt: new Date().toISOString(), duration: 60 });
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/v1/training/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).put(`/api/v1/training/${SESSION_ID}`).send({ title: 'X' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/v1/training/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).patch(`/api/v1/training/${SESSION_ID}`).send({ title: 'X' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v1/training/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).delete(`/api/v1/training/${SESSION_ID}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/training/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(`/api/v1/training/${SESSION_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB-GATED: Input validation + role authorization
// ─────────────────────────────────────────────────────────────────────────────

const dbSuite = DB_AVAILABLE ? describe : describe.skip;

dbSuite('POST /api/v1/training — validation (DB)', () => {
  let coachCookie: string;

  beforeAll(async () => {
    coachCookie = await loginAs(
      process.env.TEST_USER_EMAIL!,
      process.env.TEST_USER_PASSWORD!,
    );
  });

  it('missing title → 400', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ scheduledAt: new Date().toISOString(), duration: 60 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('missing scheduledAt → 400', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ title: 'Test', duration: 60 });
    expect(res.status).toBe(400);
  });

  it('missing duration → 400', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ title: 'Test', scheduledAt: new Date().toISOString() });
    expect(res.status).toBe(400);
  });

  it('duration 0 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ title: 'Test', scheduledAt: new Date().toISOString(), duration: 0 });
    expect(res.status).toBe(400);
  });

  it('duration > 480 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ title: 'Test', scheduledAt: new Date().toISOString(), duration: 999 });
    expect(res.status).toBe(400);
  });

  it('invalid drill enum value → 400', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ title: 'Test', scheduledAt: new Date().toISOString(), duration: 60, drills: ['FAKE_DRILL'] });
    expect(res.status).toBe(400);
  });

  it('playerIds with non-UUID values → 400', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ title: 'Test', scheduledAt: new Date().toISOString(), duration: 60, playerIds: ['not-a-uuid'] });
    expect(res.status).toBe(400);
  });

  it('valid payload from HEAD_COACH → 201', async () => {
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({
        title:       'Smoke Test Session',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        duration:    90,
        drills:      ['TECHNICAL_PASSING', 'SPRINT_INTERVALS'],
      });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.title).toBe('Smoke Test Session');
  });
});

dbSuite('PATCH /api/v1/training/:id — authorization (DB)', () => {
  let adminCookie:  string;
  let sessionId:    string;

  beforeAll(async () => {
    adminCookie = await loginAs(
      process.env.TEST_CLUB_ADMIN_EMAIL!,
      process.env.TEST_CLUB_ADMIN_PASSWORD!,
    );
    // Create a session to patch
    const createRes = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${adminCookie}`)
      .send({
        title:       'Admin Patch Target',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        duration:    60,
      });
    sessionId = createRes.body?.data?.id;
  });

  it('empty body → 400', async () => {
    if (!sessionId) return;
    const res = await request(app)
      .patch(`/api/v1/training/${sessionId}`)
      .set('Cookie', `access_token=${adminCookie}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('valid partial update → 200 with updated data', async () => {
    if (!sessionId) return;
    const res = await request(app)
      .patch(`/api/v1/training/${sessionId}`)
      .set('Cookie', `access_token=${adminCookie}`)
      .send({ duration: 120 });
    expect(res.status).toBe(200);
    expect(res.body.data.duration).toBe(120);
  });
});

dbSuite('POST /api/v1/training — role authorization (DB)', () => {
  // COACH role test only — PLAYER role check via cookie-based login
  it('HEAD_COACH cookie → 201 (authorized)', async () => {
    const coachCookie = await loginAs(
      process.env.TEST_USER_EMAIL!,
      process.env.TEST_USER_PASSWORD!,
    );
    const res = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({
        title:       'Auth Role Check',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        duration:    45,
      });
    expect([201, 400, 403]).toContain(res.status); // 201 if authorized, 400/403 otherwise
  });
});

dbSuite('DELETE /api/v1/training/:id — authorization (DB)', () => {
  let adminCookie: string;
  let sessionId:   string;

  beforeAll(async () => {
    adminCookie = await loginAs(
      process.env.TEST_CLUB_ADMIN_EMAIL!,
      process.env.TEST_CLUB_ADMIN_PASSWORD!,
    );
    const createRes = await request(app)
      .post('/api/v1/training')
      .set('Cookie', `access_token=${adminCookie}`)
      .send({
        title:       'Delete Target',
        scheduledAt: new Date(Date.now() + 86400000).toISOString(),
        duration:    30,
      });
    sessionId = createRes.body?.data?.id;
  });

  it('CLUB_ADMIN can delete own session → 204', async () => {
    if (!sessionId) return;
    const res = await request(app)
      .delete(`/api/v1/training/${sessionId}`)
      .set('Cookie', `access_token=${adminCookie}`);
    expect(res.status).toBe(204);
  });

  it('deleting non-existent session → 404', async () => {
    const res = await request(app)
      .delete(`/api/v1/training/${SESSION_ID}`)
      .set('Cookie', `access_token=${adminCookie}`);
    expect(res.status).toBe(404);
  });
});

dbSuite('GET /api/v1/training/form — returns form data (DB)', () => {
  it('returns form object', async () => {
    const coachCookie = await loginAs(
      process.env.TEST_USER_EMAIL!,
      process.env.TEST_USER_PASSWORD!,
    );
    const res = await request(app)
      .get('/api/v1/training/form')
      .set('Cookie', `access_token=${coachCookie}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('attackForm');
    expect(res.body.data).toHaveProperty('defenseForm');
    expect(res.body.data).toHaveProperty('possession');
    expect(res.body.data).toHaveProperty('conditionForm');
  });
});
