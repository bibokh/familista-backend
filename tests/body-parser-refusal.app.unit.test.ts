/**
 * A body the parsers refuse is answered as the client fault it is, not as a 500.
 *
 * express.json({ limit: '2mb' }) refuses an oversized body with an http-errors error (413, type 'entity.too.large'),
 * and a body that is not JSON with another (400, 'entity.parse.failed'). The error handler had no case for either,
 * so both fell through to its catch-all: every route answered HTTP 500, and the error reporter logged it at error,
 * with the parser's message, which on Node 20+ quotes the body it failed on.
 *
 * Pinned against the real application (createApp):
 *   1. a body past the limit is 413 { success: false, message: 'Request body too large' }, on any route, before auth;
 *   2. malformed JSON is 400 with a fixed message, and nothing the client sent is echoed or logged;
 *   3. the other client refusals (a form past 1,000 fields, an unsupported charset or encoding) keep their 4xx;
 *   4. controls: an ordinary body, and one just under the limit, still reach the route and succeed;
 *   5. each refusal is logged at warn, never at error.
 * And the classifier on its own: only a listed type with a 4xx status is a refusal.
 */

import request from 'supertest';
import type { Application } from 'express';

jest.mock('../src/config/database', () => require('./helpers/stub-database').stubDatabase({
  id: '00000000-0000-0000-0000-000000000002',
  clubId: '00000000-0000-0000-0000-000000000001',
  role: 'CLUB_ADMIN',
}));

import { createApp } from '../src/app';
import { logger } from '../src/utils/logger';
import { AppError } from '../src/utils/errors';
import { bodyParserRefusal } from '../src/middleware/body-parser-refusal';

/** express.json's '2mb', as the `bytes` package reads it. */
const LIMIT = 2 * 1024 * 1024;
/** A route that answers 200 with no session and no database: the control. */
const OPEN = '/api/v1/auth/logout';
/** A route behind auth: a refusal must come before it. */
const GUARDED = '/api/v1/training/sessions';
const SECRET = 'hunter2-do-not-log';

const json = (app: Application, path: string, body: string) =>
  request(app).post(path).set('content-type', 'application/json').send(body);

/** A JSON object whose serialised length is exactly `bytes`. */
const bodyOf = (bytes: number) => {
  const shell = JSON.stringify({ pad: '' }).length;
  return JSON.stringify({ pad: 'x'.repeat(bytes - shell) });
};

let app: Application;
beforeAll(() => { app = createApp(); });

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(logger, 'warn');
  error = jest.spyOn(logger, 'error');
});
afterEach(() => jest.restoreAllMocks());

const logged = (spy: jest.SpyInstance) => JSON.stringify(spy.mock.calls);

// ── 1. Past the limit ───────────────────────────────────────────────────────
describe('a JSON body past the 2 MB limit', () => {
  it('is 413 { success: false, message: "Request body too large" } — a 3 MB string field', async () => {
    const res = await json(app, OPEN, JSON.stringify({ name: 'x'.repeat(3 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, message: 'Request body too large' });
  });

  it('is 413 one byte past the limit', async () => {
    const res = await json(app, OPEN, bodyOf(LIMIT + 1));
    expect(res.status).toBe(413);
  });

  it('is 413 on a route behind auth: the parser refuses it before auth would have said 401', async () => {
    const res = await json(app, GUARDED, bodyOf(LIMIT + 1024));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, message: 'Request body too large' });
  });
});

// ── 2. Malformed JSON ───────────────────────────────────────────────────────
describe('a body that is not JSON', () => {
  it('is 400 { success: false, message: "Malformed request body" }', async () => {
    const res = await json(app, OPEN, `{"password":"${SECRET}" x`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Malformed request body' });
  });

  it('echoes none of the body, in the response or any log line — though the parser\'s own message quotes it', async () => {
    // The negative control for the redaction: Node's message does carry the text, so a log of it would leak.
    expect(() => JSON.parse(SECRET)).toThrow(SECRET);

    const res = await json(app, OPEN, SECRET);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(SECRET);
    expect(logged(warn)).not.toContain(SECRET);
    expect(logged(error)).not.toContain(SECRET);
  });
});

// ── 3. The other client refusals ────────────────────────────────────────────
describe('the other refusals the parsers make', () => {
  it('a form body past 1,000 fields is 413', async () => {
    const res = await request(app).post(GUARDED).set('content-type', 'application/x-www-form-urlencoded')
      .send(Array.from({ length: 1500 }, (_, i) => `a=${i}`).join('&'));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ success: false, message: 'Request body has too many parameters' });
  });

  it('a charset the JSON parser does not read is 415', async () => {
    const res = await request(app).post(OPEN).set('content-type', 'application/json; charset=iso-8859-1').send('{}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ success: false, message: 'Unsupported request body charset' });
  });

  it('a content encoding the parser cannot inflate is 415', async () => {
    const res = await request(app).post(OPEN).set('content-type', 'application/json')
      .set('content-encoding', 'compress').send('{}');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ success: false, message: 'Unsupported request body encoding' });
  });
});

// ── 4. Controls ─────────────────────────────────────────────────────────────
describe('controls: a body the parser accepts still reaches the route', () => {
  it('an ordinary body succeeds', async () => {
    const res = await json(app, OPEN, JSON.stringify({ note: 'ordinary' }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('a body exactly at the limit succeeds', async () => {
    const res = await json(app, OPEN, bodyOf(LIMIT));
    expect(res.status).toBe(200);
  });

  it('a route behind auth, given an ordinary body, answers with auth (401), not a parser refusal', async () => {
    const res = await json(app, GUARDED, JSON.stringify({ title: 'x', playerIds: [] }));
    expect(res.status).toBe(401);
  });
});

// ── 5. What is logged ───────────────────────────────────────────────────────
describe('a refusal in the logs', () => {
  it('is a warn naming the refusal and its sizes, and nothing at error', async () => {
    await json(app, OPEN, bodyOf(LIMIT + 1));
    expect(warn).toHaveBeenCalledWith('Request body refused', expect.objectContaining({
      type: 'entity.too.large', statusCode: 413, path: OPEN, method: 'POST', limit: LIMIT, length: LIMIT + 1,
    }));
    expect(warn).toHaveBeenCalledWith('http.error', expect.objectContaining({
      status: 413, err: expect.objectContaining({ message: 'Request body too large', code: 'entity.too.large', stack: undefined }),
    }));
    expect(error).not.toHaveBeenCalled();
  });

  it('control: a server fault is still reported at error', () => {
    const { errorReporter } = require('../src/middleware/request-id.middleware');
    const req = { method: 'GET', originalUrl: '/api/v1/x', headers: {}, ip: '127.0.0.1' };
    errorReporter(Object.assign(new Error('boom'), { statusCode: 500 }), req, {}, () => undefined);
    expect(error).toHaveBeenCalledWith('http.error', expect.objectContaining({ status: 500 }));
  });
});

// ── The classifier ──────────────────────────────────────────────────────────
describe('bodyParserRefusal', () => {
  const httpError = (status: number, type: string) => Object.assign(new Error('parser text'), { status, statusCode: status, expose: true, type });

  it('maps each client refusal to its status and a fixed message that is not the parser\'s', () => {
    const cases: Array<[string, number]> = [
      ['entity.too.large', 413], ['parameters.too.many', 413], ['entity.parse.failed', 400],
      ['request.size.invalid', 400], ['request.aborted', 400], ['charset.unsupported', 415], ['encoding.unsupported', 415],
    ];
    for (const [type, status] of cases) {
      const r = bodyParserRefusal(httpError(status, type));
      expect(r).toEqual({ type, status, message: expect.any(String) });
      expect(r!.message).not.toBe('parser text');
    }
  });

  it('leaves everything else to the handlers after it', () => {
    expect(bodyParserRefusal(httpError(500, 'stream.encoding.set'))).toBeNull();  // a server misconfiguration
    expect(bodyParserRefusal(httpError(500, 'entity.too.large'))).toBeNull();     // a listed type without a 4xx
    expect(bodyParserRefusal(Object.assign(new Error('x'), { type: 'entity.too.large' }))).toBeNull(); // no status
    expect(bodyParserRefusal(new AppError('nope', 413))).toBeNull();
    expect(bodyParserRefusal(new Error('boom'))).toBeNull();
    expect(bodyParserRefusal(null)).toBeNull();
    expect(bodyParserRefusal('entity.too.large')).toBeNull();
  });
});
