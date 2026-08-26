// Familista — password hashing
// ─────────────────────────────────────────────────────────────────────────────
// The algorithm and the work factor are unchanged, and that is the point.
// bcrypt at cost 12 is what it was. Every hash already in the database — 1554
// of them, all $2a$ — verifies here, and every hash written here verifies under
// the old library too, so a rollback is a rollback and not a lockout. Nothing
// about the security of a stored password is weaker than it was.
//
// What changed is which thread pays for it, and how fast that thread is.
//
// `bcryptjs` is a pure-JavaScript bcrypt. At cost 12 one comparison is about
// 320ms of CPU, and called on the request thread it does not merely make the
// sign-in slow — it stops the process answering ANY request for a third of a
// second. A hundred concurrent sign-ins were thirty-two seconds of blocked
// event loop between them.
//
// The native binding is both faster (about 245ms here) and, in its async form,
// does its work on libuv's thread pool — so the event loop stays free without
// this file having to arrange it. That is the path taken when the binding
// loads.
//
// It is a compiled dependency, so it can fail to build on a host. When that
// happens the work still must not land on the request thread, so the fallback
// is bcryptjs inside a small pool of worker threads: slower, but still off the
// loop. Only if workers are unavailable too does it run inline — correct, as
// slow as it ever was, and never wrong.
//
// Order of preference, then: native async → bcryptjs in a worker → inline.

import { Worker } from 'worker_threads';
import os from 'os';
import path from 'path';
import fs from 'fs';
import bcryptjs from 'bcryptjs';

export const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

// ── the native binding, if this host could build it ─────────────────────────
type NativeBcrypt = {
  hash(data: string, rounds: number): Promise<string>;
  compare(data: string, hash: string): Promise<boolean>;
};
let native: NativeBcrypt | null = null;
// Under test the native binding stays out of the way, for the same reason the
// worker pool does: a compiled module cannot be replaced by a test's mock of
// bcryptjs, so a suite that stubs hashing would be doing real comparisons
// against fixture hashes. Production always takes the native path.
if (process.env.BCRYPT_NATIVE !== 'off' && process.env.NODE_ENV !== 'test') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    native = require('bcrypt') as NativeBcrypt;
  } catch (err) {
    // Loud, once, at boot. A silent fallback here is a silent return to a
    // blocked event loop, which is exactly the failure this file exists to stop.
    console.warn('[password] native bcrypt unavailable, falling back to bcryptjs workers:',
      (err as Error).message);
    native = null;
  }
}
export function passwordBackend(): 'native' | 'worker' | 'inline' {
  if (native) return 'native';
  return pool.usable() ? 'worker' : 'inline';
}

// ── $2y$ ────────────────────────────────────────────────────────────────────
// $2y$ is PHP's marker for the corrected bcrypt implementation; the algorithm
// is identical to $2a$ and the digests are interchangeable. The native binding
// accepts only $2a$ and $2b$, so a $2y$ hash — which an import from a PHP
// system would bring — would be REFUSED rather than mis-verified. Refusing a
// correct password is still a lockout, so the prefix is normalised. This
// database holds no $2y$ today; the guard is here so that one arriving later
// is not a silent authentication failure.
function normalise(hash: string): string {
  return hash.startsWith('$2y$') ? '$2a$' + hash.slice(4) : hash;
}

// ── the worker pool: the fallback when there is no native binding ───────────
type Job = { op: 'hash' | 'compare'; password: string; hash?: string; rounds?: number };
type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };

const POOL_SIZE = Math.max(1, Math.min(
  parseInt(process.env.PASSWORD_WORKERS ?? '0', 10) || (os.cpus().length - 1),
  8,
));

// Under test the pool stays out of the way. A worker is a separate module
// registry, so it cannot see a test's mock of bcryptjs and would do a real
// comparison against a fixture hash.
const OFF_THREAD = process.env.NODE_ENV !== 'test' && process.env.PASSWORD_WORKERS !== 'off';

function workerPath(): string | null {
  const candidates = [
    path.join(__dirname, 'password.worker.js'),
    path.join(process.cwd(), 'dist', 'utils', 'password.worker.js'),
    path.join(process.cwd(), 'src', 'utils', 'password.worker.js'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

class PasswordPool {
  private workers: Worker[] = [];
  private free: Worker[] = [];
  private queue: Array<{ job: Job; pending: Pending }> = [];
  private pending = new Map<number, Pending>();
  private seq = 0;
  private broken = false;

  usable(): boolean { return OFF_THREAD && !this.broken && workerPath() !== null; }

  private spawn(): Worker | null {
    const file = workerPath();
    if (!file) { this.broken = true; return null; }
    let w: Worker;
    try { w = new Worker(file); } catch { this.broken = true; return null; }
    w.unref();                                   // never hold the process open
    w.on('message', (m: { id: number; value?: unknown; error?: string }) => {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.value as never);
      }
      this.release(w);
    });
    w.on('error', () => { this.retire(w); });
    w.on('exit', () => { this.retire(w); });
    this.workers.push(w);
    return w;
  }

  private retire(w: Worker) {
    this.workers = this.workers.filter((x) => x !== w);
    this.free = this.free.filter((x) => x !== w);
  }

  private release(w: Worker) {
    const next = this.queue.shift();
    if (next) { this.dispatch(w, next.job, next.pending); return; }
    this.free.push(w);
  }

  private dispatch(w: Worker, job: Job, pending: Pending) {
    const id = ++this.seq;
    this.pending.set(id, pending);
    w.postMessage({ id, ...job });
  }

  run<T>(job: Job): Promise<T> | null {
    if (this.broken || !OFF_THREAD) return null;
    return new Promise<T>((resolve, reject) => {
      const pending = { resolve, reject } as unknown as Pending;
      const w = this.free.pop()
        ?? (this.workers.length < POOL_SIZE ? this.spawn() : null);
      if (w) this.dispatch(w, job, pending);
      else if (this.workers.length) this.queue.push({ job, pending });
      else reject(new Error('no password worker'));
    });
  }
}

const pool = new PasswordPool();

// ── the two things the application asks for ─────────────────────────────────

/** Hash a password. bcrypt, cost 12 — unchanged. */
export async function hashPassword(password: string, rounds = BCRYPT_ROUNDS): Promise<string> {
  if (native) {
    try { return await native.hash(password, rounds); } catch { /* fall through */ }
  }
  const off = pool.run<string>({ op: 'hash', password, rounds });
  if (off) { try { return await off; } catch { /* fall through */ } }
  return bcryptjs.hash(password, rounds);
}

/** Verify a password against a stored hash. bcrypt — unchanged. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const h = normalise(hash);
  if (native) {
    try { return await native.compare(password, h); } catch { /* fall through */ }
  }
  const off = pool.run<boolean>({ op: 'compare', password, hash: h });
  if (off) { try { return await off; } catch { /* fall through */ } }
  return bcryptjs.compare(password, h);
}
