/**
 * tests/api-cancellation.unit.test.ts
 *
 * A navigation that abandons a read is not a timeout.
 *
 * Navigation aborts the reads the screen being left was waiting on
 * (FamilistaAPI.newGeneration). The aborted fetch rejects with an AbortError,
 * and the client used to read every AbortError as its own timer firing: the read
 * became a TIMEOUT, "Connection timeout. The server is taking too long to
 * respond." went up in the backend banner, and the backend was marked unhealthy
 * (so the next requests waited for the 60 s cold-start timeout). In production
 * that happened on every deep link to an owner room (#neural-twin,
 * #agents-room, #infrastructure-city): startup displaces the route with the
 * landing, the deep-link repair navigates back, and that navigation abandoned
 * startup's own /me/context or /teams read, with the server answering normally.
 *
 * These tests run the client's own code from public/app.js, unchanged, in a VM
 * with a fetch that behaves as the browser's does, and prove:
 *   · a navigation's abort is ABORTED: no banner, the backend stays healthy, no
 *     TIMEOUT in telemetry, and the read is re-issued as before, so nothing that
 *     relied on that loses its data;
 *   · the control: the client's own timer still produces TIMEOUT, the banner
 *     with its message, and the unhealthy mark, as before;
 *   · the timeouts and the retry policy are the ones that were there.
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const APP = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
// The client, verbatim: the error type, both mappings, the logger and the FamilistaAPI module.
const CLIENT = APP.slice(APP.indexOf('class ApiError extends Error'), APP.indexOf('const BackendHealth = (function'));

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<unknown>;

function load(fetchImpl: Fetch) {
  const banner: string[] = [];
  const telemetry: string[] = [];
  const calls: string[] = [];
  const State = { token: 't', backendHealthy: true as boolean | null };
  const sandbox: Record<string, unknown> = {
    window: { FamTelemetry: { error: (c: string) => telemetry.push(c) } },
    navigator: { onLine: true },
    State,
    FAM_CONFIG: { API_BASE: '/api/v1', REQUEST_TIMEOUT_MS: 40, COLD_START_TIMEOUT_MS: 60, RETRY_COUNT: 2, RETRY_BACKOFF_MS: 5, RETRYABLE_STATUSES: [0, 408, 425, 429, 502, 503, 504] },
    BackendHealth: { notifyOffline: (err: { userMessage?: string }) => banner.push(String(err && err.userMessage)) },
    fetch: (url: string, init: { signal: AbortSignal }) => { calls.push(url); return fetchImpl(url, init); },
    AbortController, setTimeout, clearTimeout, console, Promise, Date, Math, JSON, Error, TypeError, Map, Set, Array, Object, String, Number,
  };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT + '\n;this.__api = FamilistaAPI; this.__map = mapApiError;', sandbox);
  return { api: sandbox.__api as { get: (p: string, o?: object) => Promise<unknown>; newGeneration: () => number }, map: sandbox.__map as (e: unknown, c: object) => { code: string; userMessage: string }, banner, telemetry, calls, State };
}

/** The browser's fetch: answers after `ms`, or rejects with an AbortError the moment its signal aborts. */
const answersAfter = (ms: number, body: unknown) => (_url: string, init: { signal: AbortSignal }) => new Promise((resolve, reject) => {
  const t = setTimeout(() => resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) }), ms);
  init.signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('The user aborted a request.'); e.name = 'AbortError'; reject(e); });
});

describe('a navigation that abandons a read is not a timeout', () => {
  it('ABORTED: no banner, the backend stays healthy, no TIMEOUT reported, and the read is re-issued as before', async () => {
    const c = load(answersAfter(15, { data: { ok: true } }));
    const read = c.api.get('/me/context');
    await new Promise((r) => setTimeout(r, 3));
    c.api.newGeneration();                    // the deep-link repair navigates while the read is in flight
    await expect(read).resolves.toEqual({ data: { ok: true } });
    expect(c.calls).toEqual(['/api/v1/me/context', '/api/v1/me/context']);
    expect(c.banner).toEqual([]);
    expect(c.State.backendHealthy).toBe(true);
    expect(c.telemetry).not.toContain('TIMEOUT');
    expect(c.telemetry).not.toContain('ABORTED');
  });

  it('control: the client\'s own timer is still a TIMEOUT, with the banner, its message and the unhealthy mark', async () => {
    const c = load(answersAfter(10_000, {}));   // the server never answers inside the timeout
    await expect(c.api.get('/teams')).rejects.toMatchObject({ code: 'TIMEOUT', userMessage: 'Connection timeout. The server is taking too long to respond.' });
    expect(c.calls.length).toBe(3);             // 1 + RETRY_COUNT, as before
    // raised on each failed attempt (BackendHealth paints it once and ignores the rest), always with this message
    expect(c.banner.length).toBeGreaterThan(0);
    expect([...new Set(c.banner)]).toEqual(['Connection timeout. The server is taking too long to respond.']);
    expect(c.State.backendHealthy).toBe(false);
    expect(c.telemetry).toContain('TIMEOUT');
  });

  it('classifies by cause: the timer\'s abort, any other abort, and a network failure', () => {
    const c = load(answersAfter(1, {}));
    const timer = Object.assign(new Error('AbortError'), { name: 'AbortError', timedOut: true });
    const nav = Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
    expect(c.map(timer, { url: '/x' }).code).toBe('TIMEOUT');
    expect(c.map(nav, { url: '/x' })).toMatchObject({ code: 'ABORTED', userMessage: 'Request cancelled' });
    expect(c.map(new TypeError('Failed to fetch'), { url: '/x' }).code).toBe('NETWORK');
  });

  // Every other failure is reported exactly as before: the same code, message, attempts, banner and health mark.
  // (Measured identical against main's app.js for each of these before the fix; only the navigation abort changed.)
  const reply = (status: number, body: object = {}) => () => Promise.resolve({ ok: false, status, text: async () => JSON.stringify(body) });
  it.each([
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'NETWORK', 'Backend waking up… Please retry in a few seconds.', 3, true],
    ['HTTP 503', reply(503, { message: 'down' }), 'SERVER', 'Server unavailable. The backend may be restarting — please retry in 30s.', 3, true],
    ['HTTP 504', reply(504), 'TIMEOUT', 'Connection timeout. Please retry.', 3, true],
    ['HTTP 500', reply(500, { message: 'boom' }), 'SERVER', 'Server error. Please retry shortly.', 1, false],
    ['HTTP 401, the refresh refused', reply(401, { message: 'No token provided' }), 'AUTH', 'No token provided', 2, false],
    ['HTTP 403', reply(403, { message: 'Forbidden' }), 'FORBIDDEN', 'Forbidden', 1, false],
    ['HTTP 404', reply(404), 'NOT_FOUND', 'The requested resource was not found.', 1, false],
  ] as const)('%s is still reported as it was', async (_n, f, code, msg, attempts, banner) => {
    const c = load(f as unknown as Fetch);
    await expect(c.api.get('/x')).rejects.toMatchObject({ code, userMessage: msg });
    expect(c.calls.length).toBe(attempts);
    expect(c.banner.length > 0).toBe(banner);
    if (banner) expect([...new Set(c.banner)]).toEqual([msg]);
    expect(c.State.backendHealthy).toBe(!banner);
    expect(c.telemetry).toContain(code);
  });

  it('keeps the timeouts and the retry policy it had: nothing was changed to hide the warning', () => {
    expect(APP).toMatch(/REQUEST_TIMEOUT_MS:\s+20000,/);
    expect(APP).toMatch(/COLD_START_TIMEOUT_MS:\s+60000,/);
    expect(APP).toMatch(/RETRY_COUNT:\s+2,/);
    expect(APP).toMatch(/RETRYABLE_STATUSES:\s+\[0, 408, 425, 429, 502, 503, 504\]/);
    // the banner still goes up for a network failure, a timeout and a gateway error, and only for those
    expect(CLIENT).toContain("if (err.code === 'NETWORK' || err.code === 'TIMEOUT' || err.status >= 502) {");
    expect(CLIENT).toContain('e.timedOut = true;');
  });
});
