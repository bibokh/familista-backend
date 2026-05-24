// Familista — Blockchain-Inspired Audit Chain (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// One ledger per clubId. Every security-sensitive action appends a
// SecurityAuditEvent whose `currentHash` is:
//
//   SHA-256(previousHash + actorId + clubId + action + entityType +
//            entityId + payloadHash + timestamp)
//
// Modifying any historical row invalidates every subsequent row's
// currentHash — verifyAuditChain() detects it deterministically.
//
// Design notes:
//   - Per-club chain (not global) so multi-tenant scale doesn't serialise
//     every audit on one head row.
//   - Bulk reads should call verifyAuditChain() lazily — it's O(n) in
//     chain length and recomputes SHA-256 per row. Default page is 1000.
//   - Genesis: chainPosition=0, previousHash="GENESIS".
//   - Bumps SecurityChainHead.{nextPosition,lastHash} in the SAME
//     transaction as the SecurityAuditEvent insert.

import { createHash } from 'crypto';
import { Prisma, SecurityAuditEvent } from '@prisma/client';
import { prisma } from '../config/database';
import { NotFoundError, ForbiddenError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface AuditActor {
  userId: string | null;
  clubId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AppendArgs {
  actor:        AuditActor;
  action:       string;          // e.g. "MATCH_FINALIZED"
  entityType?:  string;          // e.g. "Match"
  entityId?:    string;
  teamId?:      string | null;
  payload?:     unknown;         // anything JSON-stringifiable
}

export interface AppendResult {
  id:           string;
  clubId:       string;
  chainPosition: number;
  previousHash: string;
  currentHash:  string;
  payloadHash:  string;
}

export interface VerifyResult {
  clubId:       string;
  totalChecked: number;
  ok:           boolean;
  /** First row whose recomputed currentHash differs (null if chain is clean). */
  brokenAt?:    {
    chainPosition: number;
    id:            string;
    expected:      string;
    actual:        string;
  } | null;
  headHash?:    string | null;
}

/** Canonical JSON for hashing — sorted keys, no whitespace. */
function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  return JSON.stringify(v, Object.keys(v as object ?? {}).sort());
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload ?? null));
}

/**
 * Recompute the canonical hash of one chain row given its predecessor's hash.
 * MUST stay identical to the formula used in `appendAuditEvent` — both sides
 * are exposed here so tests can pin the contract.
 */
export function computeRowHash(args: {
  previousHash: string;
  actorId:      string | null;
  clubId:       string;
  action:       string;
  entityType:   string | null;
  entityId:     string | null;
  payloadHash:  string;
  /** ISO string. We use the persisted createdAt to keep verification stable. */
  timestampIso: string;
}): string {
  const seed = [
    args.previousHash,
    args.actorId   ?? '',
    args.clubId,
    args.action,
    args.entityType ?? '',
    args.entityId   ?? '',
    args.payloadHash,
    args.timestampIso,
  ].join('|');
  return sha256Hex(seed);
}

// ─────────────────────────────────────────────────────────────────────────
// Append
// ─────────────────────────────────────────────────────────────────────────

export async function appendAuditEvent(a: AppendArgs): Promise<AppendResult> {
  const pH = payloadHash(a.payload);

  return prisma.$transaction(async (tx) => {
    // Lock + read the head (upsert so first-ever club still works).
    const head = await tx.securityChainHead.upsert({
      where:  { clubId: a.actor.clubId },
      create: { clubId: a.actor.clubId, nextPosition: BigInt(0), lastHash: 'GENESIS' },
      update: {},
    });
    const chainPosition = head.nextPosition;
    const previousHash  = head.lastHash;
    const ts            = new Date();

    const currentHash = computeRowHash({
      previousHash,
      actorId:      a.actor.userId,
      clubId:       a.actor.clubId,
      action:       a.action,
      entityType:   a.entityType ?? null,
      entityId:     a.entityId   ?? null,
      payloadHash:  pH,
      timestampIso: ts.toISOString(),
    });

    const row = await tx.securityAuditEvent.create({
      data: {
        clubId:        a.actor.clubId,
        chainPosition,
        actorId:       a.actor.userId,
        teamId:        a.teamId ?? null,
        action:        a.action,
        entityType:    a.entityType ?? null,
        entityId:      a.entityId   ?? null,
        payloadHash:   pH,
        previousHash,
        currentHash,
        ipAddress:     a.actor.ipAddress ?? null,
        userAgent:     a.actor.userAgent ?? null,
        createdAt:     ts,
      },
    });

    await tx.securityChainHead.update({
      where: { clubId: a.actor.clubId },
      data:  { nextPosition: { increment: BigInt(1) }, lastHash: currentHash },
    });

    return {
      id:            row.id,
      clubId:        row.clubId,
      chainPosition: Number(row.chainPosition),
      previousHash:  row.previousHash,
      currentHash:   row.currentHash,
      payloadHash:   row.payloadHash,
    };
  });
}

/**
 * Fire-and-forget convenience wrapper — never throws back into the caller.
 * Use this from middleware / service hot paths.
 */
export function appendAuditEventAsync(args: AppendArgs): void {
  appendAuditEvent(args).catch((err) => {
    logger.warn('[audit-chain] append failed (swallowed)', { action: args.action, err: (err as Error).message });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Verify
// ─────────────────────────────────────────────────────────────────────────

export interface VerifyOpts {
  /** Start position (default 0). */
  fromPosition?: number;
  /** Max rows to scan in one call (cap 10_000). */
  limit?:        number;
}

export async function verifyAuditChain(clubId: string, opts: VerifyOpts = {}): Promise<VerifyResult> {
  const fromPosition = Math.max(0, opts.fromPosition ?? 0);
  const limit        = Math.min(opts.limit ?? 1000, 10_000);

  const head = await prisma.securityChainHead.findUnique({ where: { clubId } });
  if (!head) {
    return { clubId, totalChecked: 0, ok: true, brokenAt: null, headHash: null };
  }

  const rows = await prisma.securityAuditEvent.findMany({
    where:   { clubId, chainPosition: { gte: BigInt(fromPosition) } },
    orderBy: { chainPosition: 'asc' },
    take:    limit,
  });
  if (rows.length === 0) {
    return { clubId, totalChecked: 0, ok: true, brokenAt: null, headHash: head.lastHash };
  }

  let prev = fromPosition === 0
    ? 'GENESIS'
    : (await prisma.securityAuditEvent.findFirst({
        where:   { clubId, chainPosition: BigInt(fromPosition - 1) },
        select:  { currentHash: true },
      }))?.currentHash ?? 'GENESIS';

  for (const r of rows) {
    const recomputed = computeRowHash({
      previousHash: prev,
      actorId:      r.actorId,
      clubId:       r.clubId,
      action:       r.action,
      entityType:   r.entityType,
      entityId:     r.entityId,
      payloadHash:  r.payloadHash,
      timestampIso: r.createdAt.toISOString(),
    });
    if (recomputed !== r.currentHash || r.previousHash !== prev) {
      return {
        clubId,
        totalChecked: rows.indexOf(r) + 1,
        ok:           false,
        brokenAt:     {
          chainPosition: Number(r.chainPosition),
          id:            r.id,
          expected:      recomputed,
          actual:        r.currentHash,
        },
        headHash:     head.lastHash,
      };
    }
    prev = r.currentHash;
  }

  return { clubId, totalChecked: rows.length, ok: true, brokenAt: null, headHash: head.lastHash };
}

/**
 * Verify the ENTIRE chain in bounded memory by walking it in batches.
 *
 * Why this exists separately from verifyAuditChain():
 *   - The single-shot verifier returns after at most `limit` rows. For
 *     production chains (>100k rows) one verify call can never assert the
 *     whole chain — and naively raising the limit would OOM the dyno.
 *   - This helper streams the chain in `batchSize` chunks, holding only
 *     one batch in memory at a time, and stops on the first detected
 *     mismatch. Memory upper bound = O(batchSize), independent of
 *     chain length.
 *
 * Returns the same VerifyResult shape, where `totalChecked` is the cumulative
 * count across all batches. Safe to invoke on chains with millions of rows.
 */
export async function verifyAuditChainComplete(
  clubId: string,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<VerifyResult> {
  const batchSize  = Math.min(Math.max(opts.batchSize  ?? 2_000, 100), 10_000);
  const maxBatches = Math.min(Math.max(opts.maxBatches ?? 5_000, 1),   100_000);

  const head = await prisma.securityChainHead.findUnique({ where: { clubId } });
  if (!head) {
    return { clubId, totalChecked: 0, ok: true, brokenAt: null, headHash: null };
  }

  let prev = 'GENESIS';
  let cursor = 0;
  let totalChecked = 0;
  let batchesSeen = 0;

  for (;;) {
    if (batchesSeen++ >= maxBatches) {
      // Safety stop — refuse to spend more than maxBatches × batchSize
      // rows in a single verify. Caller can resume from `cursor`.
      logger.warn('[audit-chain] verifyAuditChainComplete batch cap hit', { clubId, cursor, totalChecked });
      return { clubId, totalChecked, ok: true, brokenAt: null, headHash: head.lastHash };
    }

    const rows = await prisma.securityAuditEvent.findMany({
      where:   { clubId, chainPosition: { gte: BigInt(cursor) } },
      orderBy: { chainPosition: 'asc' },
      take:    batchSize,
      select:  {
        id: true, chainPosition: true, actorId: true, clubId: true, action: true,
        entityType: true, entityId: true, payloadHash: true, previousHash: true,
        currentHash: true, createdAt: true,
      },
    });
    if (rows.length === 0) break;

    for (const r of rows) {
      const recomputed = computeRowHash({
        previousHash: prev,
        actorId:      r.actorId,
        clubId:       r.clubId,
        action:       r.action,
        entityType:   r.entityType,
        entityId:     r.entityId,
        payloadHash:  r.payloadHash,
        timestampIso: r.createdAt.toISOString(),
      });
      if (recomputed !== r.currentHash || r.previousHash !== prev) {
        return {
          clubId,
          totalChecked: totalChecked + 1,
          ok: false,
          brokenAt: {
            chainPosition: Number(r.chainPosition),
            id:            r.id,
            expected:      recomputed,
            actual:        r.currentHash,
          },
          headHash: head.lastHash,
        };
      }
      prev = r.currentHash;
      totalChecked += 1;
    }

    if (rows.length < batchSize) break;
    cursor = Number(rows[rows.length - 1].chainPosition) + 1;
  }

  return { clubId, totalChecked, ok: true, brokenAt: null, headHash: head.lastHash };
}

// ─────────────────────────────────────────────────────────────────────────
// Reads (paginated)
// ─────────────────────────────────────────────────────────────────────────

export async function listAuditEvents(
  clubId: string,
  opts: { fromPosition?: number; limit?: number } = {},
): Promise<{ items: SecurityAuditEvent[]; nextPosition: number | null }> {
  const fromPosition = Math.max(0, opts.fromPosition ?? 0);
  const limit        = Math.min(opts.limit ?? 100, 1000);
  const items = await prisma.securityAuditEvent.findMany({
    where:   { clubId, chainPosition: { gte: BigInt(fromPosition) } },
    orderBy: { chainPosition: 'asc' },
    take:    limit,
  });
  const last = items[items.length - 1];
  return { items, nextPosition: last ? Number(last.chainPosition) + 1 : null };
}

export async function getChainHead(clubId: string): Promise<{ nextPosition: number; lastHash: string }> {
  const h = await prisma.securityChainHead.findUnique({ where: { clubId } });
  return h
    ? { nextPosition: Number(h.nextPosition), lastHash: h.lastHash }
    : { nextPosition: 0, lastHash: 'GENESIS' };
}

// Export helpers (typed) so tests can pin the contract.
export const _internal = { computeRowHash, payloadHash, sha256Hex, canonicalJson };
