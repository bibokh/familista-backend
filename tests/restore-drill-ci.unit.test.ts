/**
 * tests/restore-drill-ci.unit.test.ts
 *
 * The automated restore drill (scripts/restore-drill-ci.js and
 * .github/workflows/restore-drill.yml), without Docker: every guard that keeps
 * production out of reach, every check behind the verdict, and a whole run
 * against a stand-in `docker` that records each command and each --env-file as
 * it is used — so the tests can prove no secret ever reaches a command line, a
 * log line or the job summary, and that a failure still removes the target.
 *
 * The real thing — real containers, a real pg_dump 18 backup, a real restore —
 * runs as the workflow's self-test on every pull request that touches the drill.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const drillCi = require('../scripts/restore-drill-ci.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const checks = require('../scripts/lib/workflow-checks');
import { RLS_PILOT_MODELS } from '../src/security/db-context';

const ROOT = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
type Row = Record<string, any>;

const SECRETS = {
  BACKUP_S3_BUCKET: 'familista-backups-test-bucket',
  BACKUP_S3_REGION: 'eu-central-003',
  BACKUP_S3_ENDPOINT: 'https://s3.eu-central-003.example.invalid',
  BACKUP_S3_ACCESS_KEY_ID: 'AKIDTESTKEYID1234567',
  BACKUP_S3_SECRET_ACCESS_KEY: 'SeCrEtTeStKeY+/abcdefghijklmnopqrstuvwxyz',
  BACKUP_ENCRYPTION_PRIVATE_KEY: 'MC4CAQAwBQYDK2VuBCIEIPrivateRestoreKeyMaterialAAAAAAAAAAAAAAAAA=',
  BACKUP_SIGNING_PUBLIC_KEY: 'MCowBQYDK2VwAyEASigningPublicKeyMaterialBBBBBBBBBBBBBBBBBBBBBBB=',
};
const HEAD = drillCi.latestMigration();
const RLS = [...RLS_PILOT_MODELS].sort();

describe('guards: production is never within reach', () => {
  it('refuses to start with any production setting present — named, never shown', () => {
    for (const k of ['DATABASE_URL', 'DIRECT_URL', 'BACKUP_DATABASE_URL', 'MIGRATE_DATABASE_URL', 'DRILL_DATABASE_URL']) {
      const value = 'postgresql://owner:hunter2@ep-prod-pooler.example.invalid/neondb';
      let msg = '';
      try { drillCi.refuseProductionSettings({ [k]: value }); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain(k);
      expect(msg).not.toContain('hunter2');
      expect(msg).not.toContain('example.invalid');
    }
    expect(() => drillCi.refuseProductionSettings({ NODE_ENV: 'production' })).toThrow(/NODE_ENV=production/);
    expect(() => drillCi.refuseProductionSettings({ DATABASE_URL: '  ', NODE_ENV: 'test' })).not.toThrow();
  });

  it('restores only to loopback — a production or remote host is refused', () => {
    const url = drillCi.targetUrl('p@ss/word');
    expect(url).toBe('postgresql://postgres:p%40ss%2Fword@127.0.0.1:5432/familista_drill');
    expect(() => drillCi.assertLoopbackTarget(url)).not.toThrow();
    for (const host of ['ep-prod-pooler.example.invalid', 'dpg-abc123-a', '10.0.0.5', '0.0.0.0', 'db.internal']) {
      expect(() => drillCi.assertLoopbackTarget(`postgresql://u:p@${host}:5432/x`)).toThrow(/throwaway container/);
    }
    expect(() => drillCi.assertLoopbackTarget('not a url')).toThrow(/not valid/);
  });

  it('proves the target is the container this run made: its label, its image, and no published port', () => {
    const inspect = (labels: Row, bindings: unknown, ports: unknown, image = drillCi.PG_IMAGE, code = 0) => () =>
      ({ code, stdout: `${JSON.stringify(labels)}\t${JSON.stringify(bindings)}\t${JSON.stringify(ports)}\t${image}\n`, stderr: '' });
    const ok = { [drillCi.LABEL]: 'n0nce' };
    expect(() => drillCi.proveIsolated(inspect(ok, {}, { '5432/tcp': null }), 't', 'n0nce')).not.toThrow();
    expect(() => drillCi.proveIsolated(inspect({ [drillCi.LABEL]: 'other' }, {}, {}), 't', 'n0nce')).toThrow(/not the container this run created/);
    expect(() => drillCi.proveIsolated(inspect({}, {}, {}), 't', 'n0nce')).toThrow(/not the container this run created/);
    expect(() => drillCi.proveIsolated(inspect(ok, { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] }, {}), 't', 'n0nce')).toThrow(/publishes a port/);
    expect(() => drillCi.proveIsolated(inspect(ok, {}, { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] }), 't', 'n0nce')).toThrow(/publishes a port/);
    expect(() => drillCi.proveIsolated(inspect(ok, {}, {}, 'postgres:16'), 't', 'n0nce')).toThrow(/not a postgres:18/);
    expect(() => drillCi.proveIsolated(inspect(ok, {}, {}, drillCi.PG_IMAGE, 1), 't', 'n0nce')).toThrow(/could not be inspected/);
  });

  it('names missing settings, never values, and refuses malformed ones', () => {
    let msg = '';
    try { drillCi.realSettings({ BACKUP_S3_BUCKET: SECRETS.BACKUP_S3_BUCKET }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/not configured: .*BACKUP_S3_ACCESS_KEY_ID.*BACKUP_ENCRYPTION_PRIVATE_KEY/);
    expect(msg).not.toContain(SECRETS.BACKUP_S3_BUCKET);
    expect(drillCi.realSettings(SECRETS)).toMatchObject(SECRETS);
    expect(() => drillCi.realSettings({ ...SECRETS, BACKUP_S3_SECRET_ACCESS_KEY: 'two words' })).toThrow(/single token/);
    expect(() => drillCi.realSettings({ ...SECRETS, BACKUP_S3_ENDPOINT: 'http://plain.example.invalid' })).toThrow(/https/);
    expect(() => drillCi.realSettings({ ...SECRETS, BACKUP_ENCRYPTION_PRIVATE_KEY: 'not-base64!' })).toThrow(/not a base64 key/);
  });

  it('the self-test refuses to be handed a real secret', () => {
    expect(() => drillCi.refuseSecretsInSelfTest({})).not.toThrow();
    expect(() => drillCi.refuseSecretsInSelfTest({ BACKUP_ENCRYPTION_PRIVATE_KEY: 'x' })).toThrow(/without secrets/);
  });

  it('accepts only a .fbk backup key, never a manifest or a path escape', () => {
    expect(drillCi.isBackupKey('2026/10/06/familista-20261006T113259Z-1a2b3c4d.fbk')).toBe(true);
    for (const k of ['2026/10/06/x.fbk.manifest.json', '../x.fbk', '/abs/x.fbk', '2026/x.sql', 'x.fbk; rm -rf /', '']) {
      expect(drillCi.isBackupKey(k)).toBe(false);
    }
  });
});

describe('secrets never travel by command line or log', () => {
  it('writes --env-file files 0600, refuses a value that could add a line, and never overwrites', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-env-'));
    try {
      const f = drillCi.writeEnvFile(dir, 'a.env', { A_KEY: 'v=1', B: 'x' });
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(f, 'utf8')).toBe('A_KEY=v=1\nB=x\n');
      expect(() => drillCi.writeEnvFile(dir, 'b.env', { A: 'x\nDRILL_CONFIRM_ISOLATED=yes' })).toThrow(/single line/);
      expect(() => drillCi.writeEnvFile(dir, 'c.env', { 'bad name': 'x' })).toThrow(/invalid setting name/);
      expect(() => drillCi.writeEnvFile(dir, 'a.env', { A: 'x' })).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('masks secret values, connection strings and URLs in anything printed', () => {
    const r = drillCi.redactor(Object.values(SECRETS));
    const text = `key ${SECRETS.BACKUP_S3_SECRET_ACCESS_KEY} at ${SECRETS.BACKUP_S3_ENDPOINT}/bucket and postgresql://u:p@h:5432/d done`;
    const out = r(text);
    for (const v of Object.values(SECRETS)) expect(out).not.toContain(v);
    expect(out).not.toMatch(/postgresql:\/\/|https:\/\//);
    expect(out).toMatch(/done$/);
  });

  it('the runner container gets the checkout read-only, no capabilities, this uid, and env files only', () => {
    const args = drillCi.runnerArgs({ user: '1001:118', network: 'container:t', envFiles: ['/w/k.env', '/w/d.env'], command: ['drill', 'x.fbk'] });
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1001:118']));
    expect(args).toContain(`${ROOT}:/app:ro`);
    expect(args.filter((a: string) => a === '--env-file')).toHaveLength(2);
    expect(args.join(' ')).not.toMatch(/-e [A-Z_]*(KEY|SECRET|PASSWORD|URL)=/);
  });
});

describe('repository facts the verdict holds a restore to', () => {
  it('the newest migration is the last migration directory in the repository', () => {
    const dirs = fs.readdirSync(path.join(ROOT, 'prisma/migrations')).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(HEAD).toBe(dirs[dirs.length - 1]);
  });

  it('the protected tables are exactly the ones the application enforces row-level security on', () => {
    expect(drillCi.protectedTables()).toEqual(RLS);
    expect(RLS).toEqual(expect.arrayContaining(['Player', 'Membership']));
  });
});

const REPORT = {
  ok: true, objectKey: '2026/10/06/familista-20261006T113259Z-1a2b3c4d.fbk', createdAt: '2026-10-06T11:32:59.451Z',
  migrationHead: HEAD, restoredMigrationHead: HEAD, tables: 360,
  rowCounts: { User: 41, Club: 4, Team: 9, Player: 212, Membership: 57, _prisma_migrations: 60 },
  durationMs: 4200,
  ciphertextSha256: 'a'.repeat(64), ciphertextBytes: 1234567, plaintextSha256: 'b'.repeat(64), plaintextBytes: 2345678,
  encryptionKeyId: 'c'.repeat(32), signingKeyId: 'd'.repeat(32),
};
function dbFor(over: Row = {}) {
  const tableState = new Map(RLS.map((t) => [t, { rls: true, forced: true, policies: 2 }]));
  for (const t of ['User', 'Club', 'Team', '_prisma_migrations']) tableState.set(t, { rls: false, forced: false, policies: 0 });
  const rows: Record<string, number> = { User: 41, Club: 4, Team: 9 };
  for (const t of RLS) rows[t] = t === 'Player' ? 212 : t === 'Membership' ? 57 : 0;
  return { tables: 360, head: HEAD, tableState, rows, ...over };
}

describe('the verdict', () => {
  const run = (report: Row, db: Row | null) => drillCi.evaluate({ report, db, expectedHead: HEAD, rlsTables: RLS });

  it('passes only when the drill succeeded and the restored database agrees with it on every count', () => {
    const v = run(REPORT, dbFor());
    expect(v.pass).toBe(true);
    expect(v.checks.map((c: Row) => c.name)).toEqual([
      'Backup authenticated, decrypted and restored',
      'Schema head is the newest migration',
      'Restored tables match the drill',
      'Core row counts match the drill',
      'Core tables hold rows (Player and Membership are row-level-security protected)',
      'Row-level security restored on every protected table',
    ]);
  });

  it('fails on a failed drill, with its reason', () => {
    const v = run({ ok: false, error: 'backup does not match its signed manifest' }, null);
    expect(v.pass).toBe(false);
    expect(v.checks[0].detail).toMatch(/does not match its signed manifest/);
  });

  it('fails when the schema head is behind the repository, or differs from the manifest', () => {
    expect(run(REPORT, dbFor({ head: '20250101000000_old' })).pass).toBe(false);
    expect(run({ ...REPORT, migrationHead: '20250101000000_old' }, dbFor()).pass).toBe(false);
  });

  it('fails when the database disagrees with the drill about tables or core rows', () => {
    expect(run(REPORT, dbFor({ tables: 359 })).pass).toBe(false);
    const db = dbFor();
    db.rows.Membership = 56;
    const v = run(REPORT, db);
    expect(v.pass).toBe(false);
    expect(v.checks.find((c: Row) => !c.ok).detail).toMatch(/Membership/);
  });

  it('fails when a row-level-security table came back empty — a dump made without the system context', () => {
    for (const t of ['Player', 'Membership']) {
      const db = dbFor();
      db.rows[t] = 0;
      const report = { ...REPORT, rowCounts: { ...REPORT.rowCounts, [t]: 0 } };
      const v = run(report, db);
      expect(v.pass).toBe(false);
      expect(v.checks.find((c: Row) => !c.ok).detail).toBe(`no rows: ${t}`);
    }
  });

  it('fails when row-level security did not come back: a table missing, not forced, or without its policy', () => {
    const missing = dbFor(); missing.tableState.delete('PlayerInjury');
    const unforced = dbFor(); unforced.tableState.set('VideoAsset', { rls: true, forced: false, policies: 2 });
    const noPolicy = dbFor(); noPolicy.tableState.set('StaffClubNote', { rls: true, forced: true, policies: 0 });
    expect(run(REPORT, missing).checks.find((c: Row) => !c.ok).detail).toMatch(/missing: PlayerInjury/);
    expect(run(REPORT, unforced).checks.find((c: Row) => !c.ok).detail).toMatch(/not forced: VideoAsset/);
    expect(run(REPORT, noPolicy).checks.find((c: Row) => !c.ok).detail).toMatch(/no policy: StaffClubNote/);
  });

  it('prints one verdict line first, the evidence after, and no exact counts unless allowed', () => {
    const v = run(REPORT, dbFor());
    const base = { mode: 'latest', ...v, report: REPORT, db: dbFor(), expectedHead: HEAD, rlsTables: RLS };
    const hidden = drillCi.render({ ...base, exactCounts: false }).lines.join('\n');
    expect(hidden.split('\n')[0]).toBe('RESTORE DRILL: PASS');
    expect(hidden).toContain('a'.repeat(64));
    expect(hidden).toContain('1234567 bytes');
    expect(hidden).toContain(`Schema head: ${HEAD} (the repository's newest migration)`);
    expect(hidden).toMatch(/Player present, Membership present/);
    expect(hidden).not.toMatch(/\b(212|57|41)\b/);
    const exact = drillCi.render({ ...base, exactCounts: true }).lines.join('\n');
    expect(exact).toMatch(/Player 212/);
    const failed = drillCi.render({ mode: 'latest', pass: false, checks: [], failure: 'the restore drill is not configured: BACKUP_S3_BUCKET not set' });
    expect(failed.lines.slice(0, 2)).toEqual(['RESTORE DRILL: FAIL', 'Reason: the restore drill is not configured: BACKUP_S3_BUCKET not set']);
    expect(drillCi.render({ mode: 'self-test', pass: true, checks: [] }).lines[0]).toBe('RESTORE DRILL SELF-TEST: PASS');
  });
});

// ── a whole run, against a stand-in docker ──────────────────────────────────

interface Call { args: string[]; files: Record<string, string>; input?: string }

function fakeDocker(opts: { publishLeak?: boolean; notEmpty?: boolean; drillReport?: Row; listing?: Row; noDocker?: boolean } = {}) {
  const calls: Call[] = [];
  let label = '';
  const docker = (args: string[], o: Row = {}) => {
    const files: Record<string, string> = {};
    args.forEach((a, i) => { if (a === '--env-file') files[args[i + 1]] = fs.readFileSync(args[i + 1], 'utf8'); });
    calls.push({ args, files, input: o.input });
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'version') return opts.noDocker ? { code: 1, stdout: '', stderr: 'no daemon' } : ok('27.0.0');
    if (args[0] === 'build' || args[0] === 'rm') return ok();
    if (args[0] === 'run' && args[1] === '-d') { label = args[args.indexOf('--label') + 1].split('=')[1]; return ok('cid\n'); }
    if (args[0] === 'inspect') {
      const bindings = opts.publishLeak ? { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] } : {};
      return ok(`${JSON.stringify({ [drillCi.LABEL]: label })}\t${JSON.stringify(bindings)}\t{"5432/tcp":null}\t${drillCi.PG_IMAGE}\n`);
    }
    if (args[0] === 'exec' && args.includes('pg_isready')) return ok();
    if (args[0] === 'exec' && args.includes('-Atc')) return ok('1\n');
    if (args[0] === 'exec' && args[1] === '-i') {
      const sql = String(o.input);
      if (/NOT IN \('pg_catalog'/.test(sql)) return ok(`tables|${opts.notEmpty ? '3' : '0'}\n`);
      if (/migration_head/.test(sql)) {
        const tables = [...RLS.map((t) => `table:${t}|rls:forced:2`), 'table:User|plain:unforced:0', 'table:Club|plain:unforced:0', 'table:Team|plain:unforced:0'];
        return ok(['public_tables|360', `migration_head|${HEAD}`, ...tables].join('\n'));
      }
      const counts = { User: 41, Club: 4, Team: 9, Player: 212, Membership: 57 } as Record<string, number>;
      return ok([...sql.matchAll(/'rows:(\w+)'/g)].map((m) => `rows:${m[1]}|${counts[m[1]] ?? 0}`).join('\n'));
    }
    if (args[0] === 'run' && args.includes('latest')) return ok(`${JSON.stringify(opts.listing ?? { ok: true, objectKey: REPORT.objectKey, lastModified: REPORT.createdAt, size: 1234567, complete: 6 })}\n`);
    if (args[0] === 'run' && args.includes('drill')) {
      const report = opts.drillReport ?? REPORT;
      return { code: report.ok ? 0 : 1, stdout: `${JSON.stringify(report)}\n`, stderr: '' };
    }
    throw new Error(`unexpected docker call: ${args.join(' ')}`);
  };
  return { docker, calls };
}

async function runMain(env: Row, docker: Row) {
  const out: string[] = [];
  const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drill-summary-'));
  const summaryFile = path.join(summaryDir, 'summary.md');
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('fam-restore-drill-')));
  try {
    const code = await drillCi.main([], { ...env, RUNNER_TEMP: '' }, { docker: docker.docker, out: (l: string) => out.push(l), summaryFile, user: '1001:118' });
    const leftovers = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('fam-restore-drill-') && !before.has(d));
    return { code, out: out.join('\n'), summary: fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '', leftovers };
  } finally {
    fs.rmSync(summaryDir, { recursive: true, force: true });
  }
}

describe('a whole drill run', () => {
  it('passes, and nothing secret reaches a command line, a log line or the summary', async () => {
    const d = fakeDocker();
    const r = await runMain(SECRETS, d);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^RESTORE DRILL: PASS$/m);
    expect(r.out).toMatch(/Checks: 6 of 6 passed/);
    expect(r.leftovers).toEqual([]);

    const target = d.calls.find((c) => c.args[0] === 'run' && c.args[1] === '-d')!;
    const password = /POSTGRES_PASSWORD=(\w+)/.exec(Object.values(target.files)[0])![1];
    const forbidden = [...Object.values(SECRETS), password];
    for (const c of d.calls) {
      for (const v of forbidden) expect(c.args.join(' ')).not.toContain(v);
      expect(c.args.join(' ')).not.toMatch(/postgres(ql)?:\/\//);
    }
    for (const v of forbidden) {
      expect(r.out).not.toContain(v);
      expect(r.summary).not.toContain(v);
    }
    expect(r.out).not.toMatch(/https?:\/\/|postgres(ql)?:\/\//);
    expect(r.summary).toMatch(/RESTORE DRILL: PASS/);
  });

  it('starts the target with no published port, proves it, and restores into it over its own network only', async () => {
    const d = fakeDocker();
    await runMain(SECRETS, d);
    const target = d.calls.find((c) => c.args[0] === 'run' && c.args[1] === '-d')!;
    expect(target.args).not.toContain('-p');
    expect(target.args).not.toContain('--publish');
    expect(target.args[target.args.length - 1]).toBe(drillCi.PG_IMAGE);
    const name = target.args[target.args.indexOf('--name') + 1];
    const order = d.calls.map((c) => c.args[0] === 'inspect' ? 'inspect' : c.args.includes('drill') ? 'drill' : c.args[0] === 'rm' ? 'rm' : '');
    expect(order.indexOf('inspect')).toBeLessThan(order.indexOf('drill'));
    expect(order.lastIndexOf('rm')).toBeGreaterThan(order.indexOf('drill'));

    const drill = d.calls.find((c) => c.args.includes('drill'))!;
    expect(drill.args).toEqual(expect.arrayContaining(['--network', `container:${name}`]));
    const env = Object.values(drill.files).join('');
    expect(env).toMatch(/^DRILL_DATABASE_URL=postgresql:\/\/postgres:\w+@127\.0\.0\.1:5432\/familista_drill$/m);
    expect(env).toMatch(/^DRILL_CONFIRM_ISOLATED=yes$/m);
    expect(env).not.toMatch(/^(DATABASE_URL|DIRECT_URL|BACKUP_DATABASE_URL)=/m);

    const listing = d.calls.find((c) => c.args.includes('latest'))!;
    const listEnv = Object.values(listing.files).join('');
    expect(listEnv).toContain('BACKUP_S3_ACCESS_KEY_ID=');
    expect(listEnv).not.toMatch(/BACKUP_ENCRYPTION_PRIVATE_KEY|DRILL_DATABASE_URL/);
    expect(d.calls.find((c) => c.args[0] === 'rm')!.args).toEqual(['rm', '-f', '-v', name]);
  });

  it('shows exact counts only when the repository allows it', async () => {
    const hidden = await runMain(SECRETS, fakeDocker());
    expect(hidden.out).not.toMatch(/Player 212/);
    const shown = await runMain({ ...SECRETS, RESTORE_DRILL_SHOW_COUNTS: 'true' }, fakeDocker());
    expect(shown.out).toMatch(/Player 212/);
  });

  it('refuses before touching Docker when a production setting is present or a secret is missing', async () => {
    for (const env of [{ ...SECRETS, DATABASE_URL: 'postgresql://x:y@prod.example.invalid/db' }, { BACKUP_S3_BUCKET: 'b' }]) {
      const d = fakeDocker();
      const r = await runMain(env, d);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/^RESTORE DRILL: FAIL$/m);
      expect(d.calls).toHaveLength(0);
      expect(r.out).not.toContain('prod.example.invalid');
      expect(r.leftovers).toEqual([]);
    }
  });

  it('never restores into a target that publishes a port or is not empty — and still removes it', async () => {
    for (const opts of [{ publishLeak: true }, { notEmpty: true }]) {
      const d = fakeDocker(opts);
      const r = await runMain(SECRETS, d);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(opts.publishLeak ? /publishes a port/ : /not empty/);
      expect(d.calls.some((c) => c.args.includes('drill'))).toBe(false);
      expect(d.calls.some((c) => c.args[0] === 'rm')).toBe(true);
    }
  });

  it('fails on a failed drill, sanitized, and removes the target', async () => {
    const d = fakeDocker({ drillReport: { ok: false, error: `backup does not match its signed manifest (${SECRETS.BACKUP_S3_ENDPOINT})` } });
    const r = await runMain(SECRETS, d);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Reason: Backup authenticated, decrypted and restored — the drill failed: backup does not match its signed manifest/);
    expect(r.out).not.toContain(SECRETS.BACKUP_S3_ENDPOINT);
    expect(d.calls.some((c) => c.args[0] === 'rm')).toBe(true);
  });

  it('fails without Docker, and when the listing finds no backup', async () => {
    expect((await runMain(SECRETS, fakeDocker({ noDocker: true }))).out).toMatch(/Docker is not available/);
    const none = await runMain(SECRETS, fakeDocker({ listing: { ok: false, error: 'no complete backup: every .fbk found lacks its signed manifest' } }));
    expect(none.out).toMatch(/no backup to restore: no complete backup/);
  });
});

describe('the workflow', () => {
  const W = read('.github/workflows/restore-drill.yml');
  const selfTest = W.split(/\n {2}self-test:\n/)[1].split(/\n {2}drill:\n/)[0];
  const drillJob = W.split(/\n {2}drill:\n/)[1];

  it('runs weekly and on demand, and self-tests pull requests that touch the drill', () => {
    expect(W).toMatch(/schedule:\n(\s+#.*\n)*\s+- cron: '23 13 \* \* 1'/);
    expect(W).toMatch(/\n {2}workflow_dispatch:\n/);
    expect(W).toMatch(/pull_request:\n\s+branches: \[main\]\n\s+paths:/);
  });

  it('the self-test is given no secret; the real drill runs only on main, from its environment', () => {
    expect(selfTest).toMatch(/run: node scripts\/restore-drill-ci\.js --self-test/);
    expect(selfTest).not.toMatch(/secrets\.|vars\.|environment:/);
    expect(drillJob).toMatch(/needs: self-test/);
    expect(drillJob).toMatch(/if: github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/);
    expect(drillJob).toMatch(/environment: restore-drill/);
    expect(drillJob).toMatch(/run: node scripts\/restore-drill-ci\.js\s*$/);
  });

  it('hands the drill the bucket and restore keys only — no database URL, no deploy or trigger secret', () => {
    const names = [...W.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).sort();
    expect(names).toEqual([...drillCi.STORE_SETTINGS, ...drillCi.KEY_SETTINGS, 'BACKUP_S3_PREFIX'].sort());
    expect(W).not.toMatch(/DATABASE_URL|DIRECT_URL|RENDER_|BACKUP_TRIGGER_SECRET/);
  });

  it('is least-privilege, pinned, injection-free, and leaves no token in the checkout', () => {
    expect(checks.leastPrivilege(W)).toBe(true);
    expect(checks.actionRefs(W).every((r: Row) => r.pinned)).toBe(true);
    expect(checks.expressionInScript(W)).toBe(false);
    for (const c of W.split('uses: actions/checkout@').slice(1)) expect(c.slice(0, 200)).toMatch(/persist-credentials:\s*false/);
    expect(W).toMatch(/timeout-minutes: 30/);
    expect(W).toMatch(/timeout-minutes: 45/);
  });
});
