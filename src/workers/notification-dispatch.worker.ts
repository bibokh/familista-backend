// Familista — Notification Dispatch Worker (Phase P+)
// ─────────────────────────────────────────────────────────────────────────
// Reads unread, unarchived UserNotification rows and pushes them through
// every ACTIVE UserNotificationChannel that the recipient has registered.
//
// Channels:
//   • IN_APP   — no-op (already in the inbox)
//   • EMAIL    — POST to NOTIFY_EMAIL_WEBHOOK (your transactional provider)
//   • SMS      — POST to NOTIFY_SMS_WEBHOOK
//   • PUSH     — POST to NOTIFY_PUSH_WEBHOOK
//   • WEBHOOK  — POST to the channel.target URL directly
//
// Each successful dispatch writes a `dispatched.<channel>=<ts>` flag into
// the notification's payload so the worker never re-fires a channel.
//
// If no webhook env is set for a channel, that channel is logged as
// "skipped (no transport configured)" — never errors.

import crypto from 'crypto';
import { Prisma, UserNotificationChannel } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const TICK_MS    = parseInt(process.env.NOTIFY_TICK_MS    ?? '15000', 10);
const BATCH_SIZE = parseInt(process.env.NOTIFY_BATCH_SIZE ?? '50',    10);
const MAX_RETRIES = parseInt(process.env.NOTIFY_MAX_RETRIES ?? '3', 10);

interface ChannelTransport {
  kind: 'EMAIL' | 'SMS' | 'PUSH' | 'WEBHOOK';
  url:  string | null;
  /** Optional shared secret for HMAC signing — never leaves env. */
  secret?: string | null;
}

function transportFor(kind: ChannelTransport['kind'], channelTarget: string): ChannelTransport {
  if (kind === 'WEBHOOK') {
    // The target IS the webhook URL the user/club registered.
    return { kind, url: channelTarget, secret: process.env.NOTIFY_WEBHOOK_SECRET ?? null };
  }
  if (kind === 'EMAIL') return { kind, url: process.env.NOTIFY_EMAIL_WEBHOOK ?? null, secret: process.env.NOTIFY_EMAIL_SECRET ?? null };
  if (kind === 'SMS')   return { kind, url: process.env.NOTIFY_SMS_WEBHOOK   ?? null, secret: process.env.NOTIFY_SMS_SECRET   ?? null };
  if (kind === 'PUSH')  return { kind, url: process.env.NOTIFY_PUSH_WEBHOOK  ?? null, secret: process.env.NOTIFY_PUSH_SECRET  ?? null };
  return { kind, url: null };
}

function sign(body: string, secret: string | null | undefined): Record<string, string> {
  if (!secret) return {};
  const mac = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return { 'x-familista-signature': `sha256=${mac}` };
}

async function postJson(url: string, body: unknown, headers: Record<string, string>): Promise<{ ok: boolean; status: number; bodyText?: string }> {
  // Node 20+ has global fetch. Cap at 10s.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const payload = JSON.stringify(body);
    const sigHeaders = sign(payload, headers['x-familista-secret'] ?? null);
    const cleaned = { ...headers }; delete cleaned['x-familista-secret'];
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sigHeaders, ...cleaned },
      body: payload,
      signal: ctrl.signal,
    });
    const bodyText = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, bodyText: bodyText.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, bodyText: (err as Error).message };
  } finally {
    clearTimeout(t);
  }
}

interface DispatchAttempt {
  channel:  string;
  target:   string;
  ok:       boolean;
  status:   number;
  message?: string;
  at:       string;
}

let _timer: ReturnType<typeof setTimeout> | null = null;
let _running = false;

/**
 * Dispatch ONE notification through all of the recipient's active channels.
 * Returns the channel attempts written into the row's payload.
 */
async function dispatchOne(
  notificationId: string,
  userId:         string,
  title:          string,
  body:           string | null,
  payload:        Prisma.JsonValue,
): Promise<DispatchAttempt[]> {
  const channels = await prisma.userNotificationChannel.findMany({
    where: { userId, isActive: true },
    take: 20,
  });
  if (channels.length === 0) return [];

  // Mark which channels were already delivered (idempotency).
  const alreadyDispatched = new Set<string>();
  if (payload && typeof payload === 'object' && payload && 'dispatched' in (payload as object)) {
    const d = (payload as { dispatched?: Record<string, string> }).dispatched ?? {};
    for (const k of Object.keys(d)) alreadyDispatched.add(k);
  }

  const attempts: DispatchAttempt[] = [];
  for (const ch of channels) {
    if (ch.channel === 'IN_APP') continue;
    const key = `${ch.channel}:${ch.target}`;
    if (alreadyDispatched.has(key)) continue;

    const t = transportFor(ch.channel as ChannelTransport['kind'], ch.target);
    if (!t.url) {
      attempts.push({ channel: ch.channel, target: ch.target, ok: false, status: 0, message: 'no transport configured', at: new Date().toISOString() });
      continue;
    }
    const headers: Record<string, string> = {};
    if (t.secret) headers['x-familista-secret'] = t.secret;
    const r = await postJson(t.url, {
      to:    ch.target,
      kind:  ch.channel,
      title, body, payload,
      notificationId, userId,
    }, headers);
    attempts.push({ channel: ch.channel, target: ch.target, ok: r.ok, status: r.status, message: r.bodyText, at: new Date().toISOString() });
  }
  return attempts;
}

export async function runNotificationDispatchTick(): Promise<{ processed: number; dispatched: number }> {
  // Pick UNREAD, UNARCHIVED, older than 2 seconds (to let the writer's
  // transaction settle) but younger than 7 days.
  const olderThan = new Date(Date.now() - 2_000);
  const youngerThan = new Date(Date.now() - 7 * 86_400_000);
  const rows = await prisma.userNotification.findMany({
    where:   { archived: false, readAt: null, createdAt: { lte: olderThan, gte: youngerThan } },
    orderBy: { createdAt: 'asc' },
    take:    BATCH_SIZE,
  });
  let dispatched = 0;
  for (const n of rows) {
    try {
      const attempts = await dispatchOne(n.id, n.userId, n.title, n.body, n.payload);
      if (attempts.length === 0) continue;
      // Merge into payload.dispatched map. Cap attempts.
      const existingPayload = (n.payload && typeof n.payload === 'object') ? (n.payload as Record<string, unknown>) : {};
      const existingDispatched = (existingPayload.dispatched && typeof existingPayload.dispatched === 'object'
        ? existingPayload.dispatched as Record<string, DispatchAttempt[]>
        : {});
      for (const a of attempts) {
        const k = `${a.channel}:${a.target}`;
        const arr = existingDispatched[k] ?? [];
        arr.push(a);
        if (arr.length > MAX_RETRIES) arr.shift();
        existingDispatched[k] = arr;
      }
      const newPayload = { ...existingPayload, dispatched: existingDispatched };
      await prisma.userNotification.update({
        where: { id: n.id },
        data:  { payload: newPayload as unknown as Prisma.InputJsonValue },
      });
      dispatched += attempts.filter((a) => a.ok).length;
    } catch (err) {
      logger.warn('[notify] dispatch failed', { notificationId: n.id, err: (err as Error).message });
    }
  }
  return { processed: rows.length, dispatched };
}

export function startNotificationDispatchWorker(): void {
  if (_running) return;
  _running = true;
  const tick = async () => {
    try {
      const r = await runNotificationDispatchTick();
      if (r.dispatched > 0) logger.info('[notify] tick', r);
    } catch (err) {
      logger.error('[notify] tick failed', { err: (err as Error).message });
    } finally {
      if (_running) _timer = setTimeout(tick, TICK_MS);
    }
  };
  _timer = setTimeout(tick, 5_000);
  logger.info('[notify] dispatch worker started', { tickMs: TICK_MS, batchSize: BATCH_SIZE });
}

export function stopNotificationDispatchWorker(): void {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
}

export function notificationDispatchStatus() {
  return {
    running: _running,
    tickMs: TICK_MS,
    batchSize: BATCH_SIZE,
    transports: {
      email:   !!process.env.NOTIFY_EMAIL_WEBHOOK,
      sms:     !!process.env.NOTIFY_SMS_WEBHOOK,
      push:    !!process.env.NOTIFY_PUSH_WEBHOOK,
      webhook: true,
    },
  };
}
// Silences unused-import warning for the bound channel type.
export type _UNC = UserNotificationChannel;
