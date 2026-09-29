/**
 * tests/backup-schedule.unit.test.ts
 *
 * Cyber Defense, Step 10 — the daily backup at €0/month.
 *
 * GitHub Actions provides the schedule; the running familista-backend service
 * does the work. What the workflow may hold is pinned here: one secret (the
 * trigger's) and the service's public address — never the database, the
 * bucket's keys, the signing key, the restore key or the decryption key. And
 * the paid Render cron job is gone from the blueprint, so a sync can never
 * create a billable service.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WF = read('.github/workflows/backup.yml');
const RENDER = read('render.yaml');
const code = WF.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('.github/workflows/backup.yml', () => {
  it('runs daily at 03:17 UTC and on demand', () => {
    expect(code).toMatch(/on:\n\s+schedule:\n(?:\s+#.*\n)*\s+- cron: '17 3 \* \* \*'\n\s+workflow_dispatch:/);
  });

  it('has a read-only token and never runs two at once', () => {
    expect(code).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(code).not.toMatch(/:\s*write\b/);
    expect(code).toMatch(/concurrency:\n\s+group: backup\n\s+cancel-in-progress: false/);
  });

  it('holds exactly one secret: BACKUP_TRIGGER_SECRET', () => {
    const secrets = [...new Set([...code.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(secrets).toEqual(['BACKUP_TRIGGER_SECRET']);
    expect(code).toMatch(/BACKUP_SERVICE_URL: \$\{\{ vars\.BACKUP_SERVICE_URL \}\}/);
  });

  it.each(['DATABASE_URL', 'DIRECT_URL', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_SIGNING_PRIVATE_KEY',
    'BACKUP_ENCRYPTION_PRIVATE_KEY', 'BACKUP_ENCRYPTION_PUBLIC_KEY', 'PGPASSWORD', 'pg_dump', 'psql'])('never names %s', (name) => {
    expect(code).not.toContain(name);
  });

  it('runs only the trigger script, with the values reaching it through env', () => {
    const runs = [...code.matchAll(/^\s+run:\s*(.+)$/gm)].map((m) => m[1].trim());
    expect(runs).toEqual(['node scripts/backup-trigger.js']);
  });

  it('checks out without persisting the token and pins every action to a commit', () => {
    expect(code).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+persist-credentials: false/);
    for (const line of code.split('\n').filter((l) => /uses:/.test(l))) {
      expect(line).toMatch(/uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+\s*$/);
    }
  });

  it('allows enough time to wake the service and wait for the run', () => {
    expect(Number((code.match(/timeout-minutes: (\d+)/) || [])[1])).toBeGreaterThanOrEqual(70);
  });
});

describe('render.yaml — no paid backup service', () => {
  it('declares no cron job and no backup service', () => {
    expect(RENDER).not.toMatch(/^\s*-\s*type:\s*cron\s*$/m);
    expect(RENDER).not.toMatch(/familista-backup\b/);
  });

  it('never declares the decryption key', () => {
    expect(RENDER).not.toMatch(/-\s*key:\s*BACKUP_ENCRYPTION_PRIVATE_KEY\b/);
  });
});
