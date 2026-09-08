// Familista — the database, as durations
// ─────────────────────────────────────────────────────────────────────────────
// What a trace shows of a query: the model, the operation, and how long it took.
//
//     DB | Player UPDATE | 14 ms
//
// It does NOT show the statement, the `where`, the `data`, or any value in
// either. Those are the row itself — somebody's name, address, medical note or
// wage — and a diagnostic panel is not a reason to put them on a screen. Prisma
// hands this hook the arguments; this hook reads two fields off them and drops
// the rest on the floor.
//
// Installed once, and inert while tracing is off: the middleware runs, asks the
// boolean, and calls through.

import type { PrismaClient } from '@prisma/client';
import { emit, isTracing } from './trace-bus';
import { currentRequestId } from './trace-context';

/** Prisma's verbs, as the four words an operator thinks in. */
const VERB: Record<string, string> = {
  findUnique: 'SELECT', findUniqueOrThrow: 'SELECT', findFirst: 'SELECT',
  findFirstOrThrow: 'SELECT', findMany: 'SELECT', count: 'SELECT',
  aggregate: 'SELECT', groupBy: 'SELECT',
  create: 'INSERT', createMany: 'INSERT',
  update: 'UPDATE', updateMany: 'UPDATE', upsert: 'UPSERT',
  delete: 'DELETE', deleteMany: 'DELETE',
};

let installed = false;

/**
 * Put the timing hook on the client. Idempotent, and safe to call at boot.
 *
 * A failure to install is a failure to trace, and nothing more: the client is
 * returned untouched and every query still runs.
 */
export function installPrismaTracing(client: PrismaClient): void {
  if (installed) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const use = (client as any).$use;
    if (typeof use !== 'function') return;
    installed = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    use.call(client, async (params: any, next: (p: any) => Promise<unknown>) => {
      if (!isTracing()) return next(params);
      const started = Date.now();
      try {
        const out = await next(params);
        record(params, Date.now() - started, 'ok');
        return out;
      } catch (err) {
        record(params, Date.now() - started, 'error');
        throw err;                       // the query's failure is the query's
      }
    });
  } catch (_) { /* an uninstrumented database is not a broken one */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function record(params: any, durationMs: number, outcome: 'ok' | 'error'): void {
  try {
    const id = currentRequestId();
    if (!id) return;
    const model = typeof params?.model === 'string' ? params.model : 'raw';
    const action = typeof params?.action === 'string' ? params.action : 'query';
    const verb = VERB[action] ?? action.toUpperCase();
    // The name is the only string built from the query, and both halves of it
    // are enum-like: a model name and an operation. Never an argument.
    emit(id, 'DB', `${model} ${verb}`, { durationMs, outcome, detail: { model, op: verb } });
  } catch (_) { /* as above */ }
}
