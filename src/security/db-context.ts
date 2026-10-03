// Who is asking the database (Cyber Defense, R14 — row-level security pilot)
// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL checks club isolation itself on the pilot tables
// (prisma/migrations/20261004100000_rls_pilot). It can only do that if every
// query on them says who is asking. This module holds that answer for the
// current request or task, and config/database.ts hands it to PostgreSQL as
// transaction-local settings before each query on a pilot table:
//
//   club     a signed-in request inside one club (set by `authenticate`)
//   system   an explicit, named path that acts across clubs: the platform
//            owner, a background worker, sign-in before a club is known,
//            a transfer that moves a player between clubs. Every use names
//            its reason, and the list is reviewed (posture: db-rls-context).
//
// No context at all is not "system". It is nothing, and once enforcement is on
// the database answers it with no rows and no writes. Fail closed.
//
// DB_RLS_CONTEXT decides what the application does, independently of the
// database's own switch (familista_rls_enforced()):
//
//   off      (default) nothing changes — the exported client is the plain one
//   observe  queries run as before; a pilot-table query with no context is
//            logged once per model and operation, so the paths still missing
//            a context are found before anything is enforced
//   on       every pilot-table query carries its context to the database

// A Prisma query runs when it is awaited, not when it is built: await it
// inside the context (`async () => await prisma.x.findMany()`), which every
// request handler does by construction, since it runs inside `authenticate`.

import { AsyncLocalStorage } from 'async_hooks';

export type DbContext =
  | { mode: 'club'; clubId: string | null; userId?: string | null }
  | { mode: 'system'; reason: string };

type Held = DbContext & { inTransaction?: boolean };

export type RlsContextMode = 'off' | 'observe' | 'on';

/** The tables the pilot covers, by Prisma model name. Extended table by table. */
export const RLS_PILOT_MODELS: ReadonlySet<string> = new Set(['Player', 'Membership', 'PlayerInjury', 'VideoAsset']);

const store = new AsyncLocalStorage<Held>();

export function rlsContextMode(env: Record<string, string | undefined> = process.env): RlsContextMode {
  const v = (env.DB_RLS_CONTEXT ?? '').trim().toLowerCase();
  return v === 'on' || v === 'observe' ? v : 'off';
}

export function currentDbContext(): Held | undefined {
  return store.getStore();
}

/** Run `fn` as a request inside one club. */
export function runInClubContext<T>(clubId: string | null | undefined, userId: string | null | undefined, fn: () => T): T {
  return store.run({ mode: 'club', clubId: clubId ?? null, userId: userId ?? null }, fn);
}

/**
 * Run `fn` across clubs, on purpose. The reason is required, short and
 * literal, so every path that steps outside a club can be found and reviewed.
 */
export function runAsSystem<T>(reason: string, fn: () => T): T {
  if (!/^[a-z][a-z0-9:-]{2,63}$/.test(reason)) throw new Error(`runAsSystem needs a literal reason, got ${JSON.stringify(reason)}`);
  return store.run({ mode: 'system', reason }, fn);
}

/** The context an interactive transaction's queries run under: already set inside it. */
export function runInTransaction<T>(ctx: Held | undefined, fn: () => T): T {
  return store.run({ ...(ctx ?? { mode: 'club', clubId: null }), inTransaction: true } as Held, fn);
}

/** The two settings PostgreSQL reads, for the context (or for none). */
export function dbSettings(ctx: DbContext | undefined): { mode: string; clubId: string } {
  if (!ctx) return { mode: '', clubId: '' };
  if (ctx.mode === 'system') return { mode: 'system', clubId: '' };
  return { mode: 'club', clubId: ctx.clubId ?? '' };
}
