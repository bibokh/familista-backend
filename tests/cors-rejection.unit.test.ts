/**
 * Cyber Defense · Step 3 — a refused browser origin is a 403, not a server error
 *
 * The CORS origin callback used to hand Express a bare `Error`. The error
 * handler treats an unknown error as a programming fault, so an origin outside
 * the allowlist was answered with HTTP 500, logged as "Unexpected error" with a
 * stack, and counted by the Infrastructure City meter as an application-service
 * failure — a stranger's browser could raise the platform's error rate at will.
 *
 * A refused origin is now an `OriginNotAllowedError`: a 403, handled as an
 * operational refusal, and never counted as a service failure. What an allowed
 * origin or a request with no Origin receives is unchanged, and so is the set of
 * allowed origins.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://u:p@localhost:5432/db';
process.env.DIRECT_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? 'a'.repeat(48);
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? 'b'.repeat(48);

jest.mock('../src/config/database', () => ({
  prisma: new Proxy({}, {
    get: (_t, k: string) => {
      if (k === '$queryRaw' || k === '$executeRaw') return async () => [{ ok: 1 }];
      if (k === '$connect' || k === '$disconnect') return async () => {};
      return new Proxy({}, { get: () => async () => null });
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const request = require('supertest');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createApp } = require('../src/app');
import { onError } from '../src/middleware/request-id.middleware';
import { apiTraffic, resetApiTraffic } from '../src/infra/api-traffic';
import { AppError, ForbiddenError, OriginNotAllowedError } from '../src/utils/errors';

const ALLOWED = 'https://familista-v5.onrender.com';
const STRANGER = 'https://attacker.example';

describe('a request from an origin outside the allowlist', () => {
  const app = createApp();
  const reported: Array<{ status: number }> = [];
  onError((frame) => { reported.push({ status: frame.status }); });

  beforeEach(() => { reported.length = 0; resetApiTraffic(); });

  it('is refused with 403, not 500', async () => {
    const res = await request(app).get('/healthz').set('Origin', STRANGER);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, message: 'Origin not allowed' });
  });

  it('is refused on a preflight too, without any CORS grant', async () => {
    const res = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', STRANGER)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('carries no error-class debug headers and does not echo the origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', STRANGER);
    expect(res.headers['x-error-type']).toBeUndefined();
    expect(res.headers['x-error-code']).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('attacker.example');
  });

  it('is reported as a 403 and never counted as an application-service failure', async () => {
    await request(app).get('/healthz').set('Origin', STRANGER);
    await request(app).get('/api/v1/billing/plans').set('Origin', STRANGER);
    expect(reported.map((r) => r.status)).toEqual([403, 403]);
    const traffic = apiTraffic();
    expect(traffic.unhandledErrors).toBe(0);
    expect(traffic.serverErrors).toBe(0);
  });
});

describe('what the allowlist lets through is unchanged', () => {
  const app = createApp();

  it('an allowed origin gets its origin and credentials granted', async () => {
    const res = await request(app).get('/healthz').set('Origin', ALLOWED);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('an allowed preflight still succeeds with the declared methods and headers', async () => {
    const res = await request(app)
      .options('/api/v1/auth/login')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-request-id');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type,Authorization,x-club-id,x-request-id');
  });

  it('a request with no Origin (server-to-server, health probes) is not affected', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OriginNotAllowedError', () => {
  it('is an operational 403', () => {
    const e = new OriginNotAllowedError();
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(e).toBeInstanceOf(AppError);
    expect(e.statusCode).toBe(403);
    expect(e.isOperational).toBe(true);
    expect(e.message).toBe('Origin not allowed');
  });
});
