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
    expect(APP).toContain("'<div class=\"lg-row fl-match'");
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

describe('the fixture preview costs one request, not two', () => {
  it('the Match Center is handed the payload the preview already loaded', () => {
    const open = codeOnly(APP.slice(APP.indexOf('async function _flOpenMatch('),
                                    APP.indexOf('async function _flOpenMatch(') + 1400));
    expect(open).toContain('_FL.preview.fixtureId === fixtureId');
    expect(open).toContain('_flHandOver(_FL.preview.data, fixtureId)');
    // And the workspace's own match is reused too, so returning to the section
    // costs nothing at all.
    expect(open).toContain('_FL.match.fixtureId === fixtureId');
    expect(open).toContain('_flHandOver(_FL.match.data, fixtureId)');
    // The refetch is the fallback for a row opened without a preview.
    expect(open.indexOf('_flHandOver(_FL.preview.data, fixtureId)'))
      .toBeLessThan(open.indexOf("api('/familista-league/fixtures/"));
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
    // Scoped to the host the workspace was drawn into, so the League's embedded
    // overlay and the standalone page's cannot be confused for one another.
    const paint = APP.slice(APP.indexOf('function _mcPaintCmp('), APP.indexOf('function _mcPaintCmp(') + 700);
    expect(paint).toContain("root.querySelector('.mcx-overlay')");
    expect(paint).toContain('(_MC.host && _MC.host.isConnected)');
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

  it('sets the podium apart and marks our own club', () => {
    expect(APP).toContain("(i < 3 ? ' is-top is-top' + (i + 1) : '')");
    for (const c of ['.fl-board-row.is-top1{', '.fl-board-row.is-top2{', '.fl-board-row.is-top3{', '.fl-board-row.is-mine{']) {
      expect(CSS).toContain(c);
    }
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

describe('the Match Center is a section, not a destination', () => {
  it('the League header names it beside the other three', () => {
    const head = APP.slice(APP.indexOf('function _flHeaderHtml('), APP.indexOf('function _flSkeleton('));
    expect(head).toContain("['match', 'Match Center']");
    for (const t of ["['standings', 'Standings']", "['matches', 'Matches']", "['players', 'Player Stats']"]) {
      expect(head).toContain(t);
    }
    // And the way in is a control in the header, not something to be found
    // inside the fixtures list.
    expect(head).toContain('class="fl-mc-btn" data-action="flOpenMC"');
    expect(head).toContain('<span>Open Match Center</span>');
    // Sections on the left of the control bar, actions on the right, one row.
    expect(head).toContain('<div class="fl-bar">');
    expect(CSS).toContain('.fl-bar{ display:flex;');
  });

  it('and it draws into the League body rather than another page', () => {
    expect(APP).toContain('function renderMatchCenter(host, opts)');
    expect(APP).toContain('const el = host || document.getElementById(\'match-center-content\');');
    const paint = APP.slice(APP.indexOf('function _flPaintBody('), APP.indexOf('function _flPaintOverlay('));
    expect(paint).toContain("b.querySelector('#fl-mc')");
    expect(paint).toContain('renderMatchCenter(mc, { embedded: true })');
    // Nothing navigates on the way in.
    const hand = APP.slice(APP.indexOf('function _flHandOver('), APP.indexOf('function _flTabTo('));
    expect(codeOnly(hand)).not.toContain("navTo('match-center')");
    expect(hand).toContain("_flTabTo('match')");
  });

  it('the workspace keeps the match it was given', () => {
    expect(APP).toMatch(/var _FL = \{[\s\S]{0,900}match: null,/);
    const hand = APP.slice(APP.indexOf('function _flHandOver('), APP.indexOf('function _flTabTo('));
    expect(hand).toContain('_FL.match = {');
    // Coming back to the section redraws from what is held, with no request.
    const host = APP.slice(APP.indexOf('function _flMatchHostHtml('), APP.indexOf('// ── tab 1 · standings'));
    expect(host).toContain('!_FL.match || !_FL.match.data');
    expect(codeOnly(host)).not.toContain('api(');
  });
});

describe('choosing the match is one step, and only asked when it has to be', () => {
  it('the obvious fixture is opened without asking', () => {
    const fn = codeOnly(APP.slice(APP.indexOf('function _flPrimaryFixture('),
                                  APP.indexOf('async function _flEnterMatchCenter(')));
    // Only a fixture with a match behind it can be opened at all.
    expect(fn).toContain('x.matchId');
    // Our own club's fixture in the round the season is on.
    expect(fn).toContain('_flMine(x.home && x.home.teamId)');
    // And when it is not obvious it returns null rather than guessing one.
    expect(fn).toContain('if (mine.length > 1) return null;');
    expect(fn).toContain('return playable.length === 1 ? playable[0] : null;');
    expect(fn).not.toMatch(/Math\.random|\[0\]\s*;?\s*\/\/ *just/);
  });

  it('and otherwise a lightweight selector asks, in the same shell', () => {
    const enter = codeOnly(APP.slice(APP.indexOf('async function _flEnterMatchCenter('),
                                     APP.indexOf('function _flOpenPick(')));
    expect(enter).toContain('var pick = _flPrimaryFixture();');
    expect(enter).toContain('_flOpenMatch(pick.fixtureId)');
    expect(enter).toContain('_flOpenPick()');
    // The selector is a floating panel on the shared shell, not a page.
    const pick = APP.slice(APP.indexOf('function _flPickHtml('), APP.indexOf('function _flPickHtml(') + 2200);
    expect(pick).toContain('_lgFloat({');
    expect(pick).toContain('Choose a match');
    expect(pick).toContain('_flMatchRow(x, true)');
    // It is painted into the overlay, so the workspace beneath does not move.
    expect(APP).toContain("(_FL.pick ? _flPickHtml() : '')");
    expect(APP).toMatch(/act === 'flPick'[\s\S]{0,80}_flOpenPick\(\)/);
  });

  it('and a fixture clicked inside a panel opens the match rather than a second panel', () => {
    const branch = codeOnly(FL_ACTIONS).slice(codeOnly(FL_ACTIONS).indexOf("act === 'flMatch'"));
    expect(branch).toContain("el.closest('.lg-float')");
    expect(branch).toContain('_flOpenMatch(fid)');
    expect(branch).toContain('_flOpenPreview(fid)');
  });
});

describe('embedded, the workspace does not repeat what the shell already says', () => {
  it('no second breadcrumb, no second page title, and no duplicated id', () => {
    const MCX = APP.slice(APP.indexOf('function renderMatchCenter(host, opts)'),
                          APP.indexOf('function _mcPanel('));
    expect(MCX).toContain('var crumb = (ctx && !embedded)');
    expect(MCX).toContain('var ident = embedded');
    expect(MCX).toContain("var deskId = embedded ? '' : ' id=\"mcx-desk\"';");
    expect(MCX).toContain("var ovId = embedded ? '' : ' id=\"mcx-overlay\"';");
    // Standalone it still names itself in full.
    expect(MCX).toContain('<h1 class="mcx-h1">Match Center</h1>');
  });

  it('and the Standings shortcut stays in the shell when there is one', () => {
    const handler = codeOnly(APP).slice(codeOnly(APP).indexOf("act === 'mcStandings'"));
    expect(handler.slice(0, 260)).toContain("_flTabTo('standings')");
    expect(handler.slice(0, 260)).toContain("navTo('familista-league')");
  });

  it('the host takes its own height so the body behind it does not scroll', () => {
    expect(CSS).toContain('.fl-body.is-mc{ overflow:hidden; }');
    expect(CSS).toMatch(/\.fl-mc\{[^}]*display:flex[^}]*flex:1 1 auto[^}]*min-height:0/);
    expect(APP).toContain("b.classList.toggle('is-mc', !!mc);");
    // And the escape hatch is the same one every workspace carries.
    expect(CSS).toMatch(/@media \(max-width:980px\), \(max-height:620px\)\{[\s\S]{0,400}\.fl-mc\{ display:block; \}/);
  });
});

describe('nothing in the competition moves under a stationary pointer', () => {
  it('no control in either module lifts on hover', () => {
    // A control that moves on hover moves again the moment its region is
    // repainted with the pointer standing still, which reads as a shake.
    for (const rule of ['.fl-tab:hover', '.fl-mc-btn:hover', '.mcx-tab:hover', '.mcx-act:hover',
                        '.lg-act:hover', '.fl-manage-btn:hover, .fl-rules-btn:hover']) {
      const at = CSS.indexOf(rule);
      expect(`${rule}@${at > -1}`).toBe(`${rule}@true`);
      expect(CSS.slice(at, CSS.indexOf('}', at))).not.toContain('translateY');
    }
    // And the transitions those controls declare cannot animate geometry.
    const btn = CSS.slice(CSS.indexOf('.fl-mc-btn{'), CSS.indexOf('.fl-mc-btn:hover'));
    expect(btn).toContain('transition:filter .15s, box-shadow .15s;');
  });
});

describe('the fixture reads as a fixture and the boards as one row', () => {
  it('club against club keeps a measure instead of spanning the workspace', () => {
    expect(APP).toContain("'<div class=\"fl-fx\">' + side(x.home, 'home') + mid + side(x.away, 'away') + '</div>'");
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
