// Familista — Event Source (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// Durable event log backing every publish().
//
// Properties:
//   - `seq` is strictly monotonic per matchId (gap-free; bumped via a
//     dedicated MatchEventSequence row inside the same transaction).
//   - `idempotencyKey` is unique → at-least-once producers dedupe.
//   - Once big-data adapters acknowledge a row, it gets `publishedAt = now()`
//     and `adapters = "REDIS,KAFKA,IN_PROC"` (csv of names that ack'd).
//
// This is the durability anchor for "deterministic replay".

import { createHash } from 'crypto';
import { prisma } from '../config/database';
import { Prisma } from '@prisma/client';
import { logger } from '../utils/logger';

export type OutboxKind =
  | 'MATCH_EVENT'
  | 'FUSION_PACKET'
  | 'AI_ALERT'
  | 'AI_RECOMMENDATION'
  | 'SENSOR_PACKET'
  | 'TIMELINE_ADDED'
  | 'SNAPSHOT_TAKEN'
  | 'TACTICAL_STATE'
  | 'DEVICE_STATUS'
  | 'CUSTOM';

export interface OutboxWriteArgs {
  clubId:          string;
  matchId?:        string | null;
  kind:            OutboxKind | string;
  payload:         unknown;
  idempotencyKey?: string;
  source?:         string;
}

/**
 * Append one row to the EventOutbox + bump the per-match sequence in a
 * single transaction. Returns the saved row. NEVER throws — failures are
 * logged so producers (e.g. timeline service) stay decoupled.
 */
export async function appendEvent(args: OutboxWriteArgs): Promise<{ id: string; seq: bigint } | null> {
  const idempotencyKey = args.idempotencyKey ?? deriveIdempotencyKey(args);

  try {
    return await prisma.$transaction(async (tx) => {
      let nextSeq: bigint = BigInt(0);
      if (args.matchId) {
        // Upsert + read the new seq value in one round-trip.
        const seqRow = await tx.matchEventSequence.upsert({
          where:  { matchId: args.matchId },
          create: { matchId: args.matchId, next: BigInt(1) },
          update: { next:    { increment: BigInt(1) } },
        });
        nextSeq = seqRow.next;
      }

      const row = await tx.eventOutbox.create({
        data: {
          clubId:         args.clubId,
          matchId:        args.matchId ?? null,
          seq:            nextSeq,
          kind:           String(args.kind),
          idempotencyKey,
          payload:        (args.payload ?? null) as Prisma.InputJsonValue,
          source:         args.source ?? null,
        },
        select: { id: true, seq: true },
      });
      return row;
    });
  } catch (err) {
    // Most common path here is a duplicate idempotencyKey — that's success
    // from the caller's POV (the row already exists). Other errors are
    // logged but swallowed; the in-proc bus continues to fan out anyway.
    const msg = (err as Error).message || '';
    if (msg.includes('Unique constraint') || msg.includes('idempotencyKey')) {
      return null;
    }
    logger.warn('[event-outbox] append failed', { kind: args.kind, err: msg });
    return null;
  }
}

/**
 * Mark a row as published by a given adapter. Adapters call this AFTER
 * successful network ack. When all configured adapters have acked, the
 * row's `publishedAt` is set.
 */
export async function markPublished(id: string, adapter: string, allAdapters: string[]): Promise<void> {
  try {
    const row = await prisma.eventOutbox.findUnique({ where: { id }, select: { adapters: true } });
    if (!row) return;
    const acked = new Set((row.adapters ?? '').split(',').filter(Boolean));
    acked.add(adapter);
    const fullySent = allAdapters.every((a) => acked.has(a));
    await prisma.eventOutbox.update({
      where: { id },
      data:  {
        adapters:    Array.from(acked).join(','),
        publishedAt: fullySent ? new Date() : null,
      },
    });
  } catch (err) {
    logger.warn('[event-outbox] markPublished failed', { id, adapter, err: (err as Error).message });
  }
}

/** Pending rows that no adapter has acked yet — for retry workers. */
export async function listPendingForRetry(adapter: string, limit = 200) {
  return prisma.eventOutbox.findMany({
    where: {
      publishedAt: null,
      OR: [
        { adapters: null },
        { NOT: { adapters: { contains: adapter } } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take:    Math.min(limit, 1000),
  });
}

function deriveIdempotencyKey(args: OutboxWriteArgs): string {
  const seed = JSON.stringify({
    clubId: args.clubId, matchId: args.matchId, kind: args.kind,
    payload: args.payload, source: args.source,
    // Include a coarse timestamp so identical-payload events still get distinct keys.
    bucket: Math.floor(Date.now() / 1000),
  });
  return createHash('sha256').update(seed).digest('hex');
}
