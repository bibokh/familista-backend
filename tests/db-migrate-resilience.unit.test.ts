/**
 * tests/db-migrate-resilience.unit.test.ts
 *
 * A database that was asleep is not a migration that was wrong.
 *
 * Production runs on Neon, whose compute suspends when idle. The first
 * connection wakes it, and waking can take longer than the five seconds Prisma
 * waits by default — so `prisma migrate deploy` returns
 *
 *   P1002: The database server was reached but timed out
 *
 * having applied nothing. Retrying that is correct. Retrying a migration that
 * actually failed is how a database gets damaged, so the line between the two
 * is drawn in exactly one place and pinned here.
 */

import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const runner = require('../scripts/db-migrate.js') as {
  isTransientConnectionError: (text: string) => boolean;
  migrationUrl: (env: Record<string, string | undefined>) => {
    url: string | null; source: string | null; pooled: boolean; direct: boolean;
  };
  withConnectTimeout: (url: string, seconds: number) => string;
  redactUrl: (url?: string) => string;
  suggestedDirectHost: (url?: string) => string | null;
  runDeploy: (env: NodeJS.ProcessEnv, opts: {
    timeoutMs?: number; command?: string; args?: string[]; graceMs?: number;
    write?: (s: string) => void; log?: (s: string) => void;
    onStall?: (s: { applying: boolean }) => Promise<void>;
  }) => Promise<{ code: number; out: string; stalled: boolean }>;
  EXIT_UNAVAILABLE: number;
};
const { redactUrl, suggestedDirectHost } = runner;

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'db-migrate.js'), 'utf8');
const PREDEPLOY = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'render-predeploy.sh'), 'utf8');
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('what counts as "the database did not answer"', () => {
  it('every connection-level failure is retried', () => {
    for (const text of [
      'Error: P1002 The database server was reached but timed out',
      'P1001: Can\'t reach database server at ep-x.eu-central-1.aws.neon.tech:5432',
      'P1008: Operations timed out',
      'P1017: Server has closed the connection',
      'P2024: Timed out fetching a new connection from the connection pool',
      'connect ETIMEDOUT 10.0.0.1:5432',
      'read ECONNRESET',
      'getaddrinfo EAI_AGAIN ep-x.neon.tech',
    ]) {
      expect(`${text} → ${runner.isTransientConnectionError(text)}`).toBe(`${text} → true`);
    }
  });

  it('and a real migration failure is never retried', () => {
    for (const text of [
      'P3009: migrate found failed migrations in the target database',
      'P3018: A migration failed to apply. Migration name: 20260904090000_training_session_team',
      'P3005: The database schema is not empty',
      'P3006: Migration failed to apply cleanly to the shadow database',
      'ERROR: syntax error at or near "ALTER"',
      '',
    ]) {
      expect(`${text} → ${runner.isTransientConnectionError(text)}`).toBe(`${text} → false`);
    }
    // Even when a failed migration's own output quotes a connection code, the
    // migration verdict wins: that one must be looked at, not repeated.
    expect(runner.isTransientConnectionError('P3018 failed; earlier the log showed P1002')).toBe(false);
  });
});

describe('the connection migrations run on', () => {
  it('prefers a direct URL over the pooled one, and says which it took', () => {
    expect(runner.migrationUrl({ MIGRATE_DATABASE_URL: 'postgres://a/db', DIRECT_URL: 'postgres://b/db', DATABASE_URL: 'postgres://c/db' }))
      .toMatchObject({ url: 'postgres://a/db', source: 'MIGRATE_DATABASE_URL', direct: true });
    expect(runner.migrationUrl({ DIRECT_URL: 'postgres://b/db', DATABASE_URL: 'postgres://c/db' }))
      .toMatchObject({ url: 'postgres://b/db', source: 'DIRECT_URL', direct: true });
    expect(runner.migrationUrl({ DATABASE_URL: 'postgres://c/db' }))
      .toMatchObject({ url: 'postgres://c/db', source: 'DATABASE_URL', direct: false });
    expect(runner.migrationUrl({})).toMatchObject({ url: null, source: null });
  });

  it('recognises Neon\'s pooled endpoint, which cannot run migrations reliably', () => {
    expect(runner.migrationUrl({ DATABASE_URL: 'postgres://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/db' }).pooled).toBe(true);
    expect(runner.migrationUrl({ DATABASE_URL: 'postgres://u:p@ep-x.eu-central-1.aws.neon.tech/db' }).pooled).toBe(false);
    // Said out loud rather than worked around: the fix is one env var.
    expect(SRC).toContain('set DIRECT_URL to the non-pooled host');
  });

  it('gives the migration connection time to wake a suspended compute, and rewrites nothing else', () => {
    expect(runner.withConnectTimeout('postgres://h/db', 30)).toBe('postgres://h/db?connect_timeout=30');
    expect(runner.withConnectTimeout('postgres://h/db?sslmode=require', 30))
      .toBe('postgres://h/db?sslmode=require&connect_timeout=30');
    // An operator who set one keeps it.
    expect(runner.withConnectTimeout('postgres://h/db?connect_timeout=90', 30))
      .toBe('postgres://h/db?connect_timeout=90');
    // The host, the credentials and sslmode are untouched.
    const url = 'postgres://user:secret@ep-x.neon.tech/db?sslmode=require';
    expect(runner.withConnectTimeout(url, 30).startsWith(url)).toBe(true);
  });
});

describe('the pooled endpoint runs the app; the direct one runs migrations', () => {
  const POOLED = 'postgresql://dbuser42:s3cr3t@ep-cool-a1b2-pooler.eu-central-1.aws.neon.tech/familista?sslmode=require';
  const DIRECT = 'postgresql://dbuser42:s3cr3t@ep-cool-a1b2.eu-central-1.aws.neon.tech/familista?sslmode=require';

  it('the schema declares directUrl, so Prisma migrations take the direct connection', () => {
    const schema = read('prisma/schema.prisma');
    const datasource = schema.slice(schema.indexOf('datasource db {'), schema.indexOf('}', schema.indexOf('datasource db {')));
    // Matched loosely on whitespace: `prisma format` aligns the keys in this
    // block, so the number of spaces is the formatter's business, not this
    // test's.
    expect(datasource).toMatch(/\burl\s*=\s*env\("DATABASE_URL"\)/);
    expect(datasource).toMatch(/\bdirectUrl\s*=\s*env\("DIRECT_URL"\)/);
  });

  it('and DIRECT_URL is guaranteed, because a declared variable that is missing fails the deploy', () => {
    // Prisma refuses to run a migration when a variable the datasource declares
    // is unset. That would turn an improvement into a prerequisite, so both
    // scripts that run a migrate command resolve it first, falling back to
    // DATABASE_URL — which is exactly what happened before directUrl existed.
    const lib = read('scripts/lib/direct-url.sh');
    expect(lib).toContain('export DIRECT_URL="${DATABASE_URL:-}"');
    for (const script of ['scripts/render-start.sh', 'scripts/render-predeploy.sh']) {
      const body = read(script);
      expect(`${script}:${body.includes('lib/direct-url.sh')}`).toBe(`${script}:true`);
      expect(`${script}:${body.includes('familista_resolve_direct_url')}`).toBe(`${script}:true`);
    }
    // The runner passes it to the child too, for the same reason.
    expect(SRC).toContain('DATABASE_URL: url, DIRECT_URL: url');
  });

  it('never prints a connection string, only a host', () => {
    expect(redactUrl(POOLED)).toBe('postgresql://ep-cool-a1b2-pooler.eu-central-1.aws.neon.tech/familista');
    // Neither half of the userinfo survives. (The fixture's username is
    // deliberately not a substring of the host — "neon.tech" would make a
    // careless assertion here pass for the wrong reason.)
    expect(redactUrl(POOLED)).not.toContain('s3cr3t');
    expect(redactUrl(POOLED)).not.toContain('dbuser42');
    expect(redactUrl(POOLED)).not.toContain('@');
    expect(redactUrl('not a url')).toBe('(unparseable url)');
    expect(redactUrl(undefined)).toBe('(none)');
    // And nothing that prints ever interpolates a URL. Checked line by line,
    // because a nested call — redactUrl(chosen.url) — is exactly the shape a
    // careless regex over the whole file gets wrong in both directions.
    // A line offends when it PRINTS and the thing it interpolates is a URL.
    // `log = console.log` in a parameter list is not a print, and
    // redactUrl(...)/suggestedDirectHost(...) hand back a host, not a URL.
    const printsUrl = (line: string) =>
      /(console\.(log|error|warn)|\blog)\(|^\s*echo\b/.test(line)
      && /\$\{\s*(chosen\.)?url\b|\$\{\s*DATABASE_URL|\$\{\s*DIRECT_URL|\$\{?DATABASE_URL\}?"|\$\{?DIRECT_URL\}?"|\+\s*url\b/.test(line)
      && !/redactUrl|suggestedDirectHost|_fam_direct_host/.test(line);

    for (const [name, body] of [
      ['db-migrate.js', SRC],
      ['direct-url.sh', read('scripts/lib/direct-url.sh')],
      ['render-start.sh', read('scripts/render-start.sh')],
      ['render-predeploy.sh', PREDEPLOY],
    ] as const) {
      const offenders = body.split('\n').filter(printsUrl);
      expect(`${name}: ${offenders.join(' | ')}`).toBe(`${name}: `);
    }
  });

  it('suggests the direct host rather than silently connecting to it', () => {
    expect(suggestedDirectHost(POOLED)).toBe('ep-cool-a1b2.eu-central-1.aws.neon.tech');
    // Already direct, or not Neon: nothing to suggest.
    expect(suggestedDirectHost(DIRECT)).toBeNull();
    expect(suggestedDirectHost('postgresql://u:p@localhost:5432/db')).toBeNull();
    expect(suggestedDirectHost(undefined)).toBeNull();
    // The runner never rewrites the host it was given — it only reports one.
    expect(SRC).not.toMatch(/replace\('-pooler\.', '\.'\)[\s\S]{0,80}(url =|env\.|DATABASE_URL)/);
  });

  it('leaves the application pointed at the pooled endpoint', () => {
    // The API's own client reads DATABASE_URL and nothing else. directUrl is a
    // CLI concern; the running service keeps the pooler it was designed for.
    const db = read('src/config/database.ts');
    expect(db).toContain('process.env.DATABASE_URL');
    expect(db).not.toContain('DIRECT_URL');
  });
});

describe('what the runner is allowed to do to a database', () => {
  it('only ever deploys — it never resets, drops, seeds or force-resolves', () => {
    expect(SRC).toContain("'migrate', 'deploy'");
    for (const forbidden of ['migrate reset', 'db push', '--force', 'migrate resolve', 'deleteMany', 'DROP ']) {
      expect(`${forbidden}:${SRC.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it('and the deploy step is the one the start script calls', () => {
    expect(PREDEPLOY).toContain('node scripts/db-migrate.js');
    // The existing recovery path is unchanged: a real failure still falls
    // through to resolving the baseline migrations, exactly as before.
    expect(PREDEPLOY).toContain('prisma migrate resolve --applied 00000000000000_baseline');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A deploy that waits on a lock does not fail: it waits, silently, past the
// moment Render stops waiting for the port. These pin the one place that bounds
// it — a stand-in for `prisma migrate deploy` (a node script) plays each case,
// so nothing here needs a database.
describe('a migrate deploy that goes silent', () => {
  // Every stand-in prints its pid first, and whatever a test started is killed
  // after it: a regression that stops the bound must fail the test, not hang CI.
  const started: number[] = [];
  const track = (s: string) => { for (const m of s.matchAll(/(?:PID|ENGINE) (\d+)/g)) started.push(Number(m[1])); };
  afterEach(() => { for (const pid of started.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch (_) { /* gone */ } } });
  const quiet = { write: track, log: () => {} };
  const fake = (script: string) => ({ command: process.execPath, args: ['-e', `console.log('PID ' + process.pid); ${script}`] });
  const alive = (pid: number) => {
    // A zombie still answers kill(pid, 0); /proc says what it really is.
    if (fs.existsSync(`/proc/${pid}/stat`)) return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    if (fs.existsSync('/proc')) return false;
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
  };
  const gone = async (pid: number) => {
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
  };

  it('relays Prisma\'s output as it arrives, not when the run ends', async () => {
    const seen: Array<{ s: string; at: number }> = [];
    const r = await runner.runDeploy(process.env, {
      ...fake("process.stdout.write('first\\n'); setTimeout(() => { process.stderr.write('second\\n'); process.exit(3); }, 300)"),
      write: (s) => { track(s); seen.push({ s, at: Date.now() }); }, log: () => {},
    });
    const ended = Date.now();
    expect(r).toMatchObject({ code: 3, stalled: false });
    expect(r.out).toContain('first');
    expect(r.out).toContain('second');
    expect(ended - seen.find((x) => x.s.includes('first'))!.at).toBeGreaterThanOrEqual(200);
  });

  it('stops a run silent before applying anything, with everything it started, after reporting the locks', async () => {
    const stalls: boolean[] = [];
    const t0 = Date.now();
    const r = await runner.runDeploy(process.env, {
      ...fake("const g = require('child_process').spawn('sleep', ['300'], { stdio: 'ignore' }); console.log('ENGINE ' + g.pid); setInterval(() => {}, 1000)"),
      ...quiet, timeoutMs: 300, graceMs: 200,
      onStall: async ({ applying }) => { stalls.push(applying); },
    });
    expect(r.stalled).toBe(true);
    expect(r.code).not.toBe(0);
    expect(stalls).toEqual([false]);
    expect(Date.now() - t0).toBeLessThan(5000);
    // The schema engine Prisma starts is a grandchild: the whole group is stopped.
    const engine = Number(/ENGINE (\d+)/.exec(r.out)![1]);
    expect(await gone(engine)).toBe(true);
  });

  it('and one that ignores SIGTERM is killed after the grace period', async () => {
    const t0 = Date.now();
    const r = await runner.runDeploy(process.env, {
      ...fake("process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)"),
      ...quiet, timeoutMs: 300, graceMs: 200,
    });
    expect(r.stalled).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('never interrupts a run that has started applying a migration, however long it is silent', async () => {
    const stalls: boolean[] = [];
    const r = await runner.runDeploy(process.env, {
      ...fake("console.log('Applying migration `20990101000000_slow`'); setTimeout(() => { console.log('All migrations have been successfully applied.'); process.exit(0); }, 1200)"),
      ...quiet, timeoutMs: 300, graceMs: 100,
      onStall: async ({ applying }) => { stalls.push(applying); },
    });
    expect(r).toMatchObject({ code: 0, stalled: false });
    expect(r.out).toContain('successfully applied');
    // Reported each time it went silent, and left to finish every time.
    expect(stalls.length).toBeGreaterThanOrEqual(2);
    expect(stalls.every((a) => a)).toBe(true);
  });

  it('a command that cannot start is a failed attempt, not a crash', async () => {
    const r = await runner.runDeploy(process.env, { command: 'familista-no-such-command', args: [], ...quiet, timeoutMs: 300 });
    expect(r).toMatchObject({ code: 1, stalled: false });
    expect(r.out).toMatch(/ENOENT/);
  });

  it('the deploy step is bounded, and the lock report reads no statement text', () => {
    expect(SRC).not.toContain('spawnSync(');
    expect(SRC).toContain('detached: true');
    expect(SRC).toMatch(/MIGRATE_ATTEMPT_TIMEOUT_MS \|\| 90000/);
    expect(SRC).toMatch(/MIGRATE_BUDGET_MS \|\| 300000/);
    // pg_stat_activity.query is read only through its first word.
    expect(SRC.match(/a\.query\b/g)).toHaveLength(1);
    expect(SRC).toContain("split_part(ltrim(coalesce(a.query, '')), ' ', 1)");
    expect(SRC).not.toMatch(/pg_(cancel|terminate)_backend/);
  });

  it('a run the database never let happen stops the boot instead of running recovery against it', () => {
    expect(runner.EXIT_UNAVAILABLE).toBe(75);
    // render-predeploy.sh: 75 returns before any `migrate resolve`.
    const stop = PREDEPLOY.indexOf('if [ "$rc" -eq 75 ]; then');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(PREDEPLOY.indexOf('prisma migrate resolve --applied'));
    expect(PREDEPLOY).toContain('node scripts/db-migrate.js || rc=$?');
    // render-start.sh: the code is read first thing in the else branch, and 75
    // refuses before the reconciliation loop.
    const START = read('scripts/render-start.sh');
    expect(START).toMatch(/if bash scripts\/render-predeploy\.sh; then\n[^\n]*\nelse\n {2}rc=\$\?\n/);
    const refuse = START.indexOf('if [ "$rc" -eq 75 ]; then');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(START.indexOf('for _attempt in $(seq 1 25)'));
  });
});
