// Familista — Kafka adapter (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// Optional Kafka adapter. Behind the BIG_DATA_KAFKA_BROKERS env flag.
// When unset, no-op. Lazy `kafkajs` require keeps installs lean.
//
// Topic strategy:
//   - One topic per kind: `familista.events.<kind>` (lowercase)
//   - Partition key: matchId (or clubId if matchId is null) — preserves
//     per-match ordering downstream.

import { logger } from '../utils/logger';

const NAME = 'KAFKA';

interface KafkaProducerLike {
  connect:    () => Promise<void>;
  send:       (args: { topic: string; messages: Array<{ key: string; value: string }> }) => Promise<unknown>;
  disconnect: () => Promise<void>;
}

let _producer: KafkaProducerLike | null = null;
let _enabled = false;
let _tried = false;

export function isEnabled(): boolean {
  return !!process.env.BIG_DATA_KAFKA_BROKERS && _enabled;
}

export function adapterName(): string { return NAME; }

async function ensureProducer(): Promise<void> {
  if (_tried) return;
  _tried = true;
  const brokersRaw = process.env.BIG_DATA_KAFKA_BROKERS;
  if (!brokersRaw) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { Kafka } = require('kafkajs') as { Kafka: new (opts: { clientId: string; brokers: string[] }) => { producer: () => KafkaProducerLike } };
    const kafka = new Kafka({ clientId: 'familista-backend', brokers: brokersRaw.split(',').map((s) => s.trim()).filter(Boolean) });
    const producer = kafka.producer();
    await producer.connect();
    _producer = producer;
    _enabled = true;
    logger.info('[big-data:kafka] connected', { brokers: brokersRaw });
  } catch (err) {
    logger.info('[big-data:kafka] disabled (' + ((err as Error).message || 'no driver') + ')');
    _enabled = false;
  }
}

export async function publish(envelope: {
  id:       string;
  seq:      string;
  clubId:   string;
  matchId?: string | null;
  kind:     string;
  payload:  unknown;
}): Promise<boolean> {
  await ensureProducer();
  if (!_enabled || !_producer) return false;
  try {
    const topic = `familista.events.${envelope.kind.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`;
    const key   = envelope.matchId ?? envelope.clubId;
    const value = JSON.stringify({ id: envelope.id, seq: envelope.seq, clubId: envelope.clubId, matchId: envelope.matchId, kind: envelope.kind, payload: envelope.payload });
    await _producer.send({ topic, messages: [{ key, value }] });
    return true;
  } catch (err) {
    logger.warn('[big-data:kafka] publish failed', { err: (err as Error).message });
    return false;
  }
}

export async function disconnect(): Promise<void> {
  if (_producer) {
    try { await _producer.disconnect(); } catch (_) { /* ignore */ }
    _producer = null;
    _enabled = false;
  }
}
