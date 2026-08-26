/**
 * tests/request-scalability.unit.test.ts
 *
 * The request architecture, from login to module navigation.
 *
 * A single developer doing ordinary navigation was intermittently answered
 * HTTP 429. The cause was not volume — a session is about sixty API calls over
 * a minute — but a blanket limiter of a hundred requests per fifteen minutes
 * per address, mounted in front of the purpose-built three-tier limiter and
 * counting every route, asset and health probe. Two laps exhausted a
 * fifteen-minute budget.
 *
 * What is asserted here:
 *   · the blanket limiter is gone, and what replaced it is narrow, keyed by
 *     identity rather than address, and skips health and non-API traffic;
 *   · the per-IP bucket applies to anonymous traffic only, so the number of
 *     colleagues behind one office address is not a scaling ceiling;
 *   · the limiter can identify the caller — it runs before `authenticate`, so
 *     without reading the token the user and tenant buckets were unreachable;
 *   · the credential bucket is scoped to credential endpoints, is counted per
 *     account, and charges the address only for attempts that FAIL;
 *   · every 429 carries Retry-After;
 *   · the client joins an identical GET already in flight rather than repeating
 *     it, holds a read briefly, drops everything on a write and on logout;
 *   · a 429 is retried once, after the server's own Retry-After, exponentially;
 *   · navigation abandons what the screen being left was waiting on;
 *   · the workspace bootstrap does not hydrate a module nobody opened, and a
 *     module's hydration is coalesced rather than re-fired on every entry;
 *   · the identity lookup that ran on every request is held briefly and
 *     dropped the moment anything changes who a user is.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP  = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const SRC  = (p: string) => readFileSync(join(__dirname, '..', 'src', p), 'utf8');
const APPTS = SRC('app.ts');
const RL    = SRC('middleware/rate-limit.middleware.ts');
const AUTH  = SRC('middleware/auth.middleware.ts');

function fnBody(src: string, name: string) {
  const at = src.search(new RegExp(`(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  const i = src.indexOf('{', at);
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(i, j);
}

describe('the edge guard', () => {
  it('no longer counts a hundred requests per fifteen minutes across everything', () => {
    // the blanket limiter took its window and ceiling straight from config
    expect(APPTS).not.toContain('windowMs: config.rateLimit.windowMs');
    expect(APPTS).not.toContain('max: config.rateLimit.max');
  });

  it('is narrow: API only, never health, never a page load', () => {
    expect(APPTS).toContain("!req.path.startsWith('/api/')");
    expect(APPTS).toContain("req.path === '/api/health'");
    expect(APPTS).toContain("req.path === '/api/v1/health'");
  });

  it('and is keyed by who is asking, not by where from', () => {
    expect(APPTS).toContain('keyGenerator: edgeIdentity');
    const k = fnBody(RL, 'edgeIdentity');
    expect(k).toContain('identify(req)');
    expect(k).toContain('`u:${who.sub}`');
    expect(k).toContain('`ip:${ipOf(req)}`');
  });

  it('and it answers 429 with Retry-After', () => {
    expect(APPTS).toContain("res.setHeader('Retry-After'");
  });
});

describe('the three-tier limiter', () => {
  it('can identify the caller, which it could not before', () => {
    // it runs before `authenticate`, so req.user is empty; without reading the
    // token the user and tenant buckets were never reached
    const id = fnBody(RL, 'identify');
    expect(id).toContain('jwt.verify');
    expect(id).toContain('access_token');
    expect(id).toContain("Bearer ");
    expect(fnBody(RL, 'rateLimit')).toContain('identify(req)');
  });

  it('applies the address bucket to anonymous traffic only', () => {
    const f = fnBody(RL, 'rateLimit');
    expect(f).toContain('if (!userId) {');
    expect(f).toContain('`ip:${ip}`');
    // and an authenticated request is limited by who and by which club
    expect(f).toContain('`user:${userId}`');
    expect(f).toContain('`tenant:${clubId}`');
  });

  it('and every refusal says when to come back', () => {
    const d = fnBody(RL, 'deny');
    expect(d).toContain("res.setHeader('Retry-After'");
    expect(d).toContain('Math.ceil(refillMs / 1000)');
    expect(d).toContain('retryAfterSec');
    // every branch denies through it
    const f = fnBody(RL, 'rateLimit');
    expect(f).not.toMatch(/res\.status\(429\)/);
  });
});

describe('the credential bucket stays tight, and stays a security control', () => {
  it('covers only the endpoints that take a credential', () => {
    expect(RL).toContain("'/login', '/register', '/forgot-password', '/reset-password',");
    const f = fnBody(RL, 'rateLimitAuth');
    expect(f).toContain('CREDENTIAL_PATHS.has(path)');
    // /auth/refresh and /auth/me are ordinary session traffic and fall through
    expect(f).toContain('return next();');
  });

  it('counts per account, which is what an attack actually looks like', () => {
    const f = fnBody(RL, 'rateLimitAuth');
    expect(f).toContain('`acct:${email}`');
    expect(f).toContain('ACCOUNT_CAPACITY');
  });

  it('and charges an address only for attempts that fail', () => {
    const f = fnBody(RL, 'rateLimitAuth');
    expect(f).toContain('store.peek');
    expect(f).toContain("res.on('finish'");
    expect(f).toContain('res.statusCode >= 400');
    // the ceiling is still enforced — peek only avoids spending on success
    expect(f).toContain('`auth:${ip}`');
  });

  it('and the store can answer without spending', () => {
    expect(SRC('middleware/rate-limit-store.ts')).toContain('peek?(key: string');
    expect(SRC('middleware/rate-limit-memory.store.ts')).toContain('peek(key: string');
  });
});

describe('the client stops asking the same question twice', () => {
  const req = fnBody(APP, 'request');

  it('joins a GET already in flight instead of repeating it', () => {
    expect(req).toContain('_inflight.get(key)');
    expect(req).toContain('_inflight.set(key, run)');
    expect(APP).toContain("netLog('join'");
  });

  it('holds a read for a moment, so a second module reads what the first fetched', () => {
    expect(req).toContain('_cache.get(key)');
    expect(req).toContain('READ_TTL_MS');
    expect(APP).toContain('const READ_TTL_MS = 4000;');
  });

  it('never shares or replays a write, and a write drops every held read', () => {
    expect(req).toContain("if (method !== 'GET')");
    expect(req).toContain('invalidateReadCache()');
  });

  it('and a session\'s reads do not survive it', () => {
    expect(fnBody(APP, 'doLogout')).toContain('FamilistaAPI.invalidateReadCache()');
  });

  it('the Squad\'s own client shares the same transport for reads', () => {
    expect(APP).toContain("if (method === 'GET' && typeof FamilistaAPI !== 'undefined' && FamilistaAPI.request)");
  });
});

describe('a 429 is not answered by asking harder', () => {
  it('waits the server\'s own Retry-After, and exponentially otherwise', () => {
    const w = fnBody(APP, '_waitFor');
    expect(w).toContain('err.status === 429');
    expect(w).toContain('retryAfterSec');
    expect(w).toContain('Math.pow(2, attempt - 1)');
  });

  it('and retries a refusal once, never three times', () => {
    const a = fnBody(APP, 'attemptRequest');
    expect(a).toContain('sawRateLimit');
    expect(a).toContain('if (sawRateLimit) throw err;');
  });
});

describe('work nobody will read is abandoned', () => {
  it('navigation starts a new generation and aborts the previous screen\'s reads', () => {
    expect(fnBody(APP, 'newGeneration')).toContain('c.abort()');
    expect(fnBody(APP, 'navTo')).toContain('FamilistaAPI.newGeneration()');
  });

  it('and only cancellable reads are enrolled — a write is never abandoned', () => {
    const f = fnBody(APP, 'rawFetch');
    expect(f).toContain("const cancellable = method === 'GET'");
    expect(f).toContain('_live.add(controller)');
    expect(f).toContain('_live.delete(controller)');
  });
});

describe('no module hydrates another, and none hydrates itself twice', () => {
  it('opening a club no longer fires the Transfers hydration', () => {
    // the bootstrap used to call _tfSyncAll for a module nobody had opened
    const boot = APP.slice(0, APP.indexOf('function navTo'));
    expect(boot).not.toContain('if (typeof _tfSyncAll === \'function\') _tfSyncAll();');
  });

  it('and re-entering a module joins the hydration rather than re-firing it', () => {
    const w = fnBody(APP, '_tfSyncAll');
    expect(w).toContain('if (_TF_SYNC.run) return _TF_SYNC.run;');
    expect(w).toContain('Date.now() - _TF_SYNC.at < TF_SYNC_FRESH_MS');
  });

  it('but a write forces a real re-read', () => {
    expect(fnBody(APP, '_tfSyncAll')).toContain('opts.force');
    expect(APP).toContain('_tfSyncAll({ force: true })');
  });
});

describe('the same row is not read forty times a lap', () => {
  it('the identity lookup on every request is held briefly', () => {
    expect(AUTH).toContain('const user = await loadIdentity(payload.sub);');
    const f = fnBody(AUTH, 'loadIdentity');
    expect(f).toContain('IDENTITY_TTL_MS');
    expect(f).toContain('identityCache.get(userId)');
    // and concurrent hydration shares one read rather than racing
    expect(f).toContain('identityInflight.get(userId)');
  });

  it('the cache is bounded', () => {
    expect(fnBody(AUTH, 'loadIdentity')).toContain('IDENTITY_MAX');
  });

  it('and it is dropped the moment anything changes who a user is', () => {
    expect(AUTH).toContain('export function forgetIdentity');
    // deactivation, password change, context switch, staff edit
    expect(SRC('services/admin-management.service.ts')).toContain('forgetIdentity(userId)');
    expect(SRC('services/auth.service.ts')).toContain('forgetIdentity(userId)');
    expect(SRC('services/context.service.ts')).toContain('forgetIdentity(actor.userId)');
    expect(SRC('staff-market/staff-market.service.ts')).toContain('forgetIdentity(staffUserId)');
  });
});
