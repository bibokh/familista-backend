/**
 * Medical smoke tests — exercise auth guard, input validation, and authorization
 * for /api/v1/phase-q/workload/injuries* and /workload/players/:id/medical.
 *
 * ── No-DB tests (always run) ──────────────────────────────────────────────────
 *   Auth guard: every injury route rejects unauthenticated or bad tokens before
 *   any Prisma call → safe without a live DB.
 *
 * ── DB-required tests (gated on TEST_DATABASE_URL) ────────────────────────────
 *   Full CRUD validation and authorization tests (skip in pure CI).
 *
 * Prerequisites for DB-gated tests:
 *   TEST_DATABASE_URL           = valid Postgres connection string
 *   TEST_USER_EMAIL             = HEAD_COACH user
 *   TEST_USER_PASSWORD          = password for that user
 *   TEST_CLUB_ADMIN_EMAIL       = CLUB_ADMIN user
 *   TEST_CLUB_ADMIN_PASSWORD    = password
 *   TEST_PLAYER_ID              = UUID of a player owned by the test club
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { Application } from 'express';

const DB_AVAILABLE  = !!process.env.TEST_DATABASE_URL;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;

const CLUB_ID   = '00000000-0000-0000-0000-000000000001';
const USER_ID   = '00000000-0000-0000-0000-000000000002';
const INJURY_ID = '00000000-0000-0000-0000-000000000099';
const PLAYER_ID = '00000000-0000-0000-0000-000000000077';

let app: Application;
beforeAll(() => { app = createApp(); });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeToken(role: string, overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    { sub: USER_ID, email: 'test@test.com', role, clubId: CLUB_ID, ...overrides },
    ACCESS_SECRET,
    { expiresIn: '15m' },
  );
}

async function loginAs(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  const raw = res.headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw as string] : [];
  const match = cookies.join(';').match(/access_token=([^;]+)/);
  if (!match) throw new Error('Login failed — no access_token cookie');
  return match[1];
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD — No DB required
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/phase-q/workload/injuries — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get('/api/v1/phase-q/workload/injuries');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('Authorization header without Bearer → 401', async () => {
    const res = await request(app)
      .get('/api/v1/phase-q/workload/injuries')
      .set('Authorization', 'Token something');
    expect(res.status).toBe(401);
  });

  it('malformed JWT → 401', async () => {
    const res = await request(app)
      .get('/api/v1/phase-q/workload/injuries')
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
      .get('/api/v1/phase-q/workload/injuries')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/v1/phase-q/workload/injuries — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .send({ playerId: PLAYER_ID, injuryDate: '2024-01-01', bodyLocation: 'Knee' });
    expect(res.status).toBe(401);
  });

  it('wrong-secret JWT → 401', async () => {
    const bad = jwt.sign({ sub: USER_ID, role: 'HEAD_COACH', clubId: CLUB_ID }, 'wrong', { expiresIn: '15m' });
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Authorization', `Bearer ${bad}`)
      .send({ playerId: PLAYER_ID, injuryDate: '2024-01-01', bodyLocation: 'Knee' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/v1/phase-q/workload/injuries/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app)
      .patch(`/api/v1/phase-q/workload/injuries/${INJURY_ID}`)
      .send({ bodyLocation: 'Ankle' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v1/phase-q/workload/injuries/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).delete(`/api/v1/phase-q/workload/injuries/${INJURY_ID}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/phase-q/workload/injuries/:id — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(`/api/v1/phase-q/workload/injuries/${INJURY_ID}`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/phase-q/workload/players/:id/medical — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(`/api/v1/phase-q/workload/players/${PLAYER_ID}/medical`);
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/v1/phase-q/workload/injuries/:id/return — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app)
      .patch(`/api/v1/phase-q/workload/injuries/${INJURY_ID}/return`)
      .send({ returnDate: '2024-06-01' });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB-GATED: Zod input validation
// ─────────────────────────────────────────────────────────────────────────────

const dbSuite = DB_AVAILABLE ? describe : describe.skip;

dbSuite('POST /api/v1/phase-q/workload/injuries — validation (DB)', () => {
  let coachCookie: string;

  beforeAll(async () => {
    coachCookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
  });

  it('missing playerId → 400', async () => {
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ injuryDate: '2024-01-01', bodyLocation: 'Knee' });
    expect(res.status).toBe(400);
  });

  it('non-UUID playerId → 400', async () => {
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ playerId: 'not-a-uuid', injuryDate: '2024-01-01', bodyLocation: 'Knee' });
    expect(res.status).toBe(400);
  });

  it('missing injuryDate → 400', async () => {
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ playerId: PLAYER_ID, bodyLocation: 'Knee' });
    expect(res.status).toBe(400);
  });

  it('missing bodyLocation → 400', async () => {
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ playerId: PLAYER_ID, injuryDate: '2024-01-01' });
    expect(res.status).toBe(400);
  });

  it('invalid severity enum → 400', async () => {
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ playerId: PLAYER_ID, injuryDate: '2024-01-01', bodyLocation: 'Knee', severity: 'EXTREME' });
    expect(res.status).toBe(400);
  });

  it('invalid mechanism enum → 400', async () => {
    const res = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ playerId: PLAYER_ID, injuryDate: '2024-01-01', bodyLocation: 'Knee', mechanism: 'ALIEN_ATTACK' });
    expect(res.status).toBe(400);
  });
});

dbSuite('PATCH /api/v1/phase-q/workload/injuries/:id — validation (DB)', () => {
  let adminCookie: string;
  let injuryId:    string;

  beforeAll(async () => {
    adminCookie = await loginAs(process.env.TEST_CLUB_ADMIN_EMAIL!, process.env.TEST_CLUB_ADMIN_PASSWORD!);
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const createRes = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${adminCookie}`)
      .send({ playerId, injuryDate: '2024-05-01', bodyLocation: 'Left Hamstring', severity: 'MODERATE' });
    injuryId = createRes.body?.id;
  });

  it('empty body → 400', async () => {
    if (!injuryId) return;
    const res = await request(app)
      .patch(`/api/v1/phase-q/workload/injuries/${injuryId}`)
      .set('Cookie', `access_token=${adminCookie}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('valid partial update → 200', async () => {
    if (!injuryId) return;
    const res = await request(app)
      .patch(`/api/v1/phase-q/workload/injuries/${injuryId}`)
      .set('Cookie', `access_token=${adminCookie}`)
      .send({ severity: 'MAJOR', notes: 'Progressing well' });
    expect(res.status).toBe(200);
    expect(res.body.severity).toBe('MAJOR');
  });
});

dbSuite('PATCH /api/v1/phase-q/workload/injuries/:id/return — bug fix (DB)', () => {
  let adminCookie: string;
  let injuryId:    string;

  beforeAll(async () => {
    adminCookie = await loginAs(process.env.TEST_CLUB_ADMIN_EMAIL!, process.env.TEST_CLUB_ADMIN_PASSWORD!);
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const createRes = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${adminCookie}`)
      .send({ playerId, injuryDate: '2024-04-01', bodyLocation: 'Right Ankle' });
    injuryId = createRes.body?.id;
  });

  it('missing returnDate → 400', async () => {
    if (!injuryId) return;
    const res = await request(app)
      .patch(`/api/v1/phase-q/workload/injuries/${injuryId}/return`)
      .set('Cookie', `access_token=${adminCookie}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('valid returnDate → 200 with daysAbsent set', async () => {
    if (!injuryId) return;
    const res = await request(app)
      .patch(`/api/v1/phase-q/workload/injuries/${injuryId}/return`)
      .set('Cookie', `access_token=${adminCookie}`)
      .send({ returnDate: '2024-04-15' });
    expect(res.status).toBe(200);
    expect(res.body.returnDate).toBeTruthy();
    expect(typeof res.body.daysAbsent).toBe('number');
  });
});

dbSuite('DELETE /api/v1/phase-q/workload/injuries/:id — delete (DB)', () => {
  let adminCookie: string;
  let injuryId:    string;

  beforeAll(async () => {
    adminCookie = await loginAs(process.env.TEST_CLUB_ADMIN_EMAIL!, process.env.TEST_CLUB_ADMIN_PASSWORD!);
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const createRes = await request(app)
      .post('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${adminCookie}`)
      .send({ playerId, injuryDate: '2024-03-01', bodyLocation: 'Back' });
    injuryId = createRes.body?.id;
  });

  it('valid delete → 204', async () => {
    if (!injuryId) return;
    const res = await request(app)
      .delete(`/api/v1/phase-q/workload/injuries/${injuryId}`)
      .set('Cookie', `access_token=${adminCookie}`);
    expect(res.status).toBe(204);
  });

  it('delete already-deleted → 404', async () => {
    if (!injuryId) return;
    const res = await request(app)
      .delete(`/api/v1/phase-q/workload/injuries/${injuryId}`)
      .set('Cookie', `access_token=${adminCookie}`);
    expect(res.status).toBe(404);
  });
});

dbSuite('GET /api/v1/phase-q/workload/injuries — list includes player data (DB)', () => {
  it('returns array with player objects', async () => {
    const coachCookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/phase-q/workload/injuries')
      .set('Cookie', `access_token=${coachCookie}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Each record should include player data (the bug fix verification)
    if (res.body.length > 0) {
      expect(res.body[0]).toHaveProperty('player');
      expect(res.body[0].player).toHaveProperty('firstName');
    }
  });
});
