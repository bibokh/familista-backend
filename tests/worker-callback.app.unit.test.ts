/**
 * tests/worker-callback.app.unit.test.ts
 *
 * Cyber Defense, R1a — the same question asked of the real application
 * (createApp), with a valid user session: can a signed-in club user still
 * reach the transcode callback? The old API path no longer exists, and the
 * worker route answers 503 without its secret and 401 to a user token with it.
 */

import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Application } from 'express';
import { createApp } from '../src/app';

jest.mock('../src/config/database', () => require('./helpers/stub-database').stubDatabase({
  id: '00000000-0000-0000-0000-000000000002',
  clubId: '00000000-0000-0000-0000-000000000001',
  role: 'CLUB_ADMIN',
}));

const ASSET = '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const body = {
  assetId: ASSET,
  hlsManifestKey: `clubs/22222222-2222-4222-8222-222222222222/videos/${ASSET}/hls/index.m3u8`,
};

function userToken(): string {
  return jwt.sign(
    { sub: '00000000-0000-0000-0000-000000000002', email: 't@test.invalid', role: 'CLUB_ADMIN', clubId: '00000000-0000-0000-0000-000000000001' },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: '15m' },
  );
}

let app: Application;
const saved = process.env.VIDEO_WORKER_CALLBACK_SECRET;
beforeAll(() => { delete process.env.VIDEO_WORKER_CALLBACK_SECRET; app = createApp(); });
afterAll(() => { if (saved === undefined) delete process.env.VIDEO_WORKER_CALLBACK_SECRET; else process.env.VIDEO_WORKER_CALLBACK_SECRET = saved; });

describe('the transcode callback in the real application', () => {
  it('the old user-session path is gone: a signed-in user gets no handler at all', async () => {
    const res = await request(app).post('/api/v1/phase-q/video/transcode-callback')
      .set('Authorization', `Bearer ${userToken()}`).send(body);
    // Before R1a the same request reached the service, which answered
    // "VideoAsset not found" for an unknown asset (and updated a known one).
    // Now no route matches.
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/VideoAsset/);
  });

  it('the worker route is closed while no secret is configured, whoever asks', async () => {
    const res = await request(app).post('/internal/video/transcode-callback')
      .set('Authorization', `Bearer ${userToken()}`).set('content-type', 'application/json').send(JSON.stringify(body));
    expect(res.status).toBe(503);
  });

  it('with a secret configured, a user token without the worker signature is refused', async () => {
    process.env.VIDEO_WORKER_CALLBACK_SECRET = 'w'.repeat(48);
    try {
      const res = await request(app).post('/internal/video/transcode-callback')
        .set('Authorization', `Bearer ${userToken()}`).set('content-type', 'application/json').send(JSON.stringify(body));
      expect(res.status).toBe(401);
    } finally {
      delete process.env.VIDEO_WORKER_CALLBACK_SECRET;
    }
  });
});
