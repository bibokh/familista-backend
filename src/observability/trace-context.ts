// Familista — which request am I inside?
// ─────────────────────────────────────────────────────────────────────────────
// A database query knows its model and its timing but has no idea which request
// asked for it, because Prisma is called from services that were never handed a
// request. `AsyncLocalStorage` is Node's own answer to exactly that: the id is
// bound once, at the door, and every asynchronous continuation of that request —
// however deep — can read it without a single signature changing.
//
// Nothing else is stored in it. Not the user, not the club, not the token: an
// ambient store that carries identity is an invitation to authorize from it, and
// authorization here is decided by the guards from the request, as it always was.

import { AsyncLocalStorage } from 'async_hooks';

const store = new AsyncLocalStorage<{ requestId: string }>();

/** Run the rest of this request inside a context that knows its own id. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return store.run({ requestId }, fn);
}

/** The id of the request this code is running inside, if any. */
export function currentRequestId(): string | undefined {
  try { return store.getStore()?.requestId; } catch (_) { return undefined; }
}
