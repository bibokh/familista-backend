// The database-backed secret store — ciphertext only, ever
// ─────────────────────────────────────────────────────────────────────────────
// One implementation of `SecretStore`, over `PlatformSecret`. It is the only
// file in the secrets module that knows Postgres exists.
//
// The property that matters: this table holds ciphertext sealed under a KEK
// that lives in the environment and is never written to the database. A logical
// dump therefore contains no credential, which is precisely what the plaintext
// `Device.hmacSecret` column fails at today.
//
// REVOCATION IS NOT DELETION
//
// `deleteSecret` marks a version revoked and leaves the row. Two reasons, and
// the second is the one that gets forgotten: a revoked version must stop
// authenticating immediately, and the record that a credential existed and was
// revoked — when, and by whom — is exactly what an incident review needs.
// Destroying the row destroys the evidence along with the key.
//
// Hard removal exists as `purge`, is not part of the port, and is deliberately
// harder to reach.

import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { formatSecretRef, nextVersion, type SecretRef } from './secret-ref';
import { LEGACY_KID } from './keyring';
import {
  envelopeKid, generateSecret, openSecret, sealSecret,
  type PutSecretOptions, type RotateResult, type SecretStore, type SecretValue,
} from './secret-store';

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2002';
  const code = (err as { code?: unknown })?.code;
  if (code === 'P2002') return true;
  return /Unique constraint/i.test((err as Error)?.message ?? '');
}

export class DbSecretStore implements SecretStore {
  readonly provider = 'db';

  async getSecret(ref: SecretRef): Promise<SecretValue | null> {
    const row = await prisma.platformSecret.findUnique({
      where: { scope_name_version: { scope: ref.scope, name: ref.name, version: ref.version } },
      select: { sealed: true, revokedAt: true },
    });
    // A revoked version resolves to nothing. Deliberately indistinguishable
    // from a version that never existed: the difference between "revoked" and
    // "absent" is information an attacker probing references would use, and it
    // is information no legitimate caller needs.
    if (!row || row.revokedAt) return null;
    return openSecret(row.sealed);
  }

  async putSecret(ref: SecretRef, value: SecretValue, opts: PutSecretOptions = {}): Promise<void> {
    const sealed = sealSecret(value);
    const where = { scope_name_version: { scope: ref.scope, name: ref.name, version: ref.version } };

    if (opts.overwrite) {
      await prisma.platformSecret.upsert({
        where,
        create: {
          scope: ref.scope, name: ref.name, version: ref.version, sealed,
          kid: envelopeKid(sealed),
          metadata: (opts.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        update: { sealed, kid: envelopeKid(sealed), revokedAt: null },
      });
      return;
    }

    try {
      await prisma.platformSecret.create({
        data: {
          scope: ref.scope, name: ref.name, version: ref.version, sealed,
          kid: envelopeKid(sealed),
          metadata: (opts.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });
    } catch (err) {
      // Matched on the code rather than the class. Prisma's error classes are
      // not stable across versions and a duplicate that arrived as a plain
      // Error would otherwise escape as a raw driver message — which is how a
      // reference-only error becomes a leaky one.
      if (isUniqueViolation(err)) {
        // The message names the REFERENCE, never the value.
        throw new Error(`A secret already exists at ${formatSecretRef(ref)}`);
      }
      throw err;
    }
  }

  /**
   * Mint the next version, and leave the previous one working.
   *
   * The grace window is the whole design. A hundred wearables cannot re-key in
   * the same instant, so a rotation that invalidated the old version on the
   * spot would take the fleet offline. The previous version is marked
   * `rotatedAt` — still resolvable, now known to be superseded — and a separate,
   * deliberate `deleteSecret` closes the window when the fleet has moved.
   */
  async rotateSecret(ref: SecretRef, opts: { bytes?: number } = {}): Promise<RotateResult> {
    const next = nextVersion(ref);
    const value = generateSecret(opts.bytes);
    const sealed = sealSecret(value);

    await prisma.$transaction(async (tx) => {
      await tx.platformSecret.create({
        data: {
          scope: next.scope, name: next.name, version: next.version, sealed,
          kid: envelopeKid(sealed),
        },
      });
      await tx.platformSecret.updateMany({
        where: { scope: ref.scope, name: ref.name, version: ref.version, rotatedAt: null },
        data: { rotatedAt: new Date() },
      });
    });

    return { ref: next, value, previous: ref };
  }

  /** Revoke. The ciphertext stays; the credential stops working. */
  async deleteSecret(ref: SecretRef): Promise<void> {
    await prisma.platformSecret.updateMany({
      where: { scope: ref.scope, name: ref.name, version: ref.version, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async exists(ref: SecretRef): Promise<boolean> {
    const row = await prisma.platformSecret.findUnique({
      where: { scope_name_version: { scope: ref.scope, name: ref.name, version: ref.version } },
      select: { revokedAt: true },
    });
    return !!row && !row.revokedAt;
  }

  /**
   * Every version of one name, newest first — WITHOUT the ciphertext.
   *
   * What a credential-history view reads. The `sealed` column is not selected,
   * so this cannot become the read that leaks the thing the table exists to
   * protect.
   */
  async history(scope: string, name: string) {
    return prisma.platformSecret.findMany({
      where: { scope, name },
      orderBy: { version: 'desc' },
      select: {
        id: true, scope: true, name: true, version: true, kid: true,
        createdAt: true, createdBy: true, rotatedAt: true, revokedAt: true, metadata: true,
      },
    });
  }

  // ── re-key support ─────────────────────────────────────────────────────────
  //
  // Two queries and one guarded write. Everything the rotation runbook needs
  // and nothing more: no bulk read of `sealed` into a list, no method that
  // returns plaintext, and no way to ask for "all the secrets".

  /**
   * How many rows sit under each key, by the recorded kid.
   *
   * The answer to "is the re-key finished" and to "may this key be retired",
   * computed without opening a single envelope. NULL is reported as the legacy
   * kid because that is what a NULL row's envelope resolves to.
   */
  async countByKid(): Promise<Record<string, number>> {
    const rows = await prisma.platformSecret.groupBy({
      by: ['kid'],
      where: { revokedAt: null },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows as Array<{ kid: string | null; _count: { _all: number } }>) {
      const kid = r.kid ?? LEGACY_KID;
      out[kid] = (out[kid] ?? 0) + r._count._all;
    }
    return out;
  }

  /**
   * One page of rows not yet sealed under `toKid`, oldest id first.
   *
   * Paged by id rather than by offset so the scan is resumable and stable while
   * rows are being rewritten underneath it — an offset-paged scan re-numbers
   * itself as it works and skips rows.
   *
   * Revoked rows are skipped. Re-keying a credential that has been withdrawn
   * would decrypt something nothing is allowed to use, to protect it better.
   */
  async pageForRewrap(toKid: string, opts: { after?: string | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    return prisma.platformSecret.findMany({
      where: {
        revokedAt: null,
        NOT: { kid: toKid },
        ...(opts.after ? { id: { gt: opts.after } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true, scope: true, name: true, version: true, sealed: true, kid: true },
    });
  }

  /**
   * Replace one row's envelope, but only if it still holds the one we opened.
   *
   * The `sealed: expect` guard is the whole safety of an unattended re-key. A
   * rotation running concurrently with this scan may have already replaced the
   * row; without the guard this would overwrite that newer envelope with one
   * derived from the value it superseded, quietly resurrecting a rotated-out
   * credential. With it, the write simply does not apply and the scan moves on.
   *
   * Returns whether it applied.
   */
  async applyRewrap(id: string, expect: string, sealed: string): Promise<boolean> {
    const { count } = await prisma.platformSecret.updateMany({
      where: { id, sealed: expect, revokedAt: null },
      data: { sealed, kid: envelopeKid(sealed) },
    });
    return count === 1;
  }
}
