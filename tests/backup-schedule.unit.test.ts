/**
 * tests/backup-schedule.unit.test.ts
 *
 * Cyber Defense, Step 10 in production — the Render cron job that takes the
 * encrypted off-site backup every day.
 *
 * What the blueprint must say, and must never say. The job runs the backup
 * wrapper on a schedule, in the database's region (so it reaches it on the
 * private network), with the database URL linked rather than pasted, every
 * credential supplied from the dashboard rather than committed, and nothing
 * beyond what a backup needs: no decryption key, and none of the web
 * service's secrets.
 */

import fs from 'fs';
import path from 'path';

const RAW = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');

/** The text of one top-level entry under services:, by its `name:`. */
function serviceBlock(name: string): string {
  const entries = RAW.split(/\n(?=  - type:)/);
  const hit = entries.find((e) => new RegExp(`^[ \\t]*name:[ \\t]*${name}[ \\t]*$`, 'm').test(e));
  if (!hit) throw new Error(`no service ${name} in render.yaml`);
  // Stop at the databases: section if the entry is the last service.
  return hit.split(/\ndatabases:/)[0];
}

/** `{ key: supply }` for each env var of a block: value / sync:false / fromDatabase / fromService. */
function envOf(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = block.split('\n');
  lines.forEach((l, i) => {
    const k = l.match(/^[ \t]*-[ \t]*key:[ \t]*([A-Z0-9_]+)[ \t]*$/);
    if (!k) return;
    const nextLine = lines[i + 1] ?? '';
    const f = nextLine.match(/^[ \t]*(value|sync|fromDatabase|fromService|generateValue):[ \t]*(.*)$/);
    out[k[1]] = f ? (f[1] === 'sync' ? `sync:${f[2].trim()}` : f[1]) : 'none';
  });
  return out;
}

const cron = serviceBlock('familista-backup');
const field = (name: string) => (cron.match(new RegExp(`^[ \\t]*${name}:[ \\t]*(.+)$`, 'm')) || [])[1]?.trim();
const env = envOf(cron);
const dbRegion = (RAW.slice(RAW.indexOf('\ndatabases:')).match(/^[ \t]*region:[ \t]*(\S+)/m) || [])[1];

describe('render.yaml — the backup cron job', () => {
  it('is a cron service on main that runs the backup wrapper daily', () => {
    expect(cron).toMatch(/^  - type: cron$/m);
    expect(field('branch')).toBe('main');
    expect(field('schedule')).toBe('"17 3 * * *"');
    expect(field('startCommand')).toBe('pg_dump --version && bash scripts/backup.sh');
  });

  it('builds exactly as the web service does', () => {
    expect(field('buildCommand')).toBe((serviceBlock('familista-backend').match(/^[ \t]*buildCommand:[ \t]*(.+)$/m) || [])[1]?.trim());
  });

  it('runs in the database region, so it reaches it on the private network', () => {
    expect(dbRegion).toBe('frankfurt');
    expect(field('region')).toBe(dbRegion);
  });

  it('takes the database URL by link, never as a value', () => {
    expect(env.DATABASE_URL).toBe('fromDatabase');
    expect(cron).toMatch(/- key: DATABASE_URL\n\s+fromDatabase:\n\s+name: familista-postgres\n\s+property: connectionString/);
  });

  it.each(['BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_PUBLIC_KEY', 'BACKUP_SIGNING_PRIVATE_KEY'])(
    '%s is set in the dashboard, never committed', (key) => {
      expect(env[key]).toBe('sync:false');
    });

  it('states only non-secret values inline: the environment and the AWS region', () => {
    const inline = Object.entries(env).filter(([, s]) => s === 'value').map(([k]) => k).sort();
    expect(inline).toEqual(['BACKUP_S3_REGION', 'NODE_ENV']);
    expect(cron).toMatch(/- key: NODE_ENV\n\s+value: production/);
    expect(cron).toMatch(/- key: BACKUP_S3_REGION\n\s+value: eu-central-1/);
  });

  it('declares nothing else — no decryption key and none of the web service\'s secrets', () => {
    expect(Object.keys(env).sort()).toEqual([
      'BACKUP_ENCRYPTION_PUBLIC_KEY', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_BUCKET', 'BACKUP_S3_REGION',
      'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_SIGNING_PRIVATE_KEY', 'DATABASE_URL', 'NODE_ENV',
    ]);
    expect(RAW).not.toMatch(/-\s*key:\s*BACKUP_ENCRYPTION_PRIVATE_KEY\b/);
  });

  it('uses AWS directly: no custom endpoint or path-style override', () => {
    expect(env.BACKUP_S3_ENDPOINT).toBeUndefined();
    expect(env.BACKUP_S3_FORCE_PATH_STYLE).toBeUndefined();
  });

  it('leaves the web service untouched by the addition', () => {
    const web = serviceBlock('familista-backend');
    expect(web).toMatch(/^  - type: web$/m);
    expect(envOf(web).BACKUP_SIGNING_PRIVATE_KEY).toBeUndefined();
    expect(envOf(web).BACKUP_S3_SECRET_ACCESS_KEY).toBeUndefined();
  });
});
