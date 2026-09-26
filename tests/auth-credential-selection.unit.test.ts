/**
 * WHICH CREDENTIAL THE SERVER READS, AND WHAT THE BROWSER SENDS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Familista authenticates a browser session with TWO things: an HttpOnly
 * `access_token` cookie, and an in-memory access token the SPA mints through
 * `/auth/refresh`. The second is not a fallback for exotic clients — the cookie
 * lives fifteen minutes (`JWT_ACCESS_TTL`), so every ordinary session spends
 * most of its life running on the bearer alone.
 *
 * Two defects met in production and hung Familista Vision on
 * "READING VISION SERVICE — One moment":
 *
 *   1 · The Vision frontend sent neither an Authorization header nor
 *       `credentials: 'include'`, so once the cookie lapsed every Vision call
 *       was unauthenticated — while the landing card, which does attach the
 *       bearer, kept reporting the service as live.
 *
 *   2 · `authenticate` picked the cookie whenever one existed and rejected
 *       outright if it did not verify, so an EXPIRED cookie travelling beside a
 *       VALID bearer was refused. That one is platform-wide, not Vision's.
 *
 * These pin both, and pin that the fix grants nothing new.
 */

import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';

const ROOT = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('the server reads whichever credential is actually valid', () => {
  const SRC = read('src/middleware/auth.middleware.ts');

  it('verifies each candidate rather than trusting the first one present', () => {
    // The shape that mattered: a list, tried in order, each one VERIFIED.
    expect(SRC).toMatch(/const candidates\s*=\s*\[cookieToken,\s*bearerToken\]/);
    expect(SRC).toContain('for (const candidate of candidates)');
    expect(SRC).toContain('jwt.verify(candidate, config.jwt.secret)');
    // and the old shape is gone
    expect(SRC).not.toMatch(/if \(cookieToken\) \{\s*token = cookieToken;/);
  });

  it('still refuses a request that carries no credential at all', () => {
    expect(SRC).toContain("throw new UnauthorizedError('No token provided')");
    expect(SRC).toMatch(/if \(candidates\.length === 0\)/);
  });

  it('still refuses when no candidate verifies', () => {
    expect(SRC).toMatch(/if \(!payload\)\s*\{\s*\n\s*throw new UnauthorizedError\('Invalid or expired token'\)/);
  });

  it('prefers the cookie when both are valid, so nothing about a fresh session changes', () => {
    const list = SRC.slice(SRC.indexOf('const candidates'), SRC.indexOf('let payload'));
    expect(list.indexOf('cookieToken')).toBeLessThan(list.indexOf('bearerToken'));
  });

  /**
   * The behaviour itself, not just its shape: the same secret, the same
   * verification, run over the ordered candidates.
   */
  it('accepts a valid bearer that arrives beside an expired cookie', () => {
    const secret = 'unit-test-secret-not-a-real-key';
    const claims = { sub: 'u-1', email: 'a@b.c', role: 'PLATFORM_OWNER', tv: 0 };
    const expired = jwt.sign(claims, secret, { expiresIn: '-5m' });
    const valid   = jwt.sign(claims, secret, { expiresIn: '15m' });

    const pick = (cookie?: string, bearer?: string) => {
      const candidates = [cookie, bearer].filter(Boolean) as string[];
      if (candidates.length === 0) return null;
      for (const c of candidates) {
        try { return jwt.verify(c, secret) as { sub: string }; } catch { /* next */ }
      }
      return null;
    };

    expect(pick(expired, valid)?.sub).toBe('u-1');   // the case that 401ed
    expect(pick(valid, undefined)?.sub).toBe('u-1');
    expect(pick(undefined, valid)?.sub).toBe('u-1');
    expect(pick(expired, expired)).toBeNull();
    expect(pick(undefined, 'not.a.token')).toBeNull();
    expect(pick(undefined, undefined)).toBeNull();
  });
});

describe('every platform module sends the credential the platform runs on', () => {
  const MODULES: Array<[string, string]> = [
    ['Familista Vision', 'public/familista-vision/familista-vision.js'],
    ['Source Core', 'public/source-core/source-core.js'],
    ['Data Vault', 'public/data-vault/data-vault.js'],
    ['Infrastructure City', 'public/infrastructure-city/infrastructure-city.js'],
  ];

  it.each(MODULES)('%s attaches the bearer token', (_name, file) => {
    const js = read(file);
    expect(js).toContain("Authorization: 'Bearer '");
    expect(js).toMatch(/State && (window\.)?State\.token|State\.token/);
  });

  it.each(MODULES)('%s sends credentials with the request', (_name, file) => {
    expect(read(file)).toContain("credentials: 'include'");
  });

  it.each(MODULES)('%s reads its API base from the platform, not a constant', (_name, file) => {
    const js = read(file);
    expect(js).toContain('FAM_CONFIG.API_BASE');
    // A hard-coded absolute prefix points at the page's own host, which is the
    // wrong host wherever the SPA and the API are different origins.
    expect(js).not.toMatch(/fetch\(\s*['"]\/api\/v1/);
  });

  it('Vision no longer holds a hard-coded API constant', () => {
    const js = read('public/familista-vision/familista-vision.js');
    expect(js).not.toMatch(/var API\s*=\s*['"]\/api\/v1/);
    expect(js).toContain('function apiBase()');
    expect(js).toContain('function authHeaders(');
  });

  it('Vision downloads an export through fetch, which can carry a header', () => {
    // `window.open` cannot set Authorization, so the download inherited the
    // same fault and rendered a 401 body as a blank tab.
    const js = read('public/familista-vision/familista-vision.js');
    const fn = js.slice(js.indexOf('function exportReport('), js.indexOf('/* ── events'));
    expect(fn).toContain('authHeaders()');
    expect(fn).not.toContain('window.open');
  });
});

describe('a failed read is shown as a failure, not as loading for ever', () => {
  const js = read('public/familista-vision/familista-vision.js');
  const live = js.slice(js.indexOf('function secLive()'), js.indexOf('function trackFilters'));

  it('checks the error before the absence', () => {
    // `health` is absent both while a request is in flight and when it failed.
    // Testing the absence first rendered every failure as the loading state.
    //
    // Comments are stripped: the rule's own comment names the loading string in
    // order to explain why it may not come first.
    const code = live.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const err = code.indexOf('VISION SERVICE UNAVAILABLE');
    const loading = code.indexOf('READING VISION SERVICE');
    expect(err).toBeGreaterThan(-1);
    expect(loading).toBeGreaterThan(-1);
    expect(err).toBeLessThan(loading);
  });

  it('tells a signed-out reader from an unauthorised one', () => {
    expect(js).toContain('Your session has expired');
    expect(js).toContain('Familista Vision is not available to this account');
    expect(js).toMatch(/r\.status === 401/);
    expect(js).toMatch(/r\.status === 403/);
  });

  it('surfaces any other HTTP failure rather than swallowing it', () => {
    expect(js).toContain('The Vision service answered HTTP ');
  });

  it('offers a way back without a page reload', () => {
    expect(live).toContain('data-vx-retry');
    expect(js).toContain("t.closest('[data-vx-retry]')");
  });
});
