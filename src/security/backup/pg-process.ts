// Cyber Defense, Step 10 — running the PostgreSQL client tools safely
// ─────────────────────────────────────────────────────────────────────────────
// Every child gets only the PG* variables it needs (password in PGPASSWORD,
// never in argv), and anything it says on stderr is scrubbed of connection
// details before it can reach a log or a BackupRecord.

import { spawn, ChildProcess } from 'child_process';
import { setPriority } from 'os';
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

/** The oldest pg_dump that can dump the production server (PostgreSQL 16). */
export const MIN_PG_DUMP_MAJOR = 16;

export interface PgToolVersion { available: boolean; version: string | null; major: number | null }

/**
 * `pg_dump --version`, parsed. Only the version number is ever returned or
 * logged — never the tool's other output, and no environment is passed to it.
 */
export function pgToolVersion(bin: string, timeoutMs = 10_000): Promise<PgToolVersion> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (v: PgToolVersion) => { if (!settled) { settled = true; resolve(v); } };
    let child: ChildProcess;
    try {
      child = spawn(bin, ['--version'], { env: { PATH: process.env.PATH, LANG: 'C' }, stdio: ['ignore', 'pipe', 'ignore'], shell: false });
    } catch {
      done({ available: false, version: null, major: null });
      return;
    }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ available: false, version: null, major: null }); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { if (out.length < 256) out += d.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); done({ available: false, version: null, major: null }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const m = /^pg_dump \(PostgreSQL\) (\d+)(?:\.(\d+))?/.exec(out.trim());
      if (code !== 0 || !m) return done({ available: false, version: null, major: null });
      done({ available: true, version: m[2] ? `${m[1]}.${m[2]}` : m[1], major: Number(m[1]) });
    });
  });
}

/** Refuses to go on unless pg_dump is present and new enough for the server. */
export async function requirePgDump(bin: string): Promise<PgToolVersion> {
  const v = await pgToolVersion(bin);
  if (!v.available) throw new Error('pg_dump is not available on this host');
  if ((v.major ?? 0) < MIN_PG_DUMP_MAJOR) {
    throw new Error(`pg_dump ${MIN_PG_DUMP_MAJOR} or newer is required; found ${v.version}`);
  }
  return v;
}

/**
 * Lowest scheduling priority for a child, so a backup running inside the web
 * service yields the CPU to request handling. Best effort: a host that forbids
 * it still gets its backup.
 */
export function lowestPriority(child: ChildProcess): void {
  if (!child.pid) return;
  try { setPriority(child.pid, 19); } catch { /* not permitted here; the backup still runs */ }
}
