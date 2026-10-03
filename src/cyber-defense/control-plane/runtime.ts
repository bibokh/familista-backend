// What the running platform recorded — read-only, aggregated, bounded
// ─────────────────────────────────────────────────────────────────────────────
// The Command Center's live layer. Every read here is:
//
//   READ-ONLY     counts, groupings and one timestamp at a time. No write, no
//                 configuration change, no RLS mode change.
//   AGGREGATED    it returns how many and when — never an id, a user, a club,
//                 an IP address, a payload or a value.
//   BOUNDED       windows of 24 hours and 7 days on indexed columns; each read
//                 has a timeout and fails to UNAVAILABLE with a reason rather
//                 than holding the page or guessing.
//   SHARED        one snapshot serves every domain, cached for a few seconds,
//                 so opening the Command Center costs a dozen small queries.
//
// In-process facts (collector counters, the alert dispatcher, the RLS mode and
// observations) are read directly: they belong to THIS instance and the screen
// says "since this instance started".

import { prisma } from '../../config/database';
import { rlsContextMode, RLS_PILOT_MODELS } from '../../security/db-context';
import { rlsObservations, rlsObservationWindowStart } from '../../security/rls-observations';
import { securityAlertsRunning, parseAlertRecipient, BACKUP_STALE_MS } from '../../security/security-alerts';
import { securityCollectorStats } from '../collectors';
import { adminMfaRequired, ADMIN_ROLES } from '../../auth-prod/admin-mfa';
import { SECURITY_EVENT_TYPES } from '../security-event-schema';
import { MIN_SECRET_LENGTH } from '../../security/backup/backup-trigger';

export type ReadState = 'READ' | 'UNAVAILABLE';
export interface RuntimeRead<T> { state: ReadState; value: T | null; reason: string | null }

export interface EventCounts {
  /** kind → count, last 24 hours. */
  byKind24h: Record<string, number>;
  /** kind → count, last 7 days. */
  byKind7d: Record<string, number>;
  /** kind → critical count, last 24 hours. */
  critical24hByKind: Record<string, number>;
  total24h: number; total7d: number; critical24h: number; warning24h: number;
}
export interface SignalCounts { byType24h: Record<string, number>; byType7d: Record<string, number> }

export interface RuntimeSnapshot {
  measuredAt: string;
  events: RuntimeRead<EventCounts>;
  signals: RuntimeRead<SignalCounts>;
  devices: RuntimeRead<{ events24h: number; events7d: number }>;
  ai: RuntimeRead<{ calls24h: number; refused24h: number; failed24h: number; pendingApprovals: number }>;
  audit: RuntimeRead<{ appended7d: number; lastAppendedAt: string | null; egress7d: number }>;
  backups: RuntimeRead<{ lastSuccessAt: string | null; failed7d: number }>;
  mfa: RuntimeRead<{ admins: number; adminsEnrolled: number }>;
  rlsEnforced: RuntimeRead<boolean>;
  /**
   * Of the tables the application protects, the ones the database itself does
   * not hold to row-level security right now — not forced, or without a
   * policy. Read in the same statement as the switch; null when it did not answer.
   */
  rlsUnprotected: RuntimeRead<string[]>;
  process: {
    startedAt: string;
    uptimeHours: number;
    collectors: { written: number; suppressed: number; overCap: number; refused: number };
    alertDispatcherRunning: boolean;
    alertRecipientConfigured: boolean;
    mfaRequiredForAdmins: boolean;
    rlsMode: 'off' | 'observe' | 'on';
    rlsObservations: Array<{ model: string; operation: string; firstSeenAt: string }>;
    rlsObservationWindowStart: string;
    visionWebhookConfigured: boolean;
    clipWebhookConfigured: boolean;
    backupStaleAfterHours: number;
  };
}

const READ_TIMEOUT_MS = 4000;
const CACHE_MS = 15_000;
const DAY = 24 * 60 * 60 * 1000;

/** One field of a read; a field the answer did not carry is unavailable, not empty. */
function part<T, U>(r: RuntimeRead<T>, pick: (v: T) => U | null): RuntimeRead<U> {
  if (r.state !== 'READ' || r.value === null) return { state: r.state, value: null, reason: r.reason };
  const value = pick(r.value);
  return value === null ? { state: 'UNAVAILABLE', value: null, reason: 'The platform could not read this.' } : { state: 'READ', value, reason: null };
}

async function read<T>(f: () => Promise<T>): Promise<RuntimeRead<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      f(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), READ_TIMEOUT_MS); }),
    ]);
    return { state: 'READ', value, reason: null };
  } catch (err) {
    const why = (err as Error)?.message === 'timed out' ? 'The read timed out.' : 'The platform could not read this.';
    return { state: 'UNAVAILABLE', value: null, reason: why };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const count = (r: { _count?: { _all?: number } | number }): number =>
  typeof r._count === 'number' ? r._count : (r._count?._all ?? 0);

async function eventCounts(now: number): Promise<EventCounts> {
  const since24 = new Date(now - DAY);
  const since7 = new Date(now - 7 * DAY);
  const [d1, d7] = await Promise.all([
    prisma.securityEvent.groupBy({ by: ['kind', 'severity'], where: { createdAt: { gt: since24 } }, _count: { _all: true } }),
    prisma.securityEvent.groupBy({ by: ['kind'], where: { createdAt: { gt: since7 } }, _count: { _all: true } }),
  ]);
  const out: EventCounts = { byKind24h: {}, byKind7d: {}, critical24hByKind: {}, total24h: 0, total7d: 0, critical24h: 0, warning24h: 0 };
  for (const r of (d1 as Array<{ kind: string; severity: string; _count: { _all: number } }>)) {
    const n = count(r);
    out.byKind24h[r.kind] = (out.byKind24h[r.kind] ?? 0) + n;
    out.total24h += n;
    if (r.severity === 'CRITICAL') { out.critical24h += n; out.critical24hByKind[r.kind] = (out.critical24hByKind[r.kind] ?? 0) + n; }
    if (r.severity === 'WARN') out.warning24h += n;
  }
  for (const r of (d7 as Array<{ kind: string; _count: { _all: number } }>)) {
    const n = count(r);
    out.byKind7d[r.kind] = n;
    out.total7d += n;
  }
  return out;
}

async function signalCounts(now: number): Promise<SignalCounts> {
  const types = SECURITY_EVENT_TYPES.map((t) => t.type);
  const [d1, d7] = await Promise.all([
    prisma.fabricEventHistory.groupBy({ by: ['eventType'], where: { eventType: { in: types }, occurredAt: { gt: new Date(now - DAY) } }, _count: { _all: true } }),
    prisma.fabricEventHistory.groupBy({ by: ['eventType'], where: { eventType: { in: types }, occurredAt: { gt: new Date(now - 7 * DAY) } }, _count: { _all: true } }),
  ]);
  const map = (rows: unknown) => Object.fromEntries((rows as Array<{ eventType: string; _count: { _all: number } }>).map((r) => [r.eventType, count(r)]));
  return { byType24h: map(d1), byType7d: map(d7) };
}

async function deviceCounts(now: number) {
  const [events24h, events7d] = await Promise.all([
    prisma.deviceSecurityEvent.count({ where: { createdAt: { gt: new Date(now - DAY) } } }),
    prisma.deviceSecurityEvent.count({ where: { createdAt: { gt: new Date(now - 7 * DAY) } } }),
  ]);
  return { events24h, events7d };
}

async function aiCounts(now: number) {
  const since = new Date(now - DAY);
  const [byOutcome, pendingApprovals] = await Promise.all([
    prisma.aiEgressRecord.groupBy({ by: ['outcome'], where: { createdAt: { gt: since } }, _count: { _all: true } }),
    prisma.aIApprovalRequest.count({ where: { status: 'PENDING', expiresAt: { gt: new Date(now) } } }),
  ]);
  let calls24h = 0; let refused24h = 0; let failed24h = 0;
  for (const r of (byOutcome as Array<{ outcome: string; _count: { _all: number } }>)) {
    const n = count(r);
    calls24h += n;
    if (r.outcome === 'REFUSED') refused24h += n;
    if (r.outcome === 'FAILED' || r.outcome === 'INVALID_OUTPUT') failed24h += n;
  }
  return { calls24h, refused24h, failed24h, pendingApprovals };
}

async function auditCounts(now: number) {
  const since = new Date(now - 7 * DAY);
  const [appended7d, last, egress7d] = await Promise.all([
    prisma.securityAuditEvent.count({ where: { createdAt: { gt: since } } }),
    prisma.securityAuditEvent.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    prisma.aiEgressRecord.count({ where: { createdAt: { gt: since } } }),
  ]);
  return { appended7d, lastAppendedAt: last?.createdAt ? new Date(last.createdAt).toISOString() : null, egress7d };
}

async function backupFacts(now: number) {
  const [last, failed7d] = await Promise.all([
    prisma.backupRecord.findFirst({
      where: { kind: 'SCHEDULED', ok: true, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' }, select: { finishedAt: true },
    }),
    prisma.backupRecord.count({ where: { kind: 'SCHEDULED', ok: false, finishedAt: { gt: new Date(now - 7 * DAY) } } }),
  ]);
  return { lastSuccessAt: last?.finishedAt ? new Date(last.finishedAt).toISOString() : null, failed7d };
}

/** Above this many enrolments the count is refused rather than truncated. */
const ENROLMENT_SCAN_CAP = 50_000;

async function mfaCounts() {
  const adminWhere = { role: { in: [...ADMIN_ROLES] }, isActive: true };
  // MFASetting carries a bare userId (no relation to filter through), so the
  // enrolled administrators are counted in two steps. The ids never leave this
  // function: only the two counts do. Enrolled = isEnrolled() in admin-mfa.ts.
  const [admins, enrolled] = await Promise.all([
    prisma.user.count({ where: adminWhere }),
    prisma.mFASetting.findMany({
      where: { enabledAt: { not: null }, method: { not: 'NONE' } }, select: { userId: true }, take: ENROLMENT_SCAN_CAP + 1,
    }),
  ]);
  const ids = (enrolled as Array<{ userId: string }>).map((e) => e.userId);
  if (ids.length > ENROLMENT_SCAN_CAP) throw new Error('too many enrolments to count exactly');
  const adminsEnrolled = ids.length === 0 ? 0 : await prisma.user.count({ where: { ...adminWhere, id: { in: ids } } });
  return { admins, adminsEnrolled };
}

/**
 * The database's own enforcement switch, and — in the same statement, from the
 * catalogue — which of the protected tables it does not hold to row-level
 * security (not FORCE'd, or with no policy). Both are the database's answer,
 * not the repository's: Stage 4 is reported from what PostgreSQL says now.
 */
async function rlsDatabaseFacts(): Promise<{ enforced: boolean; unprotected: string[] | null }> {
  const tables = [...RLS_PILOT_MODELS];
  const rows = await prisma.$queryRaw<Array<{ enforced: unknown; unprotected: unknown }>>`SELECT public.familista_rls_enforced() AS enforced,
    (SELECT coalesce(json_agg(t ORDER BY t), '[]'::json) FROM unnest(${tables}::text[]) AS t
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity)
         OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t)) AS unprotected`;
  const row = Array.isArray(rows) && rows.length ? rows[0] : undefined;
  if (typeof row?.enforced !== 'boolean') throw new Error('no answer');
  const u = row.unprotected;
  return { enforced: row.enforced, unprotected: Array.isArray(u) && u.every((x) => typeof x === 'string') ? u as string[] : null };
}

const secretConfigured = (name: string): boolean => (process.env[name] ?? '').trim().length >= MIN_SECRET_LENGTH;

function processFacts(): RuntimeSnapshot['process'] {
  const up = process.uptime();
  return {
    startedAt: new Date(Date.now() - up * 1000).toISOString(),
    uptimeHours: Math.floor(up / 3600),
    collectors: { ...securityCollectorStats() },
    alertDispatcherRunning: securityAlertsRunning(),
    alertRecipientConfigured: parseAlertRecipient(process.env.SECURITY_ALERT_EMAIL) !== null,
    mfaRequiredForAdmins: adminMfaRequired(),
    rlsMode: rlsContextMode(),
    rlsObservations: rlsObservations(),
    rlsObservationWindowStart: rlsObservationWindowStart(),
    visionWebhookConfigured: secretConfigured('VISION_WEBHOOK_TOKEN'),
    clipWebhookConfigured: secretConfigured('VISION_CLIP_WEBHOOK_TOKEN'),
    backupStaleAfterHours: Math.round(BACKUP_STALE_MS / 3_600_000),
  };
}

let cached: { at: number; snapshot: RuntimeSnapshot } | null = null;
let inflight: Promise<RuntimeSnapshot> | null = null;

/** One shared snapshot of the live layer, at most a few seconds old. */
export async function runtimeSnapshot(nowMs: number = Date.now()): Promise<RuntimeSnapshot> {
  if (cached && nowMs - cached.at < CACHE_MS) return cached.snapshot;
  if (inflight) return inflight;
  inflight = (async () => {
    const [events, signals, devices, ai, audit, backups, mfa, enforced] = await Promise.all([
      read(() => eventCounts(nowMs)),
      read(() => signalCounts(nowMs)),
      read(() => deviceCounts(nowMs)),
      read(() => aiCounts(nowMs)),
      read(() => auditCounts(nowMs)),
      read(() => backupFacts(nowMs)),
      read(() => mfaCounts()),
      read(() => rlsDatabaseFacts()),
    ]);
    const snapshot: RuntimeSnapshot = {
      measuredAt: new Date(nowMs).toISOString(),
      events, signals, devices, ai, audit, backups, mfa,
      rlsEnforced: part(enforced, (f) => f.enforced),
      rlsUnprotected: part(enforced, (f) => f.unprotected),
      process: processFacts(),
    };
    cached = { at: nowMs, snapshot };
    return snapshot;
  })();
  try { return await inflight; } finally { inflight = null; }
}

/** The most recent security events of the given kinds: kind, severity and time only. */
export async function recentEvents(kinds: string[] | '*', take = 20): Promise<RuntimeRead<Array<{ kind: string; severity: string; at: string }>>> {
  return read(async () => {
    const rows = await prisma.securityEvent.findMany({
      where: kinds === '*' ? {} : { kind: { in: kinds as never[] } },
      orderBy: { createdAt: 'desc' }, take,
      select: { kind: true, severity: true, createdAt: true },
    });
    return (rows as Array<{ kind: string; severity: string; createdAt: Date }>).map((r) => ({
      kind: String(r.kind), severity: String(r.severity), at: new Date(r.createdAt).toISOString(),
    }));
  });
}

/** The most recent `security.*` signals of the given types: type and time only. */
export async function recentSignals(types: string[] | '*', take = 20): Promise<RuntimeRead<Array<{ type: string; at: string }>>> {
  const declared = SECURITY_EVENT_TYPES.map((t) => t.type);
  const wanted = types === '*' ? declared : types.filter((t) => declared.includes(t));
  return read(async () => {
    if (!wanted.length) return [];
    const rows = await prisma.fabricEventHistory.findMany({
      where: { eventType: { in: wanted } }, orderBy: { occurredAt: 'desc' }, take,
      select: { eventType: true, occurredAt: true },
    });
    return (rows as Array<{ eventType: string; occurredAt: Date }>).map((r) => ({
      type: r.eventType, at: new Date(r.occurredAt).toISOString(),
    }));
  });
}

/** Tests only. */
export function resetRuntimeSnapshot(): void { cached = null; inflight = null; }
