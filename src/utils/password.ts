// Familista — password hashing
// ─────────────────────────────────────────────────────────────────────────────
// The algorithm and the work factor are unchanged. bcrypt at cost 12 is what it
// was; these hashes verify against the ones already in the database and the
// ones written here verify anywhere bcrypt is understood. Nothing about the
// security of a stored password is weaker than it was.
//
// What changed is where the work happens.
//
// `bcryptjs` is a pure-JavaScript bcrypt, and at cost 12 one comparison costs
// about 320ms of CPU on this hardware. Called on the request thread it does not
// merely make that request slow — it stops the process answering ANY request
// for a third of a second. Measured: a hundred concurrent sign-ins spent
// thirty-two seconds of blocked event loop between them, which is exactly the
// p99 the load tests showed, and every ordinary read queued behind it.
//
// So the work moves to a small pool of worker threads. The event loop stays
// free, the other cores are used for the one thing in this application that is
// genuinely CPU-bound, and the cost factor is untouched — this is not a
// security trade, it is the same work done somewhere it does not block.
//
// If workers cannot be created — an environment that forbids them, a test
// runner that has already torn its pool down — the call falls back to doing the
// work inline. Correct, just as slow as before, and never wrong.

import { Worker } from 'worker_threads';
import os from 'os';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';

export const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

type Job = { op: 'hash' | 'compare'; password: string; hash?: string; rounds?: number };
type Pending = { resolve: (v: never) => void; reject: (e: Error) => void };

// One fewer than the cores, so the request thread always has one to itself, and
// at least one worker on a single-core instance.
const POOL_SIZE = Math.max(1, Math.min(
  parseInt(process.env.PASSWORD_WORKERS ?? '0', 10) || (os.cpus().length - 1),
  8,
));

// Under test the pool stays out of the way. A worker is a separate module
// registry, so it cannot see a test's mock of bcryptjs and would do a real
// comparison against a fixture hash. Tests are one request at a time and have
// nothing to gain from the pool; the inline path below is the same function.
const OFF_THREAD = process.env.NODE_ENV !== 'test' && process.env.PASSWORD_WORKERS !== 'off';

// The worker ships as .js beside this file. After a build it sits in dist/utils;
// under ts-node it sits in src/utils. Look in both rather than assuming one.
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

  private spawn(): Worker | null {
    const file = workerPath();
    if (!file) { this.broken = true; return null; }
    let w: Worker;
    try {
      w = new Worker(file);
    } catch { this.broken = true; return null; }
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

/** Hash a password. bcrypt, cost 12 — unchanged. */
export async function hashPassword(password: string, rounds = BCRYPT_ROUNDS): Promise<string> {
  const off = pool.run<string>({ op: 'hash', password, rounds });
  if (off) { try { return await off; } catch { /* fall through */ } }
  return bcrypt.hash(password, rounds);
}

/** Verify a password against a stored hash. bcrypt — unchanged. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const off = pool.run<boolean>({ op: 'compare', password, hash });
  if (off) { try { return await off; } catch { /* fall through */ } }
  return bcrypt.compare(password, hash);
}
