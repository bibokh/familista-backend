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

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto';
import { formatSecretRef, nextVersion, type SecretRef } from './secret-ref';

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

export const SECRET_KEK_ENV = 'FAMILISTA_SECRET_KEK';

/**
 * How much real key material the KEK must carry.
 *
 * 32 bytes — 256 bits — because that is the width of the AES-256 key it is
 * hashed into. A KEK with less entropy than the key it derives does not make
 * the key stronger; it makes the key exactly as guessable as the KEK, and the
 * SHA-256 in between hides that fact by producing 32 bytes of output whatever
 * goes in. That hiding is the whole hazard this floor exists to remove.
 */
export const MIN_KEK_BYTES = 32;

/**
 * The fewest distinct characters a KEK may be built from.
 *
 * Length alone is not strength: `'a'.repeat(64)` is 64 bytes and carries almost
 * no entropy, and would sail past a length check. Eight is deliberately low —
 * lowercase hex has only sixteen distinct symbols and is a perfectly good KEK,
 * so a stricter floor would reject a legitimate one to catch a pathological
 * one. This rejects the pathological case and nothing real.
 */
export const MIN_KEK_DISTINCT_CHARS = 8;

/** Anything wrong with the key-encryption key. Config, not runtime. */
export class SecretKeyConfigError extends Error {}

export class SecretKeyUnavailable extends SecretKeyConfigError {
  constructor() {
    super(
      `${SECRET_KEK_ENV} is not set. The encrypted secret store cannot open or seal anything without it.`,
    );
    this.name = 'SecretKeyUnavailable';
  }
}

export class WeakSecretKey extends SecretKeyConfigError {
  constructor(reason: string) {
    // Names the variable and the requirement. Never the value, never its
    // actual length, never any part of it — an error message is a place
    // secrets go to be read by whoever has the logs.
    super(
      `${SECRET_KEK_ENV} does not meet the minimum strength for sealing credentials: ${reason}. `
      + `Supply at least ${MIN_KEK_BYTES} bytes of cryptographic randomness — for example, `
      + `the output of \`openssl rand -base64 48\`.`,
    );
    this.name = 'WeakSecretKey';
  }
}

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

/** Why this KEK is unacceptable, or null when it is fine. */
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

/**
 * The current KEK's usability, without revealing anything about it.
 *
 * Read by the status surface so a deployment can be checked BEFORE a credential
 * is minted against it. Returns a reason a person can act on and nothing a
 * person could attack.
 */
export function secretKeyStatus(): { usable: boolean; reason: string | null } {
  const raw = process.env[SECRET_KEK_ENV] || process.env.MFA_ENCRYPTION_KEY || '';
  if (!raw) return { usable: false, reason: `${SECRET_KEK_ENV} is not set` };
  const weakness = kekWeakness(raw);
  return weakness
    ? { usable: false, reason: `${SECRET_KEK_ENV} ${weakness}` }
    : { usable: true, reason: null };
}

function deriveKek(): Buffer {
  // The MFA key is accepted as a fallback so a deployment that already has one
  // strong, separately-managed key is not forced to add a second before this
  // can be used at all. A distinct KEK is still the right end state, and the
  // domain separator below means the two derive different keys either way.
  const raw = process.env[SECRET_KEK_ENV] || process.env.MFA_ENCRYPTION_KEY || '';
  if (!raw) throw new SecretKeyUnavailable();

  // Fail CLOSED, and before the hash. SHA-256 turns anything into 32 plausible
  // bytes, so a one-character KEK produces a key that looks exactly as good as
  // a strong one — which is precisely why the check has to happen here, on the
  // input, rather than anywhere downstream where only the output is visible.
  const weakness = kekWeakness(raw);
  if (weakness) throw new WeakSecretKey(weakness);

  return createHash('sha256').update(`${raw}:familista:secret:v1`).digest();
}

/** iv:tag:ciphertext, all base64. The same envelope shape the MFA store uses. */
export function sealSecret(value: SecretValue): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKek(), iv);
  const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

export function openSecret(envelope: string): SecretValue | null {
  try {
    const [ivB64, tagB64, encB64] = String(envelope).split(':');
    if (!ivB64 || !tagB64 || !encB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', deriveKek(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (err) {
    // A missing or weak key is a configuration fault worth surfacing; a failed
    // tag is a tampered or wrong-key ciphertext and answers "no", not "why".
    if (err instanceof SecretKeyConfigError) throw err;
    return null;
  }
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
