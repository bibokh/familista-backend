/**
 * Scouting & Recruitment Center smoke tests
 *
 * ── No-DB tests (always run) ──────────────────────────────────────────────────
 *   Auth guard: every scouting route rejects unauthenticated / bad-token
 *   requests before any Prisma call → safe without a live DB.
 *
 * ── DB-required tests (gated on TEST_DATABASE_URL) ────────────────────────────
 *   Happy-path shape tests and CRUD validation tests (skip in pure CI).
 *
 * Prerequisites for DB-gated tests:
 *   TEST_DATABASE_URL     = valid Postgres connection string
 *   TEST_USER_EMAIL       = HEAD_COACH user
 *   TEST_USER_PASSWORD    = password for that user
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import type { Application } from 'express';

const DB_AVAILABLE  = !!process.env.TEST_DATABASE_URL;
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET!;

const CLUB_ID = '00000000-0000-0000-0000-000000000001';
const USER_ID = '00000000-0000-0000-0000-000000000002';

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

const SCOUTING_READ_ROUTES = [
  ['GET', '/api/v1/scouting'],
  ['GET', '/api/v1/scouting/dashboard'],
  ['GET', '/api/v1/scouting/pipeline'],
  ['GET', '/api/v1/scouting/watchlist'],
  ['GET', '/api/v1/scouting/compare?prospectA=00000000-0000-0000-0000-000000000001&prospectB=00000000-0000-0000-0000-000000000002'],
] as const;

describe('Scouting routes — auth guard (no DB)', () => {
  for (const [method, path] of SCOUTING_READ_ROUTES) {
    it(`${method} ${path} — no token → 401`, async () => {
      const res = await request(app)[method.toLowerCase() as 'get'](path);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it(`${method} ${path} — wrong-secret JWT → 401`, async () => {
      const bad = jwt.sign(
        { sub: USER_ID, email: 'x@x.com', role: 'HEAD_COACH', clubId: CLUB_ID },
        'wrong-secret',
        { expiresIn: '15m' },
      );
      const res = await request(app)[method.toLowerCase() as 'get'](path)
        .set('Authorization', `Bearer ${bad}`);
      expect(res.status).toBe(401);
    });

    it(`${method} ${path} — valid token → not 401`, async () => {
      const token = makeToken('HEAD_COACH');
      const res = await request(app)[method.toLowerCase() as 'get'](path)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).not.toBe(401);
    });
  }
});

describe('Scouting write routes — auth guard (no DB)', () => {
  it('POST /api/v1/scouting — no token → 401', async () => {
    const res = await request(app).post('/api/v1/scouting').send({ playerName: 'Test', position: 'ST' });
    expect(res.status).toBe(401);
  });

  it('POST /api/v1/scouting — valid HEAD_COACH token → not 401', async () => {
    const token = makeToken('HEAD_COACH');
    const res = await request(app).post('/api/v1/scouting')
      .set('Authorization', `Bearer ${token}`)
      .send({ playerName: 'Test Player', position: 'ST' });
    expect(res.status).not.toBe(401);
  });

  it('PATCH /api/v1/scouting/:id — no token → 401', async () => {
    const res = await request(app).patch('/api/v1/scouting/00000000-0000-0000-0000-000000000001').send({});
    expect(res.status).toBe(401);
  });

  it('DELETE /api/v1/scouting/:id — no token → 401', async () => {
    const res = await request(app).delete('/api/v1/scouting/00000000-0000-0000-0000-000000000001');
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// UUID validation (no DB — auth passes with valid JWT; handler-level 400
// fires before the DB is touched for prospect ID params)
// Note: auth middleware calls prisma.user.findFirst → without DB will 500/401
// before UUID check fires. These tests verify auth passes (not 401).
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/scouting/:prospectId — UUID format (no DB)', () => {
  it('valid UUID format — auth guard reachable (not 401)', async () => {
    const token = makeToken('HEAD_COACH');
    const res = await request(app)
      .get('/api/v1/scouting/00000000-0000-0000-0000-000000000999')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Compare endpoint — query param validation (no DB)
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/scouting/compare — query param guard (no DB)', () => {
  it('valid token → not 401 (auth guard passes)', async () => {
    const token = makeToken('HEAD_COACH');
    const res = await request(app)
      .get('/api/v1/scouting/compare?prospectA=00000000-0000-0000-0000-000000000001&prospectB=00000000-0000-0000-0000-000000000002')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).not.toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB-GATED: Shape + validation tests
// ─────────────────────────────────────────────────────────────────────────────

const dbSuite = DB_AVAILABLE ? describe : describe.skip;

dbSuite('POST /api/v1/scouting — validation (DB)', () => {
  it('missing playerName → 400', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .post('/api/v1/scouting')
      .set('Cookie', `access_token=${cookie}`)
      .send({ position: 'ST' });
    expect(res.status).toBe(400);
  });

  it('missing position → 400', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .post('/api/v1/scouting')
      .set('Cookie', `access_token=${cookie}`)
      .send({ playerName: 'Test Player' });
    expect(res.status).toBe(400);
  });

  it('attribute out of range (pace: 200) → 400', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .post('/api/v1/scouting')
      .set('Cookie', `access_token=${cookie}`)
      .send({ playerName: 'Test', position: 'ST', pace: 200 });
    expect(res.status).toBe(400);
  });

  it('non-UUID prospect id → 400', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/scouting/not-a-uuid')
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(400);
  });
});

dbSuite('Scouting CRUD lifecycle (DB)', () => {
  let createdId: string;

  it('creates a prospect → 201 with computed fields', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .post('/api/v1/scouting')
      .set('Cookie', `access_token=${cookie}`)
      .send({
        playerName: 'Smoke Test Prospect',
        position:   'ST',
        age:        22,
        nationality: 'Brazil',
        pace:        85, finishing: 82, shooting: 80,
        stamina:     75, strength: 70,
        workRate:    80, determination: 78,
      });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('id');
    expect(res.body.data.playerName).toBe('Smoke Test Prospect');
    expect(typeof res.body.data.currentRating).toBe('number');
    expect(typeof res.body.data.potentialRating).toBe('number');
    expect(typeof res.body.data.recommendationScore).toBe('number');
    expect(res.body.data.recommendation).toBeTruthy();
    createdId = res.body.data.id;
  });

  it('lists prospects → 200 with items array', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/scouting')
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('gets a single prospect → 200 with all fields', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get(`/api/v1/scouting/${createdId}`)
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(createdId);
    expect(res.body.data).toHaveProperty('fitGK');
    expect(res.body.data).toHaveProperty('fitStriker');
    expect(res.body.data).toHaveProperty('injuryRisk');
    expect(res.body.data).toHaveProperty('financialRisk');
  });

  it('updates a prospect → 200 with recomputed scores', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .patch(`/api/v1/scouting/${createdId}`)
      .set('Cookie', `access_token=${cookie}`)
      .send({ pace: 90, marketValueEur: 3000000 });
    expect(res.status).toBe(200);
    expect(res.body.data.pace).toBe(90);
    expect(typeof res.body.data.currentRating).toBe('number');
  });

  it('advances pipeline status → 200 with new status', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .patch(`/api/v1/scouting/${createdId}/pipeline`)
      .set('Cookie', `access_token=${cookie}`)
      .send({ status: 'SCOUTED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SCOUTED');
  });

  it('invalid pipeline status → 400', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .patch(`/api/v1/scouting/${createdId}/pipeline`)
      .set('Cookie', `access_token=${cookie}`)
      .send({ status: 'INVALID_STAGE' });
    expect(res.status).toBe(400);
  });

  it('adds to watchlist → 200 with isOnWatchlist=true', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .patch(`/api/v1/scouting/${createdId}/watchlist`)
      .set('Cookie', `access_token=${cookie}`)
      .send({ isOnWatchlist: true, watchlistCategory: 'TRANSFER_TARGET', watchlistPriority: 80 });
    expect(res.status).toBe(200);
    expect(res.body.data.isOnWatchlist).toBe(true);
    expect(res.body.data.watchlistCategory).toBe('TRANSFER_TARGET');
  });

  it('watchlist list → 200 array containing the added prospect', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/scouting/watchlist')
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const found = res.body.data.find((p: { id: string }) => p.id === createdId);
    expect(found).toBeTruthy();
  });

  it('invalid watchlistCategory → 400', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .patch(`/api/v1/scouting/${createdId}/watchlist`)
      .set('Cookie', `access_token=${cookie}`)
      .send({ isOnWatchlist: true, watchlistCategory: 'BAD_CATEGORY' });
    expect(res.status).toBe(400);
  });

  it('deletes prospect → 204', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .delete(`/api/v1/scouting/${createdId}`)
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(204);
  });

  it('get after delete → 404', async () => {
    if (!createdId) return;
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get(`/api/v1/scouting/${createdId}`)
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(404);
  });
});

dbSuite('GET /api/v1/scouting/dashboard — shape (DB)', () => {
  it('returns kpis + distributions + pipeline', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/scouting/dashboard')
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('kpis');
    expect(res.body.data).toHaveProperty('positionDistribution');
    expect(res.body.data).toHaveProperty('nationalityDistribution');
    expect(res.body.data).toHaveProperty('potentialDistribution');
    expect(res.body.data).toHaveProperty('pipeline');
    expect(typeof res.body.data.kpis.total).toBe('number');
  });
});

dbSuite('GET /api/v1/scouting/pipeline — shape (DB)', () => {
  it('returns pipeline board keyed by stage', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/scouting/pipeline')
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.data).toBe('object');
    // Should have at least IDENTIFIED stage
    expect(res.body.data).toHaveProperty('IDENTIFIED');
  });
});

dbSuite('GET /api/v1/scouting/compare — validation (DB)', () => {
  it('same prospectA and prospectB → 400', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const id = '00000000-0000-0000-0000-000000000001';
    const res = await request(app)
      .get(`/api/v1/scouting/compare?prospectA=${id}&prospectB=${id}`)
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(400);
  });

  it('non-UUID prospectA → 400', async () => {
    const cookie = await loginAs(process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
    const res = await request(app)
      .get('/api/v1/scouting/compare?prospectA=not-a-uuid&prospectB=00000000-0000-0000-0000-000000000001')
      .set('Cookie', `access_token=${cookie}`);
    expect(res.status).toBe(400);
  });
});
