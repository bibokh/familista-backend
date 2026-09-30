/**
 * tests/restore-drill-script.unit.test.ts
 *
 * Cyber Defense, Step 10 — the Windows restore drill (scripts/restore-drill.ps1).
 *
 * The failure it exists for: pasted drill steps fed their own next lines into
 * hidden prompts, so BACKUP_S3_SECRET_ACCESS_KEY was never set — and
 * `docker run -e NAME` passes nothing, silently, for a variable that is not set,
 * so the drill only said "BACKUP_S3_SECRET_ACCESS_KEY is required". The script
 * is run as one command, validates each hidden input, and hands secrets to the
 * container through a temporary --env-file checked by name first.
 *
 * The second finding it encodes: production backups come from pg_dump 18,
 * which only pg_restore 18 reads, and which a PostgreSQL 16 server rejects
 * (`SET transaction_timeout`). The drill restores into PostgreSQL 18.
 *
 * Driven end to end (pwsh 7, Docker, an S3-compatible server, a pg_dump 18
 * backup of a PostgreSQL 16 source) when this was written; pinned here.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const PS1 = fs.readFileSync(path.join(ROOT, 'scripts/restore-drill.ps1'), 'utf8');
const DOCKERFILE = fs.readFileSync(path.join(ROOT, 'scripts/restore-drill/Dockerfile'), 'utf8');
const code = PS1.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The two credential patterns, as the script declares them (.NET and JS agree on these). */
function pattern(name: string): RegExp {
  const m = new RegExp(`Read-Secret '${name}' '([^']+)'`).exec(PS1);
  if (!m) throw new Error(`no pattern for ${name}`);
  return new RegExp(m[1]);
}

describe('scripts/restore-drill.ps1', () => {
  it('is plain ASCII, so Windows PowerShell 5.1 reads it the same way (no BOM needed)', () => {
    expect(/[^\x00-\x7F]/.test(PS1)).toBe(false);
  });

  it('asks for credentials only at hidden prompts', () => {
    const prompts = [...code.matchAll(/Read-Host\b[^\n]*/g)].map((m) => m[0]);
    expect(prompts.length).toBeGreaterThan(0);
    for (const p of prompts) expect(p).toMatch(/-AsSecureString/);
    expect(code).toMatch(/ZeroFreeBSTR/);
  });

  it('refuses a pasted line of script as a credential, and accepts real-shaped keys', () => {
    const id = pattern('BACKUP_S3_ACCESS_KEY_ID');
    const secret = pattern('BACKUP_S3_SECRET_ACCESS_KEY');
    for (const bad of ["Set-SecretEnv 'BACKUP_S3_SECRET_ACCESS_KEY'", '$env:BACKUP_S3_BUCKET = "x"', '', 'a b', '"quoted"']) {
      expect(id.test(bad)).toBe(false);
      expect(secret.test(bad)).toBe(false);
    }
    // Shapes of B2 credentials (25-character key id, 31-character key), built at runtime.
    expect(id.test('0'.repeat(12) + 'a1b2c3d4e5f60')).toBe(true);
    expect(secret.test('K' + 'x'.repeat(29) + 'A')).toBe(true);
  });

  it('never moves a secret through a command line or a pass-through variable', () => {
    expect(code).not.toMatch(/'-e',\s*'BACKUP_S3/);
    expect(code).not.toMatch(/-e\s+BACKUP_S3/);
    expect(code).toMatch(/'--env-file', \$KeysFile, '--env-file', \$envFile/);
    expect(code).toMatch(/"BACKUP_S3_SECRET_ACCESS_KEY=\$secretKey"/);
  });

  it('checks every setting the drill requires, by name, before it runs', () => {
    for (const n of ['DRILL_CONFIRM_ISOLATED', 'DRILL_DATABASE_URL', 'BACKUP_ENCRYPTION_PRIVATE_KEY', 'BACKUP_SIGNING_PUBLIC_KEY',
      'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_REGION', 'BACKUP_S3_ENDPOINT']) {
      expect(code).toContain(`'${n}'`);
    }
    expect(code).toMatch(/if \(\$present -notcontains \$n\) \{ Fail "\$n is not set" \}/);
  });

  it('keeps the temporary env file private and deletes it whatever happens', () => {
    expect(code).toMatch(/icacls \$tmp \/inheritance:r \/grant:r/);
    expect(code).toMatch(/finally \{\n\s+if \(\$tmp -and \(Test-Path -LiteralPath \$tmp\)\) \{ Remove-Item -LiteralPath \$tmp -Recurse -Force \}/);
    expect(code).toMatch(/Remove-Item Env:BACKUP_S3_ACCESS_KEY_ID, Env:BACKUP_S3_SECRET_ACCESS_KEY/);
  });

  it('restores only into a throwaway PostgreSQL 18 container, never a production URL', () => {
    expect(code).toMatch(/'run', '-d', '--name', \$target,[^\n]*'postgres:18-bookworm'/);
    expect(code).not.toMatch(/'-p'|--publish/);
    expect(code).toMatch(/'--network', "container:\$target"/);
    expect(code).not.toMatch(/\bDATABASE_URL\b(?!.*DRILL)|DIRECT_URL|BACKUP_DATABASE_URL/);
    expect(code).toMatch(/Invoke-Quiet 'docker' @\('rm', '-f', '-v', \$target\)/);
  });

  it('runs the repository\'s own drill and passes only when the database agrees with it', () => {
    expect(code).toMatch(/'node', '\/app\/dist\/scripts\/backup\.js', 'drill', \$Object/);
    expect(code).toMatch(/'-v', "\$\{repo\}:\/app:ro"/);
    for (const check of ['drill ok', 'schema head matches the backup', 'tables restored']) expect(code).toContain(`'${check}'`);
    expect(code).toMatch(/\$checks\["\$t rows match"\]/);
    expect(code).toMatch(/STEP 10 RESTORE DRILL: /);
  });

  it('takes exactly one of -Latest or -Object, and checks a named key the same way as a found one', () => {
    expect(code).toMatch(/\[string\] \$Object,\n\s+\[switch\] \$Latest,/);
    expect(code).not.toMatch(/Mandatory/);
    expect(code).toMatch(/if \(\[bool\]\$Object -eq \[bool\]\$Latest\) \{ Fail /);
    expect(code).toMatch(/if \(-not \(Test-BackupKey \$Object\)\) \{ Fail 'the object must be/);
  });

  it('-Latest lists with the Read Only B2 settings only: no offline key, no database URL', () => {
    const m = /\$listArgs = @\(([^)]*)\)/.exec(code);
    expect(m).not.toBeNull();
    const args = m![1];
    expect(args).toContain("'--env-file', $storeFile");
    expect(args).not.toMatch(/KeysFile|envFile|--network/);
    expect(args).toMatch(/'node', '\/app\/dist\/scripts\/backup\.js', 'latest'/);
    // store.env is written from the B2 lines alone, then deleted as soon as the listing ends.
    expect(code).toMatch(/WriteAllText\(\$storeFile, \(\(\$storeLines -join/);
    expect(code).toMatch(/Remove-Item -LiteralPath \$storeFile -Force/);
    const storeBlock = /\$storeLines = @\(([\s\S]*?)\n\s+\)/.exec(code)![1];
    expect(storeBlock).not.toMatch(/DRILL_|PRIVATE_KEY/);
  });

  it('-Latest restores only a .fbk the listing returned, never a manifest, and stops on a failed listing', () => {
    const fn = /function Test-BackupKey[\s\S]*?\n\}/.exec(code)![0];
    expect(fn).toContain("-cmatch '^[A-Za-z0-9._\\-/]+\\.fbk$'");
    expect(fn).toContain("-not $Key.EndsWith('.manifest.json')");
    expect(code).toMatch(/if \(\$listExit -ne 0 -or -not \(Prop \$found 'ok'\)\) \{ Fail "could not find a backup to restore/);
    expect(code).toMatch(/\$Object = "\$\(Prop \$found 'objectKey'\)"\n\s+if \(-not \(Test-BackupKey \$Object\)\) \{ Fail /);
  });

  it('masks the entered credentials in anything it prints from a container', () => {
    expect(code).toMatch(/function Hide-Secrets[\s\S]{0,160}\$accessKeyId, \$secretKey[\s\S]{0,80}Replace\(\$s, '\*\*\*'\)/);
    expect(code).toMatch(/\$listOutput = @\(& docker @listArgs 2>&1 \| ForEach-Object \{ Hide-Secrets "\$_" \}\)/);
    expect(code).toMatch(/\$output = @\(& docker @dockerArgs 2>&1 \| ForEach-Object \{ Hide-Secrets "\$_" \}\)/);
  });

  it('keeps native stderr from ending Windows PowerShell 5.1 early', () => {
    expect(code).toMatch(/function Invoke-Quiet[\s\S]{0,200}\$ErrorActionPreference = 'Continue'/);
  });
});

describe('scripts/restore-drill/Dockerfile', () => {
  it('is pg_restore 18 from the official postgres image plus Node 20, nothing from a package repository', () => {
    const lines = DOCKERFILE.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual([
      'FROM node:20-bookworm AS node',
      'FROM postgres:18-bookworm',
      'COPY --from=node /usr/local/bin/node /usr/local/bin/node',
      'USER postgres',
    ]);
  });
});
