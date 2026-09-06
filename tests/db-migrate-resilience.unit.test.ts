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
