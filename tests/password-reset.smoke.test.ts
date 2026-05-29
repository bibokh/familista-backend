/**
 * Password-reset smoke tests — Exercise HTTP validation layer.
 *
 * No-DB tests: Zod validation failures are caught before any service/DB call.
 * DB-dependent tests (token validation, actual reset) are skipped unless
 * TEST_DATABASE_URL is set in the environment.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import type { Application } from 'express';

const DB_AVAILABLE = !!process.env.TEST_DATABASE_URL;

let app: Application;

beforeAll(() => {
  app = createApp();
});

// ─── POST /api/v1/auth/forgot-password ───────────────────────────────────────

describe('POST /api/v1/auth/forgot-password — input validation', () => {
  it('empty body → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('invalid email format → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'not-a-valid-email' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toMatch(/validation/i);
  });

  it('numeric email field → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 12345 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // DB-dependent: a valid email is accepted by Zod but triggers a DB lookup.
  // The service always returns the same success envelope (anti-enumeration).
  (DB_AVAILABLE ? it : it.skip)(
    'valid email + DB available → 200 (anti-enumeration: same response whether email exists or not)',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'no-such-user@familista.app' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  );
});

// ─── POST /api/v1/auth/reset-password ────────────────────────────────────────

describe('POST /api/v1/auth/reset-password — input validation', () => {
  it('empty body → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('missing `token` field → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ newPassword: 'ValidNewPass1!' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('password shorter than 8 chars → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'sometoken', newPassword: 'short' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('missing `newPassword` → 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'sometoken' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // DB-dependent: valid structure but non-existent token → 404/400 from service.
  (DB_AVAILABLE ? it : it.skip)(
    'valid structure + DB available + unknown token → non-200 error',
    async () => {
      const res = await request(app)
        .post('/api/v1/auth/reset-password')
        .send({ token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', newPassword: 'ValidPass1!' });

      // Token not found → 400 or 404 from the service layer.
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.success).toBe(false);
    }
  );
});

// ─── GET /api/v1/auth/reset-password/:token/validate ─────────────────────────

describe('GET /api/v1/auth/reset-password/:token/validate', () => {
  // DB-dependent: the tokenParamSchema accepts any non-empty string,
  // so validation passes and the service queries the DB immediately.
  (DB_AVAILABLE ? it : it.skip)(
    'unknown token + DB available → 400/404 from service',
    async () => {
      const res = await request(app)
        .get('/api/v1/auth/reset-password/nonexistent-token-abc123/validate');

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.success).toBe(false);
    }
  );
});
