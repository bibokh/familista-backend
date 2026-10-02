/**
 * tests/worker-channel.unit.test.ts
 *
 * Cyber Defense, R13 — every machine-to-machine channel proves who sent it.
 *
 *   vision webhooks   HMAC over method, full path, timestamp and raw body
 *                     (was a static header: replayable, any body accepted)
 *   outbound jobs     signed the same way, so a worker can refuse a replay
 *   camera / device   HMAC over the message, constant-time, wrong length refused
 */

import express from 'express';
import request from 'supertest';
import { createHmac } from 'crypto';

jest.mock('../src/config/database', () => ({ prisma: { deviceSession: { findUnique: jest.fn() } } }));
jest.mock('../src/lib/prisma', () => ({ prisma: {} }));

import { requireWebhookAuth } from '../src/middleware/vision-access.middleware';
import { rawBodyForSignedWebhooks } from '../src/middleware/raw-body-paths';
import { signWorkerCallback, signedWorkerHeaders, verifyWorkerCallback } from '../src/security/worker-callback';
import { verifyCameraHmac } from '../src/vision/camera-registry.service';
import { issueDeviceToken } from '../src/services/device-auth.service';
import { prisma } from '../src/config/database';

const ENV = 'VISION_WEBHOOK_TOKEN';
const SECRET = 'v'.repeat(48);
const PATH = '/api/v1/vision/webhooks/inference/job-1';
const now = () => Math.floor(Date.now() / 1000);

function appWith(parseFirst = false) {
  const app = express();
  if (parseFirst) app.use(express.json());
  app.use(rawBodyForSignedWebhooks());
  app.use(express.json());
  const router = express.Router();
  router.post('/webhooks/inference/:jobId', ...requireWebhookAuth(ENV), (req, res) => { res.json({ got: req.body }); });
  app.use('/api/v1/vision', router);
  app.use((err: { statusCode?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: err.message });
  });
  return app;
}

function post(app: express.Express, body: string, headers: Record<string, string>, path = PATH) {
  let r = request(app).post(path).set('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
  return r.send(body);
}

function sign(body: string, opts: { path?: string; ts?: number; secret?: string } = {}) {
  const ts = String(opts.ts ?? now());
  return { 'x-worker-timestamp': ts, 'x-worker-signature': signWorkerCallback(opts.secret ?? SECRET, 'POST', opts.path ?? PATH, ts, Buffer.from(body)) };
}

const body = JSON.stringify({ status: 'COMPLETED', tracks: [] });

describe('vision webhooks: signed, fresh, and over the exact body', () => {
  const saved = process.env[ENV];
  afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

  it('is closed while the secret is unset or shorter than 32 characters', async () => {
    delete process.env[ENV];
    expect((await post(appWith(), body, sign(body))).status).toBe(403);
    process.env[ENV] = 'short-secret';
    expect((await post(appWith(), body, sign(body, { secret: 'short-secret' }))).status).toBe(403);
  });

  it('accepts a correctly signed callback and hands the handler the parsed body', async () => {
    process.env[ENV] = SECRET;
    const res = await post(appWith(), body, sign(body));
    expect(res.status).toBe(200);
    expect(res.body.got).toEqual(JSON.parse(body));
  });

  it('refuses the old static header on its own', async () => {
    process.env[ENV] = SECRET;
    const res = await post(appWith(), body, { 'x-vision-inference-token': SECRET });
    expect(res.status).toBe(401);
  });

  it('refuses a tampered body, a stale timestamp, another path, and another secret', async () => {
    process.env[ENV] = SECRET;
    const app = appWith();
    expect((await post(app, body.replace('COMPLETED', 'FAILED'), sign(body))).status).toBe(401);
    expect((await post(app, body, sign(body, { ts: now() - 600 }))).status).toBe(401);
    expect((await post(app, body, sign(body), '/api/v1/vision/webhooks/inference/job-2')).status).toBe(401);
    expect((await post(app, body, sign(body, { secret: 'o'.repeat(48) }))).status).toBe(401);
  });

  it('fails closed when a JSON parser has already consumed the body', async () => {
    process.env[ENV] = SECRET;
    expect((await post(appWith(true), body, sign(body))).status).toBe(401);
  });
});

describe('outbound worker requests are signed', () => {
  it('signs the URL path and exact body so the worker can verify them', () => {
    const url = 'https://worker.test.invalid/jobs';
    const h = signedWorkerHeaders(SECRET, 'POST', url, body, 1_700_000_000);
    const verify = (b: string, path = '/jobs') => verifyWorkerCallback(Buffer.from(SECRET), {
      method: 'POST', path, timestamp: h['x-worker-timestamp'], signature: h['x-worker-signature'], body: Buffer.from(b),
    }, 1_700_000_000);
    expect(verify(body)).toBe('ok');
    expect(verify(body + ' ')).toBe('unauthenticated');
    expect(verify(body, '/clips')).toBe('unauthenticated');
  });
});

describe('camera and device signatures', () => {
  const key = Buffer.alloc(32, 7);
  const sig = (m: string) => createHmac('sha256', key).update(m).digest('base64');

  it('a camera message verifies only with its own signature', () => {
    expect(verifyCameraHmac(key.toString('base64'), 'cam-1.100.payload', sig('cam-1.100.payload'))).toBe(true);
    expect(verifyCameraHmac(key.toString('base64'), 'cam-1.100.payloaX', sig('cam-1.100.payload'))).toBe(false);
    expect(verifyCameraHmac(key.toString('base64'), 'cam-1.100.payload', sig('cam-1.100.payload').slice(0, 20))).toBe(false);
    expect(verifyCameraHmac(Buffer.alloc(32, 8).toString('base64'), 'cam-1.100.payload', sig('cam-1.100.payload'))).toBe(false);
  });

  it('a device handshake is refused when stale or wrongly signed, and issued when correct', async () => {
    const findUnique = (prisma as unknown as { deviceSession: { findUnique: jest.Mock } }).deviceSession.findUnique;
    findUnique.mockResolvedValue({
      id: 'ds-1', clubId: 'c-1', teamId: null, matchId: null, trainingSessionId: null,
      deviceModel: 'pod', deviceSerial: 'SN1', sessionKey: key.toString('base64'), endedAt: null,
    });
    const ts = now();
    const nonce = 'n'.repeat(24);
    await expect(issueDeviceToken({ deviceSessionId: 'ds-1', ts: ts - 3600, nonce, sig: sig(`${ts - 3600}.${nonce}`) }))
      .rejects.toThrow(/skew/i);
    await expect(issueDeviceToken({ deviceSessionId: 'ds-1', ts, nonce, sig: sig(`${ts}.other-nonce-xxxxxxxx`) }))
      .rejects.toThrow(/signature/i);
    const issued = await issueDeviceToken({ deviceSessionId: 'ds-1', ts, nonce, sig: sig(`${ts}.${nonce}`) });
    expect(issued.sessionId).toBe('ds-1');
    expect(typeof issued.token).toBe('string');
  });
});
