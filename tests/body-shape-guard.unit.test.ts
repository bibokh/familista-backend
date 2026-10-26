/**
 * The body shape guard — the compensating control for GHSA-mrhx-c7xc-m3w5 (zod < 4.6.6).
 *
 * 1. The advisory, reproduced on the zod this repository installs: an array schema keeps one issue per failing
 *    element, with no cap, even when it declares .max(). This is why a bound must act before any schema runs.
 * 2. The guard refuses each limit at its first value past it, accepts each at exactly the limit, never recurses,
 *    and never copies an oversized object to count it.
 * 3. Every legitimate body the platform documents passes: a device batch, a provisioning batch, a notification fan-out.
 * 4. Under the guard, the most issues any schema can build is bounded by maxValues.
 * 5. In the real application it runs after the body parsers and before every route and auth check, answers 413,
 *    and leaves a signed raw body (a Buffer) to its own verifier.
 */

import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { z } from 'zod';
import type { Application } from 'express';

jest.mock('../src/config/database', () => require('./helpers/stub-database').stubDatabase({
  id: '00000000-0000-0000-0000-000000000002',
  clubId: '00000000-0000-0000-0000-000000000001',
  role: 'CLUB_ADMIN',
}));

import { createApp } from '../src/app';
import { BODY_SHAPE_LIMITS as L, bodyShapeBreach } from '../src/middleware/body-shape-guard';

const zeros = (n: number) => new Array(n).fill(0);
/** `depth` containers, one inside the other, around nothing. */
const nest = (depth: number) => { let v: unknown = []; for (let i = 1; i < depth; i++) v = [v]; return v; };
const objectWith = (keys: number) => Object.fromEntries(Array.from({ length: keys }, (_, i) => [`k${i}`, 0]));

// ── 1. The advisory, as the installed zod behaves ───────────────────────────
describe('GHSA-mrhx-c7xc-m3w5 on the installed zod', () => {
  it('keeps one issue per failing element, and a declared .max() does not stop it', () => {
    const r = z.array(z.string()).max(10).safeParse(zeros(100_000));
    expect(r.success).toBe(false);
    // 100,000 element issues plus the one for the length: every element was parsed after the length had already failed.
    expect(!r.success && r.error.issues.length).toBe(100_001);
  });
});

// ── 2. The limits ───────────────────────────────────────────────────────────
describe('bodyShapeBreach', () => {
  it('accepts every limit exactly at it, and refuses it one past', () => {
    expect(bodyShapeBreach(zeros(L.maxArrayLength))).toBeNull();
    expect(bodyShapeBreach(zeros(L.maxArrayLength + 1))).toBe('array');
    expect(bodyShapeBreach(objectWith(L.maxObjectKeys))).toBeNull();
    expect(bodyShapeBreach(objectWith(L.maxObjectKeys + 1))).toBe('keys');
    expect(bodyShapeBreach(nest(L.maxDepth))).toBeNull();
    expect(bodyShapeBreach(nest(L.maxDepth + 1))).toBe('depth');
    // maxValues counts the body and every value in it: 1 + arrays + their items.
    const per = L.maxArrayLength;
    const fill = (extra: number) => {
      const arrays = Math.floor((L.maxValues - 1) / (per + 1));
      const body: Record<string, unknown> = Object.fromEntries(Array.from({ length: arrays }, (_, i) => [`a${i}`, zeros(per)]));
      const used = 1 + arrays * (per + 1);
      body.rest = zeros(L.maxValues - used - 1 + extra);
      return body;
    };
    expect(bodyShapeBreach(fill(0))).toBeNull();
    expect(bodyShapeBreach(fill(1))).toBe('values');
  });

  it('is not recursive: a body nested 200,000 deep is refused, not a stack overflow', () => {
    const deep = JSON.parse('['.repeat(200_000) + ']'.repeat(200_000));
    expect(bodyShapeBreach(deep)).toBe('depth');
  });

  it('refuses the widest object a 2 MB body can hold', () => {
    expect(bodyShapeBreach(objectWith(222_222))).toBe('keys');
  });

  it('counts own keys only, including the ones JSON.parse makes from "__proto__"', () => {
    const parsed = JSON.parse(`{${Array.from({ length: L.maxObjectKeys }, (_, i) => `"k${i}":0`).join(',')},"__proto__":{"x":1}}`);
    expect(bodyShapeBreach(parsed)).toBe('keys');
  });

  it('passes what is not a container: a string, a number, null', () => {
    for (const v of ['x'.repeat(2_000_000), 5, null, undefined, true]) expect(bodyShapeBreach(v)).toBeNull();
  });
});

// ── 3. Legitimate bodies ────────────────────────────────────────────────────
describe('every legitimate body the platform documents passes', () => {
  it('a device batch at its declared maximum (500 packets, docs/fusion-protocol.md)', () => {
    const packets = Array.from({ length: 500 }, (_, i) => ({
      kind: 'HEALTH_BUNDLE', capturedAt: new Date(1_700_000_000_000 + i * 10).toISOString(), sigB64: 'c2ln',
      payload: { hr: 152, hrv: 41, spo2: 97, temp: 37.2, ax: 0.1, ay: -0.2, az: 9.8, gx: 0.01, gy: 0.02, gz: 0.03, lat: 52.5, lon: 13.4, speed: 8, x: 50, y: 30, rr: [812, 798, 805, 790] },
    }));
    expect(bodyShapeBreach({ packets })).toBeNull();
  });

  it('a provisioning batch at its declared maximum (1,000 serials) and a notification fan-out (500 users)', () => {
    expect(bodyShapeBreach({ model: 'FAM-W1', serials: Array.from({ length: 1000 }, (_, i) => `SN-${i}`), metadata: { batch: 7 } })).toBeNull();
    expect(bodyShapeBreach({ userIds: Array.from({ length: 500 }, () => '00000000-0000-4000-8000-000000000000'), title: 't' })).toBeNull();
  });

  it('is several times the largest declared bound reachable through the JSON parser, so no declared request is refused', () => {
    expect(L.maxArrayLength).toBeGreaterThanOrEqual(5 * 1000);
    expect(L.maxValues).toBeGreaterThanOrEqual(5 * 8_500);
  });
});

// ── 4. The bound it gives every schema ──────────────────────────────────────
describe('under the guard, the issues a schema can build are bounded', () => {
  it('the most adversarial accepted bodies yield at most maxValues issues', () => {
    const arrays = Math.floor((L.maxValues - 1) / (L.maxArrayLength + 1));
    const body = Object.fromEntries(Array.from({ length: arrays }, (_, i) => [`a${i}`, zeros(L.maxArrayLength)]));
    expect(bodyShapeBreach(body)).toBeNull();
    const schema = z.object(Object.fromEntries(Object.keys(body).map((k) => [k, z.array(z.string())])));
    const r = schema.safeParse(body);
    expect(!r.success && r.error.issues.length).toBeLessThanOrEqual(L.maxValues);
    const objs = Array.from({ length: Math.floor((L.maxValues - 1) / 10) }, () => ({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0, h: 0, i: 0 }));
    expect(bodyShapeBreach(objs)).toBeNull();
    const r2 = z.array(z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string(), f: z.string(), g: z.string(), h: z.string(), i: z.string() })).safeParse(objs);
    expect(!r2.success && r2.error.issues.length).toBeLessThanOrEqual(L.maxValues);
  });
});

// ── 5. In the application ───────────────────────────────────────────────────
describe('in the application', () => {
  let app: Application;
  beforeAll(() => { app = createApp(); });

  it('refuses an oversized body 413 before routing and before auth, on a route that validates with zod', async () => {
    const res = await request(app).post('/api/v1/training/sessions').set('content-type', 'application/json')
      .send(JSON.stringify({ title: 'x', playerIds: zeros(600_000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, message: 'The request body holds a list longer than any request accepts.' });
  });

  it('control: the same route with an ordinary body is not refused by the guard (auth answers instead)', async () => {
    const res = await request(app).post('/api/v1/training/sessions').send({ title: 'x', playerIds: [] });
    expect(res.status).toBe(401);
  });

  it('leaves a signed raw body to its verifier: a large Buffer on the billing webhook is not refused by the guard', async () => {
    const res = await request(app).post('/api/v1/billing/webhook').set('content-type', 'application/json')
      .send(JSON.stringify(zeros(10_000)));
    expect(res.status).not.toBe(413);
  });

  it('a form body past the urlencoded parser\'s own limit is refused by that parser, before any route or auth', async () => {
    const res = await request(app).post('/api/v1/training/sessions').set('content-type', 'application/x-www-form-urlencoded')
      .send(Array.from({ length: 1500 }, (_, i) => `a=${i}`).join('&'));
    // The parser refuses it (413 parameters.too.many); the application's error handler currently answers that as 500,
    // a status mapping outside this change. Either way no route and no schema sees it: auth would have said 401.
    expect(res.status).toBeGreaterThanOrEqual(413);
    expect(res.status).not.toBe(401);
  });

  it('is mounted after both body parsers and before the first route, the edge limiter and auth', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.ts'), 'utf8');
    const at = (s: string) => { const i = src.indexOf(s); if (i < 0) throw new Error(`${s} not found`); return i; };
    const guard = at('app.use(bodyShapeGuard());');
    expect(guard).toBeGreaterThan(at("app.use(express.json({ limit: '2mb' }));"));
    expect(guard).toBeGreaterThan(at('app.use(express.urlencoded({ extended: true }));'));
    expect(src.match(/bodyShapeGuard\(\)/g)).toHaveLength(1);
    const firstRoute = Math.min(...[...src.matchAll(/app\.use\('\/api/g)].map((m) => m.index as number));
    expect(guard).toBeLessThan(firstRoute);
  });
});
