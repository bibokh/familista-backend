// Cyber Defense, Step 10 — backup command line
// ─────────────────────────────────────────────────────────────────────────────
//   node dist/scripts/backup.js keygen <dir>   write two key pairs into <dir> (0600)
//   node dist/scripts/backup.js run            take one encrypted off-site backup
//   node dist/scripts/backup.js drill <key>    restore <key> into an isolated database
//   node dist/scripts/backup.js latest         name the newest complete backup in the store
//
// Output is one JSON line. No key, password or connection string is ever
// printed; keygen writes its keys to files, not to the terminal.

import fs from 'fs';
import path from 'path';
import { generateBackupKeys } from '../security/backup/backup-crypto';
import { drillConfigFromEnv, runnerConfigFromEnv, storeFromEnv } from '../security/backup/backup-config';
import { findLatestBackup } from '../security/backup/backup-latest';
import { storeFor } from '../security/backup/backup-store';
import { runBackup } from '../security/backup/backup-runner';
import { runRestoreDrill } from '../security/backup/restore-drill';

function out(obj: unknown): void { process.stdout.write(`${JSON.stringify(obj)}\n`); }

/** Settings whose values must never reach the output, even inside an error from a library. */
const SECRET_SETTINGS = ['BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_ENCRYPTION_PRIVATE_KEY',
  'BACKUP_SIGNING_PRIVATE_KEY', 'DATABASE_URL', 'DIRECT_URL', 'BACKUP_DATABASE_URL', 'DRILL_DATABASE_URL'] as const;

export function redact(message: string, env: NodeJS.ProcessEnv): string {
  let m = message;
  for (const name of SECRET_SETTINGS) {
    const v = (env[name] ?? '').trim();
    if (v.length >= 8) m = m.split(v).join(`[${name}]`);
  }
  return m;
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, arg] = argv;
  try {
    if (cmd === 'keygen') {
      if (!arg) throw new Error('usage: backup keygen <empty directory>');
      const dir = path.resolve(arg);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.readdirSync(dir).length) throw new Error('keygen refuses a non-empty directory');
      const k = generateBackupKeys();
      const files: Record<string, string> = {
        'runner.env': `BACKUP_ENCRYPTION_PUBLIC_KEY=${k.encryptionPublicKey}\nBACKUP_SIGNING_PRIVATE_KEY=${k.signingPrivateKey}\n`,
        'offline-restore.env': `BACKUP_ENCRYPTION_PRIVATE_KEY=${k.encryptionPrivateKey}\nBACKUP_SIGNING_PUBLIC_KEY=${k.signingPublicKey}\n`,
      };
      for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body, { mode: 0o600, flag: 'wx' });
      out({ ok: true, wrote: Object.keys(files), dir });
      return 0;
    }
    if (cmd === 'run') {
      out(await runBackup(runnerConfigFromEnv(env)));
      return 0;
    }
    if (cmd === 'drill') {
      if (!arg) throw new Error('usage: backup drill <object key>');
      out(await runRestoreDrill(drillConfigFromEnv(env), arg));
      return 0;
    }
    if (cmd === 'latest') {
      // Needs only the store settings: lists names, reads nothing, writes nothing.
      out({ ok: true, ...(await findLatestBackup(storeFor(storeFromEnv(env)))) });
      return 0;
    }
    throw new Error('usage: backup keygen <dir> | run | drill <object key> | latest');
  } catch (err) {
    out({ ok: false, error: redact((err as Error)?.message ?? String(err), env) });
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
