// A suspended club cannot be operated, whichever door you come in by
// ─────────────────────────────────────────────────────────────────────────────
// Hiding the buttons is not suspending a club. If the only thing standing
// between a president and a deactivated club's transfer market is a menu that
// no longer renders, then the club is not suspended — it is suspended-looking,
// and one `curl` says otherwise.
//
// So the rule is enforced where every authenticated request passes, once, and
// it is enforced by asking the database what state the club is in rather than
// by trusting anything the request carries.
//
// WHY IT LIVES IN `authenticate`
//
// Familista mounts around fifty routers under /api/v1, each of which calls
// `authenticate` itself. There is no middleware position that runs after
// authentication and before every handler — a guard mounted at the API root
// runs BEFORE authentication and has no identity to judge. The one function
// every authenticated request genuinely passes through is `authenticate`, so
// the rule is called from the end of it, and lives here so that the rule and
// its reasons are one file rather than a paragraph buried in the identity code.
//
// WHAT IS EXEMPT, AND WHY
//
// Three families of route, and the list is closed:
//
//   /auth   Signing in, refreshing and signing out are things a PERSON does.
//           Somebody whose club was suspended must still be able to sign in —
//           otherwise they cannot be told why, and cannot reach a club of
//           theirs that is perfectly healthy.
//   /me     The session's own context and settings. This is what carries the
//           news: /me/context reports the club's lifecycle, and the interface
//           reads it to say what has happened. Refusing it would leave the
//           screen unable to explain itself.
//   /system The platform's own console, which asserts platform authority on
//           every route of its own. Inspecting a suspended club is the entire
//           point of suspending one rather than deleting it.
//
// Everything else — every player, team, match, training session, transfer,
// message, upload and setting — is operating the club, and is refused.

import type { Request, Response, NextFunction } from 'express';
import { ForbiddenError } from '../utils/errors';
import { hasPlatformAuthority } from '../platform/access-levels';
import { clubLifecycleOf, isOperableLifecycle } from '../platform/club-lifecycle.service';

/**
 * Route prefixes that are about a PERSON or the PLATFORM rather than about
 * operating a club. Matched against the path under /api/v1.
 */
const IDENTITY_PREFIXES = ['/auth', '/me', '/system', '/health', '/telemetry'];

/** Is this request one of the exempt families? */
export function isIdentityRoute(pathname: string): boolean {
  const p = String(pathname || '');
  // Anchored, so `/mentions` is not read as `/me`.
  return IDENTITY_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** The refusal, in the words the person on the other end needs. */
function refusal(lifecycle: string): ForbiddenError {
  return lifecycle === 'ARCHIVED'
    ? new ForbiddenError(
      'This club has been archived by Familista. Everything in it has been kept exactly as it was, '
      + 'and it can be restored — ask Familista to restore it.',
    )
    : new ForbiddenError(
      'This club has been deactivated by Familista. Nothing in it has been deleted, and it can be '
      + 'reactivated — ask Familista to reactivate it.',
    );
}

/**
 * Refuse a request that would operate a club the platform has suspended.
 *
 * Called at the end of `authenticate`, with the identity already resolved.
 * Throws; the caller lets it propagate to the error handler, which is what
 * turns it into a 403 with the message above.
 *
 * Platform authority passes. That is not a hole: the platform owner suspending
 * a club and then being unable to look at it would make suspension a way of
 * losing a club rather than a way of holding one.
 */
export async function assertActingClubOperable(req: Request): Promise<void> {
  const url = (req.originalUrl || req.url || '').split('?')[0];
  // The path under the API mount. `req.path` inside `authenticate` is relative
  // to the router, so the original URL is what can be matched consistently.
  const underApi = url.replace(/^\/api\/v\d+/, '') || '/';
  if (isIdentityRoute(underApi)) return;

  const user = req.user;
  if (!user) return;
  // The platform is above every club, including the ones it has suspended.
  if (hasPlatformAuthority(user)) return;

  const clubId = user.clubId;
  if (!clubId) return;

  const lifecycle = await clubLifecycleOf(clubId);
  // A club id that names no club is not this rule's business — the route that
  // needs the club will report that itself, and answering "suspended" for a
  // club that does not exist would be a worse answer than the real one.
  if (lifecycle === null) return;
  if (isOperableLifecycle(lifecycle)) return;

  throw refusal(String(lifecycle));
}

/**
 * The same rule, as an ordinary middleware.
 *
 * Not used by the main API — see the note above about mount order — but this is
 * what a new router mounted outside the usual chain should use, and what the
 * tests drive so the rule can be exercised without standing up authentication.
 */
export function requireOperableClub() {
  return async function (req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      await assertActingClubOperable(req);
      next();
    } catch (err) { next(err); }
  };
}
