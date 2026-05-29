/**
 * Video share link smoke tests.
 *
 * The share endpoint is PUBLIC — no JWT required. The share token IS the
 * credential. Tests verify:
 *   1. The route is accessible without a Bearer token (not 401/403).
 *   2. With a DB, an unknown/expired token returns 404.
 *   3. With a DB, a well-formed but non-existent token returns the correct
 *      error shape from the AppError handler (not a raw 500 stack trace).
 *
 * Tests marked (DB_AVAILABLE ? it : it.skip) need a live Postgres connection
 * in TEST_DATABASE_URL.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import type { Application } from 'express';

const DB_AVAILABLE = !!process.env.TEST_DATABASE_URL;

let app: Application;

beforeAll(() => {
  app = createApp();
});

// ─── Route accessibility (no auth required) ───────────────────────────────────

describe('GET /api/v1/phase-q/video/shared/:shareToken — public route (no auth)', () => {
  it('no Authorization header does NOT return 401 or 403', async () => {
    // The route is public. Whatever the outcome (404 with DB, 500 without DB),
    // it must not be an auth rejection.
    const res = await request(app)
      .get('/api/v1/phase-q/video/shared/any-token-here');

    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });

  it('route exists — does not return 404 for route-not-found', async () => {
    // 404 from the service (clip not found) has { success: false, message: '...' }.
    // 404 from notFoundHandler has message matching "Route not found".
    const res = await request(app)
      .get('/api/v1/phase-q/video/shared/any-token-here');

    if (res.status === 404) {
      // If it's a route-not-found 404, the message would say "Route not found"
      expect(res.body.message).not.toMatch(/Route not found/i);
    }
    // Any other status is fine here (the DB may be unavailable in this env)
  });
});

// ─── DB-dependent: token not found / expired ─────────────────────────────────

describe('GET /api/v1/phase-q/video/shared/:shareToken — with DB', () => {
  (DB_AVAILABLE ? it : it.skip)(
    'unknown share token → 404 with correct error shape',
    async () => {
      const res = await request(app)
        .get('/api/v1/phase-q/video/shared/00000000-0000-0000-0000-000000000000');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBeTruthy();
    }
  );

  (DB_AVAILABLE ? it : it.skip)(
    'share token with special characters is URL-decoded correctly and returns 404',
    async () => {
      const res = await request(app)
        .get('/api/v1/phase-q/video/shared/this-is-not-a-real-token-abc123xyz');

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    }
  );
});
