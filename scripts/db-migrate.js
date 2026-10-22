#!/usr/bin/env node
/* eslint-disable no-console */
// Apply Prisma migrations against a database that may be asleep
// ─────────────────────────────────────────────────────────────────────────────
// Production runs on Neon. A Neon compute suspends when idle and is woken by
// the first connection, and waking takes seconds — sometimes more than the five
// Prisma waits by default. `prisma migrate deploy` then fails with
//
//   P1002: The database server was reached but timed out
//
// which is not a migration error at all: nothing was applied, nothing was
// half-applied, and the same command a moment later succeeds. Retrying the
// deploy is therefore the correct response, and this file is the only place
// that decides when a failure is that kind of failure.
//
// ── What it does, in order
//
//   1. Chooses the URL migrations run on: MIGRATE_DATABASE_URL, then
//      DIRECT_URL, then DATABASE_URL. Neon's pooled endpoint (a "-pooler"
//      host, pgBouncer) cannot run migrations reliably — advisory locks and
//      session state do not survive a transaction pooler — so a pooled URL
//      with no direct alternative is called out loudly rather than silently
//      retried into the same wall.
//   2. Raises `connect_timeout` for the migration connection only, so waking a
//      suspended compute is not mistaken for an unreachable one. The
//      application's own pool is untouched.
//   3. Waits for the database to answer `SELECT 1` before running anything.
//      This is the step that actually wakes Neon, and it costs nothing when the
//      database is already awake.
//   4. Runs `prisma migrate deploy`, and retries ONLY when the failure is a
//      connection-level one. A genuine migration error — a failed statement, a
//      drifted history — is returned immediately and untouched, because
//      retrying those is how a database gets damaged.
//
// ── Why retrying cannot duplicate anything
//
// `migrate deploy` records each migration in `_prisma_migrations` in the same
// transaction that applies it, and takes a Postgres advisory lock for the run.
// A run that never connected applied nothing and recorded nothing; a run that
// connected and applied N migrations records those N and skips them next time.
// So a retry either resumes where the last one stopped or is a no-op. Nothing
// here resets, drops, seeds or force-marks anything: this file only ever calls
// `migrate deploy`.
//
// ── Why a silent deploy is stopped, and when it never is
//
// The server binds its port only after this script returns, and Render fails a
// deploy whose port does not open in time. A `migrate deploy` that waits on a
// lock another session holds — the ledger table, or Prisma's advisory lock held
// by a connection that never let go — does not fail: it waits, silently, until
// Render gives up. So Prisma's output is relayed as it arrives, and a run that
// has been silent for MIGRATE_ATTEMPT_TIMEOUT_MS BEFORE applying anything is
// stopped, after printing who holds those locks (read-only, no statement text).
// Stopping it then is a retry like any other: nothing was applied. A run that
// has started applying a migration is never interrupted by this script — its
// silence is reported, and it is left to finish.
//
// Every attempt, and the wake-up wait, share one budget, MIGRATE_BUDGET_MS. A
// run that ends without the database ever letting a migration run — it stalled,
// or never answered — exits EXIT_UNAVAILABLE (75), and the start scripts then
// refuse to boot instead of running recovery steps that need the same database:
// the previous deploy keeps serving, and the log says why.

const { spawn } = require('child_process');

const SCHEMA = '--schema=prisma/schema.prisma';

/** The database never let a migration run: it stalled, or did not answer. Not a migration error. */
const EXIT_UNAVAILABLE = 75; // EX_TEMPFAIL

/** Prisma prints this before it runs a migration's SQL. From then on the run is left to finish. */
const APPLYING = /Applying migration/;

/** Prisma waits ten seconds for its advisory lock; an attempt shorter than this proves nothing. */
const MIN_ATTEMPT_MS = 15000;

/**
 * Failures that mean "the database did not answer", as opposed to "the
 * migration is wrong". Only these are retried.
 *
 *   P1001 cannot reach the database server
 *   P1002 the server was reached but timed out          ← Neon waking up
 *   P1008 operation timed out
 *   P1017 the server closed the connection
 *   P2024 timed out fetching a connection from the pool
 *
 * Everything else — P3009 a failed migration in history, P3018 a migration
 * that errored, a syntax error in SQL — is a real problem that a retry would
 * only repeat.
 */
const TRANSIENT = /\b(P1001|P1002|P1008|P1017|P2024)\b|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|Timed out fetching|Can't reach database server|Connection terminated|server closed the connection/i;

function isTransientConnectionError(text) {
  if (!text) return false;
  // A genuine migration failure can quote a connection code in its own body;
  // the migration codes win, because those must never be retried.
  if (/\b(P3005|P3006|P3009|P3014|P3018|P3019)\b/.test(text)) return false;
  return TRANSIENT.test(text);
}

/** The URL migrations run on, and how it was chosen. */
function migrationUrl(env = process.env) {
  const direct = env.MIGRATE_DATABASE_URL || env.DIRECT_URL || null;
  const url = direct || env.DATABASE_URL || null;
  return {
    url,
    source: env.MIGRATE_DATABASE_URL ? 'MIGRATE_DATABASE_URL'
      : env.DIRECT_URL ? 'DIRECT_URL'
      : url ? 'DATABASE_URL' : null,
    pooled: !!url && /-pooler\./.test(url),
    direct: !!direct,
  };
}

/**
 * A connection string with nothing secret left in it.
 *
 * Used for every line this script prints about a URL. Postgres URLs carry the
 * password in the userinfo, and a deploy log is read by more people, and kept
 * for longer, than anybody assumes when they add a console.log. So the rule is
 * absolute: the host and the database name may be printed, the credentials and
 * the query string never are, and an unparseable URL prints as nothing at all
 * rather than as itself.
 */
function redactUrl(url) {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    const db = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.protocol}//${u.host}${db}`;
  } catch (_) {
    return '(unparseable url)';
  }
}

/**
 * Neon names its pooled endpoint by inserting "-pooler" into the host of the
 * direct one, so the direct host is mechanically recoverable from the pooled
 * host. This only ever SUGGESTS it, in a log line, with no credentials — the
 * value that gets used is the one an operator set, never one this script
 * guessed. Connecting somewhere nobody asked for is not a fix.
 */
function suggestedDirectHost(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!u.host.includes('-pooler.')) return null;
    return u.host.replace('-pooler.', '.');
  } catch (_) {
    return null;
  }
}

/**
 * The same URL with a connection timeout long enough to wake a suspended
 * compute. An operator who set one already keeps it — this only fills a gap.
 * Nothing else about the URL is rewritten: not the host, not the credentials,
 * not sslmode.
 */
function withConnectTimeout(url, seconds) {
  if (!url) return url;
  if (/[?&]connect_timeout=/.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + `connect_timeout=${seconds}`;
}

function sleep(ms) {
  const until = Date.now() + ms;
  // Synchronous on purpose: this script is a sequence of blocking steps and has
  // no event loop worth keeping free.
  while (Date.now() < until) { /* wait */ }
}

async function waitForDatabase(url, { deadlineMs, log = console.log }) {
  let PrismaClient;
  try { ({ PrismaClient } = require('@prisma/client')); } catch (_) {
    log('==> @prisma/client not generated yet — skipping the reachability wait');
    return true;
  }
  const started = Date.now();
  let attempt = 0;
  let delay = 2000;
  for (;;) {
    attempt++;
    const client = new PrismaClient({ datasourceUrl: url });
    try {
      await client.$queryRaw`SELECT 1`;
      await client.$disconnect();
      log(`==> database answered on attempt ${attempt} (${Date.now() - started}ms)`);
      return true;
    } catch (err) {
      try { await client.$disconnect(); } catch (_) { /* already gone */ }
      const text = String((err && err.message) || err);
      const transient = isTransientConnectionError(text);
      if (Date.now() - started + delay > deadlineMs || !transient) {
        log(`==> database did not answer after ${attempt} attempt(s): ${text.split('\n')[0]}`);
        return false;
      }
      log(`==> database asleep or unreachable (attempt ${attempt}) — waking, retry in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  }
}

/**
 * Who holds, or waits for, what `migrate deploy` needs: Prisma's advisory lock
 * (72707369) and the ledger table. Read-only — pg_locks and pg_stat_activity —
 * and it prints a session's pid, application name, state, lock, transaction age
 * and the first word of its statement. Never the statement, never a value.
 * Bounded, because it is asked exactly when the database is not answering well.
 */
async function migrationLockReport(url, { log = console.log, timeoutMs = 10000 } = {}) {
  let PrismaClient;
  try { ({ PrismaClient } = require('@prisma/client')); } catch (_) { return; }
  const client = new PrismaClient({ datasourceUrl: url });
  const bounded = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timed out')), timeoutMs).unref())]);
  try {
    const rows = await bounded(client.$queryRaw`
      SELECT a.pid, coalesce(a.application_name, '') AS app, coalesce(a.state, '') AS state,
             l.locktype, l.mode, l.granted,
             coalesce(extract(epoch FROM now() - a.xact_start)::int, -1) AS xact_seconds,
             upper(split_part(ltrim(coalesce(a.query, '')), ' ', 1)) AS statement
        FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE a.pid <> pg_backend_pid()
         AND ((l.locktype = 'advisory' AND l.objid = 72707369)
              OR l.relation = to_regclass('"_prisma_migrations"'))
       ORDER BY l.granted DESC, a.pid`);
    if (rows.length === 0) {
      log('==> no other session holds Prisma\'s migration lock or the ledger table');
    } else {
      log('==> sessions on the migration locks (pid · application · state · lock · held/waiting · transaction age · statement):');
      for (const r of rows) {
        const age = r.xact_seconds < 0 ? 'no transaction' : `${r.xact_seconds}s`;
        log(`==>   ${r.pid} · ${r.app || '(unnamed)'} · ${r.state || '-'} · ${r.locktype} ${r.mode} · ${r.granted ? 'held' : 'waiting'} · ${age} · ${r.statement || '-'}`);
      }
    }
  } catch (err) {
    log(`==> could not read the lock table: ${String((err && err.message) || err).split('\n')[0]}`);
  } finally {
    await bounded(client.$disconnect()).catch(() => { /* already gone */ });
  }
}

/**
 * One `prisma migrate deploy`, its output relayed line by line as it arrives.
 *
 * In its own process group, so stopping it reaches the schema engine Prisma
 * starts and not only npx; and signals this script receives are passed on, so
 * nothing outlives it. `onStall` runs each time the run has been silent for
 * `timeoutMs`; the run is then stopped only if it has applied nothing.
 */
function runDeploy(env, {
  timeoutMs = 0,
  command = 'npx',
  args = ['prisma', 'migrate', 'deploy', SCHEMA],
  write = (s) => process.stdout.write(s),
  log = console.log,
  onStall = async () => {},
  graceMs = 5000,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let stalled = false;
    let done = false;
    let timer = null;

    const group = (sig) => { try { process.kill(-child.pid, sig); } catch (_) { /* already gone */ } };
    const passOn = (sig) => { group(sig); process.exit(sig === 'SIGINT' ? 130 : 143); };
    const onTerm = () => passOn('SIGTERM');
    const onInt = () => passOn('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);

    const arm = () => {
      if (!timeoutMs || done) return;
      clearTimeout(timer);
      timer = setTimeout(onSilence, timeoutMs);
    };
    async function onSilence() {
      const heard = out.length;
      const applying = APPLYING.test(out);
      log(`==> migrate deploy silent for ${Math.round(timeoutMs / 1000)}s${applying ? ' while applying a migration' : ' before applying anything'}`);
      await onStall({ applying });
      // It spoke or finished while we looked: the next silence is a new one.
      if (done || out.length !== heard) return;
      if (APPLYING.test(out)) {
        log('==> a migration is being applied — not interrupting it');
        arm();
        return;
      }
      stalled = true;
      log('==> stopping it: nothing has been applied, so this is a retry like any other');
      group('SIGTERM');
      setTimeout(() => group('SIGKILL'), graceMs).unref();
    }

    const relay = (chunk) => { const s = chunk.toString('utf8'); out += s; write(s); arm(); };
    child.stdout.on('data', relay);
    child.stderr.on('data', relay);

    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      resolve({ code, out, stalled });
    };
    child.on('error', (err) => { out += `${err.message}\n`; finish(1); });
    child.on('close', (code) => finish(code == null ? 1 : code));
    arm();
  });
}

async function main() {
  const startedAt = Date.now();
  const budgetMs = Number(process.env.MIGRATE_BUDGET_MS || 300000);
  const attemptMs = Number(process.env.MIGRATE_ATTEMPT_TIMEOUT_MS || 90000);
  const remaining = () => budgetMs - (Date.now() - startedAt);
  const chosen = migrationUrl();
  if (!chosen.url) {
    console.error('==> no DATABASE_URL (or DIRECT_URL / MIGRATE_DATABASE_URL) is set');
    process.exit(1);
  }
  console.log(`==> migrations will run on ${chosen.source}`);
  if (chosen.pooled && !chosen.direct) {
    // Not fatal: some deployments do run migrations through the pooler. It is
    // said plainly because it is the most likely cause of a timeout that keeps
    // coming back, and the fix is one environment variable.
    console.log('==> WARNING: that URL is Neon\'s POOLED endpoint (-pooler). Migrations want a direct');
    console.log('==>          connection — set DIRECT_URL to the non-pooled host and redeploy.');
    const suggestion = suggestedDirectHost(chosen.url);
    if (suggestion) {
      console.log(`==>          The direct host for this database is ${suggestion} — the same`);
      console.log('==>          connection string with "-pooler" removed from the host.');
    }
  }
  console.log(`==> target ${redactUrl(chosen.url)}`);

  const timeout = Number(process.env.MIGRATE_CONNECT_TIMEOUT || 30);
  const url = withConnectTimeout(chosen.url, timeout);
  const deadline = Math.min(Number(process.env.MIGRATE_WAIT_MS || 180000), budgetMs);

  console.log(`==> budget ${Math.round(budgetMs / 1000)}s for the whole run; an attempt silent for ${Math.round(attemptMs / 1000)}s before applying anything is stopped`);
  console.log(`==> waiting for the database (up to ${Math.round(deadline / 1000)}s, connect_timeout=${timeout}s)`);
  await waitForDatabase(url, { deadlineMs: deadline });

  // Both, and both the same value.
  //
  // The schema's datasource declares `directUrl = env("DIRECT_URL")`, and
  // Prisma refuses to run a migration when a declared variable is missing — so
  // an unset DIRECT_URL would not fall back, it would fail the deploy. Setting
  // it here to the URL this script already resolved makes the declaration safe
  // in every deployment: where an operator set DIRECT_URL, that is what
  // migrations use; where nobody has yet, it is DATABASE_URL, which is exactly
  // what happened before this line existed.
  const env = { ...process.env, DATABASE_URL: url, DIRECT_URL: url };
  const attempts = Number(process.env.MIGRATE_MAX_ATTEMPTS || 5);
  let delay = 5000;
  let stalledOnce = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.log(`==> prisma migrate deploy (attempt ${attempt}/${attempts})`);
    const { code, out, stalled } = await runDeploy(env, {
      timeoutMs: Math.max(MIN_ATTEMPT_MS, Math.min(attemptMs, remaining())),
      onStall: () => migrationLockReport(url),
    });
    stalledOnce = stalledOnce || stalled;
    if (code === 0) {
      console.log('==> migrations up to date');
      process.exit(0);
    }
    if (!stalled && !isTransientConnectionError(out)) {
      // A real migration problem. Returned as-is so the caller's existing
      // recovery path — resolving baseline migrations — runs exactly as before.
      console.log('==> migrate deploy failed for a reason a retry cannot fix');
      process.exit(code);
    }
    if (attempt === attempts || remaining() < delay + MIN_ATTEMPT_MS) {
      // Nothing was applied and no migration error was seen: the database did
      // not let a migration run. Recovery steps need that same database, so the
      // caller is told to stop rather than to try them.
      console.log(stalledOnce
        ? `==> migrate deploy stalled on a lock and did not get past it within the ${Math.round(budgetMs / 1000)}s budget — the sessions listed above hold it`
        : '==> migrate deploy still timing out after every attempt');
      process.exit(EXIT_UNAVAILABLE);
    }
    console.log(`==> ${stalled ? 'stopped before applying anything' : 'connection-level failure'} — retrying in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30000);
  }
}

module.exports = {
  isTransientConnectionError, migrationUrl, withConnectTimeout, waitForDatabase, sleep,
  redactUrl, suggestedDirectHost, runDeploy, migrationLockReport, EXIT_UNAVAILABLE,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`==> ${(err && err.message) || err}`);
    process.exit(1);
  });
}
