// Refresh tokens, as they are kept at rest
// ─────────────────────────────────────────────────────────────────────────────
// Cyber Defense, Step 8. A refresh token is a bearer credential: whoever holds
// it can mint sessions for a week. So the database keeps only its SHA-256, and
// a copy of the table — a backup, a replica, a leaked dump — holds nothing that
// signs anybody in.
//
// Plain SHA-256, not a keyed hash, on purpose. The token is a signed JWT with a
// random `jti`, so it cannot be guessed and a digest cannot be reversed; and a
// hash that needs no key has no key to lose, rotate or leave unset. The same
// digest is computed in SQL by the Step 8 migration to backfill existing rows,
// so the prefix below must never change without a migration that re-hashes.

import { createHash } from 'crypto';

/** Domain separation: this digest cannot be confused with any other SHA-256 the platform keeps. */
export const REFRESH_TOKEN_HASH_PREFIX = 'familista:refresh-token:v1:';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(REFRESH_TOKEN_HASH_PREFIX + token, 'utf8').digest('hex');
}
