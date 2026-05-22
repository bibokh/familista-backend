// Familista — NATS JetStream adapter (Phase J)
// ─────────────────────────────────────────────────────────────────────────
// Lazy-loaded like Phase F Kafka/Redis adapters. NO-OP unless
// BIG_DATA_NATS_URL is set AND `nats` is installed.
//
// Subject convention: `familista.events.<kind>.<clubId>` — clubId in the
// subject keeps per-tenant fan-out cheap, kind keeps consumer routing
// simple. Per-match ordering is preserved by the producer including
// matchId as the message header.

import { logger } from '../utils/logger';

const NAME = 'NATS';

interface NatsConn {
  publish:    (subject: string, data: Uint8Array, opts?: { headers?: { append: (k: string, v: string) => void } }) => Promise<unknown>;
  drain:      () => Promise<void>;
  isClosed:   () => boolean;
}

let _nc: NatsConn | null = null;
let _enabled = false;
let _tried = false;

export function isEnabled(): boolean {
  return !!process.env.BIG_DATA_NATS_URL && _enabled;
}

export function adapterName(): string { return NAME; }

async function ensureConn(): Promise<void> {
  if (_tried) return;
  _tried = true;
  const url = process.env.BIG_DATA_NATS_URL;
  if (!url) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('nats') as {
      connect: (opts: { servers: string }) => Promise<NatsConn & { headers?: () => { append: (k: string, v: string) => void } }>;
    };
    _nc = await mod.connect({ servers: url });
    _enabled = true;
    logger.info('[big-data:nats] connected', { url });
  } catch (err) {
    logger.info('[big-data:nats] disabled (' + ((err as Error).message || 'no driver') + ')');
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
  await ensureConn();
  if (!_enabled || !_nc) return false;
  try {
    const subject = `familista.events.${envelope.kind.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}.${envelope.clubId}`;
    const data = new TextEncoder().encode(JSON.stringify(envelope));
    await _nc.publish(subject, data);
    return true;
  } catch (err) {
    logger.warn('[big-data:nats] publish failed', { err: (err as Error).message });
    return false;
  }
}

export async function disconnect(): Promise<void> {
  if (_nc && !_nc.isClosed()) {
    try { await _nc.drain(); } catch (_) { /* ignore */ }
  }
  _nc = null;
  _enabled = false;
}
