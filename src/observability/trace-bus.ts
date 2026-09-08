// Familista — the owner's live trace bus
// ─────────────────────────────────────────────────────────────────────────────
// One request, seen end to end: the click, the call, the guards it passed, the
// queries it ran, the answer, and the paint. It exists so a question like "why
// did that take three seconds" has an answer that is read rather than guessed.
//
// It is OFF. Nothing here records anything until the platform owner turns it on,
// and it turns itself off again after a while — a diagnostic left running is a
// diagnostic nobody remembers is running. While off, `emit` is a boolean test
// and a return, which is the whole of its cost.
//
// It records SHAPES, never CONTENT. A stage carries a category, a short name,
// a duration and an outcome. It does not carry a request body, a query's
// values, a token, a password, a photograph or a person's medical note. The
// redaction below is central and total: everything on its way out goes through
// `safeDetail`, and a key that looks sensitive is dropped rather than masked,
// because a mask still tells you the field was there.
//
// It cannot break Familista. Every entry point is wrapped: a tracer that throws
// is a tracer that logged nothing, and the request carries on.

import { randomUUID } from 'crypto';

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary
// ─────────────────────────────────────────────────────────────────────────────

export const TRACE_CATEGORIES = [
  'UI', 'FRONTEND', 'API', 'AUTH', 'AUTHZ', 'SERVICE',
  'DB', 'CACHE', 'EXTERNAL', 'RESPONSE', 'STATE', 'RENDER', 'ERROR',
] as const;
export type TraceCategory = (typeof TRACE_CATEGORIES)[number];

export type TraceOutcome = 'ok' | 'warn' | 'error';

/** One thing that happened, at a point in a request's life. */
export interface TraceStage {
  /** Milliseconds since the request began. */
  at: number;
  category: TraceCategory;
  /** Short, human, and free of values: "requireMembership", "Player UPDATE". */
  name: string;
  /** How long this stage itself took, where that is a meaningful question. */
  durationMs?: number;
  outcome: TraceOutcome;
  /** A handful of safe, whitelisted facts. Never a body, never a value. */
  detail?: Record<string, string | number | boolean>;
}

export interface TraceRequest {
  id: string;
  startedAt: number;
  method?: string;
  route?: string;
  status?: number;
  /** Whose club this ran in, as an id — never a name, never a person. */
  clubId?: string | null;
  teamId?: string | null;
  actorRole?: string | null;
  stages: TraceStage[];
  totalMs?: number;
  closed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// One place for the thresholds, so a number is never argued with in two files
// ─────────────────────────────────────────────────────────────────────────────

export const TRACE_CONFIG = {
  /** Nothing is kept beyond this many requests. The oldest goes first. */
  BUFFER: 200,
  /** Nor beyond this many stages in one request — a runaway loop cannot grow. */
  MAX_STAGES: 200,
  /** Tracing expires on its own. A diagnostic nobody turned off is a leak. */
  MAX_ENABLED_MS: 30 * 60 * 1000,
  /** How a total duration is graded. One table, read by both sides. */
  SPEED: { FAST: 300, NORMAL: 1000, SLOW: 3000 },
} as const;

export type TraceSpeed = 'FAST' | 'NORMAL' | 'SLOW' | 'CRITICAL';

export function speedOf(totalMs: number): TraceSpeed {
  if (totalMs <= TRACE_CONFIG.SPEED.FAST) return 'FAST';
  if (totalMs <= TRACE_CONFIG.SPEED.NORMAL) return 'NORMAL';
  if (totalMs <= TRACE_CONFIG.SPEED.SLOW) return 'SLOW';
  return 'CRITICAL';
}

// ─────────────────────────────────────────────────────────────────────────────
// Redaction — the one gate everything leaves through
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A key whose VALUE must never travel, whatever it is called around it.
 *
 * Matched as a substring on the lower-cased key, so `refreshToken`,
 * `reset_token_hash` and `X-API-Key` are all caught by the same entry. The
 * field is DROPPED rather than masked: a masked field still says it existed and
 * still says how long it was.
 */
const FORBIDDEN_KEY = [
  'password', 'token', 'secret', 'authorization', 'cookie', 'session',
  'apikey', 'api_key', 'credential', 'jwt', 'bearer', 'hash', 'salt', 'signature',
  'avatar', 'photo', 'image', 'medical', 'injury', 'diagnosis', 'salary', 'wage',
  'iban', 'card', 'payment', 'dob', 'dateofbirth', 'birth', 'parent', 'guardian',
  'email', 'phone', 'address', 'note', 'message', 'body', 'payload',
];

function keyIsForbidden(key: string): boolean {
  const k = key.toLowerCase();
  return FORBIDDEN_KEY.some((bad) => k.includes(bad));
}

/**
 * Anything that looks like a credential, wherever it turned up.
 *
 * The key list above is the first defence; this is the second, for a value that
 * arrives under an innocent name. A long opaque run of characters, a JWT's three
 * dots, a bearer prefix or a data URI is replaced entirely.
 */
const VALUE_LOOKS_SECRET = [
  /\beyJ[A-Za-z0-9_-]{6,}\./,          // a JWT, by its header
  /\bBearer\s+\S+/i,
  /^data:[^;]+;base64,/i,               // an inlined image or file
  /\b[A-Fa-f0-9]{32,}\b/,               // a hash or a raw token
  /\b[A-Za-z0-9_-]{40,}\b/,             // any long opaque run
  /[\w.+-]+@[\w-]+\.[\w.]+/,            // an address
];

function valueLooksSecret(v: string): boolean {
  return VALUE_LOOKS_SECRET.some((re) => re.test(v));
}

/** The only way a detail bag reaches a subscriber. */
export function safeDetail(raw: unknown): Record<string, string | number | boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (kept >= 12) break;                       // a bag, not a document
    if (keyIsForbidden(key)) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value; kept += 1; continue;
    }
    if (typeof value !== 'string') continue;     // no nesting: shapes only
    const s = value.slice(0, 120);
    if (valueLooksSecret(s)) continue;
    out[key] = s; kept += 1;
  }
  return kept ? out : undefined;
}

/**
 * A route as a SHAPE, not as an address of somebody.
 *
 * `/api/v1/players/3f2a…/stats` becomes `/api/v1/players/:id/stats`, so a trace
 * names the endpoint without naming the row. Query strings go entirely.
 */
export function safeRoute(path: string): string {
  const base = String(path || '').split('?')[0].slice(0, 200);
  return base
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d{3,}/g, '/:id')
    .replace(/\/[A-Za-z0-9_-]{22,}/g, '/:id');
}

// ─────────────────────────────────────────────────────────────────────────────
// The switch
// ─────────────────────────────────────────────────────────────────────────────

interface EnabledState { on: boolean; until: number; byUserId: string | null }
const enabled: EnabledState = { on: false, until: 0, byUserId: null };

/** The one question the hot path asks, and it is a comparison. */
export function isTracing(): boolean {
  if (!enabled.on) return false;
  if (Date.now() > enabled.until) { enabled.on = false; enabled.byUserId = null; return false; }
  return true;
}

export function enableTracing(byUserId: string, ms?: number): { until: number } {
  const window = Math.min(Math.max(ms ?? TRACE_CONFIG.MAX_ENABLED_MS, 60_000), TRACE_CONFIG.MAX_ENABLED_MS);
  enabled.on = true;
  enabled.until = Date.now() + window;
  enabled.byUserId = byUserId;
  return { until: enabled.until };
}

export function disableTracing(): void {
  enabled.on = false;
  enabled.until = 0;
  enabled.byUserId = null;
  buffer.length = 0;
  open.clear();
}

export function tracingStatus() {
  const on = isTracing();
  return {
    enabled: on,
    expiresAt: on ? enabled.until : null,
    remainingMs: on ? Math.max(0, enabled.until - Date.now()) : 0,
    buffered: buffer.length,
    subscribers: subscribers.size,
    config: TRACE_CONFIG,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The buffer and the fan-out
// ─────────────────────────────────────────────────────────────────────────────

const buffer: TraceRequest[] = [];
const open = new Map<string, TraceRequest>();
type Subscriber = (event: { kind: 'stage' | 'close'; trace: TraceRequest }) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

function publish(kind: 'stage' | 'close', trace: TraceRequest): void {
  for (const fn of subscribers) {
    // One subscriber's broken pipe is one subscriber's problem.
    try { fn({ kind, trace }); } catch (_) { /* never poison the request path */ }
  }
}

export function newRequestId(): string {
  return `fam-${randomUUID()}`;
}

/** Begin a request's trace. Silent and free when tracing is off. */
export function beginTrace(id: string, seed: Partial<TraceRequest> = {}): void {
  if (!isTracing()) return;
  try {
    if (open.has(id)) return;
    const trace: TraceRequest = {
      id,
      startedAt: Date.now(),
      stages: [],
      closed: false,
      ...seed,
    };
    open.set(id, trace);
    buffer.push(trace);
    while (buffer.length > TRACE_CONFIG.BUFFER) {
      const dropped = buffer.shift();
      if (dropped) open.delete(dropped.id);
    }
  } catch (_) { /* a tracer that throws has traced nothing */ }
}

/**
 * Record one stage. The hot path, and the only function most callers touch.
 *
 * Every argument is treated as untrusted: the name is truncated, the detail bag
 * goes through `safeDetail`, and an unknown category is refused rather than
 * invented.
 */
export function emit(
  id: string | undefined,
  category: TraceCategory,
  name: string,
  opts: { durationMs?: number; outcome?: TraceOutcome; detail?: unknown } = {},
): void {
  if (!isTracing() || !id) return;
  try {
    const trace = open.get(id);
    if (!trace || trace.stages.length >= TRACE_CONFIG.MAX_STAGES) return;
    if (!TRACE_CATEGORIES.includes(category)) return;
    const stage: TraceStage = {
      at: Date.now() - trace.startedAt,
      category,
      name: String(name || '').slice(0, 80),
      outcome: opts.outcome ?? 'ok',
    };
    if (typeof opts.durationMs === 'number' && isFinite(opts.durationMs)) {
      stage.durationMs = Math.max(0, Math.round(opts.durationMs));
    }
    const detail = safeDetail(opts.detail);
    if (detail) stage.detail = detail;
    trace.stages.push(stage);
    publish('stage', trace);
  } catch (_) { /* as above */ }
}

/** Close a request out, with the answer it gave. */
export function endTrace(id: string | undefined, patch: Partial<TraceRequest> = {}): void {
  if (!isTracing() || !id) return;
  try {
    const trace = open.get(id);
    if (!trace || trace.closed) return;
    Object.assign(trace, patch);
    trace.totalMs = Date.now() - trace.startedAt;
    trace.closed = true;
    publish('close', trace);
  } catch (_) { /* as above */ }
}

/** What a panel opening mid-flight should see. Newest last, as it happened. */
export function recentTraces(limit = 50): TraceRequest[] {
  return buffer.slice(-Math.max(1, Math.min(limit, TRACE_CONFIG.BUFFER)));
}

/** Test seam only: forget everything, including the switch. */
export function _resetTracing(): void {
  disableTracing();
}
