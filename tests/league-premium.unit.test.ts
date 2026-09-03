// The premium pass — the properties that make the four competition screens one
// product rather than four, keep a panel from shaking the page under it, and
// keep the player comparison honest.
//
// Each is something somebody could undo without noticing: a screen that goes
// back to drawing its own panel, a repaint that rebuilds the page to open a
// dialog, a comparison that quietly swaps the position it was asked about, or
// a zero standing in for a figure nobody recorded.

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

const APP = read('public/app.js');
const CSS = read('public/app.css');
const SERVICE = read('src/competition/familista-league.service.ts');

// The League module, and the comparison, isolated.
const FL = APP.slice(APP.indexOf('//  FAMILISTA COMPETITION UI'));
// The League's delegated click handler, isolated.
const FL_ACTIONS = APP.slice(APP.indexOf("if (act === 'flTab') {"), APP.indexOf("if (act === 'flTab') {") + 4000);
const CMP = APP.slice(APP.indexOf('//  PLAYER AGAINST PLAYER'), APP.indexOf('function _mcPaintCmp'));

describe('one visual system, not four', () => {
  it('the shared primitives exist once', () => {
    for (const fn of ['_lgCrest', '_lgIdent', '_lgChip', '_lgStatusChip', '_lgForm',
                      '_lgMetric', '_lgPanel', '_lgEmpty', '_lgFloat', '_lgVersus']) {
      expect(APP.match(new RegExp('^function ' + fn + '\\(', 'gm')) || []).toHaveLength(1);
    }
  });

  it('and the Match Center draws them rather than its own copies', () => {
    expect(APP).toContain('function _mcFormPills(form) { return _lgForm(form); }');
    expect(APP).toContain('function _mcStat(label, value, sub) { return _lgMetric(label, value, sub); }');
    expect(APP).toContain('function _mcEmptyPanel(title, sub) { return _lgEmpty(title, sub); }');
    expect(APP).toContain('function _mcPanel(title, sub, inner, cls) { return _lgPanel(title, sub, inner, cls); }');
    // The stylesheet no longer carries the superseded duplicates.
    for (const dead of ['.mcx-panel{', '.mcx-stat{', '.mcx-chip{', '.mcx-empty{', '.mcx-form-pill{', '.mcx-cmp-row{']) {
      expect(CSS).not.toContain(dead);
    }
  });

  it('Standings, Matches and Player Stats all sit in the shared panel and row', () => {
    for (const fn of ['_flStandingsHtml', '_flMatchesHtml', '_flBoardHtml']) {
      const at = APP.indexOf('function ' + fn + '(');
      expect(at).toBeGreaterThan(-1);
      const body = APP.slice(at, APP.indexOf('\nfunction ', at + 10));
      expect(body).toContain('_lgPanel(');
    }
    expect(APP).toContain("'<tr class=\"lg-row fl-row'");
    expect(APP).toContain("'<div class=\"lg-row fl-match fl-match--'");
    expect(APP).toContain("'<li class=\"lg-row fl-board-row'");
  });

  it('and both workspaces are built the same way', () => {
    for (const id of ['#pg-match-center', '#pg-familista-league']) {
      expect(CSS).toMatch(new RegExp(id + '\\.active\\{[^}]*height:calc\\(100vh[^}]*overflow:hidden'));
    }
  });
});

describe('a panel never shakes the page under it', () => {
  it('each region is painted on its own', () => {
    for (const fn of ['_flPaintHead', '_flPaintBody', '_flPaintOverlay']) {
      expect(APP).toContain('function ' + fn + '(');
    }
    // The header is refreshed in place. Replacing the node itself rebuilt the
    // tab strip on every paint, which is a layout pass nobody asked for.
    const head = APP.slice(APP.indexOf('function _flPaintHead('), APP.indexOf('function _flPaintBody('));
    expect(head).toContain('head.innerHTML = _flHeaderHtml();');
    expect(codeOnly(head)).not.toContain('outerHTML');
  });

  it('opening or closing a floating panel repaints the overlay and nothing else', () => {
    const handler = codeOnly(FL_ACTIONS);
    for (const act of ['flRules', 'flCloseRules', 'flCloseTeam', 'flClosePreview']) {
      const at = handler.indexOf("act === '" + act + "'");
      expect(`${act}@${at > -1}`).toBe(`${act}@true`);
      const branch = handler.slice(at, at + 220);
      expect(branch).toContain('_flPaintOverlay()');
      expect(branch).not.toContain('_flPaintBody()');
      expect(branch).not.toContain('_flRepaint()');
    }
    // Loading one is the same: the table underneath is never touched.
    const open = APP.slice(APP.indexOf('async function _flOpenTeam('), APP.indexOf('// ── the fixture'));
    expect(codeOnly(open)).not.toContain('_flPaintBody');
    expect(codeOnly(open)).not.toContain('_flRepaint');
  });

  it('the floating panel is fixed, and animates on transform and opacity only', () => {
    expect(CSS).toMatch(/\.lg-float-bg\{[^}]*position:fixed/);
    const from = CSS.indexOf('@keyframes lgRise');
    const rise = CSS.slice(from, CSS.indexOf('\n', from));
    expect(rise).toMatch(/opacity/);
    expect(rise).toMatch(/transform:translate3d/);
    // Nothing in the animation can move the page: no width, height or margin.
    expect(rise).not.toMatch(/width|height|margin|padding|top:|left:/);
  });

  it('the body reserves its scrollbar, so content of a different height cannot move a column', () => {
    expect(CSS).toMatch(/\.fl-body\{[^}]*scrollbar-gutter:stable/);
    // …and the skeleton is the size of the rows it stands in for.
    expect(CSS).toMatch(/\.fl-sk-row\{[^}]*height:\d+px/);
  });
});

describe('the League hands a fixture over rather than opening a match itself', () => {
  it('one Fixture row, read by the module that owns match preparation', () => {
    const open = codeOnly(APP.slice(APP.indexOf('function _flOpenMatch('),
                                    APP.indexOf('function _flOpenMatch(') + 900));
    // The League navigates to the Match Center and hands it the fixture id. It
    // does not fetch the match, does not hold it, and does not draw it.
    expect(open).toContain("navTo('match-center')");
    expect(open).toContain('_mccOpen(fixtureId, back)');
    expect(open).not.toContain("api('/familista-league/fixtures/");
    // The section and the round travel with it, so closing the workspace
    // returns the reader to the League state that launched it.
    expect(open).toContain("page: 'familista-league'");
    expect(open).toContain('round: _FL.round');
    // And the League keeps no match of its own any more.
    expect(APP).not.toMatch(/var _FL = \{[\s\S]{0,900}match: null,/);
    expect(APP).not.toContain('function _flHandOver');
  });
});

describe('player against player', () => {
  it('uses the repository\'s own position taxonomy and nothing else', () => {
    const map = APP.slice(APP.indexOf('var _MC_POS_NEAR = {'), APP.indexOf('function _mcPosKey'));
    const schema = read('prisma/schema.prisma');
    const enumBlock = schema.slice(schema.indexOf('enum PlayerPosition {'), schema.indexOf('enum Foot {'));
    const positions = (enumBlock.match(/^\s{2}([A-Z]+)$/gm) || []).map((s) => s.trim());
    expect(positions.length).toBeGreaterThan(8);
    // Every key is a real position, and every fallback names real positions.
    const keys = (map.match(/^\s{2}([A-Z]+):/gm) || []).map((s) => s.trim().replace(':', ''));
    expect(keys.sort()).toEqual(positions.slice().sort());
    for (const cited of map.match(/'([A-Z]+)'/g) || []) {
      expect(positions).toContain(cited.replace(/'/g, ''));
    }
  });

  it('prefers the exact position, and says so when it could not', () => {
    const fn = codeOnly(APP.slice(APP.indexOf('function _mcOpposite('), APP.indexOf('function _mcAge(')));
    // The exact position is first in every list, so index 0 is the exact match.
    expect(fn).toContain('return { player: here[0], exact: i === 0 };');
    expect(CMP).toContain('Closest positional match');
    // …and the label is shown exactly when the match was not exact.
    expect(CMP).toContain("exact ? '' : 'Closest positional match'");
    expect(CMP).toContain("chosen && !exact ? '<span class=\"lg-chip lg-chip--warn\">Closest positional match</span>' : ''");
  });

  it('never puts an unavailable player up as the opponent when a fit one exists', () => {
    const fn = APP.slice(APP.indexOf('function _mcOpposite('), APP.indexOf('function _mcAge('));
    for (const s of ['INJURED', 'SUSPENDED', 'UNAVAILABLE']) expect(fn).toContain(s);
  });

  it('shows a measured zero and an unrecorded figure differently', () => {
    // A row is drawn when either side has the figure; the missing side shows a
    // dash. A row nobody has is not drawn at all — unless it is one of the
    // metrics the panel lists precisely to say the platform does not keep it.
    expect(APP).toContain("if (a == null && b == null && !o.showUnavailable) return '';");
    expect(CMP).toContain("_lgVersus('Saves', null, null, { showUnavailable: true })");
    expect(CSS).toMatch(/\.lg-na\{|\.lg-form-none, \.lg-na\{/);
    // And nothing a reader sees is defaulted: every `pick` reads the record
    // straight through, so a missing record yields null rather than a zero.
    const picks = codeOnly(CMP).match(/function \(p\) \{ return rec\(p\)[^;]*; \}/g) || [];
    expect(picks.length).toBeGreaterThan(12);
    for (const p of picks) expect(p).not.toMatch(/\|\|\s*0\b/);
    expect(codeOnly(CMP)).not.toContain('Math.random');
  });

  it('says so plainly when neither player has played, rather than drawing zeroes', () => {
    expect(CMP).toContain('var played = !!(rec(a) || rec(chosen));');
    expect(CMP).toContain('Neither has played in this competition yet');
    for (const g of ['This competition', 'Attack', 'Passing', 'Defending']) {
      expect(CMP).toContain("if (played) groups.push(_mcCmpGroup('" + g + "'");
    }
  });

  it('lets the coach choose a different opponent, relevant roles first', () => {
    const fn = codeOnly(APP.slice(APP.indexOf('function _mcCmpChoices('), APP.indexOf('function _mcCmpHead(')));
    expect(fn).toContain('_MC_POS_NEAR[_mcPosKey(player)]');
    expect(fn).toContain('rank(a) - rank(b)');
    expect(CMP).toContain('data-action="mcCmpPick"');
    // The names in that list are data, not interface text.
    expect(CMP).toContain('<option data-user-content value=');
  });

  it('opens over the board without touching it', () => {
    // Scoped to the workspace's own layer: the comparison belongs to the match
    // that is open, and only that layer is repainted to show it.
    const paint = APP.slice(APP.indexOf('function _mcPaintCmp('), APP.indexOf('function _mcPaintCmp(') + 700);
    expect(paint).toContain("root.querySelector('.mcx-overlay')");
    expect(paint).toContain("document.getElementById('mcx-workspace')");
    expect(paint).toContain('host.innerHTML =');
    expect(paint).not.toContain('renderMatchCenter');
    expect(CSS).toContain('.mcx-overlay{ display:none; }');
  });

  it('and reads figures the League already fetched, not a request per click', () => {
    expect(codeOnly(CMP)).not.toContain('api(');
    expect(codeOnly(CMP)).not.toContain('fetch(');
    // They arrive with the squads, summed from one query over the whole season.
    expect(SERVICE).toContain('export interface LeaguePlayerRecordLine');
    expect(SERVICE).toMatch(/const recordOf = \(playerId: string\)/);
    expect(SERVICE).toContain('record: recordOf(p.id),');
    // Three reads in the whole service, none of them inside a loop over players.
    expect((SERVICE.match(/prisma\.playerMatchStats\.findMany/g) || []).length).toBeLessThanOrEqual(3);
    expect(SERVICE).not.toMatch(/for \([^)]*\) \{[^}]{0,400}playerMatchStats\.findMany/);
    expect(SERVICE).not.toMatch(/\.map\([^)]*=>[^)]{0,200}playerMatchStats\.findMany/);
  });
});

describe('Player Stats', () => {
  it('ranks the extra categories out of what the leaderboard call already returned', () => {
    const fn = codeOnly(APP.slice(APP.indexOf('function _flRank('), APP.indexOf('function _flBoardHtml(')));
    expect(fn).toContain('(_FL.boards && _FL.boards.players)');
    expect(fn).not.toContain('api(');
    // A category with no non-zero figure anywhere is not a ranking.
    expect(fn).toContain('val(p) > 0');
  });

  it('lifts the leader out of the list and marks our own club', () => {
    // A board whose first row is its tenth row at the same size buries the one
    // figure it exists to report.
    const fn = APP.slice(APP.indexOf('function _flBoardHtml('), APP.indexOf('function _flPlayersHtml('));
    expect(fn).toContain('var top = list[0];');
    expect(fn).toContain('<div class="fl-lead\' + (mineTop ? \' is-mine\' : \'\') + \'"');
    expect(fn).toContain('list.slice(1)');
    for (const c of ['.fl-lead{', '.fl-lead-av{', '.fl-lead-val{', '.fl-board-row.is-mine{']) {
      expect(CSS).toContain(c);
    }
    // And the three-place podium it replaced is gone rather than left beside it.
    expect(APP).not.toContain("' is-top is-top' + (i + 1)");
    expect(CSS).not.toContain('.fl-board-row.is-top2{');
  });

  it('opens the canonical player record rather than a second one', () => {
    expect(APP).toMatch(/act === 'flPlayer'[\s\S]{0,400}openPlayerModal\(pid\)/);
    expect(APP).not.toContain('function _flPlayerProfile');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The premium redesign that followed: the rule that made it permanent, the
// quieter current-club treatment, two pitches in Preparation, and the panel
// sizing that stopped a scrolling column from stacking panels on top of one
// another.

describe('the rule is written down, not just followed once', () => {
  const CLAUDE = read('CLAUDE.md');

  it('CLAUDE.md carries the design rule alongside the localization one', () => {
    expect(CLAUDE).toContain('## Design is part of the feature, not a follow-up');
    // The wording is the rule, so it is asserted with the line wrapping removed
    // rather than as the paragraph happens to be laid out today.
    const flat = CLAUDE.replace(/\n>\s*/g, ' ');
    expect(flat).toContain(
      'Every Familista feature must be implemented with production-quality professional UI/UX as part of the same task.');
    expect(flat).toContain('Functional correctness alone is not sufficient.');
    expect(flat).toContain(
      "New UI must follow Familista's existing design system, interaction patterns, accessibility, responsiveness, i18n, visual hierarchy, stable layout, and premium product quality.");
    expect(flat).toContain('Do not wait for a separate redesign request.');
    // Ahead of the localization rule, because it is the more general one.
    expect(CLAUDE.indexOf('## Design is part of the feature'))
      .toBeLessThan(CLAUDE.indexOf('## Localization is part of the feature'));
  });
});

describe('the current club is marked, not shouted at', () => {
  it('an accent edge and a fading wash, no flat block of colour', () => {
    const rule = CSS.slice(CSS.indexOf('.fl-row.is-mine td{'),
                           CSS.indexOf('.fl-row.is-mine td{') + 400);
    expect(rule).toContain('linear-gradient(90deg');
    expect(rule).toContain('rgba(251,191,36,0) 78%');
    expect(CSS).toContain('.fl-row.is-mine td:first-child{ box-shadow:inset 3px 0 0 var(--lg-accent); }');
    // One definition, so a superseded flat fill cannot sit above it and win
    // wherever the newer block does not reach.
    expect(CSS.match(/\.fl-row\.is-mine td\{/g) || []).toHaveLength(1);
    expect(CSS).not.toContain('.fl-row.is-mine td{ background:rgba(251,191,36,');
  });
});

describe('Preparation shows both sides', () => {
  const PREP = APP.slice(APP.indexOf('function _mcPreparationHtml('),
                         APP.indexOf('function _mcOpponentHtml('));

  it('draws two pitches through the same renderer, ours and theirs', () => {
    // One board() helper, called twice: the two pitches cannot drift apart
    // because there is only one place that draws either of them.
    expect(PREP).toContain('var board = function (title, sub, xi, shape, avail, cls)');
    expect((PREP.match(/\bboard\('/g) || []).length).toBe(2);
    expect(PREP).toContain("board('Our shape'");
    expect(PREP).toContain("board('Opponent shape'");
    expect(PREP).toContain('lg-panel--pitch ');
    // And when the opponent has no squad on record it says so, rather than
    // drawing an empty pitch or eleven invented names.
    expect(PREP).toContain("_lgEmpty('No opponent squad recorded'");
  });

  it('with the matchup between them rather than under them', () => {
    expect(PREP).toContain('mcx-cols--prep');
    const grid = CSS.slice(CSS.indexOf('.mcx-cols--prep{'), CSS.indexOf('.mcx-cols--prep{') + 300);
    expect(grid).toContain('grid-template-columns:minmax(0,1fr) minmax(280px,.72fr) minmax(0,1fr)');
    expect(PREP).toContain('Where the two shapes differ');
  });
});

describe('a panel keeps its own height', () => {
  it('so a scrolling column cannot squeeze panels into each other', () => {
    // .lg-panel carries min-height:0 so a pitch can letterbox inside it; in a
    // column that would let every panel collapse under its own content.
    expect(CSS).toContain('.mcx-col > .lg-panel{ min-height:auto; flex:0 0 auto; }');
    expect(CSS).toContain('.mcx-col > .lg-panel--fill, .mcx-col > .lg-panel--pitch{ flex:1 1 auto; min-height:0; }');
  });
});

describe('the phrases the catalogue is keyed by are phrases', () => {
  it('a label and the position beside it are separate nodes', () => {
    // "Highest rated · ST" in one text run would key as "Highest rated ·".
    for (const fn of ['function _mcOverviewHtml(', 'function _mcOpponentHtml(']) {
      const src = APP.slice(APP.indexOf(fn), APP.indexOf(fn) + 12000);
      expect(src).toContain("+ '<i><span>' + label + '</span>'");
      expect(src).toContain('<span class="mcx-key-sep">·</span>');
    }
    expect(APP).not.toContain("'Highest rated ·'");
  });

  it('and a crest keeps the club name it carries out of the catalogue', () => {
    const DOMJS = read('public/i18n/dom.js');
    for (const sel of ['.lg-crest', '.mcx-side-crest', '.mcx-opp-crest', '.fl-mg-crest']) {
      expect(DOMJS).toContain("'" + sel + "'");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One workspace. The Match Center is a section of the Familista League, opened
// from the top level, kept as the workspace's own context, and drawn in place —
// not a page the reader is sent to and has to come back from.

describe('the Match Center is a module, not a section of the League', () => {
  it('the League header names only its own three sections', () => {
    const head = APP.slice(APP.indexOf('function _flHeaderHtml('), APP.indexOf('function _flSkeleton('));
    for (const t of ["['standings', 'Standings']", "['matches', 'Matches']", "['players', 'Player Stats']"]) {
      expect(head).toContain(t);
    }
    // The fourth tab is gone, and no call to action replaced it.
    expect(head).not.toContain("['match', 'Match Center']");
    expect(head).not.toContain('fl-mc-btn');
    expect(head).not.toContain('Open Match Center');
    // Sections on the left of the control bar, actions on the right, one row.
    expect(head).toContain('<div class="fl-bar">');
    expect(CSS).toContain('.fl-bar{ display:flex;');
  });

  it('and the League body no longer hosts it', () => {
    const paint = APP.slice(APP.indexOf('function _flPaintBody('), APP.indexOf('function _flPaintOverlay('));
    expect(paint).not.toContain("b.querySelector('#fl-mc')");
    expect(paint).not.toContain('renderMatchCenter');
    expect(APP).not.toContain('function _flMatchHostHtml');
    expect(APP).not.toContain('id="fl-mc"');
    // Nor is there an embedded mode left to host.
    expect(APP).not.toContain('mcx--embed');
    expect(CSS).not.toContain('.mcx--embed');
    expect(CSS).not.toContain('.fl-mc{');
  });

  it('the module has one renderer, and it draws the calendar', () => {
    expect(APP.match(/^function renderMatchCenter\(\)/gm) || []).toHaveLength(1);
    expect(APP).not.toContain('function renderMatchCenter(host, opts)');
    const fn = APP.slice(APP.indexOf('function renderMatchCenter()'), APP.indexOf('async function _mccLoad('));
    expect(fn).toContain("document.getElementById('match-center-content')");
    expect(fn).toContain('id="mcc-list"');
    expect(fn).toContain('id="mcx-workspace"');
  });

  it('and it is a first-class item in the Club Workspace sidebar, below the League', () => {
    const nav = APP.slice(APP.indexOf('var CLUB_NAV_ITEMS = ['), APP.indexOf('function buildWorkspaceSidebar('));
    const order = (slug: string) => {
      const at = nav.indexOf(`slug:    '${slug}'`);
      expect(at).toBeGreaterThan(-1);
      return Number(/order:\s*([\d.]+)/.exec(nav.slice(at, at + 900))![1]);
    };
    expect(order('match-center')).toBeGreaterThan(order('familista-league'));
    expect(nav).toContain("i18nKey: 'navigation.matchCenter'");
  });
});

describe('the workspace opens over the calendar rather than replacing it', () => {
  it('it is a fixed layer, animating on opacity and transform only', () => {
    expect(CSS).toMatch(/\.mcx-float-bg\{[^}]*position:fixed/);
    const rise = CSS.slice(CSS.indexOf('@keyframes mcxRise'), CSS.indexOf('@keyframes mcxRise') + 160);
    expect(rise).toMatch(/opacity/);
    expect(rise).toMatch(/transform/);
    // Nothing in the animation can move the page.
    expect(rise).not.toMatch(/width|height|margin|padding|top:|left:/);
    expect(CSS).toContain('.mcx-layer{ display:none; }');
    expect(CSS).toContain('.mcx-layer.is-on{ display:block; }');
  });

  it('opening one repaints the layer and nothing else', () => {
    const paint = APP.slice(APP.indexOf('function _mccPaintWorkspace('),
                            APP.indexOf('function _mccPaintChange('));
    expect(paint).toContain("document.getElementById('mcx-workspace')");
    expect(paint).toContain('host.innerHTML =');
    // Never the calendar: the list and the masthead are painted by their own
    // functions, and opening a match does not call either.
    expect(paint).not.toContain('_mccPaintList');
    expect(paint).not.toContain('_mccPaintHead');
  });

  it('and a filter repaints the list rather than the page', () => {
    const list = APP.slice(APP.indexOf('function _mccPaintList('),
                           APP.indexOf('function _mccPaintWorkspace('));
    expect(list).toContain("document.getElementById('mcc-list')");
    expect(list).toContain('b.innerHTML = _mccListHtml()');
    // The list reserves its scrollbar, so filtering cannot shift the page.
    expect(CSS).toMatch(/\.mcc-body\{[^}]*scrollbar-gutter:stable/);
  });

  it('the fixture row is the way in, and it does not navigate', () => {
    const row = APP.slice(APP.indexOf('function _mccRowHtml('), APP.indexOf('function _mccListHtml('));
    expect(row).toContain('data-action="mccOpen"');
    expect(row).toContain('role="button" tabindex="0"');
    const open = APP.slice(APP.indexOf('async function _mccOpen('), APP.indexOf('function _mccClose('));
    expect(codeOnly(open)).not.toContain('navTo(');
    expect(open).toContain('_mccPaintWorkspace()');
  });

  it('and the way back is where the reader can see it', () => {
    const MCX = APP.slice(APP.indexOf('function _mcWorkspaceHtml()'), APP.indexOf('function _mccRowFor('));
    expect(MCX).toContain('data-action="mccClose"');
    expect(MCX).toContain('Back to Familista League');
    expect(MCX).toContain('Back to the calendar');
    // Closing restores the League section and round that launched it.
    const close = APP.slice(APP.indexOf('function _mccClose('), APP.indexOf('function _mcWorkspaceHtml('));
    expect(close).toContain("back.page === 'familista-league'");
    expect(close).toContain('_FL.round = back.round');
    expect(close).toContain("navTo('familista-league')");
  });

  it('and the Standings shortcut leaves for the competition that owns the table', () => {
    const handler = codeOnly(APP).slice(codeOnly(APP).indexOf("act === 'mcStandings'"));
    expect(handler.slice(0, 400)).toContain("navTo('familista-league')");
    expect(handler.slice(0, 400)).toContain('_MCC.open = null');
  });

  it('both Preparation boards stay in view while the matchup beside them is read', () => {
    expect(CSS).toMatch(/\.mcx-cols--prep \.mcx-col--pitch > \.lg-panel\{[\s\S]{0,240}position:sticky/);
    // At its own height: stretched to the tallest column it would grow past
    // anything a screen can show at once.
    expect(CSS).toMatch(/\.mcx-cols--prep \.mcx-col--pitch > \.lg-panel\{[\s\S]{0,240}flex:0 0 auto/);
    expect(CSS).toMatch(/\.mcx-cols--prep\{[\s\S]{0,240}align-items:stretch/);
  });
});

describe('nothing in the competition moves under a stationary pointer', () => {
  it('no control in either module lifts on hover', () => {
    // A control that moves on hover moves again the moment its region is
    // repainted with the pointer standing still, which reads as a shake.
    for (const rule of ['.fl-tab:hover', '.mcx-tab:hover', '.mcx-act:hover', '.mcx-swap:hover',
                        '.lg-act:hover', '.fl-manage-btn:hover, .fl-rules-btn:hover']) {
      const at = CSS.indexOf(rule);
      expect(`${rule}@${at > -1}`).toBe(`${rule}@true`);
      expect(CSS.slice(at, CSS.indexOf('}', at))).not.toContain('translateY');
    }
    // And the transitions those controls declare cannot animate geometry.
    const swap = CSS.slice(CSS.indexOf('.mcx-swap{'), CSS.indexOf('.mcx-swap:hover'));
    expect(swap).toContain('transition:color .15s, background .15s, border-color .15s;');
  });
});

describe('the fixture reads as a fixture and the boards as one row', () => {
  it('club against club keeps a measure instead of spanning the workspace', () => {
    expect(APP).toContain("'<div class=\"fl-fx\">' + side(x.home, 'home') + '<span class=\"fl-cap\">' + mid + '</span>' + side(x.away, 'away') + '</div>'");
    expect(CSS).toMatch(/\.fl-fx\{[\s\S]{0,200}max-width:760px/);
    expect(CSS).toMatch(/\.fl-matches\{[^}]*max-width:1180px/);
  });

  it('and the leaderboards are equal panels, with the one control on its own line', () => {
    expect(CSS).toMatch(/\.fl-boards\{[\s\S]{0,200}align-items:stretch/);
    expect(CSS).toContain('.fl-boards > .lg-panel > .lg-panel-b{ flex:1 1 auto; min-height:0; overflow-y:auto; }');
    expect(APP).toContain('<div class="fl-players">');
    expect(CSS).toContain('.fl-players > .fl-boards{ flex:1 1 auto; min-height:0; }');
    // Metric tiles are the same height whether their label wraps or not.
    expect(CSS).toMatch(/\.lg-metrics\{[^}]*grid-auto-rows:1fr/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The final polish: a simpler palette, one button, one icon set, and a panel
// that is a card without holding more cards inside it. Premium here means
// fewer things on screen, not more — each of these is something a later change
// could undo by adding one more colour, one more box or one more glow.

describe('the palette is small enough to mean something', () => {
  const BLOCK = CSS.slice(CSS.indexOf(':root{\n  /* A quieter surface'));

  it('two colours carry meaning and both come from a token', () => {
    expect(CSS).toContain('--lg-accent:#fbbf24;');
    expect(CSS).toContain('--lg-them:#8fa6c4;');
    // Nothing in the competition names the accent by value any more, so it
    // cannot drift apart between one screen and the next.
    expect(BLOCK.match(/#fbbf24/g) || []).toHaveLength(1);
    // And the bright cyan that used to compete with the accent is gone.
    expect(BLOCK).not.toContain('#7dd3fc');
    expect(BLOCK).not.toContain('125,211,252');
  });

  it('a fixture that has not been played is not a colour', () => {
    expect(CSS).toContain('.lg-chip--up{ color:var(--tx-3,#8b93a7); }');
    // Green and red still mean a result or an availability state, and only that.
    expect(CSS).toMatch(/\.lg-chip--live\{[^}]*#4ade80/);
    expect(CSS).toMatch(/\.lg-chip--post, \.lg-chip--cancel\{[^}]*#f87171/);
  });

  it('and the accent is flat wherever it is filled', () => {
    // A gradient plus a glow on a tab, a badge or a button is decoration; the
    // amber already carries the meaning by being amber.
    for (const rule of ['.lg-act--primary{', '.fl-row.is-mine .fl-pts{', '.fl-lead-av{']) {
      const at = CSS.indexOf(rule);
      expect(`${rule}@${at > -1}`).toBe(`${rule}@true`);
      const body = CSS.slice(at, CSS.indexOf('}', at));
      expect(body).toContain('var(--lg-accent)');
      expect(body).not.toContain('linear-gradient');
      expect(body).not.toContain('box-shadow');
    }
    // The two navs no longer fill at all: the League's sections underline and
    // the match's four views are one segmented control with a part of it live.
    expect(CSS).toContain('.fl-tab.is-on .fl-tab-rule{ background:var(--lg-accent); }');
    expect(CSS).toMatch(/\.fl-tab\.is-on\{ color:var\(--tx-1[^}]*\}/);
    expect(CSS).toMatch(/\.mcx-tab\.is-on\{[^}]*background:var\(--lg-tile-2\)/);
  });
});

describe('one control, one icon set', () => {
  it('every button in the module is the same button at a different size', () => {
    for (const rule of ['.lg-act{', '.mcx-act{', '.fl-more{', '.fl-rnav-btn{',
                        '.fl-manage-btn, .fl-rules-btn{', '.mcx-swap{', '.mcx-back, .mcx-crumb-btn{']) {
      const at = CSS.indexOf(rule);
      expect(`${rule}@${at > -1}`).toBe(`${rule}@true`);
      const body = CSS.slice(at, CSS.indexOf('}', at));
      expect(body).toContain('var(--lg-tile-2)');
      expect(body).toContain('var(--lg-bd)');
      expect(body).toContain('font-weight:800');
      // `transition:all` animates geometry too, which is how a control ends up
      // moving when only its colour was meant to change.
      expect(body).not.toContain('transition:all');
    }
  });

  it('and every icon is one size, one stroke, drawn from one table', () => {
    expect(APP).toContain('var _LG_ICON = {');
    expect(APP).toContain('function _lgIcon(name)');
    expect(APP).toMatch(/_lgIcon[\s\S]{0,400}width="14" height="14"/);
    expect(APP).toMatch(/_lgIcon[\s\S]{0,400}stroke-width="1\.75"/);
    expect(APP).toMatch(/_lgIcon[\s\S]{0,400}stroke="currentColor"/);
    expect(CSS).toContain('.lg-ic{ flex:0 0 auto; width:14px; height:14px; opacity:.75; }');
    // The three icon languages this replaced: a filled 16px glyph on one
    // button and text arrows on the others.
    expect(APP).not.toContain('fill-rule="evenodd" d="M18 10A8 8 0');
    expect(APP).not.toContain('<span aria-hidden="true">⇄</span>');
    // Every name in the table is drawn somewhere, and every icon drawn comes
    // from the table. A glyph nobody uses is one more thing to keep consistent
    // with nothing. The competition marks are reached through the kind table
    // rather than by name, so that counts as drawn too.
    const table = APP.slice(APP.indexOf('var _LG_ICON = {'), APP.indexOf('function _lgIcon(name)'));
    const names = (table.match(/^\s{2}([a-z]+):/gm) || []).map((m) => m.trim().replace(':', ''));
    expect(names).toEqual(expect.arrayContaining(['back', 'info', 'teams', 'trophy']));
    const kinds = APP.slice(APP.indexOf('var _MCC_KIND_ICON = {'), APP.indexOf('var _MCC_KIND_LABEL = {'));
    for (const name of names) {
      const drawn = APP.includes("_lgIcon('" + name + "')") || kinds.includes("'" + name + "'");
      expect(`${name}@${drawn}`).toBe(`${name}@true`);
    }
  });
});

describe('a panel is a card, and does not hold more cards', () => {
  it('the sections inside one are separated by a hairline, not a frame', () => {
    for (const rule of ['.mcx-ctx{', '.mcx-shape{', '.mcx-key{']) {
      const at = CSS.indexOf(rule);
      expect(`${rule}@${at > -1}`).toBe(`${rule}@true`);
      const body = CSS.slice(at, CSS.indexOf('}', at));
      expect(body).not.toContain('border:1px solid');
      expect(body).not.toContain('background:');
    }
    for (const sep of ['.mcx-ctx + .mcx-ctx{ border-top:1px solid var(--lg-bd-soft); }',
                       '.mcx-shape + .mcx-shape{ border-top:1px solid var(--lg-bd-soft); }',
                       '.mcx-danger-row + .mcx-danger-row{ border-top:1px solid var(--lg-bd-soft); }']) {
      expect(CSS).toContain(sep);
    }
  });

  it('and each of those is defined once, so a flattened card cannot keep its box', () => {
    for (const sel of ['.mcx-key', '.mcx-key-row', '.mcx-key-team', '.mcx-key-v',
                       '.mcx-danger-row', '.mcx-ctx', '.mcx-shape']) {
      const n = (CSS.match(new RegExp('^\\' + sel + '\\{', 'gm')) || []).length;
      expect(`${sel}@${n}`).toBe(`${sel}@1`);
    }
  });

  it('the panel surface itself is lighter than it was', () => {
    const panel = codeOnly(CSS.slice(CSS.indexOf('.lg-panel{'), CSS.indexOf('.lg-panel-h{')));
    expect(panel).toContain('box-shadow:var(--lg-shadow)');
    // No saturate: it tinted every crest and chip standing on the surface.
    expect(panel).toContain('backdrop-filter:blur(14px);');
    expect(panel).not.toContain('saturate(');
    expect(CSS).toContain('--lg-shadow:0 8px 24px rgba(0,0,0,.22);');
    // And an empty state states itself rather than drawing a dashed placeholder.
    expect(CSS).not.toMatch(/\.lg-empty\{[^}]*border:1px dashed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The premium redesign: structure, not colour. Each of these changed the SHAPE
// of something, and each could be undone by putting the old shape back.

describe('the League opens with a masthead, not a line of text', () => {
  const HEAD = APP.slice(APP.indexOf('function _flHeaderHtml('), APP.indexOf('function _flSkeleton('));

  it('the competition\'s own mark leads it, and the season reads as facts', () => {
    expect(HEAD).toContain('<div class="fl-mark" aria-hidden="true">');
    expect(HEAD).toContain("_lgIcon('trophy')");
    // A definition list of labelled figures, not two pills floating beside a
    // title with nothing holding them to it.
    expect(HEAD).toContain('<dl class="fl-facts">');
    expect(HEAD).toContain('<dt>Season</dt>');
    expect(HEAD).toContain('<dt>Teams</dt>');
    expect(HEAD).toContain('<dt>Round</dt>');
    expect(CSS).toMatch(/\.fl-fact\{[^}]*border-left/);
    expect(CSS).toMatch(/\.fl-mark\{[\s\S]{0,300}border-radius:11px/);
  });

  it('and the sections are an underlined nav rather than four filled pills', () => {
    expect(HEAD).toContain('<i class="fl-tab-rule" aria-hidden="true"></i>');
    const tabs = CSS.slice(CSS.indexOf('.fl-tabs{'), CSS.indexOf('.fl-tab-rule{'));
    expect(tabs).toContain('border-bottom:1px solid var(--lg-bd-soft)');
    expect(tabs).not.toContain('backdrop-filter');
    const tab = CSS.slice(CSS.indexOf('.fl-tab{'), CSS.indexOf('.fl-tab:first-child'));
    expect(tab).toContain('background:none');
    expect(tab).toContain('border:0');
  });
});

describe('a panel names itself, and a table is read in groups', () => {
  it('every panel heading carries a rule before it', () => {
    const fn = APP.slice(APP.indexOf('function _lgPanel('), APP.indexOf('function _lgEmpty('));
    expect(fn).toContain('<i class="lg-rule" aria-hidden="true"></i>');
    expect(CSS).toMatch(/\.lg-rule\{[\s\S]{0,200}background:var\(--lg-accent\)/);
    // The opponent's panels take the other side's colour, as everywhere else.
    expect(CSS).toContain('.lg-panel--pitch .lg-rule, .mcx-panel--theirs .lg-rule{ background:var(--lg-them); }');
  });

  it('the standings row is grouped: identity, what was played, what it came to', () => {
    const fn = APP.slice(APP.indexOf('function _flStandingsHtml('), APP.indexOf('// ── tab 2'));
    expect((fn.match(/is-edge/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(fn).toContain("if (i === 2 || i === 6 || i === 9) cls += ' is-edge';");
    // Barely there in the body: a divider you notice is a spreadsheet.
    expect(CSS).toContain('.fl-table td.is-edge{ border-left:1px solid rgba(255,255,255,.028); }');
    // And the rank is a figure in its column, not a chip beside the crest.
    expect(CSS).toMatch(/\.fl-pos\{[\s\S]{0,240}background:none/);
  });
});

describe('a fixture is a card and a leaderboard has a leader', () => {
  it('the fixture carries a status rail and a score capsule', () => {
    const at = APP.indexOf('function _flMatchRow(');
    const fn = APP.slice(at, APP.indexOf('\nfunction ', at + 10));
    expect(fn).toContain('var st = _lgStatus(x.status);');
    expect(fn).toContain('<i class="fl-rail" aria-hidden="true"></i>');
    expect(fn).toContain('<span class="fl-status">');
    expect(fn).toContain('<span class="fl-cap">');
    // The chip that used to sit in the row is gone from it.
    expect(fn).not.toContain('_lgStatusChip(x.status)');
    expect(CSS).toMatch(/\.fl-rail\{[\s\S]{0,240}position:absolute/);
    expect(CSS).toContain('.fl-match--done .fl-rail{ background:var(--lg-accent); }');
  });

  it('and the match hero reads top to bottom on each side', () => {
    const MCX = APP.slice(APP.indexOf('var sideBlock = function'), APP.indexOf('var ident = embedded'));
    expect(MCX).toContain('<div class="mcx-side-lbl">');
    expect(MCX).toContain('<span class="mcx-side-fact">');
    // The three facts are labelled figures now, not a string of text.
    expect(CSS).toMatch(/\.mcx-side-fact b\{[\s\S]{0,200}font-variant-numeric:tabular-nums/);
    // And the centre is the same capsule a fixture card uses.
    expect(CSS).toMatch(/\.mcx-vs\{[\s\S]{0,300}border:1px solid var\(--lg-bd-soft\)/);
  });

  it('the match views are a segmented control, not a second nav', () => {
    const rail = CSS.slice(CSS.indexOf('.mcx-rail{'), CSS.indexOf('.mcx-tab{'));
    expect(rail).toContain('padding:4px');
    expect(rail).toContain('border:1px solid var(--lg-bd-soft)');
    const tab = CSS.slice(CSS.indexOf('.mcx-tab{'), CSS.indexOf('.mcx-tab:hover'));
    expect(tab).toContain('background:none');
    expect(tab).toContain('border:0');
  });
});

describe('a metric is a labelled figure and an empty state is drawn', () => {
  it('the tile has a rule instead of another border', () => {
    expect(CSS).toMatch(/\.lg-metric\{[^}]*position:relative/);
    expect(CSS).toMatch(/\.lg-metric::before\{[\s\S]{0,240}background:var\(--lg-bd\)/);
    expect(CSS).toContain('.lg-metric--hero::before{ background:var(--lg-accent); }');
  });

  it('and the empty state draws its mark rather than printing an emoji', () => {
    const fn = APP.slice(APP.indexOf('function _lgEmpty('), APP.indexOf('function _lgFloat('));
    expect(fn).toContain('<svg viewBox="0 0 32 32"');
    expect(fn).toContain('stroke="currentColor"');
    expect(fn).not.toContain("icon || '◎'");
    expect(CSS).toMatch(/\.lg-empty-ic\{[\s\S]{0,300}border-radius:14px/);
  });

  it('and switching a match view starts that view at its own beginning', () => {
    const handler = codeOnly(APP).slice(codeOnly(APP).indexOf("act === 'mcTab'"));
    expect(handler.slice(0, 1800)).toContain('desk.scrollTop = 0;');
  });
});
