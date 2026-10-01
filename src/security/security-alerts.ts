// Cyber Defense, R6 — security signals reach a person, not only a table
// ─────────────────────────────────────────────────────────────────────────────
// The platform already RECORDS what matters: `SecurityEvent` rows (a request
// that reached for another club's data, a broken audit chain, a locked
// account, a CRITICAL rate-limit hit), the `security.*` Fabric events kept in
// `FabricEventHistory` (a reused refresh token, a sign-in run that would trip
// the lockout) and `BackupRecord` (a scheduled backup that failed). Until now
// nobody was TOLD. A signal in a table nobody reads is not detection.
//
// This dispatcher reads those three sources on a timer and emails the platform
// operator at SECURITY_ALERT_EMAIL. It is deliberately boring:
//
//   · it runs in ONE process, leased with the other background workers
//     (`infra/background-workers.ts`), so four processes never send four emails;
//   · it starts from "now" — a deploy or a restart does not replay history;
//   · it reads a closed window [cursor, now − LAG), so a row committed a moment
//     late is still counted on the next tick, and a failed read retries it;
//   · one email per rule per DEDUPE window: further signals are held and
//     reported as a count in the next email, never dropped and never spammed;
//   · at most HOURLY_CAP emails in any hour, whatever happens;
//   · one digest a day, counts only;
//   · the email carries rule names, counts and time windows ONLY — no IP, no
//     user or club id, no address, no payload (`templates/security-alert.ts`).
//
// Without SECURITY_ALERT_EMAIL (or with an invalid one) it does not run, and
// says so once. It is not a secret: it is a mailbox, set in the dashboard so it
// stays out of git.

import type { PrismaClient, SecurityEventKind } from '@prisma/client';
import { sendEmail } from '../platform/email/service';
import type { DeliveryResult, EmailMessage } from '../platform/email/types';
import {
  renderSecurityAlert, renderSecurityDigest, resolveAlertLocale,
  type AlertLine, type AlertLocale, type DigestLine,
} from '../platform/email/templates/security-alert';
import { logger } from '../utils/logger';

export type AlertRule =
  | 'critical-event' | 'tenant-mismatch' | 'audit-chain-broken' | 'login-locked'
  | 'refresh-token-reuse' | 'brute-force' | 'backup-failed' | 'backup-stale';

export const TICK_MS = 60_000;
/** Rows are read up to now − LAG, so one committed a little late is not skipped. */
export const LAG_MS = 15_000;
export const DEDUPE_MS = 15 * 60_000;
export const STALE_DEDUPE_MS = 6 * 60 * 60_000;
export const HOURLY_CAP = 12;
export const BACKUP_STALE_MS = 36 * 60 * 60_000;
export const DIGEST_HOUR_UTC = 7;

/** SecurityEvent kinds that alert whatever their severity. */
const KIND_RULES: Partial<Record<SecurityEventKind, AlertRule>> & Record<string, AlertRule | undefined> = {
  TENANT_MISMATCH: 'tenant-mismatch',
  AUDIT_CHAIN_BROKEN: 'audit-chain-broken',
  LOGIN_LOCKED: 'login-locked',
};
/** Fabric `security.*` event types that alert. */
export const FABRIC_RULES: Record<string, AlertRule> = {
  'security.refresh.reused': 'refresh-token-reuse',
  'security.lockout.triggered': 'brute-force',
};
const ORDER: AlertRule[] = [
  'audit-chain-broken', 'tenant-mismatch', 'refresh-token-reuse', 'critical-event',
  'login-locked', 'brute-force', 'backup-failed', 'backup-stale',
];

/** Which rule a SecurityEvent row raises, if any. */
export function classifySecurityEvent(kind: string, severity: string): AlertRule | null {
  return KIND_RULES[kind] ?? (severity === 'CRITICAL' ? 'critical-event' : null);
}

/** One address, plainly formed. Anything else disables alerting rather than guessing. */
export function parseAlertRecipient(raw: string | undefined): string | null {
  const v = String(raw ?? '').trim();
  if (!v || v.length > 254 || /[\s,;<>"]/.test(v)) return null;
  return /^[^@]+@[^@]+\.[A-Za-z]{2,}$/.test(v) ? v : null;
}

// ── where the signals are read ───────────────────────────────────────────────

export interface AlertStore {
  /** SecurityEvent counts by kind and severity, createdAt in (from, to]. */
  securityEventCounts(from: Date, to: Date): Promise<Array<{ kind: string; severity: string; count: number }>>;
  /** FabricEventHistory counts by type, persistedAt in (from, to]. */
  fabricCounts(from: Date, to: Date, types: string[]): Promise<Array<{ eventType: string; count: number }>>;
  /** Scheduled backups that FINISHED unsuccessfully, finishedAt in (from, to]. */
  failedBackups(from: Date, to: Date): Promise<number>;
  lastBackupSuccessAt(): Promise<Date | null>;
}

export function prismaAlertStore(prisma: PrismaClient): AlertStore {
  return {
    async securityEventCounts(from, to) {
      const rows = await prisma.securityEvent.groupBy({
        by: ['kind', 'severity'],
        where: {
          createdAt: { gt: from, lte: to },
          OR: [{ severity: 'CRITICAL' }, { kind: { in: Object.keys(KIND_RULES) as SecurityEventKind[] } }],
        },
        _count: { _all: true },
      });
      return rows.map((r) => ({ kind: String(r.kind), severity: String(r.severity), count: r._count._all }));
    },
    async fabricCounts(from, to, types) {
      const rows = await prisma.fabricEventHistory.groupBy({
        by: ['eventType'],
        where: { persistedAt: { gt: from, lte: to }, eventType: { in: types } },
        _count: { _all: true },
      });
      return rows.map((r) => ({ eventType: r.eventType, count: r._count._all }));
    },
    async failedBackups(from, to) {
      return prisma.backupRecord.count({ where: { kind: 'SCHEDULED', ok: false, finishedAt: { gt: from, lte: to } } });
    },
    async lastBackupSuccessAt() {
      const r = await prisma.backupRecord.findFirst({
        where: { kind: 'SCHEDULED', ok: true, finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      });
      return r?.finishedAt ?? null;
    },
  };
}

/** Every alerting rule's count over (from, to] — the one reader both the alert and the digest use. */
async function countRules(store: AlertStore, from: Date, to: Date): Promise<Map<AlertRule, number>> {
  const [events, fabric, failed] = await Promise.all([
    store.securityEventCounts(from, to),
    store.fabricCounts(from, to, Object.keys(FABRIC_RULES)),
    store.failedBackups(from, to),
  ]);
  const out = new Map<AlertRule, number>();
  const add = (rule: AlertRule | null | undefined, n: number) => { if (rule && n > 0) out.set(rule, (out.get(rule) ?? 0) + n); };
  for (const e of events) add(classifySecurityEvent(e.kind, e.severity), e.count);
  for (const f of fabric) add(FABRIC_RULES[f.eventType], f.count);
  add('backup-failed', failed);
  return out;
}

// ── the dispatcher ───────────────────────────────────────────────────────────

export interface AlertDeps {
  store: AlertStore;
  send: (message: EmailMessage) => Promise<Pick<DeliveryResult, 'ok' | 'failureCode'>>;
  now: () => Date;
  recipient: string;
  locale: AlertLocale;
}

interface Pending { count: number; held: number; since: number }

export interface TickResult { sent: boolean; rules: AlertRule[]; capped: boolean; digest: boolean }

export function createSecurityAlertDispatcher(deps: AlertDeps) {
  const start = deps.now().getTime();
  let cursor = new Date(start - LAG_MS);
  const lastSent = new Map<AlertRule, number>();
  const pending = new Map<AlertRule, Pending>();
  const sentAt: number[] = [];
  let capLogged = false;
  // A process that comes up after the digest hour treats today's as done:
  // every deploy would otherwise send another one.
  let lastDigestDay = new Date(start).getUTCHours() >= DIGEST_HOUR_UTC ? utcDay(start) : '';

  const dedupe = (rule: AlertRule) => (rule === 'backup-stale' ? STALE_DEDUPE_MS : DEDUPE_MS);

  function note(rule: AlertRule, n: number, now: number): void {
    const p = pending.get(rule);
    const open = now - (lastSent.get(rule) ?? -Infinity) >= dedupe(rule);
    // Staleness is a state, not a stream of events: it is one signal however
    // many ticks it lasts.
    if (rule === 'backup-stale') { if (!p) pending.set(rule, { count: 1, held: 0, since: now }); return; }
    if (!p) pending.set(rule, { count: open ? n : 0, held: open ? 0 : n, since: now });
    else if (open) p.count += n;
    else p.held += n;
  }

  async function digest(now: number): Promise<boolean> {
    const day = utcDay(now);
    if (new Date(now).getUTCHours() < DIGEST_HOUR_UTC || lastDigestDay === day) return false;
    lastDigestDay = day; // once a day, sent or not: a failing provider must not retry every minute
    const to = new Date(now);
    const counts = await countRules(deps.store, new Date(now - 24 * 60 * 60_000), to);
    const last = await deps.store.lastBackupSuccessAt();
    const lines: DigestLine[] = ORDER.filter((r) => r !== 'backup-stale').map((rule) => ({ rule, count: counts.get(rule) ?? 0 }));
    const hours = last ? Math.floor((now - last.getTime()) / 3_600_000) : null;
    const mail = renderSecurityDigest(deps.locale, lines, hours);
    const r = await deps.send({ to: { address: deps.recipient }, subject: mail.subject, html: mail.html, text: mail.text, locale: mail.locale });
    logger.info('[security-alerts] daily digest', { ok: r.ok, failureCode: r.ok ? null : r.failureCode });
    return r.ok;
  }

  async function tick(): Promise<TickResult> {
    const now = deps.now().getTime();
    const to = new Date(now - LAG_MS);
    if (to > cursor) {
      const counts = await countRules(deps.store, cursor, to); // throws → cursor kept, window retried
      cursor = to;
      for (const [rule, n] of counts) note(rule, n, now);
    }
    const last = await deps.store.lastBackupSuccessAt();
    if (!last || now - last.getTime() > BACKUP_STALE_MS) note('backup-stale', 1, now);

    const ready = ORDER.filter((rule) => {
      const p = pending.get(rule);
      if (!p || p.count + p.held === 0) return false;
      return now - (lastSent.get(rule) ?? -Infinity) >= dedupe(rule);
    });
    let sent = false;
    let capped = false;
    if (ready.length) {
      while (sentAt.length && now - sentAt[0] >= 3_600_000) sentAt.shift();
      if (sentAt.length >= HOURLY_CAP) {
        capped = true;
        if (!capLogged) { logger.warn('[security-alerts] hourly email cap reached; signals are held for the next email', { cap: HOURLY_CAP }); capLogged = true; }
      } else {
        capLogged = false;
        const lines: AlertLine[] = ready.map((rule) => {
          const p = pending.get(rule)!;
          // A held signal is reported now: it is due once its window has passed.
          return { rule, count: p.count + p.held, suppressed: p.held };
        });
        const since = Math.min(...ready.map((r) => pending.get(r)!.since));
        const minutes = Math.max(1, Math.ceil((now - since + LAG_MS) / 60_000));
        const mail = renderSecurityAlert(deps.locale, lines, minutes);
        sentAt.push(now);
        const r = await deps.send({ to: { address: deps.recipient }, subject: mail.subject, html: mail.html, text: mail.text, locale: mail.locale });
        logger.info('[security-alerts] alert email', { ok: r.ok, rules: ready, failureCode: r.ok ? null : r.failureCode });
        if (r.ok) {
          sent = true;
          for (const rule of ready) { lastSent.set(rule, now); pending.delete(rule); }
        }
      }
    }
    const digestSent = await digest(now);
    return { sent, rules: sent ? ready : [], capped, digest: digestSent };
  }

  return { tick };
}

function utcDay(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

// ── the timer, leased by infra/background-workers.ts ─────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

export function startSecurityAlerts(): void {
  if (timer) return;
  const recipient = parseAlertRecipient(process.env.SECURITY_ALERT_EMAIL);
  if (!recipient) {
    logger.warn(process.env.SECURITY_ALERT_EMAIL
      ? '[security-alerts] SECURITY_ALERT_EMAIL is not a single valid address; security alert emails are OFF'
      : '[security-alerts] SECURITY_ALERT_EMAIL is not set; security alert emails are OFF');
    return;
  }
  // Required lazily: the database client is not loaded by importing this file.
  const { prisma } = require('../config/database') as typeof import('../config/database');
  const dispatcher = createSecurityAlertDispatcher({
    store: prismaAlertStore(prisma),
    send: sendEmail,
    now: () => new Date(),
    recipient,
    locale: resolveAlertLocale(process.env.SECURITY_ALERT_LOCALE),
  });
  let running = false;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    dispatcher.tick()
      .catch((err) => logger.warn('[security-alerts] tick failed; the window is retried next tick', { err: (err as Error).message }))
      .finally(() => { running = false; });
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  logger.info('[security-alerts] security alert emails are ON', { tickMs: TICK_MS });
}

export function stopSecurityAlerts(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/** For tests and the ops view: is the timer running in this process? */
export function securityAlertsRunning(): boolean { return timer !== null; }
