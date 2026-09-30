/**
 * tests/worker-callback.unit.test.ts
 *
 * Cyber Defense, R1a — the transcode callback belongs to a worker.
 *
 * Before: POST /api/v1/phase-q/video/transcode-callback sat behind nothing but
 * a user session, and the service took any asset id and any storage keys — so
 * a signed-in user of one club could mark another club's video READY or FAILED
 * and point it at any files. Now the route is gone from the API; the callback
 * is POST /internal/video/transcode-callback, authenticated by an HMAC over
 * the method, path, timestamp and raw body, closed without its secret, and the
 * service keeps every key inside the asset's own club folder.
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { ForbiddenError, NotFoundError } from '../src/utils/errors';
import {
  MAX_CALLBACK_BYTES, TRANSCODE_CALLBACK_PATH, signWorkerCallback, verifyWorkerCallback, workerCallbackSecret,
} from '../src/security/worker-callback';
import { parseCallback, transcodeCallbackRoute, type TranscodeCallbackDeps } from '../src/controllers/internal-video.controller';
import { assertKeyWithinAsset } from '../src/video/video-asset.service';

const ROOT = path.join(__dirname, '..');
const SECRET = 'w'.repeat(48);
const NOW = 1_790_000_000;
const ASSET = '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const CLUB = '11111111-1111-4111-8111-111111111111';

function appWith(deps: Partial<TranscodeCallbackDeps> = {}) {
  const handle = jest.fn(async (dto: { assetId: string }) => ({ id: dto.assetId, status: 'READY' }));
  const full: TranscodeCallbackDeps = { secret: () => Buffer.from(SECRET), nowSeconds: () => NOW, handle, ...deps };
  const app = express();
  // The same order as app.ts: the route before the global JSON parser.
  app.post(TRANSCODE_CALLBACK_PATH, ...transcodeCallbackRoute(full));
  app.use(express.json());
  return { app, handle: full.handle as jest.Mock };
}

function signed(body: object | string, opts: { ts?: number; secret?: string; path?: string } = {}) {
  // Sent as a string: supertest would JSON-encode a Buffer, changing the bytes.
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = String(opts.ts ?? NOW);
  const sig = signWorkerCallback(opts.secret ?? SECRET, 'POST', opts.path ?? TRANSCODE_CALLBACK_PATH, ts, Buffer.from(raw));
  return { raw, headers: { 'content-type': 'application/json', 'x-worker-timestamp': ts, 'x-worker-signature': sig } };
}

const GOOD = {
  assetId: ASSET,
  hlsManifestKey: `clubs/${CLUB}/videos/${ASSET}/hls/index.m3u8`,
  thumbStorageKey: `clubs/${CLUB}/videos/${ASSET}/thumb.jpg`,
  durationSec: 90,
};

describe('the signature', () => {
  it('accepts the exact signed request and nothing altered', () => {
    const body = Buffer.from(JSON.stringify(GOOD));
    const sig = signWorkerCallback(SECRET, 'POST', TRANSCODE_CALLBACK_PATH, String(NOW), body);
    const req = { method: 'POST', path: TRANSCODE_CALLBACK_PATH, timestamp: String(NOW), signature: sig, body };
    const secret = Buffer.from(SECRET);
    expect(verifyWorkerCallback(secret, req, NOW)).toBe('ok');
    expect(verifyWorkerCallback(secret, { ...req, body: Buffer.from(JSON.stringify({ ...GOOD, durationSec: 91 })) }, NOW)).toBe('unauthenticated');
    expect(verifyWorkerCallback(secret, { ...req, path: '/internal/other' }, NOW)).toBe('unauthenticated');
    expect(verifyWorkerCallback(Buffer.from('x'.repeat(48)), req, NOW)).toBe('unauthenticated');
    expect(verifyWorkerCallback(secret, { ...req, signature: 'zz' }, NOW)).toBe('unauthenticated');
    expect(verifyWorkerCallback(secret, { ...req, timestamp: 'now' }, NOW)).toBe('unauthenticated');
    expect(verifyWorkerCallback(secret, req, NOW + 301)).toBe('stale');
    expect(verifyWorkerCallback(secret, req, NOW - 301)).toBe('stale');
  });

  it('is closed without a secret of at least 32 characters', () => {
    expect(workerCallbackSecret({})).toBeNull();
    expect(workerCallbackSecret({ VIDEO_WORKER_CALLBACK_SECRET: 'short' })).toBeNull();
    expect(workerCallbackSecret({ VIDEO_WORKER_CALLBACK_SECRET: SECRET })).toEqual(Buffer.from(SECRET));
  });
});

describe('POST /internal/video/transcode-callback', () => {
  it('answers 503 and runs nothing while no secret is configured (production today)', async () => {
    const { app, handle } = appWith({ secret: () => null });
    const s = signed(GOOD);
    const res = await request(app).post(TRANSCODE_CALLBACK_PATH).set(s.headers).send(s.raw);
    expect(res.status).toBe(503);
    expect(handle).not.toHaveBeenCalled();
  });

  it('refuses a user session: a bearer token is not a worker signature', async () => {
    const { app, handle } = appWith();
    const res = await request(app).post(TRANSCODE_CALLBACK_PATH)
      .set('authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.sig')
      .set('content-type', 'application/json').send(JSON.stringify(GOOD));
    expect(res.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  it('refuses a wrong secret, an edited body, a replay after five minutes and a query string', async () => {
    const { app, handle } = appWith();
    const wrong = signed(GOOD, { secret: 'q'.repeat(48) });
    expect((await request(app).post(TRANSCODE_CALLBACK_PATH).set(wrong.headers).send(wrong.raw)).status).toBe(401);

    const s = signed(GOOD);
    const edited = JSON.stringify({ ...GOOD, hlsManifestKey: `clubs/other/videos/${ASSET}/hls/x.m3u8` });
    expect((await request(app).post(TRANSCODE_CALLBACK_PATH).set(s.headers).send(edited)).status).toBe(401);

    const old = signed(GOOD, { ts: NOW - 301 });
    expect((await request(app).post(TRANSCODE_CALLBACK_PATH).set(old.headers).send(old.raw)).status).toBe(401);

    expect((await request(app).post(`${TRANSCODE_CALLBACK_PATH}?assetId=${ASSET}`).set(s.headers).send(s.raw)).status).toBe(400);
    expect(handle).not.toHaveBeenCalled();
  });

  it('passes a correctly signed result to the service, as the fields it accepts and nothing else', async () => {
    const { app, handle } = appWith();
    const s = signed(GOOD);
    const res = await request(app).post(TRANSCODE_CALLBACK_PATH).set(s.headers).send(s.raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: ASSET, status: 'READY' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(handle).toHaveBeenCalledWith(GOOD);
  });

  it('refuses a signed body with unknown fields, a bad asset id or an oversized body', async () => {
    const { app, handle } = appWith();
    for (const body of [{ ...GOOD, clubId: CLUB }, { ...GOOD, assetId: 'nope' }, { ...GOOD, durationSec: -1 }, [GOOD]]) {
      const s = signed(body);
      expect((await request(app).post(TRANSCODE_CALLBACK_PATH).set(s.headers).send(s.raw)).status).toBe(400);
    }
    const big = signed({ ...GOOD, errorMessage: 'x'.repeat(MAX_CALLBACK_BYTES) });
    expect((await request(app).post(TRANSCODE_CALLBACK_PATH).set(big.headers).send(big.raw)).status).toBe(413);
    expect(handle).not.toHaveBeenCalled();
  });

  it('reports the service refusing a key outside the asset folder as 403, an unknown asset as 404', async () => {
    const forbidden = appWith({ handle: async () => { throw new ForbiddenError('hlsManifestKey must be under the video\'s own storage folder'); } });
    const s = signed(GOOD);
    expect((await request(forbidden.app).post(TRANSCODE_CALLBACK_PATH).set(s.headers).send(s.raw)).status).toBe(403);
    const missing = appWith({ handle: async () => { throw new NotFoundError('VideoAsset'); } });
    expect((await request(missing.app).post(TRANSCODE_CALLBACK_PATH).set(s.headers).send(s.raw)).status).toBe(404);
  });

  it('parses only the documented shape', () => {
    expect(parseCallback(Buffer.from('not json'))).toBeNull();
    expect(parseCallback(Buffer.from(JSON.stringify({ assetId: ASSET, errorMessage: 'ffmpeg exited 1' }))))
      .toEqual({ assetId: ASSET, errorMessage: 'ffmpeg exited 1' });
  });
});

describe('the storage-key rule the service applies to every caller', () => {
  const asset = { id: ASSET, clubId: CLUB };
  it('accepts a key inside the asset folder and refuses everything else', () => {
    expect(() => assertKeyWithinAsset(asset, GOOD.hlsManifestKey, 'k')).not.toThrow();
    expect(() => assertKeyWithinAsset(asset, undefined, 'k')).not.toThrow();
    for (const key of [
      `clubs/22222222-2222-4222-8222-222222222222/videos/${ASSET}/hls/index.m3u8`,
      `clubs/${CLUB}/videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/hls/index.m3u8`,
      `clubs/${CLUB}/videos/${ASSET}/../other/index.m3u8`,
      `clubs/${CLUB}/videos/${ASSET}//x`,
      `clubs/${CLUB}/videos/${ASSET}/`,
      `clubs/${CLUB}/videos/${ASSET}/a b.m3u8`,
      `/clubs/${CLUB}/videos/${ASSET}/x`,
    ]) {
      expect(() => assertKeyWithinAsset(asset, key, 'k')).toThrow(ForbiddenError);
    }
    expect(() => assertKeyWithinAsset({ id: ASSET, clubId: null }, GOOD.hlsManifestKey, 'k')).toThrow(ForbiddenError);
  });
});

describe('wiring', () => {
  const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const app = read('src/app.ts');

  it('no API router registers a transcode callback any more', () => {
    for (const f of fs.readdirSync(path.join(ROOT, 'src/routes')).filter((x) => x.endsWith('.ts'))) {
      expect(`${f}: ${/router\.\w+\s*\(\s*'[^']*transcode-callback/.test(read(`src/routes/${f}`))}`).toBe(`${f}: false`);
    }
    expect(read('src/controllers/phase-q.controller.ts')).not.toMatch(/export async function handleTranscodeCallback/);
  });

  it('app.ts mounts the worker route at its literal path, before the JSON parser', () => {
    const at = app.indexOf(`app.post('${TRANSCODE_CALLBACK_PATH}', ...transcodeCallbackRoute())`);
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(app.indexOf('app.use(express.json('));
  });

  it('the in-process worker still calls the service directly, not over HTTP', () => {
    const worker = read('src/workers/video-transcode.worker.ts');
    expect(worker).toMatch(/import \{ handleTranscodeCallback \} from '\.\.\/video\/video-asset\.service'/);
    expect(worker).not.toMatch(/transcode-callback|fetch\(/);
  });
});
