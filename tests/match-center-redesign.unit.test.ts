// The redesigned Match Center — the properties that make it safe to have
// replaced the old page rather than added a second one.
//
// The page is one screen with four tabs, drawn entirely from records that
// already exist: the League's own fixture and standings, the clubs' own player
// rows, and the events the Match Centre recorded. Everything here is a property
// somebody could undo without noticing — a second Match Centre, a fabricated
// number, a panel that shows zero where it should say "not recorded" — so each
// is asserted rather than left to review.

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// What the CODE does, not what the comment beside it says.
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const APP = read('public/app.js');
const CSS = read('public/app.css');
const SERVICE = read('src/competition/familista-league.service.ts');
const MCS = read('src/competition/match-center.service.ts');
const SCHED = read('src/competition/match-scheduling.ts');
const WEATHER = read('src/competition/match-weather.service.ts');
const ROUTES = read('src/routes/match-center.routes.ts');
const DOM = read('public/i18n/dom.js');

// The module, isolated: everything from the tab table to the delegated handler.
const MC = APP.slice(APP.indexOf('var _MC_TABS = ['), APP.indexOf('// ─── FC Familista AI Scouting Center'));

describe('one Match Center, not two', () => {
  it('there is a single renderer and a single page', () => {
    expect(APP.match(/^function renderMatchCenter\(\)/gm) || []).toHaveLength(1);
    expect(APP.match(/id="pg-match-center"/g) || []).toHaveLength(1);
    expect(APP.match(/id="match-center-content"/g) || []).toHaveLength(1);
    // The embedded second instance the League used to draw is gone entirely.
    expect(APP).not.toContain('function renderMatchCenter(host, opts)');
    expect(APP).not.toContain('mcx--embed');
    expect(APP).not.toContain('id="fl-mc"');
  });

  it('it is a module of the Club Workspace in its own right', () => {
    // Allow-listed, titled, mounted, and — the change this file records — an
    // item in the sidebar directly beneath Familista League rather than a tab
    // inside it.
    expect(APP).toMatch(/_ALLOWED_PAGES[\s\S]{0,900}'match-center': 1/);
    expect(APP).toContain("'match-center':'Match Center'");
    expect(APP).toContain("'match-center':                renderMatchCenterHTML");
    const nav = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function buildWorkspaceSidebar('));
    expect(nav).toContain("slug:    'match-center'");
    expect(nav).toContain("i18nKey: 'navigation.matchCenter'");
  });

  it('and the old implementation is gone rather than left beside it', () => {
    expect(APP).not.toContain('function _ensureMCStyles');
    expect(APP).not.toContain('var ourCrest');
    expect(MC).not.toContain('mc2-ss-');
  });
});

describe('the calendar is every competition, and first teams only', () => {
  it('one endpoint answers the whole calendar, and the League is one row source on it', () => {
    expect(APP).toContain("api('/match-center/calendar')");
    expect(ROUTES).toContain("router.get('/calendar', ctrl.getCalendar)");
    // Scoped to the club's FIRST TEAMS, through the rule that already exists.
    expect(MCS).toContain("import { FIRST_TEAM_KINDS } from './league-eligibility'");
    expect(MCS).toContain('kind: { in: FIRST_TEAM_KINDS as TeamKind[] }');
    // No academy side is named, included or excluded by hand — the rule decides.
    expect(MCS).not.toMatch(/ACADEMY_U\d/);
  });

  it('it reads fixtures rather than creating them', () => {
    const code = codeOnly(MCS.slice(MCS.indexOf('export async function getCalendar'),
                                    MCS.indexOf('export async function getFixtureDetail')));
    expect(code).toContain('prisma.fixture.findMany');
    expect(code).not.toMatch(/fixture\.(create|update|upsert|delete)/);
  });

  it('and it groups by month, week and day from the venue\'s own date', () => {
    const g = APP.slice(APP.indexOf('function _mccGroup('), APP.indexOf('function _mccSide('));
    for (const band of ["band: 'month'", "band: 'week'", "band: 'day'", "band: 'fixture'"]) {
      expect(g).toContain(band);
    }
    expect(g).toContain('r.localDate');
  });

  it('a fixture row says what a coach needs before opening it', () => {
    const row = APP.slice(APP.indexOf('function _mccRowHtml('), APP.indexOf('function _mccListHtml('));
    for (const piece of ['mcc-comp-ic', 'r.competition.name', 'Round', "_mccSide(home.clubId, hName, 'home'",
                         "_mccSide(away.clubId, aName, 'away'", 'r.localKickoff', 'r.venue', 'r.city',
                         '_lgStatusChip(r.status)', 'mcc-score', 'mcc-ha', 'mcc-wx']) {
      expect(row).toContain(piece);
    }
    // The crests are the ones the platform already stores, not coloured circles.
    expect(APP.slice(APP.indexOf('function _mccSide('), APP.indexOf('function _mccRowHtml(')))
      .toContain('_lgCrest(id, name, 26)');
    // And a reschedule in flight is visible without opening the match.
    expect(row).toContain('Time change requested');
  });

  it('the filters are the six asked for, and All matches is the default', () => {
    const f = APP.slice(APP.indexOf('function _mccFiltersHtml('), APP.indexOf('function _mccHeadHtml('));
    for (const piece of ['All matches', 'Upcoming', 'Completed', 'Competition', 'Venue',
                         'Earliest date', 'Latest date']) {
      expect(f).toContain(piece);
    }
    expect(APP).toMatch(/filter: \{ competitionId: '', venue: 'all', state: 'all', from: '', to: '' \}/);
  });

  it('and the competition list comes from the records rather than a hardcoded set', () => {
    const f = APP.slice(APP.indexOf('function _mccFiltersHtml('), APP.indexOf('function _mccHeadHtml('));
    expect(f).toContain('d.competitions');
    // No future competition is written into the client.
    expect(APP).not.toContain('Familista Cup');
    expect(APP).not.toContain('Second Tournament');
    // The kind is classified from the competition record's own fields.
    expect(MCS).toContain('export function classifyCompetition');
    expect(MCS).toMatch(/input\.format/);
  });
});

describe('the page announces itself and its place in the competition', () => {
  it('carries a Match Center title', () => {
    const head = APP.slice(APP.indexOf('function _mccHeadHtml('), APP.indexOf('function _mccPaintHead('));
    expect(head).toContain('<h1 class="mcc-h1">Match Center</h1>');
    // And it says whose calendar it is, which is the whole point of the module.
    expect(head).toContain('<div class="mcc-eyebrow">First Team</div>');
  });

  it('and a back action to the Club Workspace that is always there', () => {
    const head = APP.slice(APP.indexOf('function _mccHeadHtml('), APP.indexOf('function _mccPaintHead('));
    expect(head).toContain('data-action="navTo" data-page="club-home"');
    expect(head).toContain('Club Workspace');
  });

  it('and the Standings shortcut goes to the League rather than somewhere new', () => {
    expect(codeOnly(MC)).toMatch(/act === 'mcStandings'[\s\S]{0,400}navTo\('familista-league'\)/);
  });

  it('the League fixture row is itself the way in, without a button repeated down the column', () => {
    // The League hands the fixture to the Match Center; it draws no match of
    // its own and offers no second entry point.
    // A row that opens the Match Center says so by being a row you can click:
    // a chevron that fills in on hover, dimmed to a dot when there is no match
    // to open. The old repeated "Open Match Center" button is gone.
    // It survives in exactly one place — the foot of the quick-preview panel,
    // where it is the panel's one primary action rather than a column of them.
    // One place only: the quick-preview panel's single primary action. The
    // top-level entry is the Match Center tab itself — a second call to action
    // beside a tab that already does the same thing is one control too many.
    expect(APP.match(/Open Match Center</g) || []).toHaveLength(1);
    expect(APP).toMatch(/foot:\s*'<button class="lg-act lg-act--primary"[^']*data-action="flPreviewOpen">Open Match Center</);
    expect(APP).not.toContain('fl-mc-btn');
    expect(APP).not.toContain('flOpenMC');
    expect(CSS).not.toContain('.fl-mc-btn{');
    expect(APP).not.toContain('class="fl-open"');
    expect(CSS).not.toContain('.fl-open{');
    expect(APP).toContain('<span class="fl-go" aria-hidden="true">');
    expect(APP).toContain('<span class="fl-go is-off" aria-hidden="true">');
    expect(CSS).toContain('.fl-go{');
    // The row carries the action, so the whole row is the target.
    expect(APP).toMatch(/lg-row fl-match[\s\S]{0,200}data-action="flMatch"[\s\S]{0,120}tabindex="0"/);
  });
});

describe('four tabs, and each one is drawn', () => {
  it('the tab table names exactly the four the page has', () => {
    const table = MC.slice(0, MC.indexOf('];') + 2);
    for (const id of ['overview', 'preparation', 'opponent', 'feed']) {
      expect(table).toContain(`id: '${id}'`);
    }
    for (const label of ['Overview', 'Preparation', 'Opponent', 'Match Feed']) {
      expect(table).toContain(`label: '${label}'`);
    }
  });

  it('the tab id is a code identifier and the label is what a reader sees', () => {
    // Written apart so the extractor catalogues the label and leaves the id
    // alone: the difference between translating a heading and translating a key.
    const table = MC.slice(0, MC.indexOf('];') + 2);
    expect(table).not.toMatch(/\[\s*'overview'\s*,/);
  });

  it('each section has a body function, and switching one redraws only the desk', () => {
    for (const fn of ['_mcOverviewHtml', '_mcPreparationHtml', '_mcOpponentHtml', '_mcFeedHtml']) {
      expect(APP).toContain('function ' + fn + '(');
    }
    // Training-style: the header, the fixture band and the rail stay where they
    // are and only the desk's contents are replaced.
    const handler = codeOnly(MC).slice(codeOnly(MC).indexOf("act === 'mcTab'"));
    // Scoped to the workspace layer, so a section switch touches the desk and
    // nothing else on the page.
    expect(handler).toContain("document.getElementById('mcx-workspace')");
    expect(handler).toContain("deskRoot.querySelector('.mcx-desk')");
    expect(handler).toContain('desk.innerHTML =');
    expect(handler).toContain('_mcPaintComputed(desk)');
    // A full re-render is the fallback, not the path: every mention of it in
    // the handler is guarded by a missing desk or reached from the catch.
    // The fallback goes through _mcRedraw, which redraws the workspace where it
    // stands rather than assuming the standalone page.
    const before = handler.slice(0, handler.indexOf('desk.innerHTML'));
    expect(before).toMatch(/if \(!desk\)[^\n]*_mcRedraw\(\)/);
    expect((before.match(/_mcRedraw\(\)/g) || []).length).toBe(1);
    expect(handler).not.toContain('renderMatchCenter()');
    expect(APP).toContain('function _mcRedraw()');
  });

  it('and opening a fixture starts on the overview again', () => {
    const open = codeOnly(APP.slice(APP.indexOf('async function _mccOpen('),
                                    APP.indexOf('function _mccClose(')));
    expect(open).toContain("_MC.tab = 'overview'");
    expect(open).toContain('_MC.cmp = null');
    expect(open).toContain('window._MC_FOCUS = _mcFocusFromDetail(d)');
  });
});

describe('every figure comes from a record, or the panel says there is none', () => {
  it('availability is counted from each player\'s own medical status', () => {
    const fn = APP.slice(APP.indexOf('function _mcAvailability'), APP.indexOf('function _mcAverage'));
    for (const s of ['INJURED', 'SUSPENDED', 'RECOVERING', 'UNAVAILABLE']) expect(fn).toContain(s);
    expect(fn).not.toMatch(/Math\.random|\|\|\s*\d\d/);
  });

  it('an average is null when nobody carries the figure, never zero', () => {
    const fn = APP.slice(APP.indexOf('function _mcAverage'), APP.indexOf('var _MC_MORALE_SCALE'));
    expect(codeOnly(fn)).toContain('if (!vals.length) return null;');
  });

  it('a comparison row with one side missing is not drawn at all', () => {
    // The rule lives once, in the primitive the League and the Match Center
    // both draw comparisons with.
    const fn = APP.slice(APP.indexOf('function _lgVersus'), APP.indexOf('function _lgVersus') + 1600);
    expect(codeOnly(fn)).toContain("if (a == null && b == null && !o.showUnavailable) return '';");
    expect(codeOnly(fn)).toContain('var known = a != null && b != null;');
    // And two nothings do not make a lead.
    expect(codeOnly(fn)).toContain('var flat = known && a === 0 && b === 0;');
    // The Match Center's own helper is that primitive, not a second copy.
    expect(APP).toContain('function _mcCompare(label, a, b, fmt) {\n  return _lgVersus(label, a, b, { fmt: fmt });');
  });

  it('every panel has an empty state of its own', () => {
    expect(APP).toContain('function _mcEmptyPanel(');
    for (const empty of [
      'No league record for these teams yet',
      'No squad ratings recorded',
      'No squad recorded for this team',
      'No lineup available',
      'No opponent record',
      'No player ratings recorded',
      'No match events yet',
      'No match statistics recorded',
      'No events recorded',
      'No player statistics yet',
    ]) {
      expect(MC).toContain(empty);
    }
  });

  it('and nothing on the page is invented', () => {
    // Attribute names are not content: data-i18n-placeholder is how a real
    // translated placeholder is declared, and is not a fabricated figure.
    const code = codeOnly(MC).replace(/data-i18n-placeholder="[^"]*"/g, '');
    expect(code).not.toContain('Math.random');
    expect(code).not.toMatch(/\bdemo\b|\bsample\b|\bplaceholder\b|\bLorem\b/i);
  });
});

describe('the pitch draws real players', () => {
  const PITCH = APP.slice(APP.indexOf('function _mcPitchPro'), APP.indexOf('function renderMatchCenter()'));

  it('the eleven is either the recorded lineup or the strongest available, and it says which', () => {
    expect(PITCH).toContain("o.recorded ? 'Recorded lineup' : 'Likely XI by rating'");
  });

  it('the likely eleven is the club\'s own rating, not a prediction', () => {
    const fn = APP.slice(APP.indexOf('function _mcLikelyXI'), APP.indexOf('function _mcTopBy'));
    expect(codeOnly(fn)).toContain('overallRating');
    expect(codeOnly(fn)).not.toContain('Math.random');
    // Nobody unavailable is put on the pitch.
    for (const s of ['INJURED', 'SUSPENDED', 'UNAVAILABLE']) expect(fn).toContain(s);
  });

  it('each token carries a number, a name and a position from the player row', () => {
    expect(PITCH).toContain('class="mcp-name"');
    expect(PITCH).toContain('class="mcp-pos"');
    expect(PITCH).toContain('class="mcp-badge"');
    // A token opens the comparison when there is an opponent to compare with,
    // and the canonical player record when there is not.
    expect(PITCH).toContain("o.compare ? 'mcCompare' : 'openPlayerModal'");
    expect(PITCH).toContain('p.playerId');
  });

  it('an empty squad yields an empty state rather than an empty pitch', () => {
    expect(codeOnly(PITCH)).toMatch(/if \(!xi \|\| !xi\.length\)[\s\S]{0,120}_mcEmptyPanel/);
  });
});

describe('the strict Content Security Policy is respected', () => {
  it('no computed value is written as an inline style attribute', () => {
    expect(MC).not.toMatch(/style="/);
    expect(MC).not.toMatch(/\.style\.cssText/);
  });

  it('computed widths, positions and colours go through the CSSOM instead', () => {
    for (const attr of ['data-mc-width', 'data-mc-color', 'data-mc-stroke']) {
      expect(APP).toContain(attr);
    }
    expect(APP).toMatch(/function _mcPaintComputed[\s\S]{0,2400}setProperty\(/);
  });

  it('and no stylesheet is injected at runtime', () => {
    expect(MC).not.toMatch(/createElement\('style'\)/);
    expect(CSS).toContain('.mcx{');
    expect(CSS).toContain('.mcp-wrap{');
  });
});

describe('the sides are read from what the League already returned', () => {
  it('the service carries both squads, both standings rows and both coaches', () => {
    expect(SERVICE).toContain('export interface LeagueSquadPlayer');
    const detail = SERVICE.slice(SERVICE.indexOf('export interface LeagueMatchDetail'));
    const body = detail.slice(0, detail.indexOf('\n}'));
    expect(body).toMatch(/standings:/);
    expect(body).toMatch(/squads:/);
    expect(body).toMatch(/staff:/);
  });

  it('and it reads them from rows that already exist', () => {
    const sides = SERVICE.slice(SERVICE.indexOf('async function matchSides'));
    const code = codeOnly(sides.slice(0, sides.indexOf('\n}\n\n') + 4));
    expect(code).toContain('standingsEntry.findMany');
    expect(code).toContain('player.findMany');
    expect(code).toContain('membership.findMany');
    // Nothing is written while a page is being read.
    expect(code).not.toMatch(/\.create\(|\.update\(|\.upsert\(|\.delete\(/);
  });

  it('both sides are read from the same record, so neither borrows the other\'s players', () => {
    const fn = APP.slice(APP.indexOf('function _mcSideData'), APP.indexOf('function _mcAvailability'));
    expect(codeOnly(fn)).toContain("var id = which === 'home' ? focus.home : focus.away;");
    expect(codeOnly(fn)).toContain('squad: ((focus.squads || {})[which] || [])');
    // With no record, an empty side — never whatever squad happens to be loaded.
    expect(codeOnly(fn)).toContain('return { identity: null, standing: null, squad: [], coach: null, isOurs: false };');
    expect(codeOnly(fn)).not.toContain('State.players');
  });

  it('and the opponent tab shows the side that is not ours', () => {
    const fn = APP.slice(APP.indexOf('function _mcOpponentHtml'), APP.indexOf('var _MC_EVENT_LABEL'));
    expect(codeOnly(fn)).toContain('home.isOurs ? away : away.isOurs ? home');
  });
});

describe('the preparation tab opens the modules that already own the work', () => {
  it('rather than restating them', () => {
    const fn = APP.slice(APP.indexOf('function _mcPreparationHtml'), APP.indexOf('function _mcOpponentHtml'));
    expect(fn).toContain('data-page="squad"');
    expect(fn).toContain('data-page="training"');
    expect(fn).toContain('data-action="mcTactics"');
    expect(fn).toContain('data-action="mcSetPieces"');
    // No second tactical board, no second training plan.
    expect(fn).not.toContain('<canvas');
    expect(fn).not.toMatch(/drag|drop/i);
  });

  it('and the tactical shortcuts land in Squad, where the board lives', () => {
    const code = codeOnly(MC);
    expect(code).toMatch(/act === 'mcTactics'[\s\S]{0,160}navTo\('squad'\)/);
    expect(code).toMatch(/act === 'mcSetPieces'[\s\S]{0,160}navTo\('squad'\)/);
  });
});

describe('nothing user-facing is left in English only', () => {
  it('names and data are marked as data, so no catalogue can translate them', () => {
    for (const cls of ['mcx-side-name', 'mcx-opp-name', 'mcx-key-name', 'mcx-danger-n', 'mcx-pt-n', 'mcx-tl-p']) {
      const at = MC.indexOf('class="' + cls + '"');
      expect(at).toBeGreaterThan(-1);
      expect(MC.slice(at, at + 90)).toContain('data-user-content');
    }
    // And the two the runtime finds by selector are the ones that exist.
    expect(DOM).toContain('.mcx-side-name');
    expect(DOM).toContain('.mcx-opp-name');
    expect(DOM).not.toContain('.mc2-ss-name');
  });

  it('the date is formatted in the locale the reader chose', () => {
    expect(APP).toContain('function _mcLocale()');
    expect(MC).not.toMatch(/toLocaleString\(undefined/);
  });

  it('and every string the page renders is in the base catalogue', () => {
    const cat = JSON.parse(read('public/i18n/catalogue/en-GB.json')) as Record<string, string>;
    const SLOT = String.fromCharCode(0);
    for (const s of [
      'Match Center', 'Back to League', 'Team comparison', 'Squad strength', 'Key players',
      'Expected lineup', 'Squad numbers', 'Prepare', 'League record', 'Dangerous players',
      'Likely XI', 'Match feed', 'Match statistics', 'Timeline', 'Player statistics',
      'Open Match Center', 'Open Squad', 'Open Training', 'Open Tactics', 'Open Set Pieces',
      'Recorded lineup', 'Likely XI by rating', 'on the bench', 'in the table',
      `${SLOT} of ${SLOT} available`, `${SLOT} injured`, `${SLOT} suspended`,
    ]) {
      expect(cat[s]).toBeDefined();
    }
  });
});

describe('one workspace, not a document', () => {
  it('the page is a fixed-height flex column while it is the active page', () => {
    // Written against the id so it beats .page{display:none} only when active —
    // the mistake Training already made once, and the reason it is written this
    // way rather than as a bare class.
    expect(CSS).toMatch(/#pg-match-center\.active\{[^}]*height:calc\(100vh[^}]*overflow:hidden[^}]*display:flex/);
    expect(CSS).toMatch(/#pg-match-center\.active > #match-center-content\{[^}]*flex:1 1 auto[^}]*min-height:0/);
    expect(CSS).toMatch(/\.mcx\{[^}]*display:flex[^}]*flex-direction:column[^}]*flex:1 1 auto[^}]*min-height:0/);
    // And the calendar that now occupies it is the same shape.
    expect(CSS).toMatch(/\.mcc\{[^}]*display:flex[^}]*flex-direction:column[^}]*flex:1 1 auto[^}]*min-height:0/);
  });

  it('the header, the rail and the desk are the three bands of it', () => {
    const WS = APP.slice(APP.indexOf('function _mcWorkspaceHtml()'), APP.indexOf('function _mccRowFor('));
    expect(WS).toContain("'<header class=\"mcx-head\">'");
    expect(WS).toContain('<nav class="mcx-rail"');
    expect(WS).toContain("'<div class=\"mcx-desk\" id=\"mcx-desk\">'");
    // One workspace in the document, so an id is safe again — the embedded
    // second instance that made them ambiguous is gone.
    expect(APP.match(/id="mcx-desk"/g) || []).toHaveLength(1);
    expect(APP.match(/id="mcx-overlay"/g) || []).toHaveLength(1);
    // The desk takes what is left; the other two do not grow.
    expect(CSS).toMatch(/\.mcx-desk\{[^}]*flex:1 1 auto[^}]*min-height:0/);
    expect(CSS).toMatch(/\.mcx-head\{[^}]*flex:0 0 auto/);
    expect(CSS).toMatch(/\.mcx-rail\{[^}]*flex:0 0 auto/);
  });

  it('what scrolls is the desk, never the page and never a column', () => {
    // The desk is the workspace's one scroll region. A column that scrolled
    // itself swallowed its own content: whatever did not fit was simply
    // unreachable, and `overflow-x:hidden` alone was enough to make one,
    // because it computes the other axis to `auto`.
    expect(CSS).toMatch(/\.mcx--float \.mcx-desk\{[^}]*overflow-y:auto/);
    expect(CSS).toMatch(/#pg-match-center \.mcx > \.mcx-desk\{[^}]*overflow-y:auto/);
    expect(CSS).toMatch(/\.mcx-col\{[^}]*overflow:visible/);
    expect(CSS).not.toMatch(/\.mcx-col\{[^}]*overflow-y:auto/);
    expect(CSS).not.toMatch(/\.mcx-col\{[^}]*overflow-x:hidden/);
    // The header and the rail hold their place while it scrolls.
    expect(CSS).toContain('.mcx--float .mcx-head, .mcx--float .mcx-rail{ flex:0 0 auto; }');
    // And a short column reaches the bottom rather than ending above a void.
    expect(CSS).toContain('.mcx-col > .mcx-panel:last-child{ flex:1 1 auto; }');
    // The calendar behind it has a scroll region of its own, with a stable
    // gutter, so filtering cannot shift the page sideways.
    expect(CSS).toMatch(/\.mcc-body\{[^}]*overflow-y:auto[^}]*scrollbar-gutter:stable/);
  });

  it('a short or narrow viewport gets its height back rather than squeezing', () => {
    // Both competition workspaces carry the same escape hatch.
    for (const id of ['#pg-match-center', '#pg-familista-league']) {
      const at = CSS.indexOf(id + '.active{ height:auto');
      expect(at).toBeGreaterThan(-1);
      expect(CSS.slice(at, at + 120)).toMatch(/height:auto[^}]*overflow:visible/);
      // …and it is inside a media query, not the base rule.
      const q = CSS.lastIndexOf('@media', at);
      expect(CSS.slice(q, q + 60)).toMatch(/max-width:980px|max-height:620px/);
    }
  });

  it('every section lays its panels out in columns rather than stacking them', () => {
    for (const fn of ['_mcOverviewHtml', '_mcPreparationHtml', '_mcOpponentHtml', '_mcFeedHtml']) {
      const body = APP.slice(APP.indexOf('function ' + fn + '('));
      const upto = body.slice(0, body.indexOf('\nfunction '));
      expect(upto).toContain('mcx-cols');
      expect(upto).toContain('class="mcx-col"');
    }
    expect(CSS).toMatch(/\.mcx-cols--3\{[^}]*grid-template-columns:minmax/);
    expect(CSS).toMatch(/\.mcx-cols--split\{[^}]*grid-template-columns:minmax/);
  });

  it('the workspace is a fixed layer, so opening it cannot move the calendar', () => {
    expect(CSS).toMatch(/\.mcx-float-bg\{[^}]*position:fixed/);
    expect(CSS).toContain('.mcx-layer{ display:none; }');
    // It animates on opacity and transform only.
    const rise = CSS.slice(CSS.indexOf('@keyframes mcxRise'), CSS.indexOf('@keyframes mcxRise') + 160);
    expect(rise).not.toMatch(/width|height|margin|padding|top:|left:/);
    // And nothing in the calendar moves on hover either.
    const row = CSS.slice(CSS.indexOf('.mcc-row{'), CSS.indexOf('.mcc-comp{'));
    expect(row).not.toMatch(/:hover[^}]*transform/);
    expect(row).not.toContain('transition:all');
  });

  it('the pitch is one panel inside the workspace, sized to it', () => {
    expect(CSS).toMatch(/\.mcp-wrap\{[^}]*flex:1 1 auto[^}]*min-height:0/);
    expect(CSS).toMatch(/\.lg-panel--fill, \.lg-panel--pitch\{[^}]*flex:1 1 auto/);
    expect(CSS).toMatch(/\.mcp-svg\{[^}]*flex:1 1 auto[^}]*height:100%/);
    // It letterboxes rather than cropping: eleven real players stay on it.
    expect(APP).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(MC).toContain('lg-panel--pitch');
  });

  it('the match header carries the fixture on one band', () => {
    const head = APP.slice(APP.indexOf("var ident = '<div class=\"mcx-head-id\">'"),
                           APP.indexOf('function _mccRowFor('));
    expect(head).toContain('mcx-fixture');
    expect(head).toContain('mcx-vs-score');
    expect(head).toContain('lg-chip lg-chip--');
    // Both sides, each drawn by the same block from its own data.
    expect(head).toContain("sideBlock(homeName, homeCrest, 'home', home)");
    expect(head).toContain("sideBlock(awayName, awayCrest, 'away', away)");
    // The facts the brief asks the header for: competition, round, date,
    // kickoff, venue, city, weather and status.
    for (const piece of ['ctx.name', "_lgChip('Season'", "_lgChip('Round'", 'when',
                         'sched.localKickoff', 'sched.timeZone', 'row.city', 'next.venue', 'status']) {
      expect(head).toContain(piece);
    }
    // And the one control that follows from looking at a fixture that is still
    // to be played.
    expect(head).toContain('data-action="mccChangeOpen"');
    expect(head).toContain('Request time change');
  });

  it('and the preparation dock opens the modules rather than restating them', () => {
    expect(MC).toContain('class="mcx-dock"');
    expect(CSS).toMatch(/\.mcx-dock\{[^}]*flex:0 0 auto/);
  });
});
