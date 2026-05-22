// Familista — Realtime envelope HMAC sign/verify (Phase I)
// ─────────────────────────────────────────────────────────────────────────
// Per-club HMAC signing for outbound realtime events (SSE/WS payloads),
// so a tampered relay can be detected end-to-end. The signing secret is
// derived once at boot from JWT_ACCESS_SECRET + clubId, never persisted.
//
// Opt-in: callers wrap their event payloads with `signEnvelope(...)` and
// downstream consumers can call `verifyEnvelope(...)`. Existing SSE
// continues to ship unsigned envelopes for backwards compatibility; new
// channels can adopt this signature.

import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';

const SCHEMA_VERSION = 'v1';

function deriveKey(clubId: string): Buffer {
  // HKDF-style derivation: HMAC( server_secret, "envelope|" + clubId ).
  // No clubId-specific persisted key — server_secret rotation re-keys all.
  return createHmac('sha256', config.jwt.secret).update('envelope|' + clubId).digest();
}

export interface SignedEnvelope<P> {
  v:       string;        // schema version
  clubId:  string;
  ts:      number;        // server epoch ms (replay window)
  kind:    string;
  payload: P;
  sig:     string;        // base64 HMAC-SHA256 over canonical content
}

function canonical<P>(envelope: Omit<SignedEnvelope<P>, 'sig'>): string {
  // Canonical: stable key order so a relay that re-keys JSON can't break
  // verification — sign exactly what we'd verify.
  return [envelope.v, envelope.clubId, envelope.ts, envelope.kind, JSON.stringify(envelope.payload ?? null)].join('|');
}

export function signEnvelope<P>(clubId: string, kind: string, payload: P): SignedEnvelope<P> {
  const env = { v: SCHEMA_VERSION, clubId, ts: Date.now(), kind, payload };
  const key = deriveKey(clubId);
  const sig = createHmac('sha256', key).update(canonical(env)).digest('base64');
  return { ...env, sig };
}

export interface VerifyOpts {
  /** Max acceptable clock skew window in ms (default 5 min). */
  maxSkewMs?: number;
}

export function verifyEnvelope<P>(env: SignedEnvelope<P>, opts: VerifyOpts = {}): { ok: true } | { ok: false; reason: string } {
  if (!env || env.v !== SCHEMA_VERSION) return { ok: false, reason: 'schema_mismatch' };
  if (!env.sig)                          return { ok: false, reason: 'missing_sig' };
  if (typeof env.ts !== 'number')        return { ok: false, reason: 'missing_ts' };

  const maxSkewMs = opts.maxSkewMs ?? 5 * 60_000;
  if (Math.abs(Date.now() - env.ts) > maxSkewMs) return { ok: false, reason: 'ts_skew' };

  let supplied: Buffer;
  try { supplied = Buffer.from(env.sig, 'base64'); }
  catch { return { ok: false, reason: 'bad_sig_b64' }; }

  const key = deriveKey(env.clubId);
  const expected = createHmac('sha256', key).update(canonical({ v: env.v, clubId: env.clubId, ts: env.ts, kind: env.kind, payload: env.payload })).digest();
  if (supplied.length !== expected.length) return { ok: false, reason: 'sig_length' };
  if (!timingSafeEqual(supplied, expected)) return { ok: false, reason: 'sig_mismatch' };
  return { ok: true };
}
