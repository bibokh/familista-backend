// The analytics vocabulary — what may be recorded, and nothing else
// ─────────────────────────────────────────────────────────────────────────────
// Product analytics answers "what is being used, and how". It is not the audit
// trail, which answers "who changed what" and lives in different tables with
// different retention. That separation is architectural, and this file is where
// it is enforced for the analytics side: an event declared here is ANALYTICS,
// full stop, and nothing in it may carry content.
//
// ── The rule that makes this safe to keep
//
// An analytics event is metadata about an interaction, never the interaction's
// subject. A module key, a feature key, a route SHAPE, a duration, a set of
// ids. There is no field for a note, a message, a name a person typed, a form
// value or a credential — not because callers are trusted to leave them out,
// but because `sanitize` below drops every key that is not on the allowlist,
// and the table has no column to put one in.
//
// GOOD   module = "match-center", event = "module_opened", durationMs = 46000
// BAD    the medical report, the tactical instruction, the search text

import { FORBIDDEN_PAYLOAD_KEYS } from '../events/contracts';

export type AnalyticsEnvironmentName = 'PRODUCTION' | 'STAGING' | 'LAB' | 'PREVIEW';

/**
 * Every event the platform records, declared once.
 *
 * Coarse on purpose. A row per gesture is a table nobody can afford to query
 * and a privacy surface nobody can defend; the questions SYSTEM actually asks —
 * who is active, what is used, for how long, by whom in what role — are all
 * answered at this grain.
 */
export const ANALYTICS_EVENTS = [
  // session boundaries
  'session_started', 'session_ended',
  // navigation
  'module_opened', 'module_closed',
  'club_opened', 'team_opened',
  // club workspaces
  'first_team_opened', 'academy_opened', 'training_centre_opened',
  'match_center_opened', 'familista_league_opened',
  'transfer_market_opened', 'coach_market_opened',
  'medical_center_opened', 'video_intelligence_opened',
  'player_profile_viewed', 'ai_feature_opened',
  // deliberate actions worth a trend line
  'training_created', 'match_created', 'search_used', 'feature_used',
  'staff_invited', 'invitation_accepted',
  // platform surfaces
  'experiment_opened', 'feature_flag_changed',
] as const;

export type AnalyticsEventName = typeof ANALYTICS_EVENTS[number];

const EVENT_SET: ReadonlySet<string> = new Set(ANALYTICS_EVENTS);
export function isAnalyticsEvent(name: string): name is AnalyticsEventName {
  return EVENT_SET.has(name);
}

/**
 * The only fields an event may carry.
 *
 * An allowlist, not a blocklist. A blocklist has to imagine every bad field
 * somebody might add; an allowlist only has to name the good ones, and a field
 * nobody thought about is dropped rather than stored.
 */
export const ALLOWED_FIELDS = [
  'eventName', 'sessionId', 'occurredAt',
  'module', 'feature', 'route',
  'clubId', 'teamId',
  'durationMs', 'deviceCategory', 'locale', 'timezone', 'source', 'schemaVersion',
] as const;

const ALLOWED = new Set<string>(ALLOWED_FIELDS);

/** Current schema version. Bumped when the shape gains meaning, never silently. */
export const ANALYTICS_SCHEMA_VERSION = 1;

export interface AnalyticsEventInput {
  eventName: string;
  sessionId: string;
  occurredAt?: string | Date;
  module?: string | null;
  feature?: string | null;
  route?: string | null;
  clubId?: string | null;
  teamId?: string | null;
  durationMs?: number | null;
  deviceCategory?: string | null;
  locale?: string | null;
  timezone?: string | null;
  source?: string | null;
  schemaVersion?: number | null;
}

/** Values long enough to hide content in are not values, they are content. */
const MAX_KEY = 64;
const MAX_ROUTE = 200;

const short = (v: unknown, max = MAX_KEY): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
};

/**
 * A route shape, never a populated route.
 *
 * "/club/8f3a-…/academy/U15" identifies a club and a team in a string; the
 * useful part is the shape. Every id-looking and number-looking segment is
 * replaced, so the journey analysis has its path and the path has no subject.
 */
export function routeShape(route: string | null | undefined): string | null {
  const raw = short(route, MAX_ROUTE);
  if (!raw) return null;
  const withoutQuery = raw.split('?')[0].split('#')[0];
  return withoutQuery
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^\d+$/.test(seg)) return ':n';
      if (seg.length > 24) return ':id';
      return seg;
    })
    .join('/')
    .slice(0, MAX_ROUTE);
}

export interface SanitizedEvent {
  eventName: AnalyticsEventName;
  sessionId: string;
  occurredAt: Date;
  module: string | null;
  feature: string | null;
  route: string | null;
  clubId: string | null;
  teamId: string | null;
  durationMs: number | null;
  deviceCategory: string | null;
  locale: string | null;
  timezone: string | null;
  source: string;
  schemaVersion: number;
}

/**
 * Everything a caller sent, reduced to what may be stored.
 *
 * Returns null when the event is not one this platform records — an unknown
 * name is dropped rather than stored as free text, because "eventName" would
 * otherwise be a column anybody could write anything into.
 */
export function sanitize(input: unknown): SanitizedEvent | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;

  // The forbidden keys are checked as well as ignored. Ignoring them is what
  // keeps them out of the database; noticing them is what makes a caller that
  // tries visible in a test rather than silently tolerated.
  for (const key of Object.keys(raw)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_PAYLOAD_KEYS.some((f) => lowered === f.toLowerCase() || lowered.endsWith(f.toLowerCase()))) {
      return null;
    }
    if (!ALLOWED.has(key)) {
      // Not fatal — an extra field is dropped, not a reason to lose the event.
      delete raw[key];
    }
  }

  const eventName = short(raw.eventName);
  if (!eventName || !isAnalyticsEvent(eventName)) return null;
  const sessionId = short(raw.sessionId, 80);
  if (!sessionId) return null;

  const at = raw.occurredAt ? new Date(raw.occurredAt as string) : new Date();
  const occurredAt = Number.isFinite(at.getTime()) ? at : new Date();
  // A clock that claims the future is a clock, not evidence. Clamp rather than
  // reject: the event still happened.
  const now = Date.now();
  const stamped = occurredAt.getTime() > now + 60_000 ? new Date(now) : occurredAt;

  const duration = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
    // A day is longer than any real dwell time; beyond that it is a tab left open.
    ? Math.max(0, Math.min(Math.round(raw.durationMs), 24 * 60 * 60 * 1000))
    : null;

  return {
    eventName,
    sessionId,
    occurredAt: stamped,
    module: short(raw.module),
    feature: short(raw.feature),
    route: routeShape(raw.route as string),
    clubId: short(raw.clubId, 80),
    teamId: short(raw.teamId, 80),
    durationMs: duration,
    deviceCategory: deviceCategory(raw.deviceCategory),
    locale: short(raw.locale, 16),
    timezone: short(raw.timezone, 64),
    source: short(raw.source, 24) ?? 'web',
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : ANALYTICS_SCHEMA_VERSION,
  };
}

/**
 * Three buckets, and no user agent.
 *
 * A user-agent string is a fingerprint; "mobile" is a fact about how the
 * product is used. Only the second is worth keeping, so only the second is
 * accepted, and anything else becomes "unknown".
 */
const DEVICE_CATEGORIES = new Set(['mobile', 'tablet', 'desktop', 'unknown']);
export function deviceCategory(v: unknown): string | null {
  const s = short(v, 16);
  if (!s) return null;
  const lowered = s.toLowerCase();
  return DEVICE_CATEGORIES.has(lowered) ? lowered : 'unknown';
}
