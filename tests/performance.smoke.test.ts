/**
 * Performance smoke tests — exercise auth guard, input validation, and authorization
 * for /api/v1/players/:id/attributes and /api/v1/players/performance/squad.
 *
 * ── No-DB tests (always run) ──────────────────────────────────────────────────
 *   Auth guard: every performance route rejects unauthenticated or bad tokens
 *   before any Prisma call → safe without a live DB.
 *
 * ── DB-required tests (gated on TEST_DATABASE_URL) ────────────────────────────
 *   Full CRUD validation and authorization tests (skip in pure CI).
 *
 * Prerequisites for DB-gated tests:
 *   TEST_DATABASE_URL           = valid Postgres connection string
 *   TEST_USER_EMAIL             = HEAD_COACH user
 *   TEST_USER_PASSWORD          = password for that user
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

describe('GET /api/v1/players/performance/squad — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get('/api/v1/players/performance/squad');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('Authorization header without Bearer → 401', async () => {
    const res = await request(app)
      .get('/api/v1/players/performance/squad')
      .set('Authorization', 'Token something');
    expect(res.status).toBe(401);
  });

  it('malformed JWT → 401', async () => {
    const res = await request(app)
      .get('/api/v1/players/performance/squad')
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
      .get('/api/v1/players/performance/squad')
      .set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('valid token → not 401 (may be 200 or 403 depending on state)', async () => {
    const token = makeToken('HEAD_COACH');
    const res = await request(app)
      .get('/api/v1/players/performance/squad')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(401);
  });
});

describe('POST /api/v1/players/:id/attributes — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app)
      .post(`/api/v1/players/${PLAYER_ID}/attributes`)
      .send({ speed: 75, stamina: 80 });
    expect(res.status).toBe(401);
  });

  it('wrong-secret JWT → 401', async () => {
    const bad = jwt.sign(
      { sub: USER_ID, role: 'HEAD_COACH', clubId: CLUB_ID },
      'wrong',
      { expiresIn: '15m' },
    );
    const res = await request(app)
      .post(`/api/v1/players/${PLAYER_ID}/attributes`)
      .set('Authorization', `Bearer ${bad}`)
      .send({ speed: 75 });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/players/:id/attributes — auth guard (no DB)', () => {
  it('no token → 401', async () => {
    const res = await request(app).get(`/api/v1/players/${PLAYER_ID}/attributes`);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB-GATED: Zod input validation + authorization
// ─────────────────────────────────────────────────────────────────────────────

const dbSuite = DB_AVAILABLE ? describe : describe.skip;

dbSuite('POST /api/v1/players/:id/attributes — validation (DB)', () => {
  let coachCookie: string;

  beforeAll(async () => {
    coachCookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
  });

  it('empty body → 400', async () => {
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const res = await request(app)
      .post(`/api/v1/players/${playerId}/attributes`)
      .set('Cookie', `access_token=${coachCookie}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('attribute value out of range (0) → 400', async () => {
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const res = await request(app)
      .post(`/api/v1/players/${playerId}/attributes`)
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ speed: 0 });
    expect(res.status).toBe(400);
  });

  it('attribute value out of range (200) → 400', async () => {
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const res = await request(app)
      .post(`/api/v1/players/${playerId}/attributes`)
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ speed: 200 });
    expect(res.status).toBe(400);
  });

  it('attribute value non-integer → 400', async () => {
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const res = await request(app)
      .post(`/api/v1/players/${playerId}/attributes`)
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ speed: 'fast' });
    expect(res.status).toBe(400);
  });

  it('valid single attribute → 201', async () => {
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const res = await request(app)
      .post(`/api/v1/players/${playerId}/attributes`)
      .set('Cookie', `access_token=${coachCookie}`)
      .send({ speed: 75, stamina: 80, shooting: 65 });
    expect(res.status).toBe(201);
    expect(res.body.speed).toBe(75);
    expect(res.body.stamina).toBe(80);
    expect(res.body.shooting).toBe(65);
    expect(res.body.playerId).toBe(playerId);
  });

  it('valid full attribute set → 201', async () => {
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const res = await request(app)
      .post(`/api/v1/players/${playerId}/attributes`)
      .set('Cookie', `access_token=${coachCookie}`)
      .send({
        speed: 78, agility: 72, stamina: 85, strength: 70,
        balance: 68, reaction: 74, technique: 77, passing: 80,
        shooting: 69, defending: 60,
      });
    expect(res.status).toBe(201);
    expect(res.body.playerId).toBe(playerId);
    expect(res.body.recordedAt).toBeTruthy();
  });
});

dbSuite('GET /api/v1/players/:id/attributes — history (DB)', () => {
  let coachCookie: string;

  beforeAll(async () => {
    coachCookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
  });

  it('valid player → 200 array', async () => {
    const playerId = process.env.TEST_PLAYER_ID;
    if (!playerId) return;
    const res = await request(app)
      .get(`/api/v1/players/${playerId}/attributes`)
      .set('Cookie', `access_token=${coachCookie}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('non-existent player → 404', async () => {
    const res = await request(app)
      .get('/api/v1/players/00000000-0000-0000-0000-000000000999/attributes')
      .set('Cookie', `access_token=${coachCookie}`);
    expect(res.status).toBe(404);
  });
});

dbSuite('GET /api/v1/players/performance/squad — squad list (DB)', () => {
  it('returns array with player + attribute data', async () => {
    const coachCookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/players/performance/squad')
      .set('Cookie', `access_token=${coachCookie}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    if (res.body.length > 0) {
      expect(res.body[0]).toHaveProperty('id');
      expect(res.body[0]).toHaveProperty('overallRating');
      // attributes may be null if none recorded yet
      expect(Object.prototype.hasOwnProperty.call(res.body[0], 'attributes')).toBe(true);
    }
  });
});
