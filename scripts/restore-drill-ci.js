#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
// Familista — the automated restore drill (Cyber Defense, Step 10)
// ─────────────────────────────────────────────────────────────────────────────
// What scripts/restore-drill.ps1 does on a Windows machine, done on a Linux
// host with Docker — the GitHub Actions runner of .github/workflows/
// restore-drill.yml — so nothing has to be installed or run locally:
//
//   node scripts/restore-drill-ci.js              restore the newest complete backup in the bucket
//   node scripts/restore-drill-ci.js --self-test  the same drill on a synthetic backup with
//                                                 throwaway keys: no secret, no bucket
//
// In order, and nothing reaches a database until the step before it passed:
//
//   1. refuses to start if a production setting is in its environment
//      (DATABASE_URL, DIRECT_URL, BACKUP_DATABASE_URL, …) or NODE_ENV is
//      production, and names — never shows — any required setting that is missing
//   2. builds the runner image from scripts/restore-drill/Dockerfile
//      (pg_restore 18 from the official postgres image, plus Node 20)
//   3. finds the newest complete backup — a .fbk whose signed manifest is
//      beside it — with the store settings only (`backup.js latest`)
//   4. starts the target: a new postgres:18 container, labelled with this run's
//      random nonce, with no published port and a random password nobody sees
//   5. proves the target is that container (label, image, no published port)
//      and that it is empty, and that the URL it will restore to is loopback
//   6. runs the repository's own drill (`backup.js drill`) in a container that
//      shares only the target's network: manifest signature, object binding,
//      key, ciphertext SHA-256 and size, authenticated decryption straight into
//      a single-transaction pg_restore, decrypted SHA-256 and size, schema head
//   7. queries the restored database itself and holds it to the drill's report,
//      the repository's newest migration, and every row-level-security table
//   8. prints one verdict — RESTORE DRILL: PASS or FAIL — with the evidence, and
//      writes the job summary; the containers and every temporary file are
//      removed whatever happens
//
// Never printed: a key, a password, a connection string, a URL, the bucket —
// and exact row counts only when RESTORE_DRILL_SHOW_COUNTS=true, because this
// repository's Actions logs are public. Secrets reach containers only through
// 0600 --env-file files, never a command line.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNNER_IMAGE = 'familista-restore-drill-runner:pg18';
const PG_IMAGE = 'postgres:18-bookworm';
const PG_USER = 'postgres';
const DRILL_DB = 'familista_drill';
const SOURCE_DB = 'familista_selftest';
const LABEL = 'familista.restore-drill';

/** Settings a drill must never hold. Present at all — even unused — is refused. */
const PRODUCTION_SETTINGS = ['DATABASE_URL', 'DIRECT_URL', 'BACKUP_DATABASE_URL', 'MIGRATE_DATABASE_URL', 'DRILL_DATABASE_URL'];
const STORE_SETTINGS = ['BACKUP_S3_BUCKET', 'BACKUP_S3_REGION', 'BACKUP_S3_ENDPOINT', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY'];
const OPTIONAL_STORE_SETTINGS = ['BACKUP_S3_PREFIX', 'BACKUP_S3_FORCE_PATH_STYLE'];
const KEY_SETTINGS = ['BACKUP_ENCRYPTION_PRIVATE_KEY', 'BACKUP_SIGNING_PUBLIC_KEY'];
/** Values masked in anything printed, should a library ever repeat one. */
const SECRET_SETTINGS = [...STORE_SETTINGS, 'BACKUP_S3_PREFIX', ...KEY_SETTINGS];
const CORE_TABLES = ['User', 'Club', 'Team', 'Player', 'Membership'];
/** A restore with no rows here restored nothing usable; Player and Membership are under row-level security. */
const MUST_HAVE_ROWS = ['User', 'Club', 'Player', 'Membership'];
const BACKUP_KEY = /^[A-Za-z0-9._\-/]+\.fbk$/;
const TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

class DrillError extends Error {
  constructor(message) { super(message); this.name = 'DrillError'; }
}

// ── guards ───────────────────────────────────────────────────────────────────

/** The drill job must never be handed production: not a URL, not the environment. */
function refuseProductionSettings(env) {
  if (String(env.NODE_ENV || '').trim() === 'production') {
    throw new DrillError('a restore drill never runs with NODE_ENV=production');
  }
  const present = PRODUCTION_SETTINGS.filter((k) => String(env[k] || '').trim());
  if (present.length) {
    throw new DrillError(`refusing to run: production setting(s) present in the drill's environment: ${present.join(', ')}`);
  }
}

/** The self-test proves the machinery; it must not be given the real keys. */
function refuseSecretsInSelfTest(env) {
  const present = [...STORE_SETTINGS, ...KEY_SETTINGS].filter((k) => String(env[k] || '').trim());
  if (present.length) throw new DrillError(`the self-test runs without secrets, but these are set: ${present.join(', ')}`);
}

/** The bucket settings and the offline restore keys, checked by name and shape; missing ones are named, never shown. */
function realSettings(env) {
  const missing = [...STORE_SETTINGS, ...KEY_SETTINGS].filter((k) => !String(env[k] || '').trim());
  if (missing.length) throw new DrillError(`the restore drill is not configured: ${missing.join(', ')} not set`);
  const out = {};
  for (const k of [...STORE_SETTINGS, ...OPTIONAL_STORE_SETTINGS, ...KEY_SETTINGS]) {
    const v = String(env[k] || '').trim();
    if (!v) continue;
    if (/\s/.test(v)) throw new DrillError(`${k} must be a single token (no spaces or line breaks)`);
    out[k] = v;
  }
  if (!/^https:\/\//.test(out.BACKUP_S3_ENDPOINT)) throw new DrillError('BACKUP_S3_ENDPOINT must be an https address');
  for (const k of KEY_SETTINGS) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(out[k])) throw new DrillError(`${k} is not a base64 key`);
  }
  return out;
}

/** A key the drill accepts as a backup object: a .fbk, never its manifest. */
function isBackupKey(key) {
  return BACKUP_KEY.test(key) && !key.includes('..') && !key.startsWith('/') && !key.endsWith('.manifest.json');
}

/** The only target a drill restores into: the throwaway container, over its own loopback. */
function targetUrl(password, db = DRILL_DB) {
  return `postgresql://${PG_USER}:${encodeURIComponent(password)}@127.0.0.1:5432/${db}`;
}

function assertLoopbackTarget(url) {
  let host;
  try { host = new URL(url).hostname; } catch { throw new DrillError('the restore target URL is not valid'); }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new DrillError('the restore target must be the throwaway container on its own loopback');
  }
}

/** Proves the container about to receive a restore is the one this run created, and is unreachable from outside. */
function proveIsolated(docker, name, nonce) {
  const r = docker(['inspect', '--format',
    '{{json .Config.Labels}}\t{{json .HostConfig.PortBindings}}\t{{json .NetworkSettings.Ports}}\t{{.Config.Image}}', name]);
  if (r.code !== 0) throw new DrillError('the restore target could not be inspected');
  const [labels, bindings, ports, image] = r.stdout.trim().split('\t');
  const parse = (s) => { try { return JSON.parse(s || 'null') || {}; } catch { return null; } };
  const L = parse(labels);
  if (!L || L[LABEL] !== nonce) throw new DrillError('the restore target is not the container this run created');
  if (String(image || '').trim() !== PG_IMAGE) throw new DrillError('the restore target is not a postgres:18 container');
  const published = (o) => o === null || Object.values(o).some((v) => Array.isArray(v) && v.some((b) => b && b.HostPort));
  if (published(parse(bindings)) || published(parse(ports))) {
    throw new DrillError('the restore target publishes a port; a drill target must be unreachable from outside its container');
  }
}

// ── repository facts ─────────────────────────────────────────────────────────

/** The newest migration in the repository: what a current backup's schema head must be. */
function latestMigration(root = ROOT) {
  const dir = path.join(root, 'prisma', 'migrations');
  const names = fs.readdirSync(dir)
    .filter((n) => /^\d{14}_[A-Za-z0-9_]+$/.test(n) && fs.existsSync(path.join(dir, n, 'migration.sql')))
    .sort();
  if (!names.length) throw new DrillError('the repository has no migrations');
  return names[names.length - 1];
}

/** The row-level-security tables, read from the one list the application enforces (src/security/db-context.ts). */
function protectedTables(root = ROOT) {
  const src = fs.readFileSync(path.join(root, 'src', 'security', 'db-context.ts'), 'utf8');
  const m = /export const RLS_PILOT_MODELS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  const names = m ? [...m[1].matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map((x) => x[1]) : [];
  if (!names.length) throw new DrillError('RLS_PILOT_MODELS could not be read from src/security/db-context.ts');
  return [...new Set(names)].sort();
}

// ── plumbing ─────────────────────────────────────────────────────────────────

/** Masks every known secret value, then any connection string or URL, in text about to be printed. */
function redactor(values) {
  const secrets = [...new Set(values.filter((v) => typeof v === 'string' && v.trim().length >= 6).map((v) => v.trim()))]
    .sort((a, b) => b.length - a.length);
  return (text) => {
    let t = String(text == null ? '' : text);
    for (const s of secrets) t = t.split(s).join('***');
    return t.replace(/postgres(?:ql)?:\/\/\S+/gi, '<database-url>').replace(/\b(?:https?|s3|file):\/\/\S+/gi, '<url>');
  };
}

/** A 0600 --env-file. A value with a line break could add a setting of its own, so it is refused. */
function writeEnvFile(dir, name, entries) {
  const lines = [];
  for (const [k, v] of Object.entries(entries)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new DrillError(`invalid setting name ${k}`);
    const s = String(v);
    if (/[\r\n\0]/.test(s)) throw new DrillError(`${k} must be a single line`);
    lines.push(`${k}=${s}`);
  }
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

function dockerRunner(spawn = spawnSync) {
  return (args, opts = {}) => {
    const r = spawn('docker', args, {
      encoding: 'utf8', input: opts.input, timeout: opts.timeoutMs || 30 * 60_000, maxBuffer: 64 * 1024 * 1024,
    });
    return { code: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function lastLine(text) {
  return String(text || '').trim().split('\n').pop() || 'no output';
}

function lastJsonLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

/** The repository's CLI in the runner image: read-only checkout, no capabilities, this job's own uid, env files only. */
function runnerArgs({ user, network, envFiles, mounts = [], command }) {
  return ['run', '--rm', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', user, '-e', 'HOME=/tmp',
    ...(network ? ['--network', network] : []),
    '-v', `${ROOT}:/app:ro`, ...mounts.flatMap((m) => ['-v', m]),
    ...envFiles.flatMap((f) => ['--env-file', f]),
    RUNNER_IMAGE, 'node', '/app/dist/scripts/backup.js', ...command];
}

function waitReady(docker, name, db, tries = 120) {
  for (let i = 0; i < tries; i++) {
    // Over TCP: during first-start initialisation the server listens only on its socket.
    if (docker(['exec', name, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', PG_USER, '-d', db]).code === 0
      && docker(['exec', name, 'psql', '-U', PG_USER, '-d', db, '-Atc', 'select 1']).stdout.trim() === '1') return;
    sleep(1000);
  }
  throw new DrillError(`the PostgreSQL 18 container ${name} did not become ready`);
}

/** A new postgres:18 container with a random password passed by --env-file. Only the self-test's source publishes, on loopback. */
function startPostgres(ctx, { name, db, publishLoopback }) {
  const password = crypto.randomBytes(24).toString('hex');
  ctx.secret(password);
  const envFile = writeEnvFile(ctx.work, `${name}.env`, { POSTGRES_PASSWORD: password, POSTGRES_DB: db });
  try {
    const args = ['run', '-d', '--name', name, '--label', `${LABEL}=${ctx.nonce}`, '--env-file', envFile];
    if (publishLoopback) args.push('-p', '127.0.0.1::5432');
    args.push(PG_IMAGE);
    const r = ctx.docker(args, { timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new DrillError(`could not start the PostgreSQL 18 container ${name}: ${ctx.redact(lastLine(r.stderr))}`);
    ctx.containers.push(name);
  } finally {
    fs.rmSync(envFile, { force: true });
  }
  waitReady(ctx.docker, name, db);
  return { name, password, db };
}

function psqlRows(docker, target, sql) {
  const r = docker(['exec', '-i', target.name, 'psql', '-U', PG_USER, '-d', target.db, '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1'],
    { input: sql });
  if (r.code !== 0) throw new DrillError('the restored database could not be queried');
  const rows = new Map();
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('|');
    if (i > 0) rows.set(line.slice(0, i), line.slice(i + 1).trim());
  }
  return rows;
}

// ── the restored database, seen directly ─────────────────────────────────────

const META_SQL = `SELECT 'public_tables', count(*)::text FROM pg_tables WHERE schemaname = 'public'
UNION ALL SELECT 'migration_head', coalesce(max(migration_name), '') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'table:' || c.relname,
  (CASE WHEN c.relrowsecurity THEN 'rls' ELSE 'plain' END) || ':' ||
  (CASE WHEN c.relforcerowsecurity THEN 'forced' ELSE 'unforced' END) || ':' ||
  (SELECT count(*) FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname)::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r';
`;

/** Schema head, table count, every table's row-level-security state, and the rows of the core and protected tables. */
function inspectRestored(docker, target, rlsTables) {
  const meta = psqlRows(docker, target, META_SQL);
  const tables = new Map();
  for (const [k, v] of meta) {
    if (!k.startsWith('table:')) continue;
    const [rls, forced, policies] = v.split(':');
    tables.set(k.slice('table:'.length), { rls: rls === 'rls', forced: forced === 'forced', policies: Number(policies) || 0 });
  }
  const counted = [...new Set([...CORE_TABLES, ...rlsTables])].filter((t) => TABLE_NAME.test(t) && tables.has(t));
  const rows = {};
  if (counted.length) {
    const counts = psqlRows(docker, target, `${counted.map((t) => `SELECT 'rows:${t}', count(*)::text FROM "${t}"`).join('\nUNION ALL ')};\n`);
    for (const t of counted) rows[t] = Number(counts.get(`rows:${t}`));
  }
  return { tables: Number(meta.get('public_tables')), head: meta.get('migration_head') || null, tableState: tables, rows };
}

// ── the verdict ──────────────────────────────────────────────────────────────

/** Every check, each with what it found. PASS only when the drill succeeded and the database agrees with it. */
function evaluate({ report, db, expectedHead, rlsTables }) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  const drillOk = Boolean(report && report.ok === true);
  check('Backup authenticated, decrypted and restored', drillOk,
    drillOk ? 'signature, object, key, hashes and sizes verified; restored in one transaction'
      : `the drill failed: ${(report && report.error) || 'no report'}`);
  if (!drillOk || !db) return { pass: false, checks };

  check('Schema head is the newest migration',
    db.head === expectedHead && report.restoredMigrationHead === db.head && report.migrationHead === db.head,
    `restored ${db.head || '(none)'}; backup manifest ${report.migrationHead || '(none)'}; repository newest ${expectedHead}`);
  check('Restored tables match the drill', db.tables > 0 && db.tables === report.tables,
    `database ${db.tables}; drill ${report.tables}`);
  const differ = CORE_TABLES.filter((t) => !(Number.isInteger(db.rows[t]) && db.rows[t] === (report.rowCounts || {})[t]));
  check('Core row counts match the drill', differ.length === 0, differ.length ? `differ: ${differ.join(', ')}` : CORE_TABLES.join(', '));
  const empty = MUST_HAVE_ROWS.filter((t) => !(db.rows[t] > 0));
  check('Core tables hold rows (Player and Membership are row-level-security protected)', empty.length === 0,
    empty.length ? `no rows: ${empty.join(', ')}` : MUST_HAVE_ROWS.join(', '));
  const missing = rlsTables.filter((t) => !db.tableState.has(t));
  const unforced = rlsTables.filter((t) => db.tableState.has(t) && !(db.tableState.get(t).rls && db.tableState.get(t).forced));
  const noPolicy = rlsTables.filter((t) => db.tableState.has(t) && !(db.tableState.get(t).policies > 0));
  const problems = [
    missing.length ? `missing: ${missing.join(', ')}` : '',
    unforced.length ? `not forced: ${unforced.join(', ')}` : '',
    noPolicy.length ? `no policy: ${noPolicy.join(', ')}` : '',
  ].filter(Boolean);
  check('Row-level security restored on every protected table', problems.length === 0,
    problems.length ? problems.join('; ') : `${rlsTables.length} of ${rlsTables.length} forced, each with its policies`);
  return { pass: checks.every((c) => c.ok), checks };
}

function shown(n, exact) {
  if (!Number.isInteger(n)) return '—';
  if (exact) return String(n);
  return n > 0 ? 'present' : 'empty';
}

/** The verdict as printed lines and as a job-summary table. Nothing here is a secret or a URL. */
function render(result) {
  const { mode, pass, checks, report, db, expectedHead, rlsTables, exactCounts, tamper, failure } = result;
  const title = mode === 'self-test' ? 'RESTORE DRILL SELF-TEST' : 'RESTORE DRILL';
  const lines = [`${title}: ${pass ? 'PASS' : 'FAIL'}`];
  if (failure) lines.push(`Reason: ${failure}`);
  const failed = (checks || []).filter((c) => !c.ok);
  if (!failure && failed.length) lines.push(`Reason: ${failed[0].name} — ${failed[0].detail}`);
  if (report && report.ok) {
    lines.push(`Backup: ${report.objectKey} (created ${report.createdAt})`);
    lines.push(`Authenticity: Ed25519 manifest signature verified (signing key ${report.signingKeyId}); the manifest names this backup; encrypted to key ${report.encryptionKeyId}`);
    lines.push(`Integrity: ciphertext SHA-256 ${report.ciphertextSha256}, ${report.ciphertextBytes} bytes — matches the signed manifest`);
    lines.push(`Decryption: AES-256-GCM, every chunk authenticated; decrypted SHA-256 ${report.plaintextSha256}, ${report.plaintextBytes} bytes — matches`);
    lines.push('Restore: pg_restore 18, one transaction, into an empty throwaway PostgreSQL 18 with no published port (removed afterwards)');
  }
  if (db) {
    lines.push(`Schema head: ${db.head || '(none)'}${db.head === expectedHead ? ' (the repository\'s newest migration)' : ` — repository newest: ${expectedHead}`}`);
    lines.push(`Tables restored: ${db.tables}`);
    lines.push(`Core rows: ${CORE_TABLES.map((t) => `${t} ${shown(db.rows[t], exactCounts)}`).join(', ')}`);
    const others = rlsTables.filter((t) => !CORE_TABLES.includes(t));
    const withRows = others.filter((t) => db.rows[t] > 0).length;
    lines.push(`Row-level security tables: ${rlsTables.length}; Player ${shown(db.rows.Player, exactCounts)}, Membership ${shown(db.rows.Membership, exactCounts)}; `
      + (exactCounts ? others.map((t) => `${t} ${shown(db.rows[t], true)}`).join(', ') : `the other ${others.length}: ${withRows} with rows, ${others.length - withRows} empty`));
  }
  if (tamper) lines.push(`Tamper check: ${tamper}`);
  lines.push('Production database: not contacted — no production setting was present; the only database written was the throwaway container');
  if (checks && checks.length) lines.push(`Checks: ${checks.filter((c) => c.ok).length} of ${checks.length} passed`);

  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const summary = [
    `### ${pass ? '✅' : '❌'} ${title}: ${pass ? 'PASS' : 'FAIL'}`,
    '',
    ...(checks && checks.length ? ['| Check | Result | Detail |', '|---|---|---|',
      ...checks.map((c) => `| ${esc(c.name)} | ${c.ok ? 'pass' : '**fail**'} | ${esc(c.detail)} |`), ''] : []),
    '```',
    ...lines,
    '```',
    '',
  ].join('\n');
  return { lines, summary };
}

// ── the run ──────────────────────────────────────────────────────────────────

/** Steps 3–7: the newest backup in the store, restored into a fresh target and examined. */
function drill(ctx, { storeEnv, storeMount, keysFile, rlsTables }) {
  const mount = storeMount ? [`${storeMount}:/store:ro`] : [];
  const storeFile = writeEnvFile(ctx.work, 'store.env', storeEnv);
  let listing;
  try {
    // Only the store settings go in: no restore key, no database URL. A file store needs no network at all.
    listing = ctx.docker(runnerArgs({ user: ctx.user, network: storeMount ? 'none' : null, envFiles: [storeFile], mounts: mount, command: ['latest'] }),
      { timeoutMs: 5 * 60_000 });
  } finally {
    fs.rmSync(storeFile, { force: true });
  }
  const found = lastJsonLine(listing.stdout);
  if (listing.code !== 0 || !found || found.ok !== true) {
    throw new DrillError(`no backup to restore: ${(found && found.error) || `the listing produced no report (exit ${listing.code})`}`);
  }
  const objectKey = String(found.objectKey || '');
  if (!isBackupKey(objectKey)) throw new DrillError('the listing returned something that is not a .fbk backup key');
  ctx.log(`Newest complete backup: ${objectKey} (${found.complete} complete backup(s) found)`);

  const target = startPostgres(ctx, { name: `familista-drill-${ctx.nonce.slice(0, 12)}`, db: DRILL_DB, publishLoopback: false });
  proveIsolated(ctx.docker, target.name, ctx.nonce);
  const [before] = [...psqlRows(ctx.docker, target, "SELECT 'tables', count(*)::text FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema');\n").values()];
  if (before !== '0') throw new DrillError('the new target database is not empty');
  const url = targetUrl(target.password);
  assertLoopbackTarget(url);

  ctx.log(`Restoring into ${target.name} (PostgreSQL 18, no published port) ...`);
  const drillFile = writeEnvFile(ctx.work, 'drill.env', { ...storeEnv, DRILL_DATABASE_URL: url, DRILL_CONFIRM_ISOLATED: 'yes' });
  let run;
  try {
    run = ctx.docker(runnerArgs({ user: ctx.user, network: `container:${target.name}`, envFiles: [keysFile, drillFile], mounts: mount, command: ['drill', objectKey] }),
      { timeoutMs: 40 * 60_000 });
  } finally {
    fs.rmSync(drillFile, { force: true });
  }
  let report = lastJsonLine(run.stdout) || { ok: false, error: `the drill produced no report (exit ${run.code})` };
  if (run.code !== 0 && report.ok) report = { ok: false, error: `the drill exited ${run.code}` };
  if (!report.ok) report = { ...report, error: ctx.redact(report.error) };
  const db = report.ok ? inspectRestored(ctx.docker, target, rlsTables) : null;
  return { objectKey, report, db, target, mount };
}

/** The self-test's backup: the repository's migrations and runner (pg_dump 18) on a seeded throwaway source. */
async function selfTestBackup(ctx) {
  const keysDir = path.join(ctx.work, 'keys');
  const kg = spawnSync(process.execPath, [path.join(ROOT, 'dist', 'scripts', 'backup.js'), 'keygen', keysDir],
    { encoding: 'utf8', env: { PATH: process.env.PATH } });
  if (kg.status !== 0) throw new DrillError('could not generate the self-test keys (is the repository built?)');

  const src = startPostgres(ctx, { name: `familista-drill-src-${ctx.nonce.slice(0, 8)}`, db: SOURCE_DB, publishLoopback: true });
  const binding = ctx.docker(['port', src.name, '5432/tcp']).stdout.trim().split('\n')[0] || '';
  const port = binding.startsWith('127.0.0.1:') ? binding.slice('127.0.0.1:'.length) : '';
  if (!/^\d+$/.test(port)) throw new DrillError('the self-test source is not bound to loopback');
  const hostUrl = `postgresql://${PG_USER}:${encodeURIComponent(src.password)}@127.0.0.1:${port}/${SOURCE_DB}`;

  ctx.log('Self-test: migrating a throwaway source with the repository\'s migrations ...');
  const mig = spawnSync('npx', ['prisma', 'migrate', 'deploy', '--schema=prisma/schema.prisma'],
    { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, DATABASE_URL: hostUrl, DIRECT_URL: hostUrl } });
  if (mig.status !== 0) throw new DrillError(`the self-test source could not be migrated: ${ctx.redact((mig.stderr || mig.stdout || '').trim().split('\n').pop())}`);

  // Rows in the row-level-security tables the verdict holds to account, written as the owner role (which bypasses RLS).
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: hostUrl } } });
  try {
    const club = await prisma.club.create({ data: { name: 'Drill FC', city: 'Drilltown' } });
    const team = await prisma.team.create({ data: { clubId: club.id, name: 'Drill First Team' } });
    const user = await prisma.user.create({
      data: { email: 'drill-owner@example.invalid', passwordHash: 'not-a-real-hash', firstName: 'Drill', lastName: 'Owner', clubId: club.id },
    });
    await prisma.membership.create({ data: { userId: user.id, clubId: club.id, role: 'CLUB_OWNER' } });
    for (const [number, position] of [[1, 'GK'], [8, 'MC']]) {
      await prisma.player.create({
        data: { firstName: 'Drill', lastName: `Player ${number}`, number, position, nationality: 'Nowhere', flag: 'XX',
          dateOfBirth: new Date('2000-01-01T00:00:00Z'), height: 180, weight: 75, clubId: club.id, teamId: team.id },
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  ctx.log('Self-test: taking an encrypted, signed backup with the repository\'s runner (pg_dump 18) ...');
  const store = path.join(ctx.work, 'store');
  fs.mkdirSync(store, { mode: 0o700 });
  const backupEnv = writeEnvFile(ctx.work, 'selftest-backup.env', {
    NODE_ENV: 'test', BACKUP_STORE: 'file', BACKUP_FILE_DIR: '/store', DATABASE_URL: targetUrl(src.password, SOURCE_DB),
  });
  let r;
  try {
    r = ctx.docker(runnerArgs({ user: ctx.user, network: `container:${src.name}`, envFiles: [path.join(keysDir, 'runner.env'), backupEnv], mounts: [`${store}:/store`], command: ['run'] }),
      { timeoutMs: 15 * 60_000 });
  } finally {
    fs.rmSync(backupEnv, { force: true });
  }
  const made = lastJsonLine(r.stdout);
  if (r.code !== 0 || !made || made.ok !== true) throw new DrillError(`the self-test backup failed: ${ctx.redact((made && made.error) || `exit ${r.code}`)}`);
  return { store, keysFile: path.join(keysDir, 'offline-restore.env') };
}

/** The same drill must refuse a backup with one byte changed — before anything reaches the target. */
function tamperCheck(ctx, { store, keysFile, objectKey, target }) {
  const tampered = path.join(ctx.work, 'store-tampered');
  fs.cpSync(store, tampered, { recursive: true });
  const file = path.join(tampered, ...objectKey.split('/'));
  const buf = fs.readFileSync(file);
  buf[buf.length - 1] ^= 0xff;
  fs.writeFileSync(file, buf);
  const drillFile = writeEnvFile(ctx.work, 'tamper.env', {
    BACKUP_STORE: 'file', BACKUP_FILE_DIR: '/store', DRILL_DATABASE_URL: targetUrl(target.password), DRILL_CONFIRM_ISOLATED: 'yes',
  });
  let run;
  try {
    run = ctx.docker(runnerArgs({ user: ctx.user, network: `container:${target.name}`, envFiles: [keysFile, drillFile], mounts: [`${tampered}:/store:ro`], command: ['drill', objectKey] }),
      { timeoutMs: 10 * 60_000 });
  } finally {
    fs.rmSync(drillFile, { force: true });
  }
  const out = lastJsonLine(run.stdout);
  const refused = run.code !== 0 && out && out.ok === false && /does not match its signed manifest/.test(String(out.error));
  return { ok: refused, detail: refused ? 'a backup with one byte changed was refused (it does not match its signed manifest)' : 'a tampered backup was NOT refused' };
}

async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const mode = argv.includes('--self-test') ? 'self-test' : 'latest';
  const docker = deps.docker || dockerRunner();
  const write = deps.out || ((line) => process.stdout.write(`${line}\n`));
  const summaryFile = deps.summaryFile !== undefined ? deps.summaryFile : env.GITHUB_STEP_SUMMARY;
  const secrets = SECRET_SETTINGS.map((k) => env[k]);
  let redact = redactor(secrets);
  const exactCounts = mode === 'self-test' || String(env.RESTORE_DRILL_SHOW_COUNTS || '').trim() === 'true';
  const work = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'fam-restore-drill-'));
  fs.chmodSync(work, 0o700);
  const ctx = {
    docker, work, containers: [],
    nonce: crypto.randomBytes(16).toString('hex'),
    user: deps.user || `${process.getuid()}:${process.getgid()}`,
    log: (line) => write(redact(line)),
    redact: (text) => redact(text),
    secret: (value) => {
      secrets.push(value);
      redact = redactor(secrets);
      if (env.GITHUB_ACTIONS === 'true') write(`::add-mask::${value}`);
    },
  };

  let result = { mode, pass: false, checks: [], exactCounts };
  try {
    refuseProductionSettings(env);
    let storeEnv; let storeMount = null; let keysFile; let store;
    const expectedHead = latestMigration(deps.root || ROOT);
    const rlsTables = protectedTables(deps.root || ROOT);
    if (mode === 'self-test') {
      refuseSecretsInSelfTest(env);
    } else {
      const s = realSettings(env);
      storeEnv = Object.fromEntries([...STORE_SETTINGS, ...OPTIONAL_STORE_SETTINGS].filter((k) => s[k]).map((k) => [k, s[k]]));
      keysFile = writeEnvFile(work, 'keys.env', { BACKUP_ENCRYPTION_PRIVATE_KEY: s.BACKUP_ENCRYPTION_PRIVATE_KEY, BACKUP_SIGNING_PUBLIC_KEY: s.BACKUP_SIGNING_PUBLIC_KEY });
    }
    if (!fs.existsSync(path.join(ROOT, 'dist', 'scripts', 'backup.js'))) throw new DrillError('dist/scripts/backup.js is missing: run npm run build first');
    if (docker(['version', '--format', '{{.Server.Version}}']).code !== 0) throw new DrillError('Docker is not available on this host');
    ctx.log(`Building ${RUNNER_IMAGE} (pg_restore 18 + Node 20) ...`);
    const built = docker(['build', '-q', '-t', RUNNER_IMAGE, path.join(ROOT, 'scripts', 'restore-drill')], { timeoutMs: 15 * 60_000 });
    if (built.code !== 0) throw new DrillError(`could not build ${RUNNER_IMAGE}: ${redact(lastLine(built.stderr))}`);
    if (mode === 'self-test') {
      const made = await selfTestBackup(ctx);
      store = made.store; keysFile = made.keysFile; storeMount = made.store;
      storeEnv = { BACKUP_STORE: 'file', BACKUP_FILE_DIR: '/store' };
    }
    const d = drill(ctx, { storeEnv, storeMount, keysFile, rlsTables });
    const verdict = evaluate({ report: d.report, db: d.db, expectedHead, rlsTables });
    result = { ...result, ...verdict, report: d.report, db: d.db, expectedHead, rlsTables };
    if (mode === 'self-test' && verdict.pass) {
      const t = tamperCheck(ctx, { store, keysFile, objectKey: d.objectKey, target: d.target });
      result.checks.push({ name: 'A tampered backup is refused', ok: t.ok, detail: t.detail });
      result.tamper = t.detail;
      result.pass = result.checks.every((c) => c.ok);
    }
  } catch (err) {
    result = { ...result, pass: false, failure: redact((err && err.message) || String(err)) };
  } finally {
    for (const name of ctx.containers.reverse()) docker(['rm', '-f', '-v', name], { timeoutMs: 2 * 60_000 });
    fs.rmSync(work, { recursive: true, force: true });
  }

  const { lines, summary } = render(result);
  for (const l of lines) write(redact(l));
  if (!result.pass && env.GITHUB_ACTIONS === 'true') write(`::error title=Restore drill::${redact(lines[1] || lines[0])}`);
  if (summaryFile) {
    try { fs.appendFileSync(summaryFile, redact(summary)); } catch { /* the verdict is already in the log */ }
  }
  return result.pass ? 0 : 1;
}

module.exports = {
  main, evaluate, render, refuseProductionSettings, refuseSecretsInSelfTest, realSettings, isBackupKey,
  targetUrl, assertLoopbackTarget, proveIsolated, latestMigration, protectedTables, redactor, writeEnvFile,
  runnerArgs, lastJsonLine, inspectRestored, DrillError,
  PRODUCTION_SETTINGS, STORE_SETTINGS, KEY_SETTINGS, CORE_TABLES, MUST_HAVE_ROWS, PG_IMAGE, LABEL,
};

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    process.stdout.write(`RESTORE DRILL: FAIL\nReason: ${(err && err.name) || 'error'} before the verdict\n`);
    process.exitCode = 1;
  });
}
