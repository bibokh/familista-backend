// The Analytics, Medical and Performance player views open, list and close again.
//
// Their controls were inline handlers — onclick="_medProfileId=null;renderMedicalPage();" — and the platform's CSP
// (script-src-attr 'none', tests/csp-inline-handlers.unit.test.ts) refuses every one: the tabs did nothing, the player
// cards did nothing, and the back buttons, which a user could never reach, would have done nothing either. They now go
// through the delegation every other control uses: a data-action attribute, one case in the document's click listener,
// and a named function. Nothing in the CSP changes.
//
// This file proves the wiring from the source and runs it: the delegation block itself is executed in a sandbox and
// handed the clicks and keys a user would make. The browser half — under the real CSP, in every official language, on
// a desktop and a phone, by mouse and keyboard, repeatedly — is tools/components/twin-browser-proof.cjs (T7).

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP = read('public/app.js');
const CSS = read('public/app.css');

const INLINE_HANDLER = /<[a-zA-Z][^<>]*?\son[a-z]+\s*=\s*\\?["']/g;
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('not found: ' + from + ' … ' + to);
  return src.slice(a, b);
};

/** Each action: the delegated call it must make, and where its control is drawn. */
const ACTIONS: Record<string, string> = {
  analyticsTab: 'setAnalyticsTab(el.dataset.tab, el)',
  analyticsOpenPlayer: 'openPlayerAnalytics(el.dataset.id)',
  analyticsBackToList: 'analyticsBackToList()',
  medicalTab: 'setMedicalTab(el.dataset.tab, el)',
  medOpenProfile: 'medOpenProfile(el.dataset.id)',
  medBackToList: 'medBackToList()',
  perfOpenHistory: 'openPerfHistory(el.dataset.id)',
  perfBackToList: 'perfBackToList()',
};

// ── the delegation block, run in a sandbox ───────────────────────────────────
export function delegation(src: string, globals: Record<string, any>) {
  const a = src.indexOf('(function wireStaticHandlers() {');
  const b = src.indexOf('\n})();', a) + 6;
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const document = { addEventListener: (t: string, f: any) => { (listeners[t] = listeners[t] || []).push(f); } };
  vm.runInNewContext(src.slice(a, b), { document, window: {}, console: { warn() {}, error() {} }, ...globals });
  return listeners;
}
/** An element as the delegation sees it: a tag, attributes, dataset, and closest() answering for itself. */
const element = (tag: string, attrs: Record<string, string>) => {
  const dataset: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = v;
  const el: any = { tagName: tag, dataset, getAttribute: (k: string) => attrs[k] ?? null, clicks: 0 };
  el.closest = (sel: string) => (sel.split(',').some((s) => { const m = s.trim().match(/^\[([\w-]+)\]$/); return !!m && m[1] in attrs; }) ? el : null);
  el.click = () => { el.clicks++; };
  return el;
};
const click = (listeners: any, el: any) => { const e = { target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; listeners.click.forEach((f: any) => f(e)); return e; };
const key = (listeners: any, el: any, k: string) => { const e = { key: k, target: el, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; listeners.keydown.forEach((f: any) => f(e)); return e; };

/** Every function the eight actions call, as a stub that records its arguments. */
const stubs = () => {
  const calls: Array<[string, any[]]> = [];
  const g: Record<string, any> = {};
  for (const name of ['setAnalyticsTab', 'openPlayerAnalytics', 'analyticsBackToList', 'setMedicalTab', 'medOpenProfile', 'medBackToList', 'openPerfHistory', 'perfBackToList'])
    g[name] = (...args: any[]) => { calls.push([name, args]); };
  return { g, calls };
};

describe('the player views: tabs, cards and back buttons go through the delegation', () => {
  const ANALYTICS = between(APP, 'function renderAnalyticsHTML', 'function _renderAnalyticsTeam');
  const MED_TABS = between(APP, 'function renderMedicalHTML', 'function setMedicalTab');
  const MED_PLAYERS = between(APP, 'async function _renderMedPlayers', '\n}\n');
  const PERF = between(APP, 'function _renderPerfDashboard', 'async function loadPerformanceData');

  it('no inline handler is left on any of them', () => {
    expect(ANALYTICS.match(INLINE_HANDLER) || []).toEqual([]);
    for (const tab of ['dashboard', 'injuries', 'players']) expect(MED_TABS).toContain(`type="button" data-action="medicalTab" data-tab="${tab}"`);
    expect(MED_TABS).not.toMatch(/setMedicalTab\(/);
    expect(MED_PLAYERS).not.toMatch(/onclick=/);
    expect(APP).not.toMatch(/onclick="[^"]*(openPerfHistory|_perfHistoryId=null|_medProfileId|openPlayerAnalytics|_analyticsPlayerId=null|setAnalyticsTab|setMedicalTab)/);
    expect((PERF.match(/data-action="perfOpenHistory" data-id="\$\{_esc\(p\.id\)\}"/g) || []).length).toBe(3);
    expect((APP.match(/type="button" data-action="perfBackToList">\$\{_dirArrow\(\)\} Back<\/button>/g) || []).length).toBe(2);
  });

  it('each action drawn has exactly one delegated case, which calls its named function', () => {
    const cases = between(APP, '(function wireStaticHandlers() {', "default: console.warn('[delegate] Unknown action:'");
    for (const [action, call] of Object.entries(ACTIONS)) {
      expect([action, (APP.match(new RegExp(`data-action="${action}"`, 'g')) || []).length > 0]).toEqual([action, true]);
      const c = cases.match(new RegExp(`case '${action}':\\s*([^;]+);\\s*break;`, 'g')) || [];
      expect([action, c.length, c[0] && c[0].includes(call)]).toEqual([action, 1, true]);
    }
    for (const fn of ['analyticsBackToList', 'medOpenProfile', 'medBackToList', 'perfBackToList'])
      expect([fn, (APP.match(new RegExp(`\\nfunction ${fn}\\(`, 'g')) || []).length]).toEqual([fn, 1]);
  });

  it('a back button still turns with the reading direction (the shared arrow of PR #158)', () => {
    expect(APP).toContain('data-action="analyticsBackToList">${_dirArrow()} Back to Players</button>');
    expect(APP).toContain('data-action="medBackToList">${_dirArrow()} Players</button>');
  });

  it('a card that opens a player is a button to the keyboard: role, tab stop, a visible ring', () => {
    expect(ANALYTICS).toContain('role="button" tabindex="0" data-action="analyticsOpenPlayer" data-id="${_esc(p.playerId)}"');
    expect(MED_PLAYERS).toContain('role="button" tabindex="0" data-action="medOpenProfile" data-id="${_esc(p.id)}"');
    expect(CSS).toContain('.card[role="button"]:focus-visible{outline:2px solid var(--green);outline-offset:2px;}');
  });
});

describe('the wiring, run', () => {
  it('a click on each control reaches its function once, with the id or tab it carries', () => {
    const { g, calls } = stubs();
    const L = delegation(APP, g);
    expect(L.click).toHaveLength(1);
    const cases: Array<[Record<string, string>, string, any[]]> = [
      [{ 'data-action': 'analyticsTab', 'data-tab': 'players' }, 'setAnalyticsTab', ['players']],
      [{ 'data-action': 'analyticsOpenPlayer', 'data-id': 'p-1' }, 'openPlayerAnalytics', ['p-1']],
      [{ 'data-action': 'analyticsBackToList' }, 'analyticsBackToList', []],
      [{ 'data-action': 'medicalTab', 'data-tab': 'players' }, 'setMedicalTab', ['players']],
      [{ 'data-action': 'medOpenProfile', 'data-id': 'p-2' }, 'medOpenProfile', ['p-2']],
      [{ 'data-action': 'medBackToList' }, 'medBackToList', []],
      [{ 'data-action': 'perfOpenHistory', 'data-id': 'p-3' }, 'openPerfHistory', ['p-3']],
      [{ 'data-action': 'perfBackToList' }, 'perfBackToList', []],
    ];
    for (const [attrs, fn, args] of cases) {
      calls.length = 0;
      click(L, element('BUTTON', attrs));
      expect([fn, calls.length, calls[0] && calls[0][0], calls[0] && calls[0][1].slice(0, args.length)]).toEqual([fn, 1, fn, args]);
    }
  });

  it('the keyboard: Enter and Space on a card that is a button make the same click; a native button and other keys are left alone', () => {
    const L = delegation(APP, stubs().g);
    const card = element('DIV', { role: 'button', tabindex: '0', 'data-action': 'medOpenProfile', 'data-id': 'p-2' });
    expect(key(L, card, 'Enter').defaultPrevented).toBe(true);
    expect(key(L, card, ' ').defaultPrevented).toBe(true);
    expect(card.clicks).toBe(2);
    key(L, card, 'Tab'); key(L, card, 'a');
    expect(card.clicks).toBe(2);
    const button = element('BUTTON', { 'data-action': 'perfBackToList' });
    key(L, button, 'Enter'); key(L, button, ' ');
    expect(button.clicks).toBe(0);               // the browser itself turns these into one click
    const plain = element('DIV', { role: 'button' });
    key(L, plain, 'Enter');
    expect(plain.clicks).toBe(0);                // no action, nothing to do
  });

  it('drawing a view again adds no listener: the delegation registers once, and no renderer registers anything', () => {
    for (const fn of ['function renderAnalyticsPage', 'function _renderAnalyticsPlayers', 'async function _renderMedPlayers', 'function renderMedicalPage', 'function renderPerformancePage', 'function _renderPerfDashboard', 'function _renderPerfHistory'])
      expect([fn, /addEventListener|onclick\s*=/.test(between(APP, fn, '\n}\n'))]).toEqual([fn, false]);
    const L = delegation(APP, stubs().g);
    expect([L.click.length, L.keydown.length]).toEqual([1, 2]);   // the click delegate; the role="button" key delegate and the Escape handler
  });

  it('leaving a view clears its state and draws the page once, with no history entry', () => {
    const run = (fnName: string, state: Record<string, any>, render: string) => {
      const src = (APP.match(new RegExp(`\\nfunction ${fnName}\\(\\) \\{[^\\n]*\\}`)) as RegExpMatchArray)[0];
      const ctx: any = { ...state, renders: 0, history: { pushState() { ctx.pushed = true; } } };
      ctx[render] = () => { ctx.renders++; };
      vm.runInNewContext(src.replace(/^\n/, '').replace(/\blet\b/g, 'var') + `; ${fnName}();`, ctx);
      return ctx;
    };
    const a = run('analyticsBackToList', { _analyticsPlayerId: 'p-1', _analyticsPlayerData: { player: {} } }, 'renderAnalyticsPage');
    expect([a._analyticsPlayerId, a._analyticsPlayerData, a.renders, !!a.pushed]).toEqual([null, null, 1, false]);
    const m = run('medBackToList', { _medProfileId: 'p-2' }, 'renderMedicalPage');
    expect([m._medProfileId, m.renders]).toEqual([null, 1]);
    const p = run('perfBackToList', { _perfHistoryId: 'p-3' }, 'renderPerformancePage');
    expect([p._perfHistoryId, p.renders]).toEqual([null, 1]);
    // opening a medical profile sets the player and draws the list region it replaces
    const open = (APP.match(/\nfunction medOpenProfile\(id\) \{[^\n]*\}/) as RegExpMatchArray)[0];
    const ctx: any = { _medProfileId: null, drawn: null, document: { getElementById: (id: string) => ({ id }) } };
    ctx._renderMedPlayers = (el: any) => { ctx.drawn = el.id; };
    vm.runInNewContext(open + "; medOpenProfile('p-2');", ctx);
    expect([ctx._medProfileId, ctx.drawn]).toEqual(['p-2', 'medical-content']);
  });

  it('a player with no history still opens, with its Back button: the empty states are the shared _lgEmpty', () => {
    // The three empty states called emptyHTML(), which has never been defined: the history view of a player with no
    // snapshots threw and stayed on "Loading history…", so its Back button was never drawn. Run, not read.
    const fn = (name: string) => between(APP, `\nfunction ${name}(`, '\n}\n') + '\n}\n';
    const helpers = fn('_lgEmpty') + (APP.match(/\nfunction _dirArrow\(glyph\) \{[^\n]*\}\n/) as RegExpMatchArray)[0];
    const draw = (renderer: string, state: Record<string, any>, src = fn(renderer)) => {
      const el: any = { innerHTML: '' };
      vm.runInNewContext(helpers + src + `; ${renderer}(el);`, { el, _esc: (s: any) => String(s), errorHTML: (m: string) => 'ERR ' + m, ...state });
      return el.innerHTML as string;
    };
    const player = { id: 'p-9', firstName: 'Alex', lastName: 'Rowe', number: 9 };
    const history = draw('_renderPerfHistory', { _perfSquad: [player], _perfHistoryId: 'p-9', _perfHistMap: { 'p-9': [] } });
    expect(history).toMatch(/data-action="perfBackToList">\s*<span class="fam-dir-ic" aria-hidden="true">←<\/span> Back<\/button>/);
    expect(history).toMatch(/class="lg-empty-t">No snapshots yet</);
    expect(draw('_renderPerfDashboard', { _perfSquad: [] })).toMatch(/class="lg-empty-t">No players found</);
    expect(draw('_renderPerfProfiles', { _perfSquad: [] })).toMatch(/class="lg-empty-t">No players found</);
    expect(APP).not.toMatch(/\bemptyHTML\(/);
    // (control) the helper as it was: the same run throws, and nothing is drawn
    expect(() => draw('_renderPerfHistory', { _perfSquad: [player], _perfHistoryId: 'p-9', _perfHistMap: {} }, fn('_renderPerfHistory').replace('_lgEmpty(', 'emptyHTML(')))
      .toThrow(/emptyHTML is not defined/);
  });

  it('nothing here evaluates text as code, and the ids reach the page escaped', () => {
    const added = ['analyticsBackToList', 'medOpenProfile', 'medBackToList', 'perfBackToList']
      .map((f) => (APP.match(new RegExp(`\\nfunction ${f}\\([^)]*\\) \\{[^\\n]*\\}`)) as RegExpMatchArray)[0]).join('\n')
      + between(APP, "document.addEventListener('keydown', function delegateKey(e) {", '\n  });');
    expect(added).not.toMatch(/\beval\b|new Function|setTimeout\(\s*['"`]|innerHTML/);
    expect(APP).not.toMatch(/data-action="(analyticsOpenPlayer|medOpenProfile|perfOpenHistory)" data-id="\$\{(?!_esc\()/);
  });
});

describe('the checks, watched working', () => {
  it('(control) an inline handler put back on a back button is found by the same scan', () => {
    const broken = APP.replace('type="button" data-action="perfBackToList">', 'onclick="_perfHistoryId=null;renderPerformancePage();">');
    expect(broken).toMatch(/onclick="[^"]*_perfHistoryId=null/);
  });

  it('(control) a control whose case is missing reaches nothing, and the run says so', () => {
    const { g, calls } = stubs();
    const L = delegation(APP.replace(/\n\s*case 'perfBackToList':[^\n]*/, ''), g);
    click(L, element('BUTTON', { 'data-action': 'perfBackToList' }));
    expect(calls).toEqual([]);
  });

  it('(control) without the key delegate, Enter on a card is lost', () => {
    const withoutKeys = APP.replace(/document\.addEventListener\('keydown', function delegateKey\(e\) \{[\s\S]*?\n  \}\);/, '');
    const L = delegation(withoutKeys, stubs().g);
    const card = element('DIV', { role: 'button', tabindex: '0', 'data-action': 'medOpenProfile', 'data-id': 'p-2' });
    key(L, card, 'Enter');
    expect(card.clicks).toBe(0);
  });
});
