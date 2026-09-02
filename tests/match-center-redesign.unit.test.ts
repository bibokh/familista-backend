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
const DOM = read('public/i18n/dom.js');

// The page, isolated: everything from the tab table to the delegated handler.
const MC = APP.slice(APP.indexOf('var _MC_TABS = ['), APP.indexOf('// ─── FC Familista AI Scouting Center'));

describe('one Match Center, not two', () => {
  it('there is a single renderer and a single page', () => {
    expect(APP.match(/^function renderMatchCenter\(host, opts\)/gm) || []).toHaveLength(1);
    expect(APP.match(/id="pg-match-center"/g) || []).toHaveLength(1);
    expect(APP.match(/id="match-center-content"/g) || []).toHaveLength(1);
  });

  it('the page it renders into is the one the navigation already allows', () => {
    expect(APP).toMatch(/_ALLOWED_PAGES[\s\S]{0,900}'match-center': 1/);
  });

  it('and the old implementation is gone rather than left beside it', () => {
    expect(APP).not.toContain('function _ensureMCStyles');
    expect(APP).not.toContain('var ourCrest');
    expect(MC).not.toContain('mc2-ss-');
  });
});

describe('the page announces itself and its place in the competition', () => {
  it('carries a Match Center title', () => {
    expect(MC).toContain('<h1 class="mcx-h1">Match Center</h1>');
  });

  it('and a breadcrumb back through the League, only when opened from one and only standalone', () => {
    const crumb = MC.slice(MC.indexOf('var crumb = (ctx'), MC.indexOf('var crumb = (ctx') + 1400);
    // Embedded in the League, the shell above has already said all of this.
    expect(MC).toContain('var crumb = (ctx && !embedded)');
    expect(crumb).toContain('Back to League');
    expect(crumb).toContain('data-page="familista-league"');
    expect(crumb).toContain('Season');
    expect(crumb).toContain('Round ');
    expect(crumb).toContain('Match Center');
    expect(crumb).toContain('data-action="mcStandings"');
    // No competition context, no breadcrumb — the standalone page is not
    // dressed up as a league match.
    expect(crumb).toMatch(/:\s*''/);
  });

  it('and the Standings shortcut goes to the League rather than somewhere new', () => {
    expect(codeOnly(MC)).toMatch(/act === 'mcStandings'[\s\S]{0,120}navTo\('familista-league'\)/);
  });

  it('the League fixture row is itself the way in, without a button repeated down the column', () => {
    // A row that opens the Match Center says so by being a row you can click:
    // a chevron that fills in on hover, dimmed to a dot when there is no match
    // to open. The old repeated "Open Match Center" button is gone.
    // It survives in exactly one place — the foot of the quick-preview panel,
    // where it is the panel's one primary action rather than a column of them.
    // Two places, both of them deliberate: the quick-preview panel's one
    // primary action, and the workspace's own top-level control.
    expect(APP.match(/Open Match Center</g) || []).toHaveLength(2);
    expect(APP).toMatch(/foot:\s*'<button class="lg-act lg-act--primary"[^']*data-action="flPreviewOpen">Open Match Center</);
    expect(APP).toMatch(/class="fl-mc-btn" data-action="flOpenMC"/);
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
    // Scoped to the host the workspace was drawn into: the League's embedded
    // instance and the standalone page can both be in the document.
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
    expect(codeOnly(APP)).toMatch(/_MC_FOCUS = [\s\S]{0,600}_MC\.tab = 'overview'/);
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
    const code = codeOnly(MC);
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

  it('a club\'s own fixture gets its own squad and the opponent gets nothing', () => {
    const fn = APP.slice(APP.indexOf('function _mcSideData'), APP.indexOf('function _mcPlayerFromState'));
    expect(codeOnly(fn)).toContain('squad: ours ? (State.players || []).map(_mcPlayerFromState) : []');
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
  });

  it('the header, the rail and the desk are the three bands of it', () => {
    expect(MC).toContain("'<header class=\"mcx-head' + (embedded ? ' mcx-head--embed' : '') + '\">'");
    expect(MC).toContain('<nav class="mcx-rail"');
    expect(MC).toContain("'<div class=\"mcx-desk\"' + deskId + '>'");
    // Only one instance in a document may own an id.
    expect(MC).toContain("var deskId = embedded ? '' : ' id=\"mcx-desk\"';");
    expect(MC).toContain("var ovId = embedded ? '' : ' id=\"mcx-overlay\"';");
    // The desk takes what is left; the other two do not grow.
    expect(CSS).toMatch(/\.mcx-desk\{[^}]*flex:1 1 auto[^}]*min-height:0/);
    expect(CSS).toMatch(/\.mcx-head\{[^}]*flex:0 0 auto/);
    expect(CSS).toMatch(/\.mcx-rail\{[^}]*flex:0 0 auto/);
  });

  it('what scrolls is a column inside the desk, never the page', () => {
    expect(CSS).toMatch(/\.mcx-col\{[^}]*min-height:0[^}]*overflow-y:auto/);
    // And a short column reaches the bottom rather than ending above a void.
    expect(CSS).toContain('.mcx-col > .mcx-panel:last-child{ flex:1 1 auto; }');
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

  it('the pitch is one panel inside the workspace, sized to it', () => {
    expect(CSS).toMatch(/\.mcp-wrap\{[^}]*flex:1 1 auto[^}]*min-height:0/);
    expect(CSS).toMatch(/\.lg-panel--fill, \.lg-panel--pitch\{[^}]*flex:1 1 auto/);
    expect(CSS).toMatch(/\.mcp-svg\{[^}]*flex:1 1 auto[^}]*height:100%/);
    // It letterboxes rather than cropping: eleven real players stay on it.
    expect(APP).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(MC).toContain('lg-panel--pitch');
  });

  it('the match header carries the fixture on one band', () => {
    const head = MC.slice(MC.indexOf('var ident = embedded'), MC.indexOf('var ident = embedded') + 2400);
    expect(head).toContain('mcx-h1');
    // Embedded the League names the page, so the identity band names the match
    // and offers the one control that follows from looking at it.
    expect(head).toContain('mcx-head-id--embed');
    expect(head).toContain('data-action="flPick"');
    expect(head).toContain('Change match');
    expect(head).toContain('mcx-fixture');
    expect(head).toContain('mcx-vs-score');
    expect(head).toContain('lg-chip lg-chip--');
    // Both sides, each drawn by the same block from its own data.
    expect(head).toContain("sideBlock(homeName, homeCrest, 'home', home)");
    expect(head).toContain("sideBlock(awayName, awayCrest, 'away', away)");
  });

  it('and the preparation dock opens the modules rather than restating them', () => {
    expect(MC).toContain('class="mcx-dock"');
    expect(CSS).toMatch(/\.mcx-dock\{[^}]*flex:0 0 auto/);
  });
});
