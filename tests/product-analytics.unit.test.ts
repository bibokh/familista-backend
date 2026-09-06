/**
 * tests/product-analytics.unit.test.ts
 *
 * What is being used, and how — measured, never estimated.
 *
 * The properties under test are the ones that make an analytics layer worth
 * having rather than dangerous to have:
 *
 *   · It records metadata and refuses content. An event carrying a password, a
 *     medical note, a search term or any field nobody declared is dropped or
 *     stripped — by an allowlist, so a field nobody thought of is refused too.
 *   · Lab traffic never reaches the production figures. The environment comes
 *     from the process, never from the request, and every read defaults to
 *     PRODUCTION.
 *   · It cannot count twice. One session row per sessionId, whatever a refresh,
 *     a duplicate listener or a re-render does.
 *   · DAU/WAU/MAU are unique users, not event counts.
 *   · Reading any of it takes platform authority. Cross-club analytics is the
 *     platform owner's view by definition.
 *   · A dashboard reads aggregates. Nothing counts a million rows in
 *     JavaScript, and a test asserts that against the source.
 */

import fs from 'fs';
import path from 'path';
import { sanitize, routeShape, isAnalyticsEvent, ANALYTICS_EVENTS, ALLOWED_FIELDS } from '../src/platform/analytics/contracts';
import { analyticsRetention, retentionCutoffs, DEFAULT_RAW_RETENTION_DAYS, DEFAULT_ROLLUP_RETENTION_DAYS } from '../src/platform/analytics/retention';

type Row = Record<string, any>;

// ── a store that behaves like the real one, in memory ───────────────────────
const events: Row[] = [];
const sessions = new Map<string, Row>();
const daily = new Map<string, Row>();

const utcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const inWindow = (e: Row, w: Row) => e.environment === w.environment && e.occurredAt >= w.from && e.occurredAt < w.to;

const memoryStore = {
  writeEvents: async (list: Row[]) => {
    for (const e of list) events.push({ ...e, day: utcDay(e.occurredAt), hourOfDay: e.occurredAt.getUTCHours(), weekday: e.occurredAt.getUTCDay() });
    return list.length;
  },
  touchSession: async (e: Row) => {
    const existing = sessions.get(e.sessionId);
    if (existing) {
      existing.eventCount += 1;
      existing.lastActivityAt = e.occurredAt;
      if (e.eventName === 'session_ended') { existing.endedAt = e.occurredAt; existing.durationMs = e.durationMs ?? null; }
      return;
    }
    sessions.set(e.sessionId, {
      id: e.sessionId, environment: e.environment, userId: e.userId, platformRole: e.platformRole,
      startedAt: e.occurredAt, lastActivityAt: e.occurredAt, endedAt: null, durationMs: null, eventCount: 1,
    });
  },
  closeIdleSessions: async () => 0,
  uniqueUsers: async (w: Row) =>
    new Set(events.filter((e) => inWindow(e, w) && e.userId).map((e) => e.userId)).size,
  eventCount: async (w: Row) => events.filter((e) => inWindow(e, w)).length,
  sessionStats: async (w: Row) => {
    const rows = [...sessions.values()].filter((s) => s.environment === w.environment && s.startedAt >= w.from && s.startedAt < w.to);
    const durations = rows.map((s) => s.durationMs).filter((d) => d != null) as number[];
    return {
      sessions: rows.length,
      avgDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      users: new Set(rows.map((s) => s.userId).filter(Boolean)).size,
    };
  },
  byDimension: async (w: Row, dim: string, limit = 30) => {
    const groups = new Map<string, { events: number; users: Set<string>; duration: number }>();
    for (const e of events) {
      if (!inWindow(e, w) || e[dim] == null) continue;
      const g = groups.get(e[dim]) ?? { events: 0, users: new Set<string>(), duration: 0 };
      g.events += 1;
      if (e.userId) g.users.add(e.userId);
      g.duration += e.durationMs ?? 0;
      groups.set(e[dim], g);
    }
    return [...groups.entries()]
      .map(([dimension, g]) => ({ dimension, events: g.events, uniqueUsers: g.users.size, totalDurationMs: g.duration }))
      .sort((a, b) => b.events - a.events).slice(0, limit);
  },
  byHour: async (w: Row) => {
    const by = new Map<number, { events: number; users: Set<string> }>();
    for (const e of events) {
      if (!inWindow(e, w)) continue;
      const g = by.get(e.hourOfDay) ?? { events: 0, users: new Set<string>() };
      g.events += 1; if (e.userId) g.users.add(e.userId);
      by.set(e.hourOfDay, g);
    }
    return [...by.entries()].map(([hour, g]) => ({ hour, events: g.events, uniqueUsers: g.users.size })).sort((a, b) => a.hour - b.hour);
  },
  byWeekday: async (w: Row) => {
    const by = new Map<number, { events: number; users: Set<string> }>();
    for (const e of events) {
      if (!inWindow(e, w)) continue;
      const g = by.get(e.weekday) ?? { events: 0, users: new Set<string>() };
      g.events += 1; if (e.userId) g.users.add(e.userId);
      by.set(e.weekday, g);
    }
    return [...by.entries()].map(([weekday, g]) => ({ weekday, events: g.events, uniqueUsers: g.users.size })).sort((a, b) => a.weekday - b.weekday);
  },
  dailyUniqueUsers: async (w: Row) => {
    const by = new Map<string, Set<string>>();
    for (const e of events) {
      if (!inWindow(e, w) || !e.userId) continue;
      const key = e.day.toISOString().slice(0, 10);
      (by.get(key) ?? by.set(key, new Set()).get(key)!).add(e.userId);
    }
    return [...by.entries()].map(([day, users]) => ({ day, uniqueUsers: users.size, events: 0 })).sort((a, b) => a.day.localeCompare(b.day));
  },
  journeys: async (w: Row) => {
    const by = new Map<string, string[]>();
    for (const e of events) {
      if (!inWindow(e, w) || e.eventName !== 'module_opened' || !e.module) continue;
      (by.get(e.sessionId) ?? by.set(e.sessionId, []).get(e.sessionId)!).push(e.module);
    }
    const paths = new Map<string, number>();
    for (const mods of by.values()) {
      const p = mods.slice(0, 5).join(' → ');
      paths.set(p, (paths.get(p) ?? 0) + 1);
    }
    return [...paths.entries()].map(([p, sessionsCount]) => ({ path: p, sessions: sessionsCount })).sort((a, b) => b.sessions - a.sessions);
  },
  retentionCohort: async (environment: string, cohortDay: Date, offsets: number[]) => {
    const day = utcDay(cohortDay);
    const key = (d: Date) => d.toISOString().slice(0, 10);
    const firstSeen = new Map<string, string>();
    for (const e of [...events].sort((a, b) => +a.occurredAt - +b.occurredAt)) {
      if (e.environment !== environment || !e.userId) continue;
      if (!firstSeen.has(e.userId)) firstSeen.set(e.userId, key(e.day));
    }
    const cohort = [...firstSeen.entries()].filter(([, d]) => d === key(day)).map(([u]) => u);
    const retained: Record<number, number> = {};
    for (const o of offsets) {
      const target = key(new Date(day.getTime() + o * 86400000));
      retained[o] = new Set(events.filter((e) => e.environment === environment && key(e.day) === target && cohort.includes(e.userId)).map((e) => e.userId)).size;
    }
    return { cohortSize: cohort.length, retained };
  },
  readDaily: async () => [],
  writeDaily: async (environment: string, day: Date, rows: Row[]) => {
    for (const r of rows) daily.set(`${utcDay(day).toISOString()}|${environment}|${r.metric}|${r.dimension}`, { ...r, day: utcDay(day), environment });
    return rows.length;
  },
  purgeRawBefore: async (cutoff: Date) => {
    const before = events.length;
    for (let i = events.length - 1; i >= 0; i--) if (events[i].occurredAt < cutoff) events.splice(i, 1);
    return before - events.length;
  },
  purgeDailyBefore: async (cutoff: Date) => {
    let n = 0;
    for (const [k, v] of daily) if (v.day < utcDay(cutoff)) { daily.delete(k); n++; }
    return n;
  },
  earliestEvent: async (environment: string) => {
    const rows = events.filter((e) => e.environment === environment).sort((a, b) => +a.occurredAt - +b.occurredAt);
    return rows[0]?.occurredAt ?? null;
  },
};

jest.mock('../src/config/database', () => ({
  prisma: { platformAdmin: { findUnique: async ({ where }: Row) => (where.userId === 'u-owner' ? { isActive: true } : null) } },
}));

import { setAnalyticsStore } from '../src/platform/analytics/store';
import * as svc from '../src/platform/analytics/service';
import { rollupDay, sweepRetention } from '../src/platform/analytics/rollup';
import { analyticsSignals } from '../src/platform/analytics/signals';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const STORE_SRC = read('src/platform/analytics/store.ts');
const CLIENT = read('public/analytics.js');
const APP = read('public/app.js');

const OWNER = { userId: 'u-owner', clubId: null, role: 'SUPER_ADMIN' };
const CLUB_OWNER = { userId: 'u-club', clubId: 'club-a', role: 'CLUB_ADMIN' };

const NOW = new Date('2026-09-07T12:00:00.000Z');
const at = (isoDay: string, hour = 10) => new Date(`${isoDay}T${String(hour).padStart(2, '0')}:00:00.000Z`);

beforeEach(() => {
  events.length = 0;
  sessions.clear();
  daily.clear();
  setAnalyticsStore(memoryStore as never);
  delete process.env.ANALYTICS_RAW_RETENTION_DAYS;
  delete process.env.ANALYTICS_ROLLUP_RETENTION_DAYS;
});

/** Put an event straight in the store, bypassing track() — for arranging state. */
const seed = (e: Partial<Row>) => memoryStore.writeEvents([{
  eventName: 'module_opened', sessionId: 's1', occurredAt: NOW, environment: 'PRODUCTION',
  userId: 'u1', platformRole: 'COACH', clubId: null, teamId: null, module: 'match-center',
  feature: null, route: null, durationMs: null, deviceCategory: 'desktop', locale: 'en-GB',
  timezone: 'UTC', source: 'web', schemaVersion: 1, ...e,
}]);

// ─────────────────────────────────────────────────────────────────────────────
// Event creation, and what may not be in one
// ─────────────────────────────────────────────────────────────────────────────

describe('an event is metadata about an interaction, never its subject', () => {
  it('creates an event from a declared name and a session', async () => {
    const out = await svc.track({ userId: 'u1', platformRole: 'HEAD_COACH' }, {
      eventName: 'module_opened', sessionId: 'sess-1', module: 'academy', clubId: 'club-a',
    });
    expect(out).toEqual({ accepted: 1, rejected: 0 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventName: 'module_opened', module: 'academy', userId: 'u1', platformRole: 'HEAD_COACH' });
    // Bucketed for aggregation at write time, not at read time.
    expect(events[0].hourOfDay).toBe(events[0].occurredAt.getUTCHours());
    expect(events[0].weekday).toBe(events[0].occurredAt.getUTCDay());
  });

  it('drops an event nobody declared, rather than storing free text', async () => {
    const out = await svc.track({ userId: 'u1' }, { eventName: 'password_typed', sessionId: 's' } as never);
    expect(out).toEqual({ accepted: 0, rejected: 1 });
    expect(events).toHaveLength(0);
    expect(isAnalyticsEvent('password_typed')).toBe(false);
  });

  it('refuses an event carrying a forbidden key outright', async () => {
    for (const bad of [
      { eventName: 'feature_used', sessionId: 's', password: 'hunter2' },
      { eventName: 'feature_used', sessionId: 's', token: 'ey...' },
      { eventName: 'feature_used', sessionId: 's', refreshToken: 'x' },
      { eventName: 'feature_used', sessionId: 's', apiKey: 'k' },
    ]) {
      expect(sanitize(bad)).toBeNull();
    }
    await svc.track({ userId: 'u1' }, { eventName: 'search_used', sessionId: 's', password: 'p' } as never);
    expect(events).toHaveLength(0);
  });

  it('strips every field that is not on the allowlist', () => {
    const clean = sanitize({
      eventName: 'search_used', sessionId: 's1',
      // None of these may reach the database, and none of them are declared.
      query: 'hamstring tear', medicalNote: 'grade 2', message: 'call me',
      email: 'a@b.c', formValues: { x: 1 }, keystrokes: 'abc', userAgent: 'Mozilla/5.0 …',
    } as never);
    expect(clean).not.toBeNull();
    const json = JSON.stringify(clean);
    for (const leak of ['hamstring', 'grade 2', 'call me', 'a@b.c', 'keystrokes', 'Mozilla']) {
      expect(`${leak}:${json.includes(leak)}`).toBe(`${leak}:false`);
    }
    expect(Object.keys(clean!).every((k) => (ALLOWED_FIELDS as readonly string[]).includes(k))).toBe(true);
  });

  it('records a route SHAPE, never a populated route', () => {
    expect(routeShape('/club/3f2504e0-4f89-11d3-9a0c-0305e82c3301/academy/12')).toBe('/club/:id/academy/:n');
    expect(routeShape('/search?q=medical+report')).toBe('/search');
    expect(routeShape('/players/a-very-long-identifier-that-is-clearly-an-id')).toBe('/players/:id');
    // And the client strips it too, rather than trusting the server to.
    expect(CLIENT).toContain('function routeShape');
    expect(CLIENT).toContain("split('?')[0]");
  });

  it('keeps no user agent, only a device category', () => {
    const clean = sanitize({ eventName: 'session_started', sessionId: 's', deviceCategory: 'Mozilla/5.0 (X11)' });
    expect(clean!.deviceCategory).toBe('unknown');
    expect(sanitize({ eventName: 'session_started', sessionId: 's', deviceCategory: 'MOBILE' })!.deviceCategory).toBe('mobile');
    expect(CLIENT).not.toMatch(/navigator\.userAgent/);
  });

  it('and the declared vocabulary is coarse — no clicks, no keystrokes', () => {
    for (const name of ANALYTICS_EVENTS) {
      expect(`${name}:${/click|mouse|scroll|key|hover|input/i.test(name)}`).toBe(`${name}:false`);
    }
    expect(ANALYTICS_EVENTS).toContain('module_opened');
    expect(ANALYTICS_EVENTS).toContain('session_started');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Environment isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('Lab traffic never reaches the production figures', () => {
  it('takes the environment from the process, never from the request', () => {
    const SERVICE = read('src/platform/analytics/service.ts');
    expect(SERVICE).toContain('function analyticsEnvironment()');
    expect(SERVICE).toContain('currentEnvironment()');
    // No path from a request body or header into the stored environment.
    expect(SERVICE).not.toMatch(/req\.(body|headers|query)[\s\S]{0,80}environment/);
    // The controller mentions the word only in the comment explaining why it
    // does not read one. What must not exist is a code path from the request.
    const CTRL = read('src/controllers/telemetry.controller.ts');
    const code = CTRL.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/environment/i);
  });

  it('excludes LAB events from every production read', async () => {
    await seed({ userId: 'u-prod', environment: 'PRODUCTION', occurredAt: NOW });
    await seed({ userId: 'u-lab-1', environment: 'LAB', occurredAt: NOW, module: 'lab-thing' });
    await seed({ userId: 'u-lab-2', environment: 'LAB', occurredAt: NOW, module: 'lab-thing' });

    const active = await svc.activeUsers(OWNER, {}, NOW);
    expect(active.dau).toBe(1);                       // only the production user

    const usage = await svc.moduleUsage(OWNER, {}, NOW);
    expect(usage.modules.map((m) => m.module)).toEqual(['match-center']);
    expect(usage.modules.map((m) => m.module)).not.toContain('lab-thing');

    // And LAB is readable on its own, when it is asked for explicitly.
    const lab = await svc.moduleUsage(OWNER, { environment: 'LAB' }, NOW);
    expect(lab.modules.map((m) => m.module)).toEqual(['lab-thing']);
  });

  it('defaults every read to PRODUCTION without being asked', async () => {
    expect(svc.windowFor({}).environment).toBe('PRODUCTION');
    expect(svc.windowFor({ days: 7 }).environment).toBe('PRODUCTION');
    const activity = await svc.platformActivity(OWNER, {}, NOW);
    expect(activity.environment).toBe('PRODUCTION');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('a session cannot be counted twice', () => {
  it('creates one session row however many events arrive for it', async () => {
    for (let i = 0; i < 6; i++) {
      await svc.track({ userId: 'u1' }, { eventName: 'module_opened', sessionId: 'sess-A', module: `m${i}` });
    }
    expect(sessions.size).toBe(1);
    expect(sessions.get('sess-A')!.eventCount).toBe(6);
  });

  it('and a refresh continues the session rather than starting another', () => {
    // sessionStorage, not localStorage: one tab's visit, surviving a refresh.
    expect(CLIENT).toContain("sessionStorage.getItem(SESSION_KEY)");
    expect(CLIENT).toContain("sessionStorage.setItem(SESSION_KEY, id)");
    expect(CLIENT).not.toMatch(/localStorage\.setItem\(SESSION_KEY/);
  });

  it('ignores a repeat navigation to the module already open', () => {
    expect(CLIENT).toMatch(/if \(module === openModule\) return;/);
    // And the tracker is installed once, guarded.
    expect(CLIENT).toContain('if (window.FamilistaAnalytics) return;');
    expect(CLIENT).toMatch(/if \(started\) return;/);
  });

  it('measures module dwell time by closing the previous module', async () => {
    const t0 = new Date('2026-09-07T10:00:00.000Z');
    await svc.track({ userId: 'u1' }, [
      { eventName: 'module_opened', sessionId: 's-d', module: 'academy', occurredAt: t0.toISOString() },
      { eventName: 'module_closed', sessionId: 's-d', module: 'academy', durationMs: 46000, occurredAt: new Date(t0.getTime() + 46000).toISOString() },
    ]);
    const closed = events.find((e) => e.eventName === 'module_closed');
    expect(closed!.durationMs).toBe(46000);
    expect(CLIENT).toContain('function closeCurrent');
    expect(CLIENT).toContain("record('module_closed'");
  });

  it('clamps a duration a broken clock could produce', () => {
    expect(sanitize({ eventName: 'module_closed', sessionId: 's', durationMs: -5 })!.durationMs).toBe(0);
    expect(sanitize({ eventName: 'module_closed', sessionId: 's', durationMs: 999_999_999 })!.durationMs).toBe(86_400_000);
  });

  it('and the product hooks the tracker exactly once, in navTo', () => {
    const hooks = APP.match(/FamilistaAnalytics\.page\(/g) || [];
    expect(hooks).toHaveLength(1);
    // It can never break navigation.
    expect(APP).toMatch(/try \{\s*\n\s*if \(window\.FamilistaAnalytics\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The numbers
// ─────────────────────────────────────────────────────────────────────────────

describe('DAU, WAU and MAU count users, not events', () => {
  it('counts a user once however busy they are', async () => {
    for (let i = 0; i < 25; i++) await seed({ userId: 'u-busy', sessionId: `s${i}`, occurredAt: NOW });
    await seed({ userId: 'u-quiet', occurredAt: NOW });
    const active = await svc.activeUsers(OWNER, {}, NOW);
    expect(active.dau).toBe(2);
    expect(await memoryStore.eventCount({ environment: 'PRODUCTION', from: new Date(0), to: new Date(NOW.getTime() + 1) })).toBe(26);
  });

  it('separates today, the last 7 days and the last 30', async () => {
    await seed({ userId: 'u-today', occurredAt: at('2026-09-07') });
    await seed({ userId: 'u-3d', occurredAt: at('2026-09-04') });
    await seed({ userId: 'u-20d', occurredAt: at('2026-08-18') });
    await seed({ userId: 'u-60d', occurredAt: at('2026-07-09') });

    const a = await svc.activeUsers(OWNER, {}, NOW);
    expect(a.dau).toBe(1);
    expect(a.wau).toBe(2);
    expect(a.mau).toBe(3);
    expect(a.definitions.dau).toMatch(/distinct authenticated users/i);
  });

  it('and a signed-out visitor is not a user', async () => {
    await seed({ userId: null, occurredAt: NOW });
    expect((await svc.activeUsers(OWNER, {}, NOW)).dau).toBe(0);
  });

  it('reports "active today" with its definition attached', async () => {
    await seed({ userId: 'u1', occurredAt: NOW });
    const activity = await svc.platformActivity(OWNER, {}, NOW);
    expect(activity.activeToday).toBe(1);
    expect(activity.activeTodayDefinition).toMatch(/current UTC calendar day/);
    // It is never called "live now" — nothing here measures a live session.
    expect(activity.activeTodayDefinition.toLowerCase()).not.toContain('live now');
    expect(read('public/system/system.js')).not.toMatch(/Live Now|live now/);
  });
});

describe('retention is a cohort, or an admission that there is not enough history', () => {
  it('says "collecting" rather than inventing a percentage', async () => {
    await seed({ userId: 'u1', occurredAt: NOW });
    const r = await svc.retention(OWNER, {}, NOW);
    expect(r.day1).toBeNull();
    expect(r.day7).toBeNull();
    expect(r.day30).toBeNull();
    expect(r.collecting).toMatch(/collecting data/i);
  });

  it('and computes a real Day 1 once a day has passed', async () => {
    await seed({ userId: 'u-a', occurredAt: at('2026-09-05') });
    await seed({ userId: 'u-b', occurredAt: at('2026-09-05') });
    await seed({ userId: 'u-a', occurredAt: at('2026-09-06') });     // came back
    const r = await svc.retention(OWNER, {}, NOW);
    expect(r.cohortDay).toBe('2026-09-05');
    expect(r.cohortSize).toBe(2);
    expect(r.day1).toBe(50);
    expect(r.day30).toBeNull();
    expect(r.collecting).toMatch(/Day 30/);
  });

  it('reports nothing at all when nothing has been recorded', async () => {
    const r = await svc.retention(OWNER, {}, NOW);
    expect(r.collecting).toMatch(/no analytics events/i);
    expect(r.cohortSize).toBe(0);
  });
});

describe('module, role and club aggregation', () => {
  beforeEach(async () => {
    await seed({ userId: 'u1', module: 'match-center', clubId: 'club-a', platformRole: 'HEAD_COACH', durationMs: 60000 });
    await seed({ userId: 'u2', module: 'match-center', clubId: 'club-a', platformRole: 'HEAD_COACH', durationMs: 40000 });
    await seed({ userId: 'u1', module: 'academy', clubId: 'club-a', platformRole: 'HEAD_COACH', durationMs: 20000 });
    await seed({ userId: 'u3', module: 'transfers', clubId: 'club-b', platformRole: 'CLUB_ADMIN', durationMs: 10000 });
  });

  it('ranks modules by opens, with unique users, time and adoption', async () => {
    const usage = await svc.moduleUsage(OWNER, { days: 7 }, NOW);
    expect(usage.modules[0]).toMatchObject({ module: 'match-center', opens: 2, uniqueUsers: 2, totalDurationMs: 100000, averageDurationMs: 50000 });
    // Adoption is unique users of the module over active users overall.
    expect(usage.activeUsers).toBe(3);
    expect(usage.modules[0].adoption).toBeCloseTo(66.7, 1);
    // No previous window is no comparison — not a 100% rise.
    expect(usage.modules[0].trend).toBeNull();
  });

  it('compares roles', async () => {
    const roles = await svc.roleUsage(OWNER, { days: 7 }, NOW);
    const coach = roles.roles.find((r) => r.dimension === 'HEAD_COACH')!;
    expect(coach).toMatchObject({ events: 3, uniqueUsers: 2 });
  });

  it('counts clubs without exposing a club\'s content', async () => {
    const clubs = await svc.clubUsage(OWNER, { days: 7 }, NOW);
    expect(clubs.activeToday).toBe(2);
    expect(clubs.clubs.map((c) => c.dimension).sort()).toEqual(['club-a', 'club-b']);
    // Ids and counts only — there is no field here a club's data could be in.
    for (const c of clubs.clubs) {
      expect(Object.keys(c).sort()).toEqual(['dimension', 'events', 'totalDurationMs', 'uniqueUsers']);
    }
  });

  it('builds journeys from module keys and nothing else', async () => {
    await seed({ sessionId: 'j1', userId: 'u9', module: 'club-home', occurredAt: new Date(NOW.getTime() - 2000) });
    await seed({ sessionId: 'j1', userId: 'u9', module: 'academy', occurredAt: new Date(NOW.getTime() - 1000) });
    const out = await svc.journeys(OWNER, { days: 7 }, NOW);
    const path = out.paths.find((p) => p.path.includes('club-home'))!;
    expect(path.path).toBe('club-home → academy');
    expect(path.path).not.toMatch(/[0-9a-f]{8}-/);
  });

  it('and reports peak hours and days in a stated timezone', async () => {
    const r = await svc.usageRhythm(OWNER, { days: 7 }, NOW);
    expect(r.timezone).toBe('UTC');
    expect(r.hours.length).toBeGreaterThan(0);
    expect(r.weekdays.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorization
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-club analytics is the platform owner\'s alone', () => {
  it('refuses a club account every read, with 403', async () => {
    for (const call of [
      () => svc.activeUsers(CLUB_OWNER, {}, NOW),
      () => svc.moduleUsage(CLUB_OWNER, {}, NOW),
      () => svc.usageRhythm(CLUB_OWNER, {}, NOW),
      () => svc.roleUsage(CLUB_OWNER, {}, NOW),
      () => svc.clubUsage(CLUB_OWNER, {}, NOW),
      () => svc.journeys(CLUB_OWNER, {}, NOW),
      () => svc.retention(CLUB_OWNER, {}, NOW),
      () => svc.platformActivity(CLUB_OWNER, {}, NOW),
    ]) {
      await expect(call()).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it('but lets any authenticated account record its own usage', async () => {
    // Writing is not reading. A coach records that they opened a module; only
    // the platform owner can ever see the aggregate.
    const out = await svc.track({ userId: 'u-club', platformRole: 'HEAD_COACH' }, { eventName: 'module_opened', sessionId: 's', module: 'academy' });
    expect(out.accepted).toBe(1);
    const routes = read('src/routes/telemetry.routes.ts');
    expect(routes).toContain('authenticate');
    expect(routes).not.toMatch(/get\(/);           // ingestion only, no reads
  });

  it('and every analytics read on the SYSTEM router is platform-gated', () => {
    const SERVICE = read('src/platform/analytics/service.ts');
    const reads = [...SERVICE.matchAll(/export async function (\w+)\(actor: PlatformActor/g)].map((m) => m[1]);
    expect(reads.length).toBeGreaterThanOrEqual(7);
    for (const fn of reads) {
      const body = SERVICE.slice(SERVICE.indexOf(`export async function ${fn}(actor: PlatformActor`));
      expect(`${fn}:${body.slice(0, 400).includes('assertPlatformOwner')}`).toBe(`${fn}:true`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregates, retention, signals
// ─────────────────────────────────────────────────────────────────────────────

describe('the dashboard reads aggregates, never a million rows', () => {
  it('the store answers every question with an aggregate', () => {
    // No findMany over the event table anywhere: counting rows in JavaScript is
    // exactly the failure this design exists to avoid.
    expect(STORE_SRC).not.toMatch(/analyticsEvent\.findMany/);
    expect(STORE_SRC).toMatch(/COUNT\(DISTINCT "userId"\)/);
    expect(STORE_SRC).toMatch(/GROUP BY/);
    // findFirst for the earliest event is a single indexed row, not a scan.
    expect(STORE_SRC).toMatch(/analyticsEvent\.findFirst[\s\S]{0,160}orderBy/);
  });

  it('and the column a GROUP BY uses is chosen from a fixed set, never interpolated', () => {
    expect(STORE_SRC).toContain("dimension: 'module' | 'feature' | 'clubId' | 'platformRole' | 'eventName'");
    expect(STORE_SRC).toMatch(/never interpolated from a\n\s*\/\/ request/);
  });

  it('rolls a finished day up idempotently', async () => {
    await seed({ userId: 'u1', module: 'academy', occurredAt: at('2026-09-06') });
    await seed({ userId: 'u2', module: 'academy', occurredAt: at('2026-09-06') });

    const first = await rollupDay('PRODUCTION', at('2026-09-06'));
    const size = daily.size;
    const second = await rollupDay('PRODUCTION', at('2026-09-06'));
    expect(second.rowsWritten).toBe(first.rowsWritten);
    expect(daily.size).toBe(size);                    // upserted, never doubled

    const dau = daily.get(`${utcDay(at('2026-09-06')).toISOString()}|PRODUCTION|dau|`);
    expect(dau).toMatchObject({ value: 2, uniqueUsers: 2 });
    const opens = daily.get(`${utcDay(at('2026-09-06')).toISOString()}|PRODUCTION|module.opens|academy`);
    expect(opens).toMatchObject({ value: 2 });
  });

  it('keeps retention configurable, and never "forever"', async () => {
    const d = analyticsRetention({});
    expect(d).toMatchObject({ rawDays: DEFAULT_RAW_RETENTION_DAYS, rollupDays: DEFAULT_ROLLUP_RETENTION_DAYS });
    expect(d.source).toEqual({ raw: 'default', rollup: 'default' });

    const custom = analyticsRetention({ ANALYTICS_RAW_RETENTION_DAYS: '30', ANALYTICS_ROLLUP_RETENTION_DAYS: '365' } as never);
    expect(custom).toMatchObject({ rawDays: 30, rollupDays: 365 });
    expect(custom.source).toEqual({ raw: 'env', rollup: 'env' });

    // Rollups always outlive raw events — deleting the summary of data still
    // held in detail is not a policy anybody means.
    const cut = retentionCutoffs(NOW, { ANALYTICS_RAW_RETENTION_DAYS: '400', ANALYTICS_ROLLUP_RETENTION_DAYS: '30' } as never);
    expect(cut.rollup.getTime()).toBeLessThanOrEqual(cut.raw.getTime());
  });

  it('expires raw events and keeps the rollups', async () => {
    await seed({ userId: 'u-old', occurredAt: new Date('2026-01-01T10:00:00Z') });
    await seed({ userId: 'u-new', occurredAt: NOW });
    await memoryStore.writeDaily('PRODUCTION', new Date('2026-01-01T00:00:00Z'), [{ metric: 'dau', dimension: '', value: 1, uniqueUsers: 1 }]);

    const swept = await sweepRetention(NOW, { ANALYTICS_RAW_RETENTION_DAYS: '90' } as never);
    expect(swept.rawDeleted).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].userId).toBe('u-new');
    expect(daily.size).toBe(1);                       // the summary survives
  });

  it('raises deterministic signals, and says what it compared', async () => {
    // 30 opens last week, 5 this week: a real drop past the threshold.
    for (let i = 0; i < 30; i++) await seed({ userId: `u${i}`, module: 'transfers', occurredAt: at('2026-08-30') });
    for (let i = 0; i < 5; i++) await seed({ userId: `u${i}`, module: 'transfers', occurredAt: at('2026-09-05') });

    const signals = await analyticsSignals('PRODUCTION', NOW);
    const drop = signals.find((s) => s.id === 'analytics.module-drop.transfers');
    expect(drop).toBeDefined();
    expect(drop!.detail).toMatch(/30 opens[\s\S]*5 in the last 7/);
    expect(drop!.action).toBeTruthy();
    // Deterministic, and it says so: no prediction, no model.
    expect(drop!.detail).toMatch(/nothing is predicted/i);
    expect(read('src/platform/analytics/signals.ts')).not.toMatch(/\bml\b|machine learning model|predict\(/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The boundary with audit, and with CLUBS
// ─────────────────────────────────────────────────────────────────────────────

describe('analytics and audit stay separate, and CLUBS is untouched', () => {
  it('writes no product usage into any audit table', () => {
    const SERVICE = read('src/platform/analytics/service.ts');
    const ROLLUP = read('src/platform/analytics/rollup.ts');
    for (const src of [STORE_SRC, SERVICE, ROLLUP]) {
      for (const audit of ['membershipAuditLog', 'platformAuditLog', 'securityEvent', 'SecurityAuditEvent']) {
        expect(`${audit}:${src.includes(audit)}`).toBe(`${audit}:false`);
      }
    }
  });

  it('and the audit trail records no product usage', () => {
    const contracts = read('src/platform/events/contracts.ts');
    // The two streams are still declared separately, per event.
    expect(contracts).toContain('EVENT_STREAM');
    expect(contracts).toContain("'AUDIT' | 'ANALYTICS' | 'BOTH'");
  });

  it('changes club behaviour by exactly one hook', () => {
    // The whole club-side integration: start(), page(), inside one try/catch.
    const calls = APP.match(/FamilistaAnalytics\.\w+\(/g) || [];
    expect(calls.sort()).toEqual(['FamilistaAnalytics.page(', 'FamilistaAnalytics.start(']);
    // No page renders its own tracking.
    expect(APP).not.toMatch(/fetch\([^)]*telemetry/);
    expect(read('public/index.html')).toContain('/analytics.js');
  });

  it('never blocks the product, and never retries into a loop', () => {
    expect(CLIENT).toContain('keepalive');
    expect(CLIENT).toMatch(/catch \(_\) \{ \/\* nothing in the product waits on this \*\/ \}/);
    const SERVICE = read('src/platform/analytics/service.ts');
    // A failed write is logged and swallowed — the product carries on.
    expect(SERVICE).toMatch(/catch \(err\)[\s\S]{0,200}logger\.warn\('analytics write failed'/);
  });

  it('mounts ingestion away from a club\'s own football analytics', () => {
    const index = read('src/routes/index.ts');
    expect(index).toContain("router.use('/telemetry'");
    expect(index).toContain("router.use('/analytics',   analyticsRoutes);");
  });
});
