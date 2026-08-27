/**
 * tests/throughput-hardening.unit.test.ts
 *
 * Why one instance saturated at ~95 requests per second, and the three things
 * that were actually responsible.
 *
 *  1. A migration that could never apply. 20250525000000 altered
 *     VideoAsset."durationSec" — a column it does not create — and altered
 *     tables the baseline never creates at all. It failed with 42703/42P01,
 *     left an unfinished row in _prisma_migrations, and Prisma then refused
 *     every later migration, including the four that create StaffProfile. That
 *     is why /staff-market/discover answered 500 on every lap.
 *
 *  2. An N+1 that scaled with the platform. leadingCommitment read up to two
 *     hundred live listings and then asked, once per listing, who was leading
 *     it. /transfer-market/my-club cost 107 queries for a 0.4 kB response, and
 *     the same loop ran inside the settlement transaction.
 *
 *  3. bcrypt on the request thread. bcryptjs is pure JavaScript; at cost 12 one
 *     comparison is ~320ms of CPU, and on the request thread that stops the
 *     process answering anything at all for a third of a second. A hundred
 *     concurrent sign-ins were thirty-two seconds of blocked event loop — the
 *     p99 the load tests kept showing.
 *
 * Plus the connection pool, which defaulted to nine against a database
 * permitting a hundred.
 *
 * The work factor is NOT reduced anywhere here. bcrypt cost 12 is still cost
 * 12; what changed is which thread pays for it.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const root = (p: string) => join(__dirname, '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');

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

describe('the migration that blocked every migration after it', () => {
  const MIG = read('prisma/migrations/20250525000000_add_phase_q_and_password_reset/migration.sql');

  it('no longer alters a column it does not create', () => {
    // it altered VideoAsset."durationSec" unconditionally; that column is
    // created by neither this migration nor the baseline
    expect(MIG).not.toMatch(/^ALTER TABLE "VideoAsset" ALTER COLUMN "durationSec"/m);
    expect(MIG).toContain("AND column_name  = 'durationSec'");
  });

  it('and every statement it aims at a table the baseline never creates is guarded', () => {
    const base = read('prisma/migrations/00000000000000_baseline/migration.sql');
    const created = new Set(
      [...MIG.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"([A-Za-z]+)"/g)].map((m) => m[1]),
    );
    const have = (t: string) => base.includes(`"${t}"`) || created.has(t);

    // any ALTER or index at column 0 is unguarded; inside a DO block it is indented
    for (const m of MIG.matchAll(/^ALTER TABLE "([A-Za-z]+)"/gm)) {
      if (!have(m[1])) throw new Error(`unguarded ALTER on absent table: ${m[1]}`);
    }
    for (const m of MIG.matchAll(/^CREATE (?:UNIQUE )?INDEX [^\n]*? ON "([A-Za-z]+)"/gm)) {
      if (!have(m[1])) throw new Error(`unguarded INDEX on absent table: ${m[1]}`);
    }
  });

  it('and its enum creation is idempotent, since CREATE TYPE has no IF NOT EXISTS', () => {
    expect(MIG).not.toMatch(/^CREATE TYPE "/m);
    expect(MIG).toContain('SELECT 1 FROM pg_type WHERE typname');
  });
});

describe('the N+1 that scaled with the whole platform', () => {
  const AUC = read('src/transfer-market/transfer-auction.service.ts');
  const f = fnBody(AUC, 'leadingCommitment');

  it('reads every bid on the live listings in one query, not one query per listing', () => {
    expect(f).toContain('tx.transferBid.findMany');
    expect(f).not.toContain('tx.transferBid.findFirst');
    // no per-listing await inside a loop
    expect(f).not.toMatch(/for \(const l of live\)[\s\S]*await tx\./);
  });

  it('and keeps the tie-break it always had — highest wins, earliest wins a tie', () => {
    expect(f).toContain("orderBy: [{ amountEur: 'desc' }, { createdAt: 'asc' }]");
    expect(f).toContain('leaderSeen');
  });
});

describe('bcrypt is off the request thread, at the same cost', () => {
  const PW = read('src/utils/password.ts');

  it('the work factor is unchanged', () => {
    expect(PW).toContain("process.env.BCRYPT_ROUNDS ?? '12'");
  });

  it('prefers the native binding, whose async form releases the event loop', () => {
    expect(PW).toContain("require('bcrypt')");
    expect(PW).toContain('await native.compare(password, h)');
    expect(PW).toContain('await native.hash(password, rounds)');
    expect(JSON.parse(read('package.json')).dependencies.bcrypt).toBeTruthy();
  });

  it('and says so loudly if the binding did not build, rather than silently blocking', () => {
    expect(PW).toContain('native bcrypt unavailable');
  });

  it('falls back to a worker, then inline — never onto the request thread by surprise', () => {
    expect(PW).toContain("import { Worker } from 'worker_threads'");
    expect(PW).toContain('return bcryptjs.hash(password, rounds);');
    expect(PW).toContain('return bcryptjs.compare(password, h);');
    // bcryptjs stays a dependency precisely so the fallback exists
    expect(JSON.parse(read('package.json')).dependencies.bcryptjs).toBeTruthy();
  });

  it('normalises $2y$, which the native binding refuses outright', () => {
    // $2y$ is algorithmically identical to $2a$. Refusing it would be a lockout
    // for anyone whose hash came from a PHP-origin system.
    expect(PW).toContain("hash.startsWith('$2y$')");
    expect(PW).toContain("'$2a$' + hash.slice(4)");
    expect(fnBody(PW, 'verifyPassword')).toContain('normalise(hash)');
  });

  it('and libuv\'s pool is sized before anything can touch it', () => {
    const SRV = read('src/server.ts');
    const at = SRV.indexOf('UV_THREADPOOL_SIZE');
    const firstImport = SRV.indexOf("import http from 'http'");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(firstImport);
    expect(read('render.yaml')).toContain('UV_THREADPOOL_SIZE');
  });

  it('the worker exists and is shipped into dist by the build', () => {
    expect(existsSync(root('src/utils/password.worker.js'))).toBe(true);
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts.build).toContain('copy-runtime-assets');
    expect(read('scripts/copy-runtime-assets.js')).toContain('password.worker.js');
  });

  it('and every call site goes through it — no bcrypt left on a request path', () => {
    for (const f of ['src/services/auth.service.ts',
                     'src/services/password-reset.service.ts',
                     'src/launch/seed-fc-familista.service.ts']) {
      const s = read(f);
      expect(s).toContain("from '../utils/password'");
      expect(s).not.toMatch(/await bcrypt\.(hash|compare)\(/);
    }
  });

  it('the readiness of multi-process scaling is written down, not assumed', () => {
    const doc = read('docs/multi-process-readiness.md');
    // This used to assert "clustering is NOT safe yet", which was the honest
    // status when the prerequisites were only catalogued. They have since been
    // built, so the assertion now checks the thing that keeps the claim true:
    // clustering is gated on Redis actually answering, not merely configured.
    expect(doc).toContain('Clustering is safe when Redis is configured and answering');
    expect(doc).toContain('refuses to start when it is not');
    // and the three that were correctness or security problems are still named,
    // with where their state lives now
    expect(doc).toContain('rate-limit-redis.store.ts');
    expect(doc).toContain('device-nonce.service.ts');
    expect(doc).toContain('two settlement sweeps racing');
    // the rule that decides every failure path
    expect(doc).toContain('may never quietly cost a security property');
  });

  it('the pool never holds the process open and stays out of the test runner', () => {
    expect(PW).toContain('w.unref()');
    expect(PW).toContain("process.env.NODE_ENV !== 'test'");
  });
});

describe('the connection pool is sized, not defaulted', () => {
  const DB = read('src/config/database.ts');

  it('is set from the environment, and an explicit URL wins', () => {
    expect(DB).toContain('DB_CONNECTION_LIMIT');
    expect(DB).toContain('connection_limit=');
    expect(DB).toContain('/[?&]connection_limit=/.test(raw)');
  });

  it('and the client is built with it', () => {
    expect(DB).toContain('datasourceUrl: datasourceUrl()');
  });
});
