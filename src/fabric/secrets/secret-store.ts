// Where secrets actually live, named without naming a vendor
// ─────────────────────────────────────────────────────────────────────────────
// Five operations, and domain code may know no more than these five. Same
// constraint as the object store, for the same reason: the only reliable way to
// keep "do not hard-code Vault, AWS Secrets Manager or GCP" is for the domain
// to have no vocabulary in which to express one.
//
// THREE PROVIDERS SHIP, NONE OF THEM PAID
//
//   memory   In process. Tests, and a deployment with nothing configured.
//   env      `process.env`, keyed by the reference. For a deployment that
//            already manages secrets outside the database — Render's own
//            environment groups, a Kubernetes secret mounted as env.
//   db       An envelope-encrypted row. AES-256-GCM under a key derived from
//            an environment KEK the database never sees, so a logical dump of
//            Postgres carries ciphertext and nothing else.
//
// `db` is the practical default and the one that actually removes the finding:
// today a device's root key is a plaintext column, so every `pg_dump`, every
// Neon branch and every logical backup carries the credentials of the entire
// device fleet in the clear. Moving it to a ciphertext row under a KEK that
// lives only in the environment breaks that, without provisioning anything.
//
// A future Vault or KMS provider implements this interface and is registered.
// Nothing else changes.
//
// WHAT THIS FILE NEVER DOES
//
// It never logs a secret, never returns one in an error message, never puts one
// in an event, and never lets a caller enumerate. `getSecret` on a reference
// that does not exist returns null; it does not say whether the name was wrong,
// the version was wrong, or the store was empty, because those three answers
// together are an oracle.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto';
import { formatSecretRef, nextVersion, type SecretRef } from './secret-ref';
import { activeKey, keyForKid, ENVELOPE_MARKER, LEGACY_KID } from './keyring';

/** A secret, in memory, for as long as the caller holds it. */
export type SecretValue = string;

export interface PutSecretOptions {
  /** Overwrite an existing value at this exact reference. Off by default. */
  overwrite?: boolean;
  /** Free-form, never secret. Who created it and why. */
  metadata?: Record<string, unknown>;
}

export interface RotateResult {
  /** The new reference — same name, next version. */
  ref: SecretRef;
  /** The new value, returned once. Never stored by the caller. */
  value: SecretValue;
  /** The reference that was superseded, still resolvable until revoked. */
  previous: SecretRef;
}

/**
 * The port.
 *
 * `rotateSecret` is part of the interface rather than a helper on top of
 * `putSecret`, because rotation has a property a put does not: the previous
 * version must stay resolvable. A fleet of devices cannot re-key in the same
 * instant, and a store that cannot express "both are valid for now" forces a
 * rotation to be an outage.
 */
export interface SecretStore {
  readonly provider: string;
  getSecret(ref: SecretRef): Promise<SecretValue | null>;
  putSecret(ref: SecretRef, value: SecretValue, opts?: PutSecretOptions): Promise<void>;
  rotateSecret(ref: SecretRef, opts?: { bytes?: number }): Promise<RotateResult>;
  deleteSecret(ref: SecretRef): Promise<void>;
  exists(ref: SecretRef): Promise<boolean>;
}

export const DEFAULT_SECRET_BYTES = 32;

/** A fresh secret. One place, so nobody invents a weaker one at a call site. */
export function generateSecret(bytes: number = DEFAULT_SECRET_BYTES): SecretValue {
  return randomBytes(bytes).toString('base64');
}

/**
 * Compare two secrets without leaking which byte differed.
 *
 * Exported so a verification path never reaches for `===`. Length is compared
 * first and non-constant-time, which is not a weakness: the length of an HMAC
 * digest is public.
 */
export function secretsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── in memory ────────────────────────────────────────────────────────────────

export class MemorySecretStore implements SecretStore {
  readonly provider = 'memory';
  private values = new Map<string, SecretValue>();

  async getSecret(ref: SecretRef): Promise<SecretValue | null> {
    return this.values.get(formatSecretRef(ref)) ?? null;
  }

  async putSecret(ref: SecretRef, value: SecretValue, opts: PutSecretOptions = {}): Promise<void> {
    const key = formatSecretRef(ref);
    if (!opts.overwrite && this.values.has(key)) {
      throw new Error('A secret already exists at that reference');
    }
    this.values.set(key, value);
  }

  async rotateSecret(ref: SecretRef, opts: { bytes?: number } = {}): Promise<RotateResult> {
    const next = nextVersion(ref);
    const value = generateSecret(opts.bytes);
    await this.putSecret(next, value, { overwrite: true });
    return { ref: next, value, previous: ref };
  }

  async deleteSecret(ref: SecretRef): Promise<void> {
    this.values.delete(formatSecretRef(ref));
  }

  async exists(ref: SecretRef): Promise<boolean> {
    return this.values.has(formatSecretRef(ref));
  }
}

// ── the environment ──────────────────────────────────────────────────────────

/**
 * `process.env`, for a deployment that manages secrets outside the database.
 *
 * Read-only by nature: a process cannot durably write its own environment, and
 * pretending otherwise — by mutating `process.env` — would produce a secret
 * that survives until the next restart and then silently does not. So writes
 * refuse, loudly, and say what to do instead.
 */
export class EnvSecretStore implements SecretStore {
  readonly provider = 'env';

  private varName(ref: SecretRef): string {
    return `FAMILISTA_SECRET_${ref.scope}_${ref.name}_V${ref.version}`
      .toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  }

  async getSecret(ref: SecretRef): Promise<SecretValue | null> {
    return process.env[this.varName(ref)] ?? null;
  }

  // The full signatures, even though every argument is refused: a narrower
  // signature would make this implementation structurally incompatible with
  // the port at a call site that passes options, and the point of a port is
  // that every implementation is substitutable.
  async putSecret(_ref: SecretRef, _value: SecretValue, _opts?: PutSecretOptions): Promise<void> {
    throw new Error(
      'The env secret store is read-only. Set the variable on the deployment, then record the reference.',
    );
  }

  async rotateSecret(_ref: SecretRef, _opts?: { bytes?: number }): Promise<RotateResult> {
    throw new Error(
      'The env secret store cannot rotate. Set the next version on the deployment, then advance the reference.',
    );
  }

  async deleteSecret(_ref: SecretRef): Promise<void> {
    throw new Error('The env secret store is read-only. Remove the variable on the deployment.');
  }

  async exists(ref: SecretRef): Promise<boolean> {
    return process.env[this.varName(ref)] != null;
  }
}

// ── envelope encryption, for the database-backed store ───────────────────────
//
// The KEK never reaches the database. A dump of `PlatformSecret` is a table of
// ciphertext, and the key that opens it is an environment variable of the
// running service — which is exactly the separation the plaintext column
// lacked.
//
// An envelope NAMES the key that sealed it, so more than one key can be live at
// once and a rotation does not have to make yesterday's ciphertext unreadable:
//
//   fam1:<kid>:<iv>:<tag>:<ciphertext>      every part base64 but the kid
//   <iv>:<tag>:<ciphertext>                 what Item 3 wrote — kid `v1`
//
// The read path uses the key the envelope names and no other. That is the rule
// the whole rotation design rests on, and `keyring.ts` is where it is enforced.

// The strength floor, the errors and the derivation all live in `keyring.ts`
// now, because a keyring is what they are policy about. Re-exported here so
// every existing importer of this module is unaffected.
export {
  SECRET_KEK_ENV, KEYRING_ENV_PREFIX, ACTIVE_KEK_ENV, RETIRED_KEKS_ENV,
  LEGACY_KID, ENVELOPE_MARKER, MIN_KEK_BYTES, MIN_KEK_DISTINCT_CHARS,
  SecretKeyConfigError, SecretKeyUnavailable, WeakSecretKey,
  UnknownKeyId, RetiredKeyId, DuplicateKeyId, KeyringMisconfigured,
  effectiveKeyBytes, kekWeakness, kidFromEnvName,
  readKeyring, keyringStatus, secretKeyStatus, keyForKid, activeKey,
  type KeyringEntry, type KeyringReport,
} from './keyring';

/**
 * A sealed envelope, taken apart.
 *
 * Everything here is non-secret and everything needed to resolve the key is
 * present: the kid that names it, the format version that says how to read the
 * rest, the nonce and the authentication tag. Nothing about the format is
 * ambiguous — a versioned envelope has five parts and a fixed marker, and an
 * Item 3 envelope has exactly three. A string that is neither is not an
 * envelope, rather than an envelope read the wrong way.
 */
export interface SecretEnvelope {
  kid: string;
  /** `fam1`, or `legacy` for the unversioned form Item 3 wrote. */
  format: 'fam1' | 'legacy';
  ivB64: string;
  tagB64: string;
  ciphertextB64: string;
}

/** A kid in an envelope is spelled the same way the keyring spells one. */
const ENVELOPE_KID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The nonce and tag are fixed widths for AES-256-GCM, and checking them is what
 * makes the two formats unambiguous rather than merely different lengths.
 *
 * Without this, `fam1:a:b` is three colon-separated parts and would be read as
 * an Item 3 envelope whose IV happens to be the string `fam1` — malformed input
 * arriving at key resolution dressed as a real ciphertext. A 12-byte IV is
 * sixteen base64 characters; `fam1` is not one.
 */
function isB64OfLength(value: string, bytes: number): boolean {
  if (!value) return false;
  const buf = Buffer.from(value, 'base64');
  return buf.length === bytes;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parse an envelope. Null for anything that is not one. Never throws. */
export function parseEnvelope(envelope: string): SecretEnvelope | null {
  const parts = String(envelope ?? '').split(':');

  const wellFormed = (ivB64: string, tagB64: string, ciphertextB64: string) =>
    isB64OfLength(ivB64, IV_BYTES) && isB64OfLength(tagB64, TAG_BYTES) && !!ciphertextB64;

  if (parts.length === 5 && parts[0] === ENVELOPE_MARKER) {
    const [, kid, ivB64, tagB64, ciphertextB64] = parts;
    if (!ENVELOPE_KID.test(kid ?? '')) return null;
    if (!wellFormed(ivB64, tagB64, ciphertextB64)) return null;
    return { kid, format: 'fam1', ivB64, tagB64, ciphertextB64 };
  }

  // Item 3's form. The key was implied rather than named, so the implication
  // is resolved here, once, instead of being re-guessed by every reader.
  if (parts.length === 3) {
    const [ivB64, tagB64, ciphertextB64] = parts;
    if (!wellFormed(ivB64, tagB64, ciphertextB64)) return null;
    return { kid: LEGACY_KID, format: 'legacy', ivB64, tagB64, ciphertextB64 };
  }

  return null;
}

/** Which key sealed this, without opening it. What the audit column records. */
export function envelopeKid(envelope: string): string | null {
  return parseEnvelope(envelope)?.kid ?? null;
}

/**
 * Seal under the ACTIVE key, and say so in the envelope.
 *
 * A deployment with nothing but the Item 3 variable set still writes the Item 3
 * three-part form — see `activeKey`. So shipping this changes no byte of what
 * production currently writes until a keyring is actually configured.
 */
export function sealSecret(value: SecretValue): string {
  const { kid, key, versioned } = activeKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const body = `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
  return versioned ? `${ENVELOPE_MARKER}:${kid}:${body}` : body;
}

/**
 * Open an envelope with the key IT NAMES. Never with any other key.
 *
 * The two failure modes are kept apart on purpose. A configuration fault — no
 * such kid, a retired kid, a weak key — throws, because swallowing it as null
 * would make every credential in the store look revoked instead of making the
 * deployment look broken. A failed authentication tag answers null, because
 * that is a wrong or tampered ciphertext and the answer to it is "no", not
 * "here is why".
 */
export function openSecret(envelope: string): SecretValue | null {
  const parsed = parseEnvelope(envelope);
  if (!parsed) return null;

  // Outside the try: a key that cannot be resolved must propagate, not become
  // a null. And resolved by the envelope's own kid — there is no second
  // attempt with a different key, which is what makes a retired key retired.
  const key = keyForKid(parsed.kid);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertextB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Re-seal an already-sealed envelope under the active key, without the
 * plaintext ever reaching the caller.
 *
 * The rewrap primitive. The value exists as a local for the length of two
 * cryptographic operations and is never returned, logged or emitted, which is
 * what makes a bulk re-key something that can run unattended.
 *
 * Returns null when the envelope cannot be opened — a wrong key or a corrupt
 * row is left exactly as it is rather than being replaced with something worse.
 */
export function rewrapEnvelope(envelope: string): { sealed: string; fromKid: string; toKid: string } | null {
  const parsed = parseEnvelope(envelope);
  if (!parsed) return null;
  const value = openSecret(envelope);
  if (value == null) return null;
  const sealed = sealSecret(value);
  const toKid = envelopeKid(sealed);
  if (!toKid) return null;
  return { sealed, fromKid: parsed.kid, toKid };
}

// ── the registered store ─────────────────────────────────────────────────────

let store: SecretStore | null = null;

export function setSecretStore(next: SecretStore | null): void {
  store = next;
}

/**
 * The store this process uses.
 *
 * `FAMILISTA_SECRET_PROVIDER` selects it; the database-backed one is the
 * default because it is the one that removes the plaintext column. Resolving
 * lazily and never throwing means a misconfigured deployment degrades to an
 * in-memory store — where every lookup simply misses and the dual-read path
 * falls back to the legacy column — rather than failing every device request.
 */
export function getSecretStore(): SecretStore {
  if (store) return store;
  const configured = (process.env.FAMILISTA_SECRET_PROVIDER ?? 'db').toLowerCase();
  try {
    if (configured === 'env') store = new EnvSecretStore();
    else if (configured === 'memory') store = new MemorySecretStore();
    else {
      const mod = require('./db-secret-store') as typeof import('./db-secret-store');
      store = new mod.DbSecretStore();
    }
  } catch {
    store = new MemorySecretStore();
  }
  return store;
}
