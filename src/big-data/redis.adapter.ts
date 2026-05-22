// Familista — Redis adapter (Phase F)
// ─────────────────────────────────────────────────────────────────────────
// Optional Redis Streams adapter. Behind the BIG_DATA_REDIS_URL env flag.
// When unset, the module is a no-op — calls silently succeed so the
// publisher path doesn't need to branch.
//
// Partition strategy:
//   - Key = `familista:events:{clubId}` (tenant-prefixed for hot-key locality)
//   - Field set = { id, seq, matchId, kind, payload (json), createdAt }
//
// We intentionally avoid pulling in `redis` as a dependency: this file
// uses a lazy require so installs without redis don't break the build.

import { logger } from '../utils/logger';

const NAME = 'REDIS';

let _client: { xAdd?: (key: string, id: string, fields: Record<string, string>) => Promise<string> } | null = null;
let _enabled = false;
let _tried = false;

export function isEnabled(): boolean {
  return !!process.env.BIG_DATA_REDIS_URL && _enabled;
}

export function adapterName(): string { return NAME; }

async function ensureClient(): Promise<void> {
  if (_tried) return;
  _tried = true;
  const url = process.env.BIG_DATA_REDIS_URL;
  if (!url) return;
  try {
    // Lazy require: keeps Render builds green when `redis` isn't installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const mod = require('redis') as { createClient: (opts: { url: string }) => { connect: () => Promise<void>; xAdd: (k: string, id: string, fields: Record<string,string>) => Promise<string>; on: (e: string, h: (err: Error) => void) => void } };
    const client = mod.createClient({ url });
    client.on('error', (err) => logger.warn('[big-data:redis] error', { err: err.message }));
    await client.connect();
    _client = client;
    _enabled = true;
    logger.info('[big-data:redis] connected');
  } catch (err) {
    logger.info('[big-data:redis] disabled (' + ((err as Error).message || 'no driver') + ')');
    _enabled = false;
  }
}

export async function publish(envelope: {
  id:       string;
  seq:      string;          // BigInt serialized to string
  clubId:   string;
  matchId?: string | null;
  kind:     string;
  payload:  unknown;
}): Promise<boolean> {
  await ensureClient();
  if (!_enabled || !_client?.xAdd) return false;
  try {
    const key = `familista:events:${envelope.clubId}`;
    await _client.xAdd(key, '*', {
      id:        envelope.id,
      seq:       envelope.seq,
      matchId:   envelope.matchId ?? '',
      kind:      envelope.kind,
      payload:   safeJson(envelope.payload),
      createdAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    logger.warn('[big-data:redis] publish failed', { err: (err as Error).message });
    return false;
  }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v ?? null); } catch { return 'null'; }
}
