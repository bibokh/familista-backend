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
};

const SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'db-migrate.js'), 'utf8');
const PREDEPLOY = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'render-predeploy.sh'), 'utf8');

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
