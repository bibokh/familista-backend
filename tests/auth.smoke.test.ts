/**
 * Auth smoke tests — Exercise the HTTP validation + auth middleware layer.
 *
 * ALL tests in this file run without a live database:
 *   - Zod validation failures (400) are caught before any service/DB call.
 *   - Missing / malformed Bearer tokens are rejected by the JWT verify step
 *     inside `authenticate`, before the DB user-lookup query executes.
 *
 * Tests that require a real DB (e.g., valid-credentials login) are kept in
 * separate integration test files and gated on TEST_DATABASE_URL.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import type { Application } from 'express';

let app: Application;

beforeAll(() => {
  app = createApp();
});

// ─── POST /api/v1/auth/login ──────────────────────────────────────────────────

describe('POST /api/v1/auth/login — input validation', () => {
  it('empty body → 400 with validation errors', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/validation/i);
  });

  it('non-email string in `email` field → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'not-an-email', password: 'somepassword' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('missing `password` field → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'coach@club.com' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('empty string `password` → 400 (min 1 char)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'coach@club.com', password: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─── POST /api/v1/auth/register — input validation ───────────────────────────

describe('POST /api/v1/auth/register — input validation', () => {
  it('empty body → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('password shorter than 8 chars → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'new@club.com',
        password: 'short',
        firstName: 'John',
        lastName: 'Doe',
        clubId: '00000000-0000-0000-0000-000000000001',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('non-UUID `clubId` → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: 'new@club.com',
        password: 'ValidPass1!',
        firstName: 'John',
        lastName: 'Doe',
        clubId: 'not-a-uuid',
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

// ─── GET /api/v1/auth/me — authentication guard ───────────────────────────────

describe('GET /api/v1/auth/me — authentication middleware', () => {
  it('no Authorization header → 401', async () => {
    const res = await request(app).get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('Authorization header without "Bearer " prefix → 401', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Token sometoken');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('malformed JWT string → 401', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', 'Bearer this.is.not.a.jwt');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('structurally-valid JWT signed with wrong secret → 401', async () => {
    // Signed with a key that does not match JWT_ACCESS_SECRET in setup.ts.
    const jwt = require('jsonwebtoken');
    const badToken = jwt.sign(
      { sub: '00000000-0000-0000-0000-000000000001', email: 'x@x.com', role: 'HEAD_COACH', clubId: '00000000-0000-0000-0000-000000000001' },
      'wrong-secret-that-will-fail-verify',
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${badToken}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ─── GET /api/v1/auth/me — cookie-based auth path ────────────────────────────

describe('GET /api/v1/auth/me — cookie auth middleware', () => {
  it('access_token cookie with malformed JWT → 401', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'access_token=not.a.valid.jwt');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('access_token cookie with valid structure but wrong secret → 401', async () => {
    const jwt = require('jsonwebtoken');
    const badCookieToken = jwt.sign(
      { sub: '00000000-0000-0000-0000-000000000001', email: 'x@x.com', role: 'HEAD_COACH', clubId: '00000000-0000-0000-0000-000000000001' },
      'wrong-secret-for-cookie-test',
      { expiresIn: '1h' }
    );

    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `access_token=${badCookieToken}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('no cookie AND no Authorization header → 401', async () => {
    // Ensure neither credential path satisfies authenticate()
    const res = await request(app)
      .get('/api/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });
});

// ─── POST /api/v1/auth/refresh — input validation ────────────────────────────

describe('POST /api/v1/auth/refresh — input validation', () => {
  it('no cookie + empty body → 400 (no refresh token at all)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('no cookie + empty refreshToken body field → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
