// Cyber Defense, Step 10 — running the PostgreSQL client tools safely
// ─────────────────────────────────────────────────────────────────────────────
// Every child gets only the PG* variables it needs (password in PGPASSWORD,
// never in argv), and anything it says on stderr is scrubbed of connection
// details before it can reach a log or a BackupRecord.

import { spawn, ChildProcess } from 'child_process';
import { pgEnv, PgConnection } from './backup-config';

const MAX_STDERR = 8 * 1024;

/** Removes URLs, the password, user and host from a message. */
export function scrub(message: string, c?: PgConnection): string {
  let s = String(message ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, '<database-url>');
  if (c) {
    for (const secret of [c.password, c.user, c.host].filter((v) => v && v.length >= 3)) {
      s = s.split(secret).join('<redacted>');
    }
  }
  return s.slice(0, 500);
}

export interface Spawned { child: ChildProcess; done: Promise<void> }

/** Spawns a pg tool; `done` rejects with a scrubbed message on a non-zero exit. */
export function spawnPg(bin: string, args: string[], c: PgConnection, stdio: Array<'pipe' | 'ignore' | 'inherit'> = ['ignore', 'pipe', 'pipe']): Spawned {
  const child = spawn(bin, args, { env: pgEnv(c), stdio: stdio as never, shell: false });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX_STDERR) stderr += d.toString('utf8'); });
  const done = new Promise<void>((resolve, reject) => {
    child.on('error', (e) => reject(new Error(`${bin} could not start: ${scrub(e.message, c)}`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} failed (${signal ?? `exit ${code}`}): ${scrub(stderr.trim(), c) || 'no output'}`));
    });
  });
  return { child, done };
}

/** One query through psql, returning trimmed rows. SQL here is fixed text, never built from input. */
export async function psqlQuery(psqlBin: string, c: PgConnection, sql: string): Promise<string[]> {
  const { child, done } = spawnPg(psqlBin, ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], c, ['ignore', 'pipe', 'pipe']);
  let out = '';
  child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  await done;
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Runs a fixed SQL script through psql on stdin, with every value passed as a
 * psql variable and quoted by psql itself (`:'name'`), so no value is ever
 * spliced into SQL text. `-c` does not interpolate variables; stdin does.
 */
export async function psqlScript(psqlBin: string, c: PgConnection, script: string, vars: Record<string, string>): Promise<string[]> {
  const args = ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error('invalid psql variable name');
    args.push('-v', `${k}=${v}`);
  }
  args.push('-f', '-');
  const { child, done } = spawnPg(psqlBin, args, c, ['pipe', 'pipe', 'pipe']);
  let out = '';
  child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
  child.stdin?.on('error', () => { /* a failed psql is reported by done */ });
  child.stdin?.end(script);
  await done;
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}
