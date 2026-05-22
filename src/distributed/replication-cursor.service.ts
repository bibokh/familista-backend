// Familista — Distributed event replication cursor (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Each region runs a consumer that drains the EventOutbox (Phase F) and
// fan-outs into in-region adapters. The cursor records the last seq we
// successfully applied so a restart resumes exactly where we left off.
//
// One row per (regionId, adapter, topic). The adapter is the LOCAL fan-out
// target, NOT the source: a region might pull from a Kafka topic and
// re-publish into its local Redis stream.

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';

export interface CursorKey {
  regionId: string;
  adapter:  string;          // "IN_PROC" | "REDIS" | "KAFKA" | "NATS"
  topic?:   string | null;
}

// Normalise `topic` so null and "" collapse to "" — Postgres treats NULLs as
// distinct in UNIQUE constraints, which would let duplicate cursor rows slip in.
function topicKey(t: string | null | undefined): string { return t ?? ''; }

/** Read the current cursor. Returns 0/null if no row yet. */
export async function readCursor(key: CursorKey): Promise<{ lastSeq: number; lastTs: Date | null }> {
  const row = await prisma.distributedEventCursor.findUnique({
    where: { regionId_adapter_topic: { regionId: key.regionId, adapter: key.adapter, topic: topicKey(key.topic) } },
  }).catch(() => null);
  return { lastSeq: row ? Number(row.lastSeq) : 0, lastTs: row?.lastTs ?? null };
}

/** Advance the cursor. Idempotent (refuses to move backwards). */
export async function advanceCursor(key: CursorKey, toSeq: number, ts: Date = new Date()): Promise<void> {
  const topic = topicKey(key.topic);
  await prisma.distributedEventCursor.upsert({
    where: { regionId_adapter_topic: { regionId: key.regionId, adapter: key.adapter, topic } },
    create: { regionId: key.regionId, adapter: key.adapter, topic, lastSeq: BigInt(toSeq), lastTs: ts },
    update: { lastSeq: { set: BigInt(Math.max(toSeq, 0)) }, lastTs: ts },
  }).catch(() => undefined);
}

/** Pull the next batch of outbox rows for a region (matchId-ordered). */
export async function nextBatch(matchId: string | null, fromSeq: number, limit = 500) {
  const where: Prisma.EventOutboxWhereInput = {
    ...(matchId ? { matchId } : {}),
    seq: { gt: BigInt(fromSeq) },
  };
  return prisma.eventOutbox.findMany({
    where,
    orderBy: { seq: 'asc' },
    take:    Math.min(limit, 5000),
  });
}
