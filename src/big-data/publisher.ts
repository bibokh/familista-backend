// Familista — Big Data Publisher (Phase E base + Phase F durability)
// ─────────────────────────────────────────────────────────────────────────
// Stable contract for shipping events to:
//   1. EventOutbox  (durable persistence — replay-safe)
//   2. MatchChannel (in-proc fan-out — drives SSE)
//   3. Redis adapter (if BIG_DATA_REDIS_URL set)
//   4. Kafka adapter (if BIG_DATA_KAFKA_BROKERS set)
//
// Order: outbox → channel → external adapters. The outbox INSERT happens
// inline so we have durability before the in-proc fan-out is observed.
// External adapter sends are non-blocking (process.nextTick).
//
// All publish* functions are FIRE-AND-FORGET. Never throws back into the
// caller; never blocks the request path.

import { publish as channelPublish } from '../realtime/match-channel';
import { appendEvent, markPublished, OutboxKind } from './event-source';
import * as redis from './redis.adapter';
import * as kafka from './kafka.adapter';
import * as nats  from '../distributed/nats.adapter';
import { logger } from '../utils/logger';

interface BigDataEnvelope {
  type:     OutboxKind;
  clubId:   string;
  matchId?: string | null;
  payload:  unknown;
  ts:       string;
  source?:  string;
}

function activeAdapters(): string[] {
  const list = ['IN_PROC'];
  if (redis.isEnabled()) list.push(redis.adapterName());
  if (kafka.isEnabled()) list.push(kafka.adapterName());
  if (nats.isEnabled())  list.push(nats.adapterName());
  return list;
}

async function dispatch(env: BigDataEnvelope): Promise<void> {
  // 1. Outbox first — durable.
  const row = await appendEvent({
    clubId:  env.clubId,
    matchId: env.matchId ?? null,
    kind:    env.type,
    payload: env,
    source:  env.source ?? undefined,
  });

  // 2. In-proc fan-out (drives SSE).
  try {
    if (env.matchId) {
      channelPublish({
        kind:    'BIG_DATA_PUBLISH',
        matchId: env.matchId,
        clubId:  env.clubId,
        payload: env,
      });
    }
  } catch (err) {
    logger.warn('[big-data] in-proc publish failed', { type: env.type, err: (err as Error)?.message });
  }
  if (row) {
    // Mark IN_PROC ack immediately so the outbox row's adapter list reflects
    // reality. Any failure here just leaves the row pending.
    markPublished(row.id, 'IN_PROC', activeAdapters()).catch(() => undefined);
  }

  // 3. External adapters — best-effort, non-blocking.
  if (row) {
    const envelopeForAdapter = {
      id:      row.id,
      seq:     row.seq.toString(),
      clubId:  env.clubId,
      matchId: env.matchId ?? null,
      kind:    env.type,
      payload: env.payload,
    };
    const adapters = activeAdapters();

    if (redis.isEnabled()) {
      process.nextTick(async () => {
        const ok = await redis.publish(envelopeForAdapter);
        if (ok) markPublished(row.id, redis.adapterName(), adapters).catch(() => undefined);
      });
    }
    if (kafka.isEnabled()) {
      process.nextTick(async () => {
        const ok = await kafka.publish(envelopeForAdapter);
        if (ok) markPublished(row.id, kafka.adapterName(), adapters).catch(() => undefined);
      });
    }
    if (nats.isEnabled()) {
      process.nextTick(async () => {
        const ok = await nats.publish(envelopeForAdapter);
        if (ok) markPublished(row.id, nats.adapterName(), adapters).catch(() => undefined);
      });
    }
  }
}

export function publishMatchEvent(clubId: string, matchId: string, payload: unknown, source?: string): void {
  dispatch({ type: 'MATCH_EVENT', clubId, matchId, payload, ts: new Date().toISOString(), source }).catch(() => undefined);
}
export function publishFusionPacket(clubId: string, matchId: string | null, payload: unknown, source?: string): void {
  dispatch({ type: 'FUSION_PACKET', clubId, matchId, payload, ts: new Date().toISOString(), source }).catch(() => undefined);
}
export function publishAIAlert(clubId: string, matchId: string | null, payload: unknown, source?: string): void {
  dispatch({ type: 'AI_ALERT', clubId, matchId, payload, ts: new Date().toISOString(), source }).catch(() => undefined);
}
export function publishAIRecommendation(clubId: string, matchId: string | null, payload: unknown, source?: string): void {
  dispatch({ type: 'AI_RECOMMENDATION', clubId, matchId, payload, ts: new Date().toISOString(), source }).catch(() => undefined);
}
export function publishSensorPacket(clubId: string, matchId: string | null, payload: unknown, source?: string): void {
  dispatch({ type: 'SENSOR_PACKET', clubId, matchId, payload, ts: new Date().toISOString(), source }).catch(() => undefined);
}
export function publishCustom(clubId: string, matchId: string | null, kind: OutboxKind | string, payload: unknown, source?: string): void {
  dispatch({ type: kind as OutboxKind, clubId, matchId, payload, ts: new Date().toISOString(), source }).catch(() => undefined);
}
