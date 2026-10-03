// The Prisma client that tells PostgreSQL who is asking (Cyber Defense, R14)
// ─────────────────────────────────────────────────────────────────────────────
// Wraps the one PrismaClient so that every query on a pilot table runs in a
// transaction that first sets `familista.rls_mode` / `familista.club_id`
// (transaction-local: nothing leaks to the next user of the pooled
// connection). Queries on any other table pass through untouched.
//
//   outside a transaction   [set_config, query] as one batch transaction
//   inside $transaction     the settings are applied once, first, inside it,
//                           and the queries run as they are
//
// Built only when DB_RLS_CONTEXT is `observe` or `on`; with it off the
// application uses the plain client (config/database.ts), exactly as before.

import { Prisma, type PrismaClient } from '@prisma/client';
import {
  currentDbContext, dbSettings, RLS_PILOT_MODELS, runInTransaction, type RlsContextMode,
} from './db-context';

export type MissingContextReporter = (model: string, operation: string) => void;

function settingsQuery(client: PrismaClient) {
  const s = dbSettings(currentDbContext());
  return client.$executeRaw`SELECT set_config('familista.rls_mode', ${s.mode}, true), set_config('familista.club_id', ${s.clubId}, true)`;
}

/**
 * The client the application uses when the pilot context is on or observed.
 * Typed as PrismaClient: the extension changes what is sent, never a shape.
 */
export function withRlsContext(base: PrismaClient, mode: Exclude<RlsContextMode, 'off'>, reportMissing: MissingContextReporter): PrismaClient {
  const seen = new Set<string>();
  const ext = base.$extends({
    name: 'familista-rls-context',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!model || !RLS_PILOT_MODELS.has(model)) return query(args);
          const ctx = currentDbContext();
          if (!ctx) {
            const key = `${model}.${operation}`;
            if (!seen.has(key)) { seen.add(key); reportMissing(model, operation); }
          }
          if (mode === 'observe' || ctx?.inTransaction) return query(args);
          const [, result] = await base.$transaction([settingsQuery(base), query(args) as Prisma.PrismaPromise<unknown>]);
          return result;
        },
      },
    },
  });

  if (mode === 'observe') return ext as unknown as PrismaClient;

  const transaction = (arg: unknown, options?: unknown): Promise<unknown> => {
    const ctx = currentDbContext();
    if (typeof arg === 'function') {
      return (ext.$transaction as (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown>)(async (tx) => {
        await settingsQuery(tx as PrismaClient);
        return runInTransaction(ctx, () => (arg as (t: unknown) => Promise<unknown>)(tx));
      }, options);
    }
    if (Array.isArray(arg)) {
      return runInTransaction(ctx, () => (ext.$transaction as (a: unknown[], o?: unknown) => Promise<unknown[]>)(
        [settingsQuery(base), ...arg], options,
      ).then((results) => results.slice(1)));
    }
    return Promise.reject(new Error('$transaction expects a function or an array'));
  };

  // $on / $use / $connect / $disconnect belong to the base client (an extended
  // client does not carry them); $transaction is the context-aware one above.
  const own = new Set(['$on', '$use', '$connect', '$disconnect']);
  return new Proxy(ext as unknown as PrismaClient, {
    get(target, prop, receiver) {
      if (prop === '$transaction') return transaction;
      if (typeof prop === 'string' && own.has(prop)) {
        const v = (base as unknown as Record<string, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(base) : v;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
