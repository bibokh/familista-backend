// The key-encryption keyring — many keys, one active, none of them in Postgres
// ─────────────────────────────────────────────────────────────────────────────
// Item 3 sealed every credential under one key read from one environment
// variable. That works right up to the day the key has to change, and then it
// does not work at all: re-keying means every existing ciphertext becomes
// unreadable at the same instant, so the only safe rotation is no rotation. A
// key that cannot be rotated is a key that will still be in use the day it
// leaks.
//
// So a sealed envelope now NAMES the key that sealed it, and this module holds
// the set of keys that name resolves against.
//
//   fam1:<kid>:<iv>:<tag>:<ciphertext>
//
// New writes use the ACTIVE key. Reads use the key the envelope names — always
// that one, never another. That single rule is what makes rotation survivable
// and it is also the rule that has to be enforced rather than intended: a read
// path that "tries the other keys" when the named one fails turns a rotation
// into an oracle, and turns a retired key into one that still works.
//
// WHERE THE MATERIAL LIVES
//
// The environment, exactly as before, and never the database. A dump of
// `PlatformSecret` is a dump of ciphertext plus the NAMES of the keys that
// would open it; the material is somewhere the database cannot reach.
//
//   FAMILISTA_SECRET_KEK        the key Item 3 deployed. Kid `v1`.
//   FAMILISTA_KEK_<KID>         one keyring entry. Kid is the suffix,
//                               lower-cased, underscores read as hyphens:
//                               FAMILISTA_KEK_2026_01 → `2026-01`.
//   FAMILISTA_ACTIVE_KEK        which kid seals new writes.
//   FAMILISTA_RETIRED_KEKS       comma-separated kids that must no longer be
//                               used, for reading OR writing.
//
// ADDING A KEY DOES NOT START USING IT
//
// With more than one key configured, `FAMILISTA_ACTIVE_KEK` is REQUIRED. There
// is no "newest wins" rule, because a rule like that means adding a key
// silently changes which one seals the next credential — and a rotation nobody
// performed is a rotation nobody verified. Step A (add material) is inert until
// step B (name it active), and both are visible in the deployment's own
// configuration.
//
// BACKWARD COMPATIBILITY, PRECISELY
//
// Kid `v1` is reserved for the key Item 3 already deployed, and derives its
// AES key through the ORIGINAL domain separator, byte for byte. Every other kid
// derives through a kid-scoped separator, so the same material configured under
// two names cannot produce the same key. `v1` keeps the old separator whether
// its material arrives as `FAMILISTA_SECRET_KEK` or `FAMILISTA_KEK_V1`; that
// exception is the whole reason ciphertext sealed before this change still
// opens after it.

import { createHash } from 'crypto';

/** The variable Item 3 shipped. Still read, still the `v1` material. */
export const SECRET_KEK_ENV = 'FAMILISTA_SECRET_KEK';

/** One keyring entry per variable with this prefix. */
export const KEYRING_ENV_PREFIX = 'FAMILISTA_KEK_';

/** Which kid seals new writes. */
export const ACTIVE_KEK_ENV = 'FAMILISTA_ACTIVE_KEK';

/** Kids that may no longer be used at all. Comma-separated. */
export const RETIRED_KEKS_ENV = 'FAMILISTA_RETIRED_KEKS';

/**
 * The kid an envelope with no kid is understood to carry.
 *
 * Item 3's envelope was `iv:tag:ciphertext` with the key implied. Those rows
 * exist, so the implication has to be given a name rather than guessed at every
 * call site.
 */
export const LEGACY_KID = 'v1';

/** The marker that distinguishes a versioned envelope from Item 3's. */
export const ENVELOPE_MARKER = 'fam1';

/**
 * How much real key material every configured key must carry.
 *
 * 32 bytes — 256 bits — because that is the width of the AES-256 key it is
 * hashed into. A KEK with less entropy than the key it derives does not make
 * the key stronger; it makes the key exactly as guessable as the KEK, and the
 * SHA-256 in between hides that fact by producing 32 bytes of output whatever
 * goes in. That hiding is the whole hazard this floor exists to remove.
 *
 * It applies to EVERY key in the keyring, not just the active one. A weak
 * retired-but-still-readable key is a weak key protecting real ciphertext.
 */
export const MIN_KEK_BYTES = 32;

/**
 * The fewest distinct characters a key may be built from.
 *
 * Length alone is not strength: `'a'.repeat(64)` reads as 32 bytes of hex and
 * would sail past a byte floor while carrying almost no entropy. Eight is
 * deliberately low — lowercase hex has only sixteen distinct symbols and is a
 * perfectly good key — so this rejects the pathological case and nothing real.
 */
export const MIN_KEK_DISTINCT_CHARS = 8;

/** A kid goes in an envelope, a column, a log and an event. Keep it plain. */
const KID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// ── the errors ───────────────────────────────────────────────────────────────
//
// All of them extend one type, because every caller wants the same distinction:
// a configuration fault must be loud and must never be mistaken for "this
// credential does not exist". `openSecret` rethrows this family and answers
// null for everything else; `storeNewCredential` catches it and falls back to
// the legacy column rather than storing a credential badly.

/** Anything wrong with the keyring or a key in it. Config, not runtime. */
export class SecretKeyConfigError extends Error {}

export class SecretKeyUnavailable extends SecretKeyConfigError {
  constructor(detail = `${SECRET_KEK_ENV} is not set`) {
    super(`${detail}. The encrypted secret store cannot open or seal anything without it.`);
    this.name = 'SecretKeyUnavailable';
  }
}

export class WeakSecretKey extends SecretKeyConfigError {
  constructor(reason: string, where = SECRET_KEK_ENV) {
    // Names the variable and the requirement. Never the value, never its
    // actual length, never any part of it — an error message is a place
    // secrets go to be read by whoever has the logs.
    super(
      `${where} does not meet the minimum strength for sealing credentials: ${reason}. `
      + `Supply at least ${MIN_KEK_BYTES} bytes of cryptographic randomness — for example, `
      + `the output of \`openssl rand -base64 48\`.`,
    );
    this.name = 'WeakSecretKey';
  }
}

/**
 * The envelope names a key this deployment does not have.
 *
 * Fails closed, and deliberately does NOT try any other key. Trying the rest of
 * the keyring would mean a ciphertext could be opened by a key that did not seal
 * it — which cannot happen with AES-GCM, so the only thing the attempt achieves
 * is turning a retired key back on and telling a prober how many keys exist.
 */
export class UnknownKeyId extends SecretKeyConfigError {
  constructor(readonly kid: string) {
    super(
      `No key-encryption key is configured for kid "${kid}". `
      + `Set ${KEYRING_ENV_PREFIX}${kid.toUpperCase().replace(/-/g, '_')} to the material that sealed it, `
      + `or leave it unset if this ciphertext is meant to be unreadable.`,
    );
    this.name = 'UnknownKeyId';
  }
}

/** The key exists but has been retired. Retired means retired. */
export class RetiredKeyId extends SecretKeyConfigError {
  constructor(readonly kid: string) {
    super(
      `The key-encryption key "${kid}" is retired and must not be used. `
      + `Remove it from ${RETIRED_KEKS_ENV} only if retiring it was a mistake.`,
    );
    this.name = 'RetiredKeyId';
  }
}

/** Two variables that mean the same kid. Which one wins is not a coin toss. */
export class DuplicateKeyId extends SecretKeyConfigError {
  constructor(readonly kid: string, sources: string[]) {
    super(
      `Two environment variables both define the key-encryption key "${kid}": `
      + `${sources.join(' and ')}. Remove one — which of them would win is not something to guess at.`,
    );
    this.name = 'DuplicateKeyId';
  }
}

/** The keyring is internally inconsistent. Named separately so it reads well. */
export class KeyringMisconfigured extends SecretKeyConfigError {
  constructor(reason: string) {
    super(`The key-encryption keyring is misconfigured: ${reason}.`);
    this.name = 'KeyringMisconfigured';
  }
}

// ── measuring key material ───────────────────────────────────────────────────

/**
 * How many bytes of key material a KEK string actually carries.
 *
 * The value is an opaque string that gets hashed, so "how long is it" has more
 * than one answer, and the honest one is the SMALLEST. A 44-character base64
 * string is 44 ASCII characters and 33 bytes of entropy; counting the
 * characters would credit it with a third more strength than it has. So every
 * plausible decoding is tried and the minimum is taken — the conservative
 * reading, which is the correct direction for a security floor to be wrong in.
 *
 * A value that is not valid base64 or hex — a passphrase, say — is measured by
 * its UTF-8 byte length. That is generous, since printable ASCII carries about
 * six bits per byte rather than eight, but the alternative is refusing every
 * passphrase, and the distinct-character floor already catches the degenerate
 * ones.
 */
export function effectiveKeyBytes(raw: string): number {
  const v = String(raw ?? '');
  if (!v) return 0;

  const candidates: number[] = [Buffer.byteLength(v, 'utf8')];

  // base64 / base64url. Node is lenient, so a round-trip check is what proves
  // the string really was that encoding rather than merely survived it.
  if (/^[A-Za-z0-9+/\-_]+={0,2}$/.test(v) && v.length >= 4) {
    const decoded = Buffer.from(v, 'base64');
    if (decoded.length > 0) {
      const reencoded = decoded.toString('base64').replace(/=+$/, '');
      const normalised = v.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
      if (reencoded === normalised) candidates.push(decoded.length);
    }
  }

  // hex
  if (/^[A-Fa-f0-9]+$/.test(v) && v.length % 2 === 0) {
    candidates.push(v.length / 2);
  }

  return Math.min(...candidates);
}

/** Why this key material is unacceptable, or null when it is fine. */
export function kekWeakness(raw: string): string | null {
  const v = String(raw ?? '');
  if (!v) return 'it is empty';
  if (effectiveKeyBytes(v) < MIN_KEK_BYTES) {
    return `it carries fewer than ${MIN_KEK_BYTES} bytes of key material`;
  }
  if (new Set(v).size < MIN_KEK_DISTINCT_CHARS) {
    return `it is built from too few distinct characters to be random`;
  }
  return null;
}

/** The kid a keyring variable name describes. */
export function kidFromEnvName(name: string): string {
  return name.slice(KEYRING_ENV_PREFIX.length).toLowerCase().replace(/_/g, '-');
}

// ── reading the keyring ──────────────────────────────────────────────────────

export interface KeyringEntry {
  kid: string;
  /** The variable it came from. A NAME, safe to log. Never the material. */
  source: string;
  retired: boolean;
  /** Why this key is unusable, or null. Never quotes the material. */
  weakness: string | null;
}

export interface KeyringReport {
  keys: KeyringEntry[];
  activeKid: string | null;
  /** Why nothing can be sealed right now, or null when the active key is fine. */
  problem: string | null;
  /**
   * Which KIND of problem, so a caller can throw the error an operator can act
   * on. Collapsing "the variable is not set", "the key is too weak" and "the
   * configuration contradicts itself" into one generic fault would tell whoever
   * is reading the logs at 3am nothing they can use.
   */
  problemKind: 'none' | 'unset' | 'weak' | 'misconfigured';
  /** For a weak key: the reason and the variable, so the error names both. */
  problemDetail: { reason: string; source: string } | null;
  /** True once any `FAMILISTA_KEK_*` is present — the switch to versioned writes. */
  versionedWrites: boolean;
}

/** Material for one kid, or null. The one place env is read for a key. */
function materialFor(kid: string): { material: string; source: string } | null {
  const direct = `${KEYRING_ENV_PREFIX}${kid.toUpperCase().replace(/-/g, '_')}`;
  const sources: Array<[string, string | undefined]> = [[direct, process.env[direct]]];

  if (kid === LEGACY_KID) {
    // The two variables Item 3 read, in the order Item 3 read them. The MFA key
    // stays a fallback so a deployment that already has one strong, separately
    // managed key was never forced to add a second before any of this worked.
    sources.push([SECRET_KEK_ENV, process.env[SECRET_KEK_ENV]]);
    sources.push(['MFA_ENCRYPTION_KEY', process.env.MFA_ENCRYPTION_KEY]);
  }

  for (const [source, material] of sources) {
    if (material) return { material, source };
  }
  return null;
}

/** Every kid this deployment names, in a stable order, with nothing secret. */
export function readKeyring(): KeyringReport {
  const retired = new Set(
    String(process.env[RETIRED_KEKS_ENV] ?? '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );

  // Collect from the prefix, and detect two names that mean one kid before
  // deciding anything. `FAMILISTA_KEK_V1` and `FAMILISTA_KEK_v1` are both legal
  // environment variables on Linux and both mean `v1`.
  const bySource = new Map<string, string[]>();
  for (const name of Object.keys(process.env)) {
    if (!name.startsWith(KEYRING_ENV_PREFIX) || !process.env[name]) continue;
    const kid = kidFromEnvName(name);
    bySource.set(kid, [...(bySource.get(kid) ?? []), name]);
  }

  const versionedWrites = bySource.size > 0;
  const kids = new Set<string>(bySource.keys());
  // `v1` exists whenever its bootstrap material does, whether or not anybody
  // wrote a keyring entry for it — otherwise deploying this would make every
  // credential Item 3 sealed unreadable, which is the exact failure it exists
  // to prevent.
  if (materialFor(LEGACY_KID)) kids.add(LEGACY_KID);

  const keys: KeyringEntry[] = [];
  const problems: string[] = [];

  for (const kid of [...kids].sort()) {
    const duplicates = bySource.get(kid) ?? [];
    if (duplicates.length > 1) {
      problems.push(new DuplicateKeyId(kid, duplicates.sort()).message);
      continue;
    }
    if (!KID.test(kid)) {
      problems.push(`"${kid}" is not a usable key id — lower case, digits and hyphens only`);
      continue;
    }
    const found = materialFor(kid);
    if (!found) continue;
    keys.push({
      kid, source: found.source, retired: retired.has(kid),
      weakness: kekWeakness(found.material),
    });
  }

  const usable = keys.filter((k) => !k.retired && !k.weakness);
  const named = String(process.env[ACTIVE_KEK_ENV] ?? '').trim().toLowerCase();

  let activeKid: string | null = null;
  let problem: string | null = problems[0] ?? null;
  let problemKind: KeyringReport['problemKind'] = problem ? 'misconfigured' : 'none';
  let problemDetail: KeyringReport['problemDetail'] = null;

  /** Record the first problem found. Later ones do not overwrite it. */
  const fault = (kind: 'unset' | 'weak' | 'misconfigured', message: string,
                 detail: { reason: string; source: string } | null = null) => {
    if (problem) return;
    problem = message; problemKind = kind; problemDetail = detail;
  };

  /** A weak key, reported so the error names the variable AND the requirement. */
  const weakFault = (entry: KeyringEntry) => fault(
    'weak', new WeakSecretKey(entry.weakness as string, entry.source).message,
    { reason: entry.weakness as string, source: entry.source },
  );

  if (named) {
    const entry = keys.find((k) => k.kid === named);
    if (!entry) {
      fault('misconfigured', `${ACTIVE_KEK_ENV} names "${named}", for which no key material is configured`);
    } else if (entry.retired) {
      fault('misconfigured', `${ACTIVE_KEK_ENV} names "${named}", which is listed in ${RETIRED_KEKS_ENV}`);
    } else if (entry.weakness) {
      weakFault(entry);
    } else {
      activeKid = entry.kid;
    }
  } else if (usable.length === 1) {
    // One key and no ambiguity to resolve. This is the shape of the currently
    // deployed service, and it must keep working with nothing added.
    activeKid = usable[0].kid;
  } else if (usable.length === 0) {
    if (keys.length === 0) {
      fault('unset', `${SECRET_KEK_ENV} is not set`);
    } else {
      // Prefer the specific weakness over "nothing here works". A deployment
      // with one weak key must be told which variable is weak and what would
      // fix it — that is the whole difference between an error and a mystery.
      const weak = keys.find((k) => !k.retired && k.weakness);
      if (weak) weakFault(weak);
      else fault('misconfigured', `every configured key-encryption key is listed in ${RETIRED_KEKS_ENV}`);
    }
  } else {
    // Deliberately fatal. See the header: adding a key must not silently change
    // which one seals the next credential.
    fault('misconfigured',
      `${keys.length} key-encryption keys are configured, so ${ACTIVE_KEK_ENV} `
      + `must name the one that seals new credentials (candidates: ${usable.map((k) => k.kid).join(', ')})`);
  }

  return { keys, activeKid, problem, problemKind, problemDetail, versionedWrites };
}

// ── deriving ─────────────────────────────────────────────────────────────────

/**
 * The AES key for one kid.
 *
 * `v1` keeps Item 3's separator exactly, which is what lets already-sealed
 * ciphertext open. Every other kid is domain-separated BY ITS KID, so the same
 * material configured twice under two names derives two different keys — the
 * property that stops a copy-pasted rotation from being a rotation in name
 * only.
 */
function deriveFor(kid: string, material: string): Buffer {
  const salted = kid === LEGACY_KID
    ? `${material}:familista:secret:v1`
    : `${material}:familista:secret:kek:${kid}`;
  return createHash('sha256').update(salted).digest();
}

/**
 * The key that opens an envelope naming this kid.
 *
 * Throws for every reason a key might not be usable, and returns a key for no
 * other reason. There is no path through this function that substitutes a
 * different kid's key — see `UnknownKeyId`.
 */
export function keyForKid(kid: string): Buffer {
  if (!KID.test(String(kid ?? ''))) throw new UnknownKeyId(String(kid));

  const ring = readKeyring();
  const entry = ring.keys.find((k) => k.kid === kid);

  // A duplicate or malformed entry elsewhere in the ring must not silently
  // become "this kid is unknown" — the operator needs the real reason.
  if (!entry) {
    if (ring.problem && /both define|not a usable key id/.test(ring.problem)) {
      throw new KeyringMisconfigured(ring.problem);
    }
    throw new UnknownKeyId(kid);
  }
  if (entry.retired) throw new RetiredKeyId(kid);
  if (entry.weakness) throw new WeakSecretKey(entry.weakness, entry.source);

  const found = materialFor(kid);
  if (!found) throw new UnknownKeyId(kid);
  return deriveFor(kid, found.material);
}

/** The kid and key that seal the next credential. Throws when nothing can. */
export function activeKey(): { kid: string; key: Buffer; versioned: boolean } {
  const ring = readKeyring();
  if (!ring.activeKid) {
    // The error class carries the diagnosis. `storeNewCredential` catches this
    // whole family identically, but a person reading the log does not.
    if (ring.problemKind === 'weak' && ring.problemDetail) {
      throw new WeakSecretKey(ring.problemDetail.reason, ring.problemDetail.source);
    }
    const problem = ring.problem ?? `${SECRET_KEK_ENV} is not set`;
    if (ring.problemKind === 'unset') throw new SecretKeyUnavailable(problem);
    throw new KeyringMisconfigured(problem);
  }
  return {
    kid: ring.activeKid,
    key: keyForKid(ring.activeKid),
    // Only start writing the versioned envelope once a keyring exists. A
    // deployment carrying nothing but the Item 3 variable keeps writing the
    // Item 3 format, so a rolling deploy cannot leave a new-format ciphertext
    // in front of an instance that predates this change.
    versioned: ring.versionedWrites,
  };
}

/**
 * Whether this deployment can seal anything, and why not.
 *
 * The shape Item 3 exported, kept exactly: callers assert on it. The richer
 * per-key picture is `keyringStatus`.
 */
export function secretKeyStatus(): { usable: boolean; reason: string | null } {
  const ring = readKeyring();
  if (ring.activeKid) return { usable: true, reason: null };
  // Item 3 phrased a weak key as "<VAR> <weakness>", short enough to sit in a
  // status row. Preserved exactly, rather than replaced with the long remedial
  // form, so an operator reading a status page sees the same sentence as before.
  if (ring.problemKind === 'weak' && ring.problemDetail) {
    return { usable: false, reason: `${ring.problemDetail.source} ${ring.problemDetail.reason}` };
  }
  return { usable: false, reason: (ring.problem ?? `${SECRET_KEK_ENV} is not set`).replace(/\.$/, '') };
}

/**
 * The whole keyring, for a status surface and for the rotation runbook.
 *
 * Names, sources and verdicts. No material, no derived key, and no length —
 * "the active key is 31 bytes" narrows a brute force.
 */
export function keyringStatus(): KeyringReport & { retiredKids: string[] } {
  const ring = readKeyring();
  return { ...ring, retiredKids: ring.keys.filter((k) => k.retired).map((k) => k.kid) };
}
