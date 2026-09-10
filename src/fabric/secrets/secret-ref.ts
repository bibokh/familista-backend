// A name for a secret, that is not the secret
// ─────────────────────────────────────────────────────────────────────────────
// The whole point of a reference is that it can be stored in an ordinary
// application row, appear in a log, travel in an event and sit in a backup
// without any of those becoming a credential leak. So the format is designed
// around one rule, and the rule is checked rather than trusted:
//
//   A REFERENCE CONTAINS NO SECRET MATERIAL.
//
// It names a provider, a scope, a name and a version. Nothing in it can be used
// to compute the secret, and `assertNoSecretMaterial` refuses a reference whose
// parts look like key material — a long base64 or hex run — so a caller who
// tries to smuggle the secret into its own reference is stopped at construction
// rather than discovered in a backup.
//
// FORMAT
//
//   fam:v1:<provider>:<scope>/<name>#<version>
//   fam:v1:db:device/9f2c…-1a#3
//
// Versioned on purpose. Rotation mints version n+1 and leaves n resolvable for
// a grace period, which is what makes a rotation something a fleet of devices
// can survive rather than an outage — and what lets a compromised credential be
// revoked by version rather than by deleting the only one there is.

export const SECRET_REF_SCHEME = 'fam';
export const SECRET_REF_VERSION = 'v1';

export interface SecretRef {
  /** Which store holds it. `db`, `env`, `memory`, and later `vault`, `kms`, … */
  provider: string;
  /** What kind of thing owns it. `device`, `camera`, `edge`, `integration`. */
  scope: string;
  /** Which one — normally the owning row's id. Never the secret. */
  name: string;
  /** Rotation generation, starting at 1. */
  version: number;
}

export class SecretRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretRefError';
  }
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Does this look like key material rather than a name?
 *
 * A deliberately blunt heuristic, and blunt is right: the cost of refusing an
 * unusual-looking name is that somebody picks a different name; the cost of
 * accepting a smuggled secret is a credential in every backup that contains
 * the row. Long unbroken base64/hex runs are what a key looks like and what an
 * id does not — a UUID has dashes every few characters and is short.
 */
export function looksLikeSecretMaterial(value: string): boolean {
  const v = String(value ?? '');
  if (v.length >= 40 && /^[A-Za-z0-9+/=_-]+$/.test(v) && !v.includes('-')) return true;
  if (/[A-Fa-f0-9]{48,}/.test(v)) return true;
  if (/^[A-Za-z0-9+/]{32,}={0,2}$/.test(v)) return true;
  return false;
}

/** Refuse a reference that is carrying what it is supposed to be replacing. */
export function assertNoSecretMaterial(ref: SecretRef): void {
  for (const [field, value] of Object.entries({
    provider: ref.provider, scope: ref.scope, name: ref.name,
  })) {
    if (looksLikeSecretMaterial(String(value))) {
      throw new SecretRefError(
        `A secret reference must not contain secret material — check "${field}"`,
      );
    }
  }
}

export function makeSecretRef(parts: {
  provider: string; scope: string; name: string; version?: number;
}): SecretRef {
  const ref: SecretRef = {
    provider: String(parts.provider ?? '').toLowerCase().trim(),
    scope: String(parts.scope ?? '').toLowerCase().trim(),
    name: String(parts.name ?? '').trim(),
    version: parts.version ?? 1,
  };
  for (const [field, value] of Object.entries({ provider: ref.provider, scope: ref.scope, name: ref.name })) {
    if (!PART.test(String(value))) throw new SecretRefError(`Secret reference ${field} is not a valid name`);
  }
  if (!Number.isInteger(ref.version) || ref.version < 1) {
    throw new SecretRefError('Secret reference version must be a positive integer');
  }
  assertNoSecretMaterial(ref);
  return ref;
}

export function formatSecretRef(ref: SecretRef): string {
  return `${SECRET_REF_SCHEME}:${SECRET_REF_VERSION}:${ref.provider}:${ref.scope}/${ref.name}#${ref.version}`;
}

const REF = new RegExp(
  `^${SECRET_REF_SCHEME}:${SECRET_REF_VERSION}:([a-z0-9._-]+):([a-z0-9._-]+)/([A-Za-z0-9._-]+)#(\\d+)$`,
);

/**
 * Parse a stored reference.
 *
 * Returns null rather than throwing for anything unparseable, because the
 * common caller is a dual-read path looking at a column that may hold a
 * reference, may hold a legacy value, or may hold nothing — and none of those
 * three is an error worth an exception.
 */
export function parseSecretRef(value: string | null | undefined): SecretRef | null {
  const m = REF.exec(String(value ?? '').trim());
  if (!m) return null;
  try {
    return makeSecretRef({ provider: m[1], scope: m[2], name: m[3], version: Number(m[4]) });
  } catch {
    return null;
  }
}

export function isSecretRef(value: string | null | undefined): boolean {
  return parseSecretRef(value) !== null;
}

/** The next generation of the same secret. Rotation, expressed as a value. */
export function nextVersion(ref: SecretRef): SecretRef {
  return { ...ref, version: ref.version + 1 };
}
