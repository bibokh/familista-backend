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
    expect(APP.match(/^function renderMatchCenter\(\)/gm) || []).toHaveLength(1);
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

  it('and a breadcrumb back through the League, only when opened from one', () => {
    const crumb = MC.slice(MC.indexOf('var crumb = ctx'), MC.indexOf('var crumb = ctx') + 1400);
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

  it('the League fixture row advertises the way in', () => {
    expect(APP).toContain('<span class="fl-open">Open Match Center</span>');
    expect(CSS).toContain('.fl-open{');
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

  it('each tab has a body function and switching one redraws the page', () => {
    for (const fn of ['_mcOverviewHtml', '_mcPreparationHtml', '_mcOpponentHtml', '_mcFeedHtml']) {
      expect(APP).toContain('function ' + fn + '(');
    }
    expect(codeOnly(MC)).toMatch(/act === 'mcTab'[\s\S]{0,200}renderMatchCenter\(\)/);
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
    const fn = APP.slice(APP.indexOf('function _mcCompare'), APP.indexOf('var _MC_POS_LINE'));
    expect(codeOnly(fn)).toContain("if (a == null || b == null) return '';");
    // And two nothings do not make a lead.
    expect(codeOnly(fn)).toContain('var flat = (a === 0 && b === 0);');
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
    expect(PITCH).toContain('data-action="openPlayerModal"');
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
    for (const cls of ['mcx-hero-name', 'mcx-opp-name', 'mcx-key-name', 'mcx-danger-n', 'mcx-pt-n', 'mcx-tl-p']) {
      const at = MC.indexOf('class="' + cls + '"');
      expect(at).toBeGreaterThan(-1);
      expect(MC.slice(at, at + 90)).toContain('data-user-content');
    }
    // And the two the runtime finds by selector are the ones that exist.
    expect(DOM).toContain('.mcx-hero-name');
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
