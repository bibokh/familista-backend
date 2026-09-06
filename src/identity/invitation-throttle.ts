// Anti-abuse for invitations — spam, replay and enumeration
// ─────────────────────────────────────────────────────────────────────────────
// An invitation endpoint is an email-sending endpoint pointed at an address the
// caller chooses. Left open it is a spam relay, a way to probe which addresses
// have accounts, and a way to burn a club's sender reputation. Four buckets,
// each describing a different abuse:
//
//   RESEND per invitation   somebody clicking "resend" repeatedly
//   INVITE per club         one club inviting the world
//   INVITE per actor        one account inviting the world across clubs
//   ACCEPT per address      brute-forcing a token
//
// A token-bucket in memory, refilling over time. Deliberately not the HTTP rate
// limiter: this counts business actions, which is what the abuse is made of,
// and it holds whether the caller comes through one route or another.

interface Bucket { tokens: number; refilledAt: number; }

const buckets = new Map<string, Bucket>();

export interface Limit { capacity: number; refillMs: number; }

/** Deliberately generous for real use and tight against a script. */
export const LIMITS: Readonly<Record<string, Limit>> = Object.freeze({
  // Three resends of one invitation per hour. A person who needs a fourth has
  // a problem an email cannot fix.
  resend: { capacity: 3, refillMs: 60 * 60 * 1000 },
  // Fifty new invitations per club per hour: a whole academy's staff at once,
  // and nothing like a mailing list.
  clubInvite: { capacity: 50, refillMs: 60 * 60 * 1000 },
  // Sixty per actor per hour, across every club they can reach.
  actorInvite: { capacity: 60, refillMs: 60 * 60 * 1000 },
  // Ten acceptance attempts per address per hour. A token is 32 random bytes;
  // ten guesses is not a brute force, it is a person with a broken clipboard.
  accept: { capacity: 10, refillMs: 60 * 60 * 1000 },
});

export function consume(bucketName: keyof typeof LIMITS | string, key: string, now = Date.now()): boolean {
  const limit = LIMITS[bucketName as string];
  if (!limit) return true;
  const id = `${bucketName}:${key}`;
  const bucket = buckets.get(id) ?? { tokens: limit.capacity, refilledAt: now };

  // Continuous refill: capacity tokens per refillMs, rather than a hard window
  // that lets a burst through the moment it rolls over.
  const elapsed = now - bucket.refilledAt;
  if (elapsed > 0) {
    bucket.tokens = Math.min(limit.capacity, bucket.tokens + (elapsed / limit.refillMs) * limit.capacity);
    bucket.refilledAt = now;
  }
  if (bucket.tokens < 1) { buckets.set(id, bucket); return false; }
  bucket.tokens -= 1;
  buckets.set(id, bucket);
  return true;
}

export function resetInvitationThrottle(): void { buckets.clear(); }

/** For a diagnostic screen. Counts only — no address is a key here that leaves. */
export function throttleStats() {
  return { buckets: buckets.size, limits: LIMITS };
}
