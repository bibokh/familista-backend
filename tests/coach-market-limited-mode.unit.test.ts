/**
 * tests/coach-market-limited-mode.unit.test.ts
 *
 * The Coach Market, opened to a coach who may watch and may not hire.
 *
 * It used to be withheld from a team-scoped head coach outright, on the
 * reasoning that browsing staff IS how an approach begins. The shortlist
 * changed that. `shortlistGuard` — `requireActingClubMembership(HEAD_COACH)` —
 * lets him keep the club's watchlist, because marking somebody sends nothing
 * out of the club, and a watchlist whose people he cannot reach is not a
 * watchlist. So the module opens, in a mode that is exactly what the server
 * will answer: browse, read a record, compare, shortlist, unshortlist, and the
 * shortlist board.
 *
 * Everything that commits the club is where it was, governed by
 * `canAdministerStaff`, which mirrors `recruitGuard`: approaching, inviting to
 * interview, sending or answering an offer, withdrawing, adding an external
 * candidate, publishing or closing a need, the club's written note on a
 * person, and a shortlist entry's priority and recruitment stage. So are the
 * three modes that are made only of those — the needs board, the live deals
 * and the recruitment timeline.
 *
 * Nothing here is authorization. Every denial is the server's, proved in
 * `recruitment-authorization`; this file proves the interface tells the same
 * story rather than drawing a button that will be refused.
 */

import fs from 'fs';
import path from 'path';
import { MembershipRole, MembershipStatus, UserRole } from '@prisma/client';

type Row = Record<string, any>;

const CLUB = 'club-mail-test';
const OTHER_CLUB = 'club-elsewhere';
const T_FIRST = 'team-first';
const T_U15 = 'team-u15';
const T_U23 = 'team-u23';

const state = {
  users: [] as Row[], memberships: [] as Row[], clubs: [] as Row[], teams: [] as Row[],
  platformAdmins: [] as Row[], audits: [] as Row[], staffProfiles: [] as Row[],
};

const match = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return (v as Row[]).some((w) => match(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('not' in v) return row[k] !== (v as Row).not;
      if ('in' in v) return ((v as Row).in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const clubOf = (id: string) => state.clubs.find((c) => c.id === id) ?? null;

const db: Row = {
  user: {
    findUnique: async ({ where }: Row) => {
      const u = state.users.find((x) => (where.id ? x.id === where.id : x.email === where.email));
      return u ? { ...u, currentClub: u.currentClubId ? clubOf(u.currentClubId) : null, currentTeam: null } : null;
    },
    update: async ({ where, data }: Row) => {
      const u = state.users.find((x) => x.id === where.id)!;
      Object.assign(u, data);
      return u;
    },
  },
  membership: {
    findMany: async ({ where = {} }: Row = {}) => state.memberships
      .filter((m) => match(m, where))
      .map((m) => ({
        ...m,
        club: clubOf(m.clubId),
        team: state.teams.find((t) => t.id === m.teamId) ?? null,
        user: state.users.find((u) => u.id === m.userId) ?? null,
      })),
    findFirst: async ({ where = {} }: Row = {}) => state.memberships.find((m) => match(m, where)) ?? null,
    count: async ({ where = {} }: Row = {}) => state.memberships.filter((m) => match(m, where)).length,
  },
  club: {
    findUnique: async ({ where }: Row) => clubOf(where.id),
    findMany: async ({ where = {} }: Row = {}) => state.clubs.filter((c) => match(c, where)),
  },
  team: {
    findUnique: async ({ where }: Row) => state.teams.find((t) => t.id === where.id) ?? null,
    findMany: async ({ where = {} }: Row = {}) => {
      const ids: string[] | null = where.id && where.id.in ? where.id.in : null;
      return state.teams
        .filter((t) =>
          (!ids || ids.includes(t.id))
          && (where.clubId === undefined || t.clubId === where.clubId)
          && (where.isActive === undefined || t.isActive === where.isActive))
        // The real select includes the club; the directory groups by it.
        .map((t) => ({ ...t, club: clubOf(t.clubId) }));
    },
  },
  player: { groupBy: async () => [] },
  staffProfile: { findMany: async () => state.staffProfiles },
  staffEngagement: { findMany: async () => [] },
  platformAdmin: {
    findUnique: async ({ where }: Row) => state.platformAdmins.find((a) => a.userId === where.userId) ?? null,
  },
  membershipAuditLog: { create: async ({ data }: Row) => { state.audits.push(data); return data; } },
  refreshToken: { deleteMany: async () => ({ count: 0 }) },
  securityEvent: { create: async () => ({}) },
  $transaction: async (fn: any) => (typeof fn === 'function' ? fn(db) : Promise.all(fn)),
};

jest.mock('../src/config/database', () => ({ prisma: db }));

import { getContext } from '../src/services/context.service';

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const COACH = 'u-coach';        // HEAD_COACH, First Team only
const ACADEMY = 'u-academy';    // YOUTH_COACH, U15 only
const MULTI = 'u-multi';        // ANALYST, First Team + U23
const PRESIDENT = 'u-president';
const OWNER = 'u-owner';
const U15_COACH = 'u-u15-coach';   // somebody else's staff, in the academy

const m = (id: string, userId: string, teamId: string | null, role: MembershipRole) => ({
  id, userId, clubId: CLUB, teamId, role, isActive: true,
  status: MembershipStatus.ACTIVE, joinedAt: new Date(), leftAt: null,
});

beforeEach(() => {
  state.clubs = [
    { id: CLUB, name: 'familista mail test', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
    { id: OTHER_CLUB, name: 'Somewhere Else', shortName: null, emblem: null, crestUrl: null, plan: 'BASIC' },
  ];
  state.teams = [
    { id: T_FIRST, clubId: CLUB, name: 'First Team', shortName: null, kind: 'SENIOR', isActive: true, ageMin: null, ageMax: null, emblem: null, color: null },
    { id: T_U15, clubId: CLUB, name: 'U15', shortName: null, kind: 'ACADEMY_U15', isActive: true, ageMin: null, ageMax: 15, emblem: null, color: null },
    { id: T_U23, clubId: CLUB, name: 'U23', shortName: null, kind: 'ACADEMY_U23', isActive: true, ageMin: null, ageMax: 23, emblem: null, color: null },
  ];
  const user = (id: string, role: UserRole) => ({
    id, email: `${id}@familista.test`, role, clubId: CLUB,
    currentClubId: CLUB, currentTeamId: null, isActive: true,
    firstName: id, lastName: 'Test', avatar: null,
  });
  state.users = [
    user(COACH, UserRole.HEAD_COACH), user(ACADEMY, UserRole.COACH), user(MULTI, UserRole.COACH),
    user(PRESIDENT, UserRole.CLUB_ADMIN), user(OWNER, UserRole.CLUB_ADMIN), user(U15_COACH, UserRole.COACH),
  ];
  state.memberships = [
    m('m-coach', COACH, T_FIRST, MembershipRole.HEAD_COACH),
    m('m-academy', ACADEMY, T_U15, MembershipRole.YOUTH_COACH),
    m('m-multi-a', MULTI, T_FIRST, MembershipRole.ANALYST),
    m('m-multi-b', MULTI, T_U23, MembershipRole.ANALYST),
    m('m-president', PRESIDENT, null, MembershipRole.CLUB_OWNER),
    m('m-u15-coach', U15_COACH, T_U15, MembershipRole.HEAD_COACH),
  ];
  state.platformAdmins = [{ userId: OWNER, isActive: true, role: 'OWNER' }];
  state.audits = [];
  state.staffProfiles = [];
});


// ─────────────────────────────────────────────────────────────────────────────
// Running the real shipped code
// ─────────────────────────────────────────────────────────────────────────────

/** The real buildWorkspaceSidebar, run against one person's real capabilities. */
function sidebarFor(effectiveAccess: Row | null): string[] {
  const config = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('(function () {\n  function _boot()'));
  const access = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function buildWorkspaceSidebar'));
  let html = '';
  const slot = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } };
  const doc = {
    getElementById: (id: string) => (id === 'workspace-nav-items' ? slot : null),
    querySelectorAll: () => [] as unknown[],
    addEventListener: () => {},
    readyState: 'complete',
    body: null,
  };
  const St = { context: { effectiveAccess } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'State', 't',
    `${access}\n${config}\nreturn buildWorkspaceSidebar;`);
  fn(doc, { State: St }, St, (k: string) => k)();
  return [...html.matchAll(/data-nav="([^"]+)"/g)].map((mm) => mm[1]);
}
const sidebarOf = async (userId: string) => sidebarFor((await getContext(userId)).effectiveAccess as Row);

/** The capability block, and the market's real mode strip, on one person. */
function marketFor(effectiveAccess: Row | null) {
  const access = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function buildWorkspaceSidebar'));
  const modes = APP.slice(APP.indexOf('var ST_MODES = ['), APP.indexOf('// ── the decision dock'));
  const St = { context: { effectiveAccess } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'State', '_TF_ST', `
    ${access}
    ${modes}
    return { nav: _stNavHtml, allowed: _stModeAllowed, view: _stView, controls: _CAP_CONTROLS };
  `);
  const doc = { querySelectorAll: () => [] as unknown[], addEventListener: () => {}, readyState: 'complete', body: null };
  return fn(doc, { State: St }, St, { view: 'market', summary: {} });
}

/** The real _capSweep, over a DOM of one button per control. */
function sweep(attrs: string[], effectiveAccess: Row | null) {
  const block = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function buildWorkspaceSidebar'));
  const els = attrs.map((a) => ({
    nodeType: 1, attr: a, removed: false,
    hasAttribute: (x: string) => x === a,
    getAttribute: () => null,
    remove() { (this as Row).removed = true; },
    parentElement: null,
  }));
  const doc = {
    querySelectorAll: (sel: string) => {
      const wanted = sel.split(',').map((x) => x.replace(/[[\]]/g, '').trim());
      return els.filter((e) => wanted.some((w) => e.hasAttribute(w)));
    },
    addEventListener: () => {}, readyState: 'complete', body: null,
  };
  const St = { context: { effectiveAccess } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', 'State', 'showToast', 'MutationObserver',
    `${block}\nreturn { _capSweep, _CAP_CONTROLS };`);
  const api = fn(doc, { State: St }, St, () => {}, undefined);
  api._capSweep(doc);
  return {
    removed: els.filter((e) => e.removed).map((e) => e.attr),
    kept: els.filter((e) => !e.removed).map((e) => e.attr),
    controls: api._CAP_CONTROLS,
  };
}

/** What the coach may press inside the market. */
const SHORTLIST_CONTROLS = ['data-st-short', 'data-tf-short'];
/** What he may read: a profile, a comparison, a filter, a page, a mode. */
const MARKET_READS = [
  'data-st-open', 'data-st-cmp', 'data-st-cmp-open', 'data-st-filters',
  'data-st-page', 'data-st-sort', 'data-st-view', 'data-st-club', 'data-st-lens',
];
/** What commits the club, and is `recruitGuard` on the server. */
const RESTRICTED_CONTROLS = [
  'data-st-approach', 'data-st-appr-send', 'data-st-interview',
  'data-st-accept', 'data-st-reject', 'data-st-withdraw',
  'data-st-ext-open', 'data-st-ext-save',
  'data-st-needopen', 'data-st-need-add', 'data-st-need-close',
  'data-st-note-save', 'data-st-pri', 'data-st-stage',
  // And the club's staff directory, which is the other door to the same work.
  'data-co-add', 'data-co-moveopen', 'data-co-movesave', 'data-co-release',
  'data-co-carsave', 'data-co-cardel', 'data-co-trsave',
  'data-co-notesave', 'data-co-noteadd',
  'data-co-seed', 'data-co-seed-all', 'data-co-unseed',
];

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · a First-Team head coach reaches the Coach Market', () => {
  it('it is in his sidebar', async () => {
    expect(await sidebarOf(COACH)).toContain('coach-market');
  });

  it('and it is the shortlist that opened it, not club authority', async () => {
    const a = (await getContext(COACH)).effectiveAccess;
    expect(a.canShortlist).toBe(true);
    expect(a.canAccessCoachMarket).toBe(true);
    // The two things it is emphatically NOT.
    expect(a.hasClubWideManageAuthority).toBe(false);
    expect(a.canAdministerStaff).toBe(false);
  });

  it('and the capability is the rank, so the tier below is still without it', async () => {
    // An academy coach carries YOUTH_COACH, which ranks with the assistants —
    // below the floor `shortlistGuard` asks for, so the server would refuse him
    // and the interface does not offer him the module.
    const y = (await getContext(ACADEMY)).effectiveAccess;
    expect(y.canShortlist).toBe(false);
    expect(y.canAccessCoachMarket).toBe(false);
    expect(await sidebarOf(ACADEMY)).not.toContain('coach-market');
    // Same for an analyst, on two teams. Breadth is not seniority.
    const an = (await getContext(MULTI)).effectiveAccess;
    expect(an.canShortlist).toBe(false);
    expect(an.canAccessCoachMarket).toBe(false);
  });

  it('and no role name decides it anywhere', () => {
    const svc = fs.readFileSync(path.join(ROOT, 'src/services/context.service.ts'), 'utf8');
    const from = svc.indexOf('const canShortlist =');
    expect(from).toBeGreaterThan(-1);
    const decl = svc.slice(from, svc.indexOf(';', from));
    // The floor arrives as MembershipRole.HEAD_COACH through the same rank
    // helper the guard reads — not as a comparison against a role name.
    expect(decl).toContain('meetsMembershipRank(currentRoles, MembershipRole.HEAD_COACH)');
    expect(decl).not.toMatch(/currentClubRole|=== *'HEAD_COACH'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · the shortlist controls are there for him', () => {
  it('the star survives the sweep on both markets', async () => {
    const a = (await getContext(COACH)).effectiveAccess as Row;
    expect(sweep(SHORTLIST_CONTROLS, a).removed).toEqual([]);
  });

  it('and it is declared against the capability that carries it', async () => {
    const { controls } = sweep([], (await getContext(COACH)).effectiveAccess as Row);
    expect(controls.canShortlist).toEqual(['data-tf-short', 'data-st-short']);
    // And it is not silently duplicated into a club-wide list, which would
    // withhold it from exactly the person this whole change is about.
    expect(controls.canAdministerStaff).not.toContain('data-st-short');
    expect(controls.canAdministerTransfers).not.toContain('data-tf-short');
  });

  it('the Shortlist mode is one he may open, with Market, Available and Free agents', async () => {
    const mk = marketFor((await getContext(COACH)).effectiveAccess as Row);
    const shown = [...String(mk.nav()).matchAll(/data-st-view="([^"]+)"/g)].map((mm) => mm[1]);
    expect(shown).toEqual(['market', 'available', 'free-agents', 'shortlisted']);
  });

  it('and reading a record, comparing and filtering are untouched', async () => {
    expect(sweep(MARKET_READS, (await getContext(COACH)).effectiveAccess as Row).removed).toEqual([]);
  });

  it('and the tier below him does not get the star either', async () => {
    const y = (await getContext(ACADEMY)).effectiveAccess as Row;
    expect(sweep(SHORTLIST_CONTROLS, y).kept).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · and nothing that commits the club is drawn', () => {
  it('every restricted control is removed', async () => {
    const out = sweep(RESTRICTED_CONTROLS, (await getContext(COACH)).effectiveAccess as Row);
    expect(out.kept).toEqual([]);
    expect(out.removed.sort()).toEqual([...RESTRICTED_CONTROLS].sort());
  });

  it('and the three modes made only of those are not offered', async () => {
    const mk = marketFor((await getContext(COACH)).effectiveAccess as Row);
    for (const mode of ['needs', 'negotiations', 'activity']) {
      expect(`${mode} offered: ${mk.allowed(mode)}`).toBe(`${mode} offered: false`);
      expect(`${mode} in strip: ${String(mk.nav()).includes(`data-st-view="${mode}"`)}`)
        .toBe(`${mode} in strip: false`);
    }
  });

  it('and a withheld mode arriving by any other route is not honoured', () => {
    // The click handler refuses it, and the board falls back rather than
    // rendering a screen whose every control has just been removed.
    const dispatch = APP.slice(APP.indexOf("var _stWanted = el.getAttribute('data-st-view')"));
    expect(dispatch.slice(0, 400)).toContain('if (!_stModeAllowed(_stWanted)) return;');
    const html = APP.slice(APP.indexOf('function _stHtml() {'), APP.indexOf('// ── the shell'));
    expect(html).toContain('var v = _stView();');
    expect(html).not.toContain('var v = _TF_ST.view;');
  });

  it('and the fallback lands on the market, which he may read', async () => {
    const mk = marketFor((await getContext(COACH)).effectiveAccess as Row);
    expect(mk.view()).toBe('market');
    expect(mk.allowed('market')).toBe(true);
    expect(mk.allowed('shortlisted')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · and the president loses none of it', () => {
  it('every mode is still hers', async () => {
    const mk = marketFor((await getContext(PRESIDENT)).effectiveAccess as Row);
    const shown = [...String(mk.nav()).matchAll(/data-st-view="([^"]+)"/g)].map((mm) => mm[1]);
    expect(shown).toEqual(['market', 'available', 'free-agents', 'shortlisted', 'needs', 'negotiations', 'activity']);
  });

  it('and every control, restricted and shortlist alike', async () => {
    const a = (await getContext(PRESIDENT)).effectiveAccess as Row;
    expect(sweep([...RESTRICTED_CONTROLS, ...SHORTLIST_CONTROLS, ...MARKET_READS], a).removed).toEqual([]);
    expect(a.canAdministerStaff).toBe(true);
    expect(a.canShortlist).toBe(true);
  });

  it('and a SUPER_ADMIN account keeps everything, as the guard short-circuits for it', async () => {
    // `requireActingClubMembership` lets SUPER_ADMIN through without a
    // membership row, exactly as `requireMembership` does, so the capability
    // has to say the same or the interface would withhold what the server
    // grants.
    state.users.push({
      id: 'u-super', email: 'super@familista.test', role: UserRole.SUPER_ADMIN, clubId: CLUB,
      currentClubId: CLUB, currentTeamId: null, isActive: true, firstName: 'S', lastName: 'A', avatar: null,
    });
    const a = (await getContext('u-super')).effectiveAccess as Row;
    expect(a.canShortlist).toBe(true);
    expect(a.canAccessCoachMarket).toBe(true);
    expect(sweep(SHORTLIST_CONTROLS, a).removed).toEqual([]);
  });

  it('and a platform administrator gets exactly what a SUPER_ADMIN account gets', async () => {
    // These two accounts are the SAME authority written down two ways —
    // `SUPER_ADMIN` on the account, and an active PlatformAdmin row — and they
    // used to behave differently here: the guards recognised the first and not
    // the second, so a platform administrator holding no membership was
    // refused a club's recruitment while a SUPER_ADMIN was not.
    //
    // That gap is not a boundary, it is the bug. Familista's real platform
    // owner has the row and not the account role, so the only way they could
    // reach a club at all was to hold a CLUB_OWNER membership of it — which is
    // exactly the contamination being unwound. The guards now recognise both,
    // and the capability mirrors the guards, as it must.
    //
    // What has NOT changed: this account holds no membership, is reported as
    // holding no club role, and nothing here gives a club role to anybody.
    const a = (await getContext(OWNER)).effectiveAccess as Row;
    expect(state.memberships.find((x) => x.userId === OWNER)).toBeUndefined();
    expect(a.isPlatformOwner).toBe(true);
    expect((await getContext(OWNER)).currentClubRole).toBeNull();
    expect(a.canShortlist).toBe(true);
    expect(sweep(SHORTLIST_CONTROLS, a).removed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 · and nothing else moved', () => {
  it('the coach\'s sidebar gains the Coach Market and nothing else', async () => {
    expect(await sidebarOf(COACH)).toEqual([
      'club-home', 'squad', 'training', 'video-intelligence',
      'transfers', 'coach-market', 'coaches', 'familista-league', 'match-center',
    ]);
    // Still not the club's own administration, and still not the platform's.
    for (const forbidden of ['academy', 'people-access', 'system', 'clubs']) {
      expect(`${forbidden}: ${(await sidebarOf(COACH)).includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });

  it('the president keeps the full navigation she had', async () => {
    expect(await sidebarOf(PRESIDENT)).toEqual([
      'club-home', 'squad', 'training', 'academy', 'video-intelligence', 'transfers',
      'coach-market', 'coaches', 'familista-league', 'match-center', 'people-access',
    ]);
  });

  it('the team scope is untouched — one team, and only one', async () => {
    const ctx = await getContext(COACH);
    expect(ctx.effectiveAccess.authorizedTeamIds).toEqual([T_FIRST]);
    expect(ctx.currentTeamScope.unrestricted).toBe(false);
  });

  it('and the server guards this mirrors are exactly as they were', () => {
    const tm = fs.readFileSync(path.join(ROOT, 'src/routes/transfer-market.routes.ts'), 'utf8');
    const sm = fs.readFileSync(path.join(ROOT, 'src/routes/staff-market.routes.ts'), 'utf8');
    expect(tm).toContain('const tradeGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
    expect(sm).toContain('const recruitGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
    // The approaches, the needs and the club's note are all still on it.
    for (const route of [
      "router.post('/approaches',", "router.post('/approaches/:approachId/accept',",
      "router.post('/needs',", "router.put('/notes/:staffUserId',", "router.post('/external',",
      "router.patch('/shortlist/:staffUserId',",
    ]) {
      const at = sm.indexOf(route);
      expect(`${route} found: ${at > -1}`).toBe(`${route} found: true`);
      expect(`${route} guarded: ${sm.slice(at, at + 160).includes('recruitGuard')}`)
        .toBe(`${route} guarded: true`);
    }
  });
});
