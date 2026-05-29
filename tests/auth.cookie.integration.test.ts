/**
 * Auth cookie integration tests — require a live database.
 *
 * These tests exercise the full login → cookie → authenticated request →
 * logout → cookie-cleared cycle against a real Postgres database.
 *
 * Prerequisites:
 *   TEST_DATABASE_URL  = valid connection string (already seeded with a user)
 *   TEST_USER_EMAIL    = email of an existing active user in that DB
 *   TEST_USER_PASSWORD = password for that user
 *
 * All tests are skipped when TEST_DATABASE_URL is absent so the suite
 * remains green in pure CI environments without a DB.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import type { Application } from 'express';

const HAS_DB    = !!process.env.TEST_DATABASE_URL;
const testEmail = process.env.TEST_USER_EMAIL    ?? '';
const testPass  = process.env.TEST_USER_PASSWORD ?? '';

const skipIfNoDB = HAS_DB ? describe : describe.skip;

let app: Application;

beforeAll(() => {
  app = createApp();
});

skipIfNoDB('Cookie auth integration', () => {
  let accessCookie  = '';
  let refreshCookie = '';

  // ── Login sets HttpOnly cookies ──────────────────────────────────────────────
  it('POST /auth/login → 200 + sets access_token and refresh_token cookies', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: testEmail, password: testPass });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const cookies = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieArr = Array.isArray(cookies) ? cookies : [cookies ?? ''];

    const ac = cookieArr.find(c => c.startsWith('access_token='));
    const rc = cookieArr.find(c => c.startsWith('refresh_token='));

    expect(ac).toBeDefined();
    expect(rc).toBeDefined();
    // HttpOnly must be present
    expect(ac).toMatch(/httponly/i);
    expect(rc).toMatch(/httponly/i);

    // Extract raw cookie values for subsequent requests
    accessCookie  = ac!.split(';')[0];  // "access_token=<value>"
    refreshCookie = rc!.split(';')[0];  // "refresh_token=<value>"
  });

  // ── Cookie → authenticated GET /auth/me ─────────────────────────────────────
  it('GET /auth/me with access_token cookie → 200 + user profile', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', accessCookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({ email: testEmail });
  });

  // ── Cookie auth preferred over absent header ─────────────────────────────────
  it('GET /auth/me with cookie but no Authorization header → 200 (cookie wins)', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', accessCookie);
    // No Authorization header set at all

    expect(res.status).toBe(200);
  });

  // ── Refresh via cookie ───────────────────────────────────────────────────────
  it('POST /auth/refresh with refresh_token cookie (no body) → 200 + new tokens', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', refreshCookie)
      .send({});  // no refreshToken in body — cookie should suffice

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const cookies = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieArr = Array.isArray(cookies) ? cookies : [cookies ?? ''];
    const newAc = cookieArr.find(c => c.startsWith('access_token='));
    expect(newAc).toBeDefined();

    // Update cookie for logout test
    accessCookie  = newAc!.split(';')[0];
    const newRc   = cookieArr.find(c => c.startsWith('refresh_token='));
    if (newRc) refreshCookie = newRc.split(';')[0];
  });

  // ── Logout clears cookies ────────────────────────────────────────────────────
  it('POST /auth/logout → 200 + clears access_token and refresh_token cookies', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', `${accessCookie}; ${refreshCookie}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const cookies = res.headers['set-cookie'] as string[] | string | undefined;
    const cookieArr = Array.isArray(cookies) ? cookies : [cookies ?? ''];

    // Cleared cookies should have Max-Age=0 or Expires in the past
    const ac = cookieArr.find(c => c.startsWith('access_token='));
    const rc = cookieArr.find(c => c.startsWith('refresh_token='));
    expect(ac).toBeDefined();
    expect(rc).toBeDefined();
    expect(ac).toMatch(/max-age=0/i);
    expect(rc).toMatch(/max-age=0/i);
  });

  // ── Cleared cookie → 401 ────────────────────────────────────────────────────
  it('GET /auth/me after logout (stale / no cookie) → 401', async () => {
    const res = await request(app)
      .get('/api/v1/auth/me');
    // No cookie, no header

    expect(res.status).toBe(401);
  });
});
