// Fixture scheduling policy — when a match may be kicked off
// ─────────────────────────────────────────────────────────────────────────────
// One rule, in one place, expressed once and used by both sides of the wire.
// A kickoff is legal when it is in the future and when its LOCAL time at the
// venue falls inside the competition's allowed window. Local at the venue, not
// local in the browser: a coach in Berlin arranging a match in São Paulo must
// not be able to schedule 05:00 there because it reads as a civilised hour on
// his own clock.
//
// The window is configuration, not code. `Competition.rules.scheduling` carries
// it, so a cup may run later than a league without a second implementation, and
// a competition that carries none gets the default below. Nothing in the
// frontend is trusted: `validateKickoff` is called on the server for every
// write, and the client calls the same rule only so a coach is told before he
// submits rather than after.

import { Prisma } from '@prisma/client';

/**
 * The default window. Deliberately conservative: early enough for a morning
 * fixture, late enough for a midweek evening one, and nowhere near the 05:00
 * kickoffs that made this rule necessary.
 */
export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = {
  earliestKickoff: '09:00',
  latestKickoff: '21:30',
  timeZone: null,
};

export interface SchedulingPolicy {
  /** HH:MM, venue-local, inclusive. */
  earliestKickoff: string;
  /** HH:MM, venue-local, inclusive. */
  latestKickoff: string;
  /**
   * The competition's own fallback zone, for a venue whose club records none.
   * Null means "fall back to the club's country, then UTC".
   */
  timeZone: string | null;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The policy a competition carries, or the default. Never throws: a competition
 * whose rules were written by hand and are malformed falls back to the safe
 * window rather than refusing to schedule anything at all.
 */
export function readSchedulingPolicy(rules: Prisma.JsonValue | null | undefined): SchedulingPolicy {
  const out: SchedulingPolicy = { ...DEFAULT_SCHEDULING_POLICY };
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return out;
  const s = (rules as Record<string, unknown>).scheduling;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  const raw = s as Record<string, unknown>;
  if (typeof raw.earliestKickoff === 'string' && HHMM.test(raw.earliestKickoff)) {
    out.earliestKickoff = raw.earliestKickoff;
  }
  if (typeof raw.latestKickoff === 'string' && HHMM.test(raw.latestKickoff)) {
    out.latestKickoff = raw.latestKickoff;
  }
  if (typeof raw.timeZone === 'string' && isValidTimeZone(raw.timeZone)) {
    out.timeZone = raw.timeZone;
  }
  // A window whose end is before its start is not a window. Rather than reject
  // every kickoff for the life of the competition, the malformed half is
  // dropped back to the default.
  if (minutesOf(out.latestKickoff) < minutesOf(out.earliestKickoff)) {
    out.earliestKickoff = DEFAULT_SCHEDULING_POLICY.earliestKickoff;
    out.latestKickoff = DEFAULT_SCHEDULING_POLICY.latestKickoff;
  }
  return out;
}

/** Is this a zone the runtime's own ICU data knows? Asked, never assumed. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Where the venue is, in IANA terms.
 *
 * In order: what the home club records for itself, then the competition's own
 * fallback, then the country the club is registered in, then UTC. Each step is
 * a recorded fact rather than a guess, and the last one is stated rather than
 * hidden — a caller can see that nothing better was available.
 */
export interface VenueZoneInput {
  clubTimeZone?: string | null;
  clubCountry?: string | null;
  policy?: SchedulingPolicy | null;
}

export interface VenueZone {
  timeZone: string;
  source: 'CLUB' | 'COMPETITION' | 'COUNTRY' | 'FALLBACK';
}

/**
 * Country to zone, for the countries the platform's clubs are registered in.
 *
 * Only countries with a single civil time zone are listed: a country with more
 * than one has no single right answer, and guessing one would be exactly the
 * fabrication this file exists to prevent. Those clubs fall through to UTC
 * until they record a zone of their own.
 */
const COUNTRY_ZONE: Record<string, string> = {
  germany: 'Europe/Berlin', de: 'Europe/Berlin', deu: 'Europe/Berlin',
  austria: 'Europe/Vienna', at: 'Europe/Vienna',
  switzerland: 'Europe/Zurich', ch: 'Europe/Zurich',
  netherlands: 'Europe/Amsterdam', nl: 'Europe/Amsterdam',
  belgium: 'Europe/Brussels', be: 'Europe/Brussels',
  france: 'Europe/Paris', fr: 'Europe/Paris',
  spain: 'Europe/Madrid', es: 'Europe/Madrid',
  italy: 'Europe/Rome', it: 'Europe/Rome',
  poland: 'Europe/Warsaw', pl: 'Europe/Warsaw',
  czechia: 'Europe/Prague', 'czech republic': 'Europe/Prague', cz: 'Europe/Prague',
  denmark: 'Europe/Copenhagen', dk: 'Europe/Copenhagen',
  norway: 'Europe/Oslo', no: 'Europe/Oslo',
  sweden: 'Europe/Stockholm', se: 'Europe/Stockholm',
  finland: 'Europe/Helsinki', fi: 'Europe/Helsinki',
  ireland: 'Europe/Dublin', ie: 'Europe/Dublin',
  'united kingdom': 'Europe/London', uk: 'Europe/London', gb: 'Europe/London',
  england: 'Europe/London', scotland: 'Europe/London', wales: 'Europe/London',
  portugal: 'Europe/Lisbon', pt: 'Europe/Lisbon',
  greece: 'Europe/Athens', gr: 'Europe/Athens',
  turkey: 'Europe/Istanbul', tr: 'Europe/Istanbul',
  romania: 'Europe/Bucharest', ro: 'Europe/Bucharest',
  hungary: 'Europe/Budapest', hu: 'Europe/Budapest',
  croatia: 'Europe/Zagreb', hr: 'Europe/Zagreb',
  serbia: 'Europe/Belgrade', rs: 'Europe/Belgrade',
  slovenia: 'Europe/Ljubljana', si: 'Europe/Ljubljana',
  slovakia: 'Europe/Bratislava', sk: 'Europe/Bratislava',
  bulgaria: 'Europe/Sofia', bg: 'Europe/Sofia',
  morocco: 'Africa/Casablanca', ma: 'Africa/Casablanca',
  algeria: 'Africa/Algiers', dz: 'Africa/Algiers',
  tunisia: 'Africa/Tunis', tn: 'Africa/Tunis',
  egypt: 'Africa/Cairo', eg: 'Africa/Cairo',
  nigeria: 'Africa/Lagos', ng: 'Africa/Lagos',
  ghana: 'Africa/Accra', gh: 'Africa/Accra',
  'south africa': 'Africa/Johannesburg', za: 'Africa/Johannesburg',
  japan: 'Asia/Tokyo', jp: 'Asia/Tokyo',
  'south korea': 'Asia/Seoul', kr: 'Asia/Seoul',
  singapore: 'Asia/Singapore', sg: 'Asia/Singapore',
  'united arab emirates': 'Asia/Dubai', ae: 'Asia/Dubai',
  'saudi arabia': 'Asia/Riyadh', sa: 'Asia/Riyadh',
  qatar: 'Asia/Qatar', qa: 'Asia/Qatar',
  israel: 'Asia/Jerusalem', il: 'Asia/Jerusalem',
  'new zealand': 'Pacific/Auckland', nz: 'Pacific/Auckland',
};

export function resolveVenueTimeZone(input: VenueZoneInput): VenueZone {
  const club = (input.clubTimeZone ?? '').trim();
  if (club && isValidTimeZone(club)) return { timeZone: club, source: 'CLUB' };

  const comp = (input.policy?.timeZone ?? '').trim();
  if (comp && isValidTimeZone(comp)) return { timeZone: comp, source: 'COMPETITION' };

  const country = (input.clubCountry ?? '').trim().toLowerCase();
  const byCountry = country ? COUNTRY_ZONE[country] : undefined;
  if (byCountry && isValidTimeZone(byCountry)) return { timeZone: byCountry, source: 'COUNTRY' };

  return { timeZone: 'UTC', source: 'FALLBACK' };
}

/**
 * The wall-clock time an instant reads as at the venue. Uses the runtime's own
 * zone database through Intl — no offset arithmetic of our own, so a fixture in
 * a week that crosses a daylight-saving boundary is still judged by the clock
 * on the wall that day.
 */
export function localClockAt(at: Date, timeZone: string): { hour: number; minute: number; minutes: number; date: string } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(at);
  const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  // Intl renders midnight as 24 in some ICU versions; normalise it to 0 so the
  // comparison below is arithmetic rather than a special case.
  const hour = Number(pick('hour')) % 24;
  const minute = Number(pick('minute'));
  return {
    hour,
    minute,
    minutes: hour * 60 + minute,
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
  };
}

export type KickoffVerdict =
  | 'OK'
  | 'MALFORMED'
  | 'IN_THE_PAST'
  | 'BEFORE_EARLIEST'
  | 'AFTER_LATEST'
  | 'UNCHANGED';

export interface KickoffCheck {
  ok: boolean;
  verdict: KickoffVerdict;
  /** A sentence for a person, already resolved against the policy in force. */
  message: string;
  timeZone: string;
  /** HH:MM at the venue, so the answer can be shown beside the reason. */
  localTime: string | null;
  policy: SchedulingPolicy;
}

export interface KickoffInput {
  /** An ISO instant, or a Date. Anything else is MALFORMED, never coerced. */
  at: string | Date;
  timeZone: string;
  policy: SchedulingPolicy;
  /** The instant to judge "in the past" against. Injected so it is testable. */
  now?: Date;
  /** The kickoff this would replace, when there is one. Equal means UNCHANGED. */
  current?: Date | null;
}

export function validateKickoff(input: KickoffInput): KickoffCheck {
  const policy = input.policy ?? DEFAULT_SCHEDULING_POLICY;
  const tz = isValidTimeZone(input.timeZone) ? input.timeZone : 'UTC';
  const base = { timeZone: tz, policy, localTime: null as string | null };

  const at = input.at instanceof Date ? input.at : new Date(String(input.at));
  if (Number.isNaN(at.getTime())) {
    return { ...base, ok: false, verdict: 'MALFORMED', message: 'That is not a valid date and time.' };
  }

  const clock = localClockAt(at, tz);
  const localTime = `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
  const withTime = { ...base, localTime };

  const now = input.now ?? new Date();
  if (at.getTime() <= now.getTime()) {
    return { ...withTime, ok: false, verdict: 'IN_THE_PAST', message: 'A kickoff must be in the future.' };
  }

  if (input.current && at.getTime() === input.current.getTime()) {
    return { ...withTime, ok: false, verdict: 'UNCHANGED', message: 'That is the kickoff already scheduled.' };
  }

  const earliest = minutesOf(policy.earliestKickoff);
  const latest = minutesOf(policy.latestKickoff);
  if (clock.minutes < earliest) {
    return {
      ...withTime, ok: false, verdict: 'BEFORE_EARLIEST',
      message: `Kickoff is ${localTime} at the venue. This competition does not start a match before ${policy.earliestKickoff}.`,
    };
  }
  if (clock.minutes > latest) {
    return {
      ...withTime, ok: false, verdict: 'AFTER_LATEST',
      message: `Kickoff is ${localTime} at the venue. This competition does not start a match after ${policy.latestKickoff}.`,
    };
  }

  return { ...withTime, ok: true, verdict: 'OK', message: 'Kickoff is inside the allowed window.' };
}
