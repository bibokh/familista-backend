// Familista — running lab code in a child process the parent can always stop
// ─────────────────────────────────────────────────────────────────────────────
// A candidate is code nobody has approved. It never runs in the process that
// judges it, and never in production. Each job runs in its own child process:
//
//   time      the PARENT holds the clock. When a child overruns its wall-clock
//             limit the parent sends SIGKILL to the child's whole process
//             group. A synchronous infinite loop cannot ignore it — nothing in
//             the child has to cooperate.
//   memory    the child's V8 heap is capped (--max-old-space-size); running
//             out ends the child, and the parent records MEMORY_LIMIT.
//   output    stdout is counted as it arrives; past the cap the child is
//             killed (OUTPUT_LIMIT). Only the tail of stderr is kept, and it
//             never reaches the evidence.
//   secrets   the child starts with an EMPTY environment plus the two
//             variables ts-node needs: no database URL, key or token of the
//             parent's can reach candidate code.
//   cleanup   after every child — finished, killed or crashed — the parent
//             kills what is left of its process group and confirms no live
//             process remains in it (on Linux, from /proc).
//   pipes     a process the child moved out of its group (a new session) is
//             beyond the group kill, and if it inherited the child's stdout or
//             stderr it holds them open for as long as it lives. So once the
//             child itself has exited, the parent waits at most
//             OUTPUT_CLOSE_GRACE_MS for its output to close, then closes its
//             own ends and reports outputHeld. Closing the pipes is all it
//             does: it neither kills that process nor claims it has ended.
//
// The parent also keeps a set of live children so a CLI that is interrupted
// can kill them on its way out (killActiveChildren).

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';

/** The repository root: lab/algorithms/ is two levels down. */
export const LAB_ROOT = path.resolve(__dirname, '..', '..');

export interface ChildLimits {
  timeoutMs: number;
  heapMb: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export type ChildState = 'COMPLETED' | 'TIMED_OUT' | 'MEMORY_LIMIT' | 'OUTPUT_LIMIT' | 'CRASHED';

export interface ChildOutcome {
  state: ChildState;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  pid: number | null;
  /** From just before the spawn to the child's own exit. */
  wallMs: number;
  /** What the child wrote to stdout before it ended or was stopped — never more than the cap. */
  stdout: string;
  stderrTail: string;
  /** No live process remained in the child's process group once the parent was done with it. */
  groupGone: boolean;
  /**
   * The child had exited, but its stdout or stderr was still held open
   * OUTPUT_CLOSE_GRACE_MS later — by a process it started that outlived it — so
   * the parent closed its own ends and stopped waiting. Whatever held them is
   * NOT verified to have ended: groupGone speaks for the child's group only.
   */
  outputHeld: boolean;
}

export interface ChildOptions {
  /** Run `entry` as TypeScript through ts-node (transpile only). */
  typescript?: boolean;
  /** Variables to ADD to the child's otherwise empty environment. */
  env?: Readonly<Record<string, string>>;
}

/** All a child is given: ts-node's switches. Nothing is copied from the parent's environment. */
export const CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  TS_NODE_TRANSPILE_ONLY: 'true',
  TS_NODE_PROJECT: path.join(LAB_ROOT, 'tsconfig.json'),
});

/**
 * How long the parent waits, once the child itself has exited, for its output
 * pipes to close. They normally close with the child, within milliseconds.
 */
export const OUTPUT_CLOSE_GRACE_MS = 2_000;

const GROUPS = process.platform !== 'win32';
const active = new Set<ChildProcess>();

/** Live children of this process — zero whenever no job is running. */
export const activeChildren = () => active.size;

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (GROUPS) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/** Kill every live child's process group. For a CLI's exit and signal handlers. */
export function killActiveChildren(): void {
  for (const c of active) killGroup(c);
}

/**
 * Live (not zombie) processes in a process group. Linux reads /proc; elsewhere
 * a signal-0 probe answers whether any member exists at all.
 */
export function liveGroupMembers(pgid: number): number {
  if (process.platform === 'linux') {
    let n = 0;
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat: string;
      try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
      // "pid (comm) state ppid pgrp …" — comm may hold spaces, so parse after its last ')'.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(rest[2]) === pgid && rest[0] !== 'Z' && rest[0] !== 'X') n += 1;
    }
    return n;
  }
  try { process.kill(-pgid, 0); return 1; } catch { return 0; }
}

async function waitGroupGone(pgid: number, withinMs: number): Promise<boolean> {
  const until = performance.now() + withinMs;
  for (;;) {
    if (liveGroupMembers(pgid) === 0) return true;
    if (performance.now() > until) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
}

const OUT_OF_MEMORY = /heap out of memory|Reached heap limit|Allocation failed/i;

/** Run one child to completion or to its limits. Never throws for anything the child does. */
export async function runChild(entry: string, args: readonly string[], limits: ChildLimits, opts: ChildOptions = {}): Promise<ChildOutcome> {
  const execArgv = [`--max-old-space-size=${limits.heapMb}`];
  if (opts.typescript) execArgv.push('-r', 'ts-node/register/transpile-only');
  const started = performance.now();
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [...execArgv, entry, ...args], {
      cwd: LAB_ROOT,
      env: { ...CHILD_ENV, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: GROUPS,
      windowsHide: true,
    });
  } catch {
    return { state: 'CRASHED', exitCode: null, signal: null, pid: null, wallMs: 0, stdout: '', stderrTail: 'spawn failed', groupGone: true, outputHeld: false };
  }
  active.add(child);

  let limit: ChildState | null = null;
  const out: Buffer[] = [];
  let outBytes = 0;
  let errTail = '';
  child.stdout?.on('data', (b: Buffer) => {
    outBytes += b.length;
    if (outBytes > limits.maxStdoutBytes) { if (!limit) { limit = 'OUTPUT_LIMIT'; killGroup(child); } return; }
    out.push(b);
  });
  child.stderr?.on('data', (b: Buffer) => {
    errTail = (errTail + b.toString('utf8')).slice(-limits.maxStderrBytes);
  });
  const timer = setTimeout(() => { if (!limit) { limit = 'TIMED_OUT'; killGroup(child); } }, limits.timeoutMs);

  // 'close' waits for every holder of the child's output, not only the child,
  // so once the child itself has exited that wait is bounded.
  let outputHeld = false;
  let exitedAt: number | null = null;
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let grace: NodeJS.Timeout | undefined;
    const done = (c: number | null, s: NodeJS.Signals | null) => { clearTimeout(grace); resolve({ code: c, signal: s }); };
    child.once('error', () => done(null, null));
    child.once('exit', (c: number | null, s: NodeJS.Signals | null) => {
      exitedAt = performance.now();
      clearTimeout(timer);
      grace = setTimeout(() => {
        outputHeld = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        done(c, s);
      }, OUTPUT_CLOSE_GRACE_MS);
    });
    child.once('close', (c: number | null, s: NodeJS.Signals | null) => done(c, s));
  });
  clearTimeout(timer);
  // Start to exit: a grace spent waiting on someone else's hold is not the child's time.
  const wallMs = (exitedAt ?? performance.now()) - started;

  // Whatever the child left in its group goes with it.
  killGroup(child);
  active.delete(child);
  const groupGone = child.pid === undefined ? true : GROUPS ? await waitGroupGone(child.pid, 2_000) : true;

  let state: ChildState;
  if (limit) state = limit;
  else if (code === 0 && signal === null) state = 'COMPLETED';
  else if (OUT_OF_MEMORY.test(errTail)) state = 'MEMORY_LIMIT';
  else state = 'CRASHED';
  return {
    state, exitCode: code, signal, pid: child.pid ?? null, wallMs,
    stdout: Buffer.concat(out).toString('utf8'),
    stderrTail: errTail, groupGone, outputHeld,
  };
}
