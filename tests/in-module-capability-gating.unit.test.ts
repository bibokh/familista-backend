/**
 * tests/in-module-capability-gating.unit.test.ts
 *
 * A button that was always going to answer 403 is not drawn.
 *
 * The navigation already reflected the backend: a first-team head coach got
 * Transfers, the Coaches directory and the League, and not the Coach Market or
 * People & Access. Inside those modules he still met the club's controls —
 * list a player, delist him, bid at auction, renew a contract, publish the
 * club's needs, add staff, move them between teams, release them. Every one of
 * those is refused by `[requireMembership(...), requireClubWideManage()]`, so
 * every one of them was a button whose only possible outcome was a refusal.
 *
 * The gating is one list — `_CAP_CONTROLS` — mapping each control to the
 * capability that gates it, and that list IS the audit: an entry here means a
 * route that already answers 403 for that person, and a control added without
 * an entry is the mistake this arrangement exists to make visible.
 *
 * It has three effects, and the third is why the first two are enough:
 *
 *   1 · the controls are REMOVED from the document, not hidden — this
 *       application has already been bitten by `hidden` losing to an author
 *       rule, and an element that is not there cannot be revealed;
 *   2 · the three trading verbs beside a scouted player are never built at
 *       all, so the row reads "no transfer action" rather than showing a
 *       stripped-down set;
 *   3 · a click on such a control is refused in the capture phase, before any
 *       module's own handler, for anything rendered faster than the sweep.
 *
 * None of it is security. `requireClubWideManage` is what refuses, it is
 * untouched, and recruitment-authorization proves it over HTTP. This is the
 * interface finally saying the same thing.
 */

import fs from 'fs';
import path from 'path';

type Row = Record<string, any>;

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = read('public/app.js');

/** The real capability block, lifted out with its dependencies. */
const CAP_BLOCK = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function buildWorkspaceSidebar'));

/**
 * Run the real sweep over a set of controls and report what survives.
 *
 * The DOM is a stand-in, but every decision is the shipped code's: which
 * selector list is built, which elements it matches, and which are removed.
 */
function sweep(controls: string[], caps: Row | null) {
  const els = controls.map((attr) => {
    const declared = /^data-cap=(.+)$/.exec(attr);
    const name = declared ? 'data-cap' : attr;
    return {
      nodeType: 1, name: attr, removed: false,
      hasAttribute: (a: string) => a === name,
      getAttribute: (a: string) => (a === 'data-cap' && declared ? declared[1] : null),
      remove() { this.removed = true; },
      parentElement: null as unknown,
    };
  });
  const doc = {
    querySelectorAll: (sel: string) => {
      const wanted = sel.split(',').map((x) => x.replace(/[[\]]/g, '').trim());
      return els.filter((e) => wanted.some((w) => e.hasAttribute(w)
        || (w === 'data-cap' && e.getAttribute('data-cap'))));
    },
    addEventListener() {}, readyState: 'complete', body: null,
  };
  const St = { context: { effectiveAccess: caps } };
  // eslint-disable-next-line no-new-func
  const api = new Function('document', 'window', 'State', 'showToast', 'MutationObserver',
    `${CAP_BLOCK}\nreturn { _capSweep, _capRefused, _CAP_CONTROLS };`)(
    doc, { State: St }, St, () => {}, undefined);
  api._capSweep(doc);
  return {
    removed: els.filter((e) => e.removed).map((e) => e.name),
    kept: els.filter((e) => !e.removed).map((e) => e.name),
    controls: api._CAP_CONTROLS as Row,
  };
}

const COACH_CAPS = {
  canAccessTeamWorkspace: true, canAccessTransfers: true, canAdministerTransfers: false,
  canAccessStaffDirectory: true, canAdministerStaff: false,
  canAccessLeague: true, canAdministerLeague: false,
  // The Coach Market opens on the shortlist, not on club authority: he keeps
  // the club's watchlist and administers none of its recruitment.
  canAccessCoachMarket: true, canShortlist: true,
  canManagePeople: false, canManageClub: false,
  hasClubWideManageAuthority: false, isPlatformOwner: false,
};
const PRESIDENT_CAPS = {
  ...COACH_CAPS, canAdministerTransfers: true, canAdministerStaff: true,
  canAccessCoachMarket: true, canManagePeople: true, canManageClub: true,
  hasClubWideManageAuthority: true,
};
const OWNER_CAPS = { ...PRESIDENT_CAPS, isPlatformOwner: true, canAdministerLeague: true };

/** Reads a coach must keep — none of these touches a gated route. */
const READS = [
  'data-tf-compare', 'data-tf-pp', 'data-tf-disc-open', 'data-tf-tab', 'data-tf-dview',
  'data-tf-dpage', 'data-tf-sort', 'data-tf-negotiation', 'data-tf-auction-open',
  'data-tf-open-player', 'data-tf-feedview', 'data-tf-needview',
  'data-co-team', 'data-co-club', 'data-co-tabto', 'data-co-ptab', 'data-co-back',
  // The shortlist, on both markets. It is a write, and it is gated on its own
  // capability rather than on club authority: `shortlistGuard` lets a
  // team-scoped head coach keep the club's watchlist, so for him the star
  // stays where he can press it.
  'data-tf-short', 'data-st-short',
];

// ─────────────────────────────────────────────────────────────────────────────
describe('Transfers · a coach browses, and does not trade', () => {
  const TRADE = [
    'data-tf-sell-open', 'data-tf-delist', 'data-tf-delist-now', 'data-tf-sign',
    'data-tf-bid', 'data-tf-auction-bid', 'data-tf-auction-place', 'data-tf-auction-cancel',
    'data-tf-offer-clubs', 'data-tf-offer-counter', 'data-tf-offer-reject',
    'data-tf-renew-save', 'data-tf-interest', 'data-tf-interest-resp',
    'data-tf-need-close', 'data-tf-need-edit', 'data-tf-need-reopen', 'data-tf-need-offer',
    'data-tf-o2c-mode', 'data-tf-exp', 'data-tf-mode', 'data-tf-aucstep',
  ];

  it('every trading control is removed for a first-team head coach', () => {
    const out = sweep(TRADE, COACH_CAPS);
    expect(out.kept).toEqual([]);
    expect(out.removed.sort()).toEqual([...TRADE].sort());
  });

  it('and every one of them is in the list that names why', () => {
    const { controls } = sweep([], COACH_CAPS);
    for (const c of TRADE) {
      expect(`${c} declared: ${controls.canAdministerTransfers.includes(c)}`)
        .toBe(`${c} declared: true`);
    }
  });

  it('while browsing, comparing and opening a profile survive', () => {
    const out = sweep(READS, COACH_CAPS);
    expect(out.removed).toEqual([]);
  });

  it('and the three trading verbs are never built beside a scouted player', () => {
    const fn = APP.slice(APP.indexOf('var _TF_TRADE_ACTIONS'), APP.indexOf('function _tfDiscAction('));
    expect(fn).toContain("var _TF_TRADE_ACTIONS = ['PURCHASE', 'MAKE_OFFER', 'REGISTER_INTEREST'];");
    expect(fn).toContain("_TF_TRADE_ACTIONS.indexOf(a) < 0 || _access('canAdministerTransfers')");
    // The two that only look are not in that list, so they always render.
    expect(fn).not.toContain('VIEW_AUCTION');
    expect(fn).not.toContain('VIEW_LISTING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Coaches · a coach sees his colleagues, and hires nobody', () => {
  const STAFF = [
    'data-co-add', 'data-co-moveopen', 'data-co-movesave', 'data-co-release',
    'data-co-carsave', 'data-co-cardel', 'data-co-trsave',
    'data-co-notesave', 'data-co-noteadd', 'data-co-seed', 'data-co-seed-all', 'data-co-unseed',
    // The Coach Market's own controls, every one of them recruitGuard.
    'data-st-approach', 'data-st-appr-send', 'data-st-interview',
    'data-st-accept', 'data-st-reject', 'data-st-withdraw',
    'data-st-ext-open', 'data-st-ext-save',
    'data-st-needopen', 'data-st-need-add', 'data-st-need-close',
    'data-st-note-save', 'data-st-pri', 'data-st-stage',
  ];

  it('every staff-administration control is removed', () => {
    const out = sweep(STAFF, COACH_CAPS);
    expect(out.kept).toEqual([]);
  });

  it('and each is declared against the capability that gates it', () => {
    const { controls } = sweep([], COACH_CAPS);
    for (const c of STAFF) {
      expect(`${c}: ${controls.canAdministerStaff.includes(c)}`).toBe(`${c}: true`);
    }
  });

  it('while reading a team, a club and a profile survive', () => {
    expect(sweep(READS, COACH_CAPS).removed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and the same list leaves everyone else exactly as they were', () => {
  const ALL = [
    'data-tf-sell-open', 'data-tf-delist', 'data-tf-auction-bid', 'data-tf-renew-save',
    'data-tf-need-edit', 'data-st-approach', 'data-st-appr-send', 'data-st-note-save',
    'data-co-add', 'data-co-release', 'data-co-moveopen', 'data-co-seed',
    ...READS,
  ];

  it('the president keeps every control', () => {
    expect(sweep(ALL, PRESIDENT_CAPS).removed).toEqual([]);
  });

  it('a club administrator keeps every control', () => {
    // CLUB_ADMIN reaches both administer capabilities, so nothing is withheld.
    expect(sweep(ALL, { ...PRESIDENT_CAPS, isPlatformOwner: false }).removed).toEqual([]);
  });

  it('the platform owner keeps every control', () => {
    expect(sweep(ALL, OWNER_CAPS).removed).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the mechanism itself', () => {
  it('removes rather than hides', () => {
    // `hidden` lost to an author rule once already in this application; that is
    // why the sweep takes the node out instead.
    const sweepFn = APP.slice(APP.indexOf('function _capSweep'), APP.indexOf('// These modules repaint'));
    expect(sweepFn).toContain('.remove()');
    expect(sweepFn).not.toMatch(/style\.display|\.hidden\s*=|classList\.add\('hidden'\)/);
  });

  it('follows the DOM, because these modules repaint at unpredictable times', () => {
    const obs = APP.slice(APP.indexOf('// These modules repaint'), APP.indexOf('// And the backstop'));
    expect(obs).toContain('new MutationObserver');
    expect(obs).toContain("observe(document.body, { childList: true, subtree: true })");
  });

  it('and refuses a click in the capture phase, before any module handler', () => {
    const guard = APP.slice(APP.indexOf('// And the backstop'), APP.indexOf('function buildWorkspaceSidebar'));
    expect(guard).toContain('ev.preventDefault();');
    expect(guard).toContain('ev.stopPropagation();');
    // `true` — capture — so it runs ahead of the delegated handlers below it.
    expect(guard).toMatch(/\}, true\);\s*$/);
  });

  it('and an unknown capability withholds rather than grants', () => {
    // No context yet: every gated control is taken out, because "not known"
    // must never read as "allowed".
    const out = sweep(['data-tf-sell-open', 'data-co-add'], null);
    expect(out.kept).toEqual([]);
    const access = APP.slice(APP.indexOf('function _access(capability)'), APP.indexOf('function _CAP_CONTROLS') > 0
      ? APP.indexOf('function _CAP_CONTROLS') : APP.indexOf('var _CAP_CONTROLS'));
    expect(access).toContain('return !!(a && a[capability]);');
  });

  it('and honours a control that declares its own capability', () => {
    expect(sweep(['data-cap=canManagePeople'], COACH_CAPS).kept).toEqual([]);
    expect(sweep(['data-cap=canManagePeople'], PRESIDENT_CAPS).kept).toEqual(['data-cap=canManagePeople']);
  });

  it('and names no role anywhere — it asks capabilities only', () => {
    const block = APP.slice(APP.indexOf('var _CAP_CONTROLS'), APP.indexOf('function buildWorkspaceSidebar'));
    for (const role of ['HEAD_COACH', 'CLUB_OWNER', 'CLUB_ADMIN', 'SUPER_ADMIN', 'MANAGER']) {
      expect(`${role}: ${block.includes(role)}`).toBe(`${role}: false`);
    }
    expect(block).toContain('canAdministerTransfers');
    expect(block).toContain('canAdministerStaff');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('and the server is still the one refusing', () => {
  it('the guards this mirrors are untouched', () => {
    expect(read('src/routes/transfer-market.routes.ts'))
      .toContain('const tradeGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
    expect(read('src/routes/coaches.routes.ts'))
      .toContain('const staffGuard = [requireMembership(MembershipRole.CLUB_ADMIN), requireClubWideManage()];');
    expect(read('src/routes/staff-market.routes.ts'))
      .toContain('const recruitGuard = [requireMembership(MembershipRole.HEAD_COACH), requireClubWideManage()];');
  });

  it('and the club-wide test still adds no rule of its own', () => {
    const mw = read('src/middleware/team-scope.middleware.ts');
    const fn = mw.slice(mw.indexOf('export function requireClubWideManage'), mw.indexOf('* The gate for a route addressed by PLAYER'));
    expect(fn).toContain('teamAccess.assertClubWideManageAuthority(actorOfRequest(req))');
  });
});
