/**
 * tests/system-overview-and-locales.unit.test.ts
 *
 * The command centre, populated from what Familista already owns — and spoken
 * in the three languages its owner reads.
 *
 * Two properties are under test, and both are the same promise from different
 * sides: SYSTEM shows what it can actually count, and admits what it cannot.
 *
 *   · Every figure on the Overview comes from an aggregate over a real table,
 *     carries the definition it was counted under, and is classified LIVE,
 *     DERIVED or NOT_INSTRUMENTED. Nothing is estimated, and a thing nothing
 *     measures stays null rather than becoming a comfortable zero.
 *   · SYSTEM carries English, German and Arabic and nothing else. It is a
 *     boundary, not a subset: the SYSTEM catalogue is its own file tree, the
 *     platform's 31 locales are untouched by it, and the two passes cannot
 *     reach the same node.
 *
 * The queries are checked by counting what the service asks the database for.
 * A page that fetched rows to count them would pass a value assertion and fail
 * this one, which is the point — this dashboard has to survive thousands of
 * clubs.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, unknown>;
type Call = { model: string; op: string; args: unknown };

const calls: Call[] = [];

/** Counts by model, keyed loosely enough that the test states its intent. */
const COUNTS: Record<string, number> = {
  'club.count': 12,
  'team.count': 40,
  'user.count': 134,
  'player.count': 260,
  'membership.count': 133,
  'clubInvitation.count': 3,
  'platformAdmin.count': 1,
  'aIApprovalRequest.count': 2,
  'securityEvent.count': 5,
  'aIAgentJob.count': 7,
};

const record = (model: string, op: string) => async (args: unknown) => {
  calls.push({ model, op, args });
  return COUNTS[`${model}.${op}`] ?? 0;
};

const counter = (model: string) => ({
  count: record(model, 'count'),
  findMany: async (args: unknown) => { calls.push({ model, op: 'findMany', args }); return [] as Row[]; },
  groupBy: async (args: unknown) => { calls.push({ model, op: 'groupBy', args }); return [] as Row[]; },
});

jest.mock('../src/config/database', () => ({
  prisma: {
    club: counter('club'),
    team: counter('team'),
    user: counter('user'),
    player: counter('player'),
    membership: counter('membership'),
    clubInvitation: counter('clubInvitation'),
    platformAdmin: {
      ...counter('platformAdmin'),
      findUnique: async () => ({ isActive: true, role: 'PLATFORM_OWNER' }),
    },
    aIApprovalRequest: counter('aIApprovalRequest'),
    securityEvent: counter('securityEvent'),
    aIAgentJob: counter('aIAgentJob'),
    membershipAuditLog: counter('membershipAuditLog'),
  },
}));

import { platformOverview, platformSignals, approvalsSurface, type Metric } from '../src/platform/system.service';
import { CAPABILITIES } from '../src/platform/capabilities';
import { resetFlags, defineFlag } from '../src/platform/innovation/flags';
import { resetExperiments, registerExperiment, decideExperiment } from '../src/platform/innovation/experiments';
import { releaseKillSwitch } from '../src/platform/intelligence/agents';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SYS_JS = read('public/system/system.js');
const SYS_CSS = read('public/system/system.css');
const APP = read('public/app.js');
const SERVICE = read('src/platform/system.service.ts');

const OWNER = { userId: 'u-owner', clubId: null, role: 'SUPER_ADMIN' };

beforeEach(() => {
  calls.length = 0;
  resetFlags();
  resetExperiments();
  releaseKillSwitch();
});

// ─────────────────────────────────────────────────────────────────────────────
// Real numbers, and the definition each was counted under
// ─────────────────────────────────────────────────────────────────────────────

describe('the Overview is populated from what the platform already owns', () => {
  it('connects every metric that can be counted safely today', async () => {
    const o = await platformOverview(OWNER);

    // The figures the founder listed, each with a real value behind it.
    expect(o.clubs.total.value).toBe(12);
    expect(o.clubs.active.value).toBe(12);
    expect(o.clubs.withoutOwner.value).toBe(12);
    expect(o.people.users.value).toBe(134);
    expect(o.people.owners.value).toBe(133);
    expect(o.people.staff.value).toBe(133);
    expect(o.people.viewers.value).toBe(134);
    expect(o.people.platformAdmins.value).toBe(1);
    expect(o.players.total.value).toBe(260);
    expect(o.access.activeMemberships.value).toBe(133);
    expect(o.access.pendingInvitations.value).toBe(3);
    expect(o.access.suspendedMemberships.value).toBe(133);
    expect(o.governance.pendingApprovals.value).toBe(2);
    expect(o.security.alertsToday.value).toBe(5);
    expect(o.security.alertsThisWeek.value).toBe(5);
    expect(o.intelligence.jobsFailed.value).toBe(7);
    expect(o.intelligence.agents.value).toBeGreaterThan(0);
    expect(o.environment).toMatch(/PRODUCTION|STAGING|LAB|PREVIEW/);
  });

  it('classifies each figure, and says how it was counted', async () => {
    const o = await platformOverview(OWNER);
    const every = (group: Record<string, Metric>) => Object.entries(group);
    const groups = [o.clubs, o.teams, o.people, o.players, o.access, o.governance,
      o.security, o.intelligence, o.innovation, o.activity] as unknown as Array<Record<string, Metric>>;

    for (const group of groups) {
      for (const [key, m] of every(group)) {
        expect(`${key}:${m.source}`).toMatch(/(LIVE|DERIVED|NOT_INSTRUMENTED)$/);
        // The definition is never blank — a number without one is unusable.
        expect(`${key}:${m.how.length > 8}`).toBe(`${key}:true`);
        // NOT_INSTRUMENTED and only NOT_INSTRUMENTED is null.
        expect(`${key}:${m.value === null}`).toBe(`${key}:${m.source === 'NOT_INSTRUMENTED'}`);
      }
    }

    // The exact classifications the founder asked for by name.
    expect(o.people.users).toMatchObject({ source: 'LIVE', how: 'COUNT(User)' });
    expect(o.clubs.total).toMatchObject({ source: 'LIVE', how: 'COUNT(Club)' });
    expect(o.players.total.source).toBe('LIVE');
    expect(o.people.owners.source).toBe('DERIVED');
    expect(o.people.staff.source).toBe('DERIVED');
  });

  it('does not call sign-ins "live users", and does not invent sessions', async () => {
    const o = await platformOverview(OWNER);
    expect(o.activity.activeToday.source).toBe('DERIVED');
    expect(o.activity.activeToday.how).toMatch(/sign-ins, not live sessions/i);
    // The two that genuinely need instrumentation stay null and say so.
    expect(o.activity.sessionsToday.value).toBeNull();
    expect(o.activity.topModules.value).toBeNull();
    expect(o.activity.sessionsToday.unavailable).toMatch(/not instrumented/i);
    expect(o.activity.topModules.unavailable).toMatch(/not instrumented/i);
  });

  it('counts with aggregates — it never fetches rows to count them', async () => {
    await platformOverview(OWNER);
    const reads = calls.filter((c) => c.op !== 'count');
    expect(reads).toEqual([]);
    expect(calls.length).toBeGreaterThan(15);

    // And the aggregates that used to be a findMany + distinct are relation
    // filters now, which compile to EXISTS rather than a set difference taken
    // in JavaScript over every membership row on the platform.
    const overview = SERVICE.slice(
      SERVICE.indexOf('export async function platformOverview('),
      SERVICE.indexOf('export interface ClubRow {'),
    );
    expect(overview).not.toMatch(/findMany|distinct|groupBy/);
    expect(overview).toContain("memberships: { none: { isActive: true, role: 'CLUB_OWNER' } }");
  });

  it('answers "not instrumented" rather than zero when a table cannot be read', async () => {
    // A deployment whose client predates a table must not report a calm zero.
    expect(SERVICE).toContain('async function countOrNull');
    expect(SERVICE).toMatch(/catch \{ return null; \}/);
    expect(SERVICE).toMatch(/pendingApprovals == null[\s\S]{0,120}notInstrumented/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What's happening now — real sources, every row actionable
// ─────────────────────────────────────────────────────────────────────────────

describe("What's happening now is built from operational rows, and every row acts", () => {
  it('raises signals from invitations, ownership, security, approvals and agents', async () => {
    const signals = await platformSignals(OWNER);
    const ids = signals.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([
      'clubs.ownerless', 'invitations.pending', 'invitations.expiring', 'invitations.expired',
      'memberships.suspended', 'people.viewers', 'ai.approvals', 'security.alerts', 'ai.jobs-failed',
    ]));
    // Not one of them needs product analytics.
    expect(SERVICE).not.toMatch(/analyticsEvent|productAnalytics/);
  });

  it('gives every signal an action and a module that can perform it', async () => {
    const signals = await platformSignals(OWNER);
    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(`${s.id}:${(s.action || '').length > 2}`).toBe(`${s.id}:true`);
      expect(`${s.id}:${(s.module || '').length > 2}`).toBe(`${s.id}:true`);
    }
  });

  it('reports flags and experiments from the registry that actually runs', async () => {
    registerExperiment({ id: 'exp-1', title: 'Shot-quality model v2', hypothesis: 'Fewer false positives', successMetrics: [], ownerUserId: 'u-owner' });
    decideExperiment('exp-1', 'RUNNING');
    defineFlag({ key: 'lab.newscout', enabled: true, audience: 'OWNER_ONLY', environments: ['PRODUCTION', 'STAGING', 'LAB', 'PREVIEW'] });

    const o = await platformOverview(OWNER);
    expect(o.innovation.experimentsRunning.value).toBe(1);
    expect(o.innovation.flagsOn.value).toBe(1);

    const signals = await platformSignals(OWNER);
    expect(signals.map((s) => s.id)).toEqual(expect.arrayContaining(['experiment.exp-1', 'flag.lab.newscout']));
  });

  it('reads the approval queue without deciding anything', async () => {
    const surface = await approvalsSurface(OWNER);
    expect(Array.isArray(surface.requests)).toBe(true);
    const write = calls.find((c) => /create|update|delete/.test(c.op));
    expect(write).toBeUndefined();
    // Deciding is declared unavailable rather than given a button that lies.
    const decide = CAPABILITIES.find((c) => c.key === 'approvals.decide');
    expect(decide).toMatchObject({ status: 'NOT_AVAILABLE', risk: 'PROTECTED' });
    expect(CAPABILITIES.find((c) => c.key === 'approvals.read')).toMatchObject({ status: 'LIVE' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The command surface
// ─────────────────────────────────────────────────────────────────────────────

describe('the Overview commands as well as reports', () => {
  it('offers quick actions, and every enabled one is backed by something real', () => {
    const block = SYS_JS.slice(SYS_JS.indexOf('var QUICK_ACTIONS'), SYS_JS.indexOf('function quickActionsHtml'));
    const live = [...block.matchAll(/'LIVE', '([^']+)'/g)].map((m) => m[1]);
    expect(live.length).toBeGreaterThanOrEqual(8);
    for (const act of live) {
      if (act.startsWith('go:')) {
        // Navigation is a real action, and the module must exist.
        expect(SYS_JS).toContain(`['${act.slice(3)}',`);
      } else {
        // Anything else performs a request, and the handler must exist.
        expect(SYS_JS).toContain(`key === '${act}'`);
      }
    }
    // A disabled action carries its reason and no handler. How many are
    // disabled is not the property — it shrinks as things get built, and did:
    // Create Club and Invite President are LIVE now. What must stay true is
    // that a disabled one explains itself and is wired to nothing.
    const off = [...block.matchAll(/'NOT_AVAILABLE', null,\s*\n?\s*'([^']+)/g)].map((m) => m[1]);
    expect(off.length).toBe((block.match(/'NOT_AVAILABLE'/g) || []).length);
    for (const reason of off) expect(reason.length).toBeGreaterThan(30);
    expect(block).not.toContain("'NOT_AVAILABLE', 'go:");
  });

  it('makes the KPI cards open their operational context', () => {
    const kpis = SYS_JS.slice(SYS_JS.indexOf('var kpis = ['), SYS_JS.indexOf('].join(\'\');'));
    for (const target of ['clubs', 'people', 'approvals', 'security']) {
      expect(`${target}:${kpis.includes(`, '${target}')`)}`).toBe(`${target}:true`);
    }
    // A KPI with a destination is a button; one without stays a plain card.
    expect(SYS_JS).toContain("var tag = go ? 'button' : 'div';");
  });

  it('carries the operational widgets, and the kill switch is a real switch', () => {
    expect(SYS_JS).toContain('function widgetsHtml(o)');
    for (const widget of ['Autonomous AI Actions', 'Environment', 'Experiments running',
      'Feature flags on', 'Pending approvals', 'Security alerts · 24h']) {
      expect(`${widget}:${SYS_JS.includes(widget)}`).toBe(`${widget}:true`);
    }
    expect(SYS_JS).toMatch(/data-sy-kill="' \+ \(ks\.engaged \? 'release' : 'engage'\)/);
    expect(SYS_JS).toContain("api('/system/agents/kill-switch'");
  });

  it('draws an empty analytics panel rather than a plausible one', () => {
    expect(SYS_JS).toContain('Analytics instrumentation pending');
    expect(SYS_JS).toContain('Configure Analytics');
    // Nothing here fabricates a series. The placeholder bars are fixed CSS
    // heights on empty elements, carry no label and no value.
    expect(SYS_JS).not.toMatch(/Math\.random|sparkline|fakeSeries|sampleData/);
    expect(SYS_CSS).toContain('.sy-pending-bars i:nth-child(1) { height: 34%; }');
  });

  it('shows every role category as a counted number', () => {
    const legend = SYS_JS.slice(SYS_JS.indexOf('var roleRow = function'), SYS_JS.indexOf("+ '</div>'\n      + '<button class=\"sy-btn\" type=\"button\" data-sy-go=\"people\">"));
    expect(SYS_JS).toContain("roleRow('Platform Owners & Admins'");
    expect(SYS_JS).toContain("roleRow('Presidents'");
    expect(SYS_JS).toContain("roleRow('Staff'");
    expect(SYS_JS).toContain("roleRow('Normal Users — no membership'");
    // The percentage is arithmetic over those counts and nothing else.
    expect(legend).toContain('Math.round((value / totalRoles) * 100)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Three languages, and a boundary
// ─────────────────────────────────────────────────────────────────────────────

const LOCALE_DIR = path.join(ROOT, 'public/system/i18n');
const loadLocale = (tag: string) =>
  JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, `${tag}.json`), 'utf8')) as Record<string, string>;

describe('SYSTEM speaks three languages, and only three', () => {
  it('ships exactly English, German and Arabic', () => {
    expect(fs.readdirSync(LOCALE_DIR).sort()).toEqual(['ar.json', 'de.json', 'en.json']);
    expect(SYS_JS).toContain("var SY_LOCALES = [['en', 'English', 'ltr'], ['de', 'Deutsch', 'ltr'], ['ar', 'العربية', 'rtl']];");
  });

  it('and every one of them is complete', () => {
    const en = loadLocale('en');
    expect(Object.keys(en).length).toBeGreaterThan(150);
    for (const tag of ['de', 'ar']) {
      const dict = loadLocale(tag);
      const missing = Object.keys(en).filter((k) => !dict[k] || !dict[k].trim());
      expect(`${tag}:${missing.join(', ')}`).toBe(`${tag}:`);
      // A "translation" identical to the English is usually a gap wearing a
      // costume — but not always: a proper noun, a SQL expression and a
      // loanword are the same word in the target language, and forcing them
      // apart would make the interface worse. Those are listed, so the list
      // itself stays short and reviewable.
      const SAME_WORD = /^(COUNT\(|LIVE$|%d live$|Detail$|live$|Agent$|Status$|Familista|English$|Deutsch$|Governance$|Innovation$|Platform$)/;
      const untranslated = Object.keys(en).filter((k) => dict[k] === k && !SAME_WORD.test(k));
      expect(`${tag}:${untranslated.join(' | ')}`).toBe(`${tag}:`);
      const sameWord = Object.keys(en).filter((k) => dict[k] === k);
      expect(sameWord.length).toBeLessThan(20);
    }
  });

  it('writes Arabic right to left, and the shell follows', () => {
    const ar = loadLocale('ar');
    // Real Arabic script, not a transliteration.
    expect(ar['Total Clubs']).toMatch(/[؀-ۿ]/);
    expect(ar['Quick Actions']).toMatch(/[؀-ۿ]/);
    expect(SYS_JS).toContain("'<div class=\"sy-shell\" dir=\"' + SY_DIR + '\" lang=\"' + SY_LANG + '\">'");
    expect(SYS_CSS).toContain('.sy-shell[dir="rtl"] { direction: rtl; }');
    // Logical properties are what make the rest of the sheet work in both
    // directions; a physical `left`/`right` in a layout rule would not.
    expect(SYS_CSS).toContain('margin-inline-start');
    expect(SYS_CSS).toContain('inset-inline-end');
  });

  it('lets the platform owner switch language, and remembers the choice', () => {
    expect(SYS_JS).toContain('data-sy-lang=');
    expect(SYS_JS).toContain("localStorage.setItem('familista_system_locale'");
    expect(SYS_JS).toContain("localStorage.getItem('familista_system_locale')");
    // The switch repaints SYSTEM only.
    expect(SYS_JS).toMatch(/setSystemLocale\(lang\.getAttribute\('data-sy-lang'\)\);\s*\n\s*paint\(host\);/);
  });
});

describe('the SYSTEM locale boundary does not touch CLUBS', () => {
  it('keeps the platform catalogue at its own locales, untouched', () => {
    const registry = read('src/i18n/locales.ts');
    const tags = [...registry.matchAll(/tag: '([a-zA-Z-]+)'/g)].map((m) => m[1]);
    // Far more than three, and en-GB is still the base. This test does not
    // state how many — adding a club locale must not have to edit it.
    expect(tags.length).toBeGreaterThan(3);
    expect(tags).toContain('en-GB');
    const jsonFor = (dir: string) => fs.readdirSync(path.join(ROOT, dir))
      .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.replace('.json', '')).sort();
    expect(jsonFor('public/i18n/locales')).toEqual([...tags].sort());
    expect(jsonFor('public/i18n/catalogue')).toEqual([...tags].sort());
  });

  it('never puts a SYSTEM string into a club locale file', () => {
    const base = JSON.parse(read('public/i18n/catalogue/en-GB.json')) as Record<string, unknown>;
    const systemOnly = ['Quick Actions', 'Analytics instrumentation pending', 'Autonomous AI Actions',
      'Platform Owners & Admins', 'Configure Analytics'];
    for (const s of systemOnly) expect(`${s}:${s in base}`).toBe(`${s}:false`);
  });

  it('and the two passes cannot reach the same node', () => {
    // The platform's DOM pass REJECTS a [data-no-i18n] subtree outright, so
    // marking the SYSTEM page is the whole boundary. SYSTEM then translates
    // itself from its own catalogue.
    expect(APP).toContain('<div class="page" id="pg-system" data-no-i18n>');
    expect(read('public/i18n/dom.js')).toContain("'[data-no-i18n]'");
    expect(SYS_JS).toContain('syTranslate(host)');
    expect(SYS_JS).not.toContain('I18N.translateDom');
  });

  it('falls through to English rather than rendering a key or a blank', () => {
    expect(SYS_JS).toContain('if (!hit) return key;');
    expect(SYS_JS).toContain("if (SY_LANG === 'en') return text;");
  });
});
