// Resolving a device or camera credential, old way or new
// ─────────────────────────────────────────────────────────────────────────────
// The dual-read seam. Every verification path in Familista asks this module for
// a credential instead of reading `row.hmacSecret`, and gets one whichever way
// the row happens to store it.
//
// THE ORDER, AND WHY IT IS THAT ORDER
//
//   1 · `secretRef` — if the row has one, that is the credential. Full stop.
//   2 · `hmacSecret` — only when there is no reference at all.
//
// Preferring the reference is what makes the cutover meaningful; falling back
// only in its ABSENCE is what makes it safe. A row that has been migrated has a
// reference, so a fallback that also fired on a resolution FAILURE would mean a
// revoked credential silently reverting to the plaintext one it replaced —
// revocation that does not revoke. So a row with a reference resolves through
// the reference or fails; it never quietly drops back.
//
// REVERSIBILITY
//
// Nothing here writes. Clearing `secretRef` on a row returns it to the legacy
// path exactly as it was, which is what makes the whole cutover a revert rather
// than a restoration.
//
// WHAT NEVER HAPPENS HERE
//
// No secret is logged, returned in an error, put in an event, or included in
// anything a serialiser can reach. The functions return a value to the caller
// that verifies with it, and that is the only place it exists.

import { logger } from '../../utils/logger';
import { emit } from '../event-bus';
import { parseSecretRef, makeSecretRef, formatSecretRef, type SecretRef } from './secret-ref';
import { getSecretStore, secretKeyStatus, secretsEqual } from './secret-store';

/** The two kinds of thing that hold a long-lived credential today. */
export type CredentialScope = 'device' | 'camera' | 'edge';

/** The shape a credential resolves from. Deliberately minimal — any row will do. */
export interface CredentialBearer {
  id: string;
  clubId?: string | null;
  secretRef?: string | null;
  /** LEGACY. Present only on rows that predate the reference. */
  hmacSecret?: string | null;
}

export type CredentialSource = 'REFERENCE' | 'LEGACY_COLUMN' | 'NONE';

export interface ResolvedCredential {
  /** The secret. Held by the caller for the length of one verification. */
  value: string | null;
  source: CredentialSource;
  /** The reference, when there is one. Safe to log — it is not the secret. */
  ref: string | null;
}

/** The canonical reference for a bearer's first credential. */
export function credentialRefFor(scope: CredentialScope, id: string, version = 1): SecretRef {
  return makeSecretRef({ provider: getSecretStore().provider, scope, name: id, version });
}

/**
 * The credential for this row, by whichever path it is stored on.
 *
 * Returns `{ value: null }` rather than throwing when nothing resolves. The
 * caller is a signature check, and a signature check that cannot find a key
 * fails the signature — which is the same refusal it would produce for a wrong
 * key, and does not tell a prober which of the two it was.
 */
export async function resolveCredential(bearer: CredentialBearer): Promise<ResolvedCredential> {
  const ref = parseSecretRef(bearer?.secretRef);

  if (ref) {
    const value = await getSecretStore().getSecret(ref).catch((err) => {
      // The reference is safe to log. The value is not, and is not in scope here.
      logger.warn('[secrets] credential reference did not resolve', {
        ref: formatSecretRef(ref), err: (err as Error).message,
      });
      return null;
    });
    // No fallback on failure — see the note above. A migrated row that cannot
    // resolve is a row whose credential has been revoked or whose store is
    // unavailable, and neither should be answered with the superseded key.
    return { value, source: 'REFERENCE', ref: formatSecretRef(ref) };
  }

  if (bearer?.hmacSecret) {
    return { value: bearer.hmacSecret, source: 'LEGACY_COLUMN', ref: null };
  }

  return { value: null, source: 'NONE', ref: null };
}

/**
 * Store a newly minted credential and return the reference to record on the row.
 *
 * Used at registration. If the store cannot accept it — no KEK configured, an
 * unavailable provider — this returns null and the caller writes the legacy
 * column exactly as it does today. That is not a silent downgrade: it is the
 * property that lets this ship without the deployment having to be reconfigured
 * first, and `credentialStorageMode` reports which way it went.
 */
export async function storeNewCredential(
  scope: CredentialScope,
  id: string,
  value: string,
  metadata: Record<string, unknown> = {},
): Promise<string | null> {
  try {
    const ref = credentialRefFor(scope, id);
    await getSecretStore().putSecret(ref, value, { overwrite: false, metadata });
    const refString = formatSecretRef(ref);
    // The REFERENCE, never the value. `value` is in scope on this line and is
    // deliberately not in the payload; a test reads this file and the emitted
    // event to prove it.
    void emit({
      eventType: 'device.credential.created',
      clubId: typeof metadata.clubId === 'string' ? metadata.clubId : null,
      subjectType: scope === 'camera' ? 'CAMERA' : 'DEVICE',
      subjectId: id,
      sourceType: 'SERVICE',
      payload: { scope, secretRef: refString, provider: getSecretStore().provider },
    });
    return refString;
  } catch (err) {
    logger.warn('[secrets] could not store a credential by reference; falling back to the legacy column', {
      scope, id, err: (err as Error).message,
    });
    return null;
  }
}

/**
 * Rotate a bearer's credential, returning the new value once.
 *
 * Only available to a row that already has a reference. A legacy row must be
 * migrated first — rotating a plaintext column in place would write a new
 * plaintext secret, which is the thing this whole item exists to stop.
 */
export async function rotateCredential(
  bearer: CredentialBearer,
): Promise<{ ref: string; value: string; previousRef: string } | null> {
  const ref = parseSecretRef(bearer?.secretRef);
  if (!ref) return null;
  const out = await getSecretStore().rotateSecret(ref);
  const result = {
    ref: formatSecretRef(out.ref),
    value: out.value,
    previousRef: formatSecretRef(out.previous),
  };
  void emit({
    eventType: 'device.credential.rotated',
    clubId: bearer.clubId ?? null,
    subjectType: ref.scope === 'camera' ? 'CAMERA' : 'DEVICE',
    subjectId: bearer.id,
    sourceType: 'SERVICE',
    // Two references and a version number. No secret material of any kind.
    payload: { secretRef: result.ref, previousRef: result.previousRef, version: out.ref.version },
  });
  return result;
}

/** Revoke one version. The credential stops authenticating; the record stays. */
export async function revokeCredential(
  refString: string | null | undefined,
  opts: { clubId?: string | null; subjectId?: string | null } = {},
): Promise<boolean> {
  const ref = parseSecretRef(refString);
  if (!ref) return false;
  await getSecretStore().deleteSecret(ref);
  void emit({
    eventType: 'device.credential.revoked',
    clubId: opts.clubId ?? null,
    subjectType: ref.scope === 'camera' ? 'CAMERA' : 'DEVICE',
    subjectId: opts.subjectId ?? ref.name,
    sourceType: 'SERVICE',
    payload: { secretRef: formatSecretRef(ref), version: ref.version },
  });
  return true;
}

/**
 * Which way this deployment will store the NEXT credential it mints.
 *
 * Read by the status surface. Says what is true rather than what is intended:
 * a deployment with no KEK configured reports that new credentials are still
 * going to the legacy column, instead of implying a migration that has not
 * happened.
 *
 * The KEK is checked here rather than only at the moment of sealing, because a
 * deployment whose KEK is too weak to seal anything should be able to discover
 * that from a status page — not from a device registration that quietly wrote
 * the legacy column instead.
 */
export async function credentialStorageMode(): Promise<{
  provider: string; writable: boolean; reason: string | null;
}> {
  const store = getSecretStore();
  try {
    const probe = makeSecretRef({ provider: store.provider, scope: 'probe', name: 'writability', version: 1 });
    await store.exists(probe);
    // Only the db store seals under the KEK; env and memory hold values as
    // they are, so a missing or weak KEK is not their problem to report.
    if (store.provider === 'db') {
      const key = secretKeyStatus();
      if (!key.usable) {
        return {
          provider: store.provider, writable: false,
          reason: `${key.reason}; new credentials fall back to the legacy column until it is.`,
        };
      }
    }
    if (store.provider === 'env') {
      return {
        provider: store.provider, writable: false,
        reason: 'The env store is read-only; new credentials fall back to the legacy column.',
      };
    }
    return { provider: store.provider, writable: true, reason: null };
  } catch (err) {
    return { provider: store.provider, writable: false, reason: (err as Error).message };
  }
}

export { secretsEqual };
