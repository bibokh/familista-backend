/**
 * tests/fam-telemetry.unit.test.ts
 *
 * The interaction layer, executed rather than read.
 *
 * `public/fam-telemetry.js` is the file that decides what Familista records
 * about a person using it — every click, every window of pointer movement,
 * every scroll threshold, every hover dwell. Two things about it have to be
 * true and neither can be established by reading it carefully once:
 *
 *   1. It CANNOT record content. Not "does not today" — cannot, because every
 *      string that reaches an event field passes one guard and that guard
 *      rejects anything with a space in it.
 *
 *   2. It AGGREGATES. A minute of continuous mouse movement is a bounded
 *      number of events, not four hundred samples. A page scrolled up and down
 *      for a minute is at most four events. A pointer resting on nothing
 *      declared is nothing at all.
 *
 * So the file is loaded into a hand-built DOM and driven: real listeners, real
 * throttles, real timers, real windows opening and closing. What the assertions
 * read is what `FamilistaAnalytics.event` was actually called with, which is
 * the exact surface that reaches the server.
 *
 * There is no jsdom in this repository and this does not add one. The stub
 * below is forty lines and implements only what this file touches — which is
 * itself worth knowing, because a telemetry layer that needed a whole browser
 * to be exercised would be a telemetry layer nobody exercised.
 */

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const SOURCE = read('public/fam-telemetry.js');

// ── the smallest DOM this file can run in ────────────────────────────────────

interface Recorded { eventName: string; module?: string; feature?: string; durationMs?: number; route?: string }

/** Selectors this file actually uses: tag, .class, #id, [attr], [attr="v"], and commas. */
function matchOne(el: FakeEl, sel: string): boolean {
  const parts = sel.trim().split(/(?=[.#[])/).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith('#')) { if (el.id !== part.slice(1)) return false; }
    else if (part.startsWith('.')) { if (!el.classes.includes(part.slice(1))) return false; }
    else if (part.startsWith('[')) {
      const m = /^\[([A-Za-z0-9_-]+)(?:=["']?([^\]"']*)["']?)?\]$/.exec(part);
      if (!m) return false;
      const have = el.attrs[m[1]];
      if (have === undefined) return false;
      if (m[2] !== undefined && have !== m[2]) return false;
    } else if (part !== '*' && el.tag !== part.toLowerCase()) return false;
  }
  return true;
}

class FakeEl {
  tag: string;
  attrs: Record<string, string> = {};
  children: FakeEl[] = [];
  parentNode: FakeEl | null = null;
  nodeType = 1;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;

  constructor(tag: string, attrs: Record<string, string> = {}) {
    this.tag = tag.toLowerCase();
    this.attrs = { ...attrs };
  }
  get id(): string { return this.attrs.id || ''; }
  get classes(): string[] { return (this.attrs.class || '').split(/\s+/).filter(Boolean); }
  getAttribute(n: string): string | null { return n in this.attrs ? this.attrs[n] : null; }
  hasAttribute(n: string): boolean { return n in this.attrs; }
  matches(sel: string): boolean { return sel.split(',').some((s) => matchOne(this, s)); }
  closest(sel: string): FakeEl | null {
    let node: FakeEl | null = this;
    while (node) { if (node.matches(sel)) return node; node = node.parentNode; }
    return null;
  }
  private descendants(): FakeEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelector(sel: string): FakeEl | null {
    return this.descendants().find((d) => d.matches(sel)) ?? null;
  }
  append(...kids: FakeEl[]): this {
    for (const k of kids) { k.parentNode = this; this.children.push(k); }
    return this;
  }
}

function makeHarness(root: FakeEl) {
  const events: Recorded[] = [];
  const docHandlers: Record<string, Array<(e: unknown) => void>> = {};
  const winHandlers: Record<string, Array<(e: unknown) => void>> = {};

  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    scrollingElement: root,
    documentElement: root,
    addEventListener(type: string, fn: (e: unknown) => void) {
      (docHandlers[type] ||= []).push(fn);
    },
    querySelector: (sel: string) => root.matches(sel) ? root : root.querySelector(sel),
  };

  const window: Record<string, unknown> = {
    location: { pathname: '/app' },
    State: { context: { clubId: 'club-1', teamId: null } },
    FamilistaAnalytics: {
      event(eventName: string, fields: Record<string, unknown>) {
        events.push({ eventName, ...(fields as object) } as Recorded);
      },
    },
    addEventListener(type: string, fn: (e: unknown) => void) {
      (winHandlers[type] ||= []).push(fn);
    },
    document,
  };
  window.window = window;

  const ctx = vm.createContext({
    window, document, setTimeout, clearTimeout, Date, Math, Object, String, Number, JSON, RegExp,
  });
  vm.runInContext(SOURCE, ctx);

  const fire = (type: string, target: FakeEl | null) => {
    for (const fn of docHandlers[type] || []) fn({ target });
  };
  const fireWindow = (type: string) => {
    for (const fn of winHandlers[type] || []) fn({});
  };

  return {
    events, fire, fireWindow, document, window,
    api: window.FamTelemetry as Record<string, (...a: unknown[]) => unknown>,
    names: () => events.map((e) => e.eventName),
    last: () => events[events.length - 1],
    reset: () => { events.length = 0; },
  };
}

/** A squad page with one declared player card inside it. */
function squadPage() {
  const card = new FakeEl('button', {
    'data-action': 'openPlayerModal', 'data-id': 'p1',
    'data-fam-region': 'player-card', 'data-fam-card': 'player',
  });
  const page = new FakeEl('div', { class: 'page active', id: 'pg-squad' });
  page.append(card);
  page.scrollHeight = 2000;
  page.clientHeight = 1000;
  return { page, card };
}

beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });

// ─────────────────────────────────────────────────────────────────────────────

describe('the guard that makes content impossible', () => {
  const { api } = makeHarness(squadPage().page);

  test('an identifier passes and a sentence does not', () => {
    for (const ok of ['sqCmdTab', 'player-card', 'depth_50', 'squad.export', 'U15:home']) {
      expect(`${ok}: ${api._identifier(ok)}`).toBe(`${ok}: ${ok}`);
    }
    // Everything a person could have typed, or a screen could have said.
    const refused = [
      'Please enter email and password',
      'Mohammed Al-Rashid',
      'hunter2 ',                 // whitespace: not something an author wrote
      ' hunter2',
      'söka efter spelare',
      '  ',
      '',
      'a'.repeat(200),
      '<script>alert(1)</script>',
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0',
      "'; DROP TABLE AnalyticsEvent; --",
      'line one\nline two',
    ];
    for (const bad of refused) {
      expect(`${JSON.stringify(bad).slice(0, 30)}: ${api._identifier(bad)}`)
        .toBe(`${JSON.stringify(bad).slice(0, 30)}: null`);
    }
  });

  test('what the guard does NOT cover, and what covers it instead', () => {
    // Stated plainly rather than implied: a bare single token with no spaces
    // IS a valid identifier, so the guard alone would not recognise a password
    // typed without a space in it. What makes that unreachable is the second
    // property of this file — it reads no value from any element, ever. The
    // guard stops content that arrives through an ATTRIBUTE; the absence of
    // value readers stops content arriving at all. Neither is load-bearing on
    // its own, and the test above pins the second.
    expect(api._identifier('hunter2')).toBe('hunter2');
    // The second property, stated as the assertion it is.
    expect(decomment(SOURCE)).not.toContain('.value');
  });

  test('a key is capped, so a long token cannot smuggle a value either', () => {
    expect(api._identifier('a'.repeat(48))).toBe('a'.repeat(48));
    expect(api._identifier('a'.repeat(49))).toBeNull();
  });

  test('camelCase becomes readable without ceasing to be an identifier', () => {
    expect(api._kebab('sqCmdTab')).toBe('sq-cmd-tab');
    expect(api._kebab('openPlayerModal')).toBe('open-player-modal');
    expect(api._kebab('a sentence')).toBeNull();
  });
});

describe('the source reads no content and listens to no keyboard', () => {
  const src = decomment(SOURCE);

  test('it never reads a value, a label or any text from the DOM', () => {
    for (const forbidden of [
      '.value', 'textContent', 'innerText', 'innerHTML',
      'placeholder', 'aria-label', '.title', '.alt',
      'FormData', 'elements[',
    ]) {
      expect(`${forbidden}: ${src.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });

  test('it registers no keyboard, clipboard or input-value listener', () => {
    for (const forbidden of ['keydown', 'keyup', 'keypress', 'paste', 'copy', 'cut', 'beforeinput']) {
      expect(`${forbidden}: ${src.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    // `input` as an EVENT would fire per keystroke. The form hook uses
    // `focusin`, which fires once when a field is entered.
    expect(src).not.toMatch(/addEventListener\(\s*'input'/);
    expect(src).toMatch(/addEventListener\(\s*'focusin'/);
  });

  test('it records no coordinate of any kind', () => {
    for (const forbidden of [
      'clientX', 'clientY', 'pageX', 'pageY', 'screenX', 'screenY',
      'offsetX', 'offsetY', 'getBoundingClientRect',
    ]) {
      expect(`${forbidden}: ${src.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
  });

  test('every event it can emit is declared in the server vocabulary', () => {
    const contracts = read('src/platform/analytics/contracts.ts');
    const declared = new Set(
      (contracts.match(/'[a-z][a-z0-9_]*'/g) || []).map((q) => q.slice(1, -1)),
    );
    const emitted = new Set(
      (src.match(/emit\(\s*'([a-z_]+)'/g) || []).map((m) => m.replace(/.*'([a-z_]+)'.*/, '$1')),
    );
    // `emit('client_error', …)` and the branch that builds `'depth_' + t` are
    // both here; the latter is a feature key, not an event name.
    expect(emitted.size).toBeGreaterThan(10);
    for (const name of emitted) {
      expect(`${name} declared: ${declared.has(name)}`).toBe(`${name} declared: true`);
    }
  });
});

describe('STAGE 3 — a click becomes one semantic event', () => {
  test('a declared tab is a tab change, carrying the key and not the label', () => {
    const { page } = squadPage();
    const tab = new FakeEl('div', { class: 'pm2-tab', 'data-fam-tab': 'statistics' });
    page.append(tab);
    const h = makeHarness(page);

    h.fire('click', tab);
    expect(h.names()).toEqual(['tab_changed']);
    expect(h.last().feature).toBe('statistics');
    expect(h.last().module).toBe('squad');
  });

  test("an undeclared control is classified from the app's own action name", () => {
    const { page } = squadPage();
    const cases: Array<[string, string]> = [
      ['sqCmdTab', 'tab_changed'],
      ['closeOnboardClubModal', 'modal_closed'],
      ['openOnboardClubModal', 'modal_opened'],
      ['trArrangeMenu', 'menu_opened'],
      ['sqCmdWinClose', 'panel_closed'],
      ['sqSimPanel', 'panel_opened'],
      ['playerEditSave', 'save_attempted'],
      ['sqTacShare', 'action_invoked'],
      ['openMatchModal', 'match_card_opened'],
    ];
    for (const [action, expected] of cases) {
      const btn = new FakeEl('button', { 'data-action': action });
      page.append(btn);
      const h = makeHarness(page);
      h.fire('click', btn);
      expect(`${action} → ${h.names().join(',')}`).toBe(`${action} → ${expected}`);
    }
  });

  test('navigation clicks are silent, because navTo reports the navigation', () => {
    const { page } = squadPage();
    const nav = new FakeEl('div', { class: 'nav-item', 'data-nav': 'training', 'data-page': 'training' });
    page.append(nav);
    const h = makeHarness(page);

    // Reporting the click as well would double every module open, and the
    // click is an intention where navTo is a fact.
    h.fire('click', nav);
    expect(h.names()).toEqual([]);

    (h.api.nav as (p: string) => void)('training-centre');
    expect(h.names()).toEqual(['route_changed', 'page_viewed']);
    expect(h.last().module).toBe('training-centre');
  });

  test('club entry, sign-in and sign-out are reported by the code that did them', () => {
    const { page } = squadPage();
    for (const action of ['openClub', 'doLogin', 'doLogout']) {
      const btn = new FakeEl('button', { 'data-action': action });
      page.append(btn);
      const h = makeHarness(page);
      h.fire('click', btn);
      expect(`${action}: ${h.names().length}`).toBe(`${action}: 0`);
    }

    const h = makeHarness(page);
    (h.api.auth as (k: string) => void)('in');
    (h.api.club as (a: string, b: string) => void)('club-2', 'club-1');
    (h.api.auth as (k: string) => void)('out');
    expect(h.names()).toEqual(['login_succeeded', 'club_exited', 'club_entered', 'logout']);
  });

  test('an opted-out subtree records nothing at all', () => {
    const { page } = squadPage();
    const quiet = new FakeEl('div', { 'data-fam-none': '' });
    const btn = new FakeEl('button', { 'data-action': 'sqTacShare' });
    quiet.append(btn);
    page.append(quiet);
    const h = makeHarness(page);

    h.fire('click', btn);
    expect(h.names()).toEqual([]);
  });

  test('a form is entered once and submitted once, and no field is read', () => {
    const { page } = squadPage();
    const form = new FakeEl('form', { id: 'playerEdit', 'data-fam-form': 'player-edit' });
    const name = new FakeEl('input', { type: 'text' });
    const notes = new FakeEl('textarea', {});
    form.append(name, notes);
    page.append(form);
    const h = makeHarness(page);

    h.fire('focusin', name);
    h.fire('focusin', notes);           // same form: already started
    h.fire('submit', form);
    expect(h.names()).toEqual(['form_started', 'save_attempted']);
    expect(h.last().feature).toBe('player-edit');
  });

  test('a form containing a password field is not keyed at all', () => {
    const { page } = squadPage();
    const form = new FakeEl('form', { id: 'login', 'data-fam-form': 'sign-in' });
    const email = new FakeEl('input', { type: 'text' });
    form.append(email, new FakeEl('input', { type: 'password' }));
    page.append(form);
    const h = makeHarness(page);

    h.fire('focusin', email);
    expect(h.names()).toEqual([]);
  });

  test('a drop reports the destination slot, never where the pointer was', () => {
    const { page } = squadPage();
    const chip = new FakeEl('div', { 'data-fam-drag': 'player', draggable: 'true' });
    const slot = new FakeEl('div', { 'data-fam-drop': 'left-back' });
    page.append(chip, slot);
    const h = makeHarness(page);

    h.fire('dragstart', chip);
    h.fire('drop', slot);
    expect(h.names()).toEqual(['player_moved']);
    expect(h.last().feature).toBe('left-back');
    expect(Object.keys(h.last())).not.toContain('x');
  });
});

describe('STAGE 4 — pointer movement is a window, not a stream', () => {
  test('a hundred movements produce one event carrying a duration', () => {
    const { page, card } = squadPage();
    const h = makeHarness(page);

    // A second of continuous movement, delivered as fast as a browser
    // possibly could — thirty-three times, at the 30ms a high-rate mouse
    // manages. The throttle looks at six or seven of them and the window
    // absorbs the rest.
    for (let i = 0; i < 33; i++) {
      h.fire('pointermove', card);
      jest.advanceTimersByTime(30);
    }
    expect(h.names()).toEqual([]);          // nothing yet: the window is open

    jest.advanceTimersByTime(2000);          // …and now it has gone idle
    expect(h.names()).toEqual(['pointer_active']);
    expect(h.last().feature).toBe('player-card');
    expect(typeof h.last().durationMs).toBe('number');
    expect(h.last().durationMs).toBeGreaterThan(0);
  });

  test('movement that never pauses still reports, on the window ceiling', () => {
    const { page, card } = squadPage();
    const h = makeHarness(page);
    const limits = h.api._limits() as Record<string, number>;

    // Ten seconds without a single pause. A window that only closed on idle
    // would report nothing at all here, which is the opposite of what a live
    // board is for — so it also closes on its own maximum.
    for (let i = 0; i < 200; i++) {
      h.fire('pointermove', card);
      jest.advanceTimersByTime(50);
    }
    const n = h.names().filter((x) => x === 'pointer_active').length;
    expect(n).toBe(Math.floor(10_000 / limits.POINTER_WINDOW_MS));
  });

  test('a still pointer emits nothing, so a quiet platform shows a quiet board', () => {
    const { page } = squadPage();
    const h = makeHarness(page);
    jest.advanceTimersByTime(60_000);
    expect(h.names()).toEqual([]);
  });

  test('a minute of unbroken movement is bounded, not four hundred samples', () => {
    const { page, card } = squadPage();
    const h = makeHarness(page);

    for (let i = 0; i < 1200; i++) {         // 60s at 50ms per movement
      h.fire('pointermove', card);
      jest.advanceTimersByTime(50);
    }
    jest.advanceTimersByTime(2000);

    const limits = h.api._limits() as Record<string, number>;
    const pointerEvents = h.names().filter((n) => n === 'pointer_active');
    expect(pointerEvents.length).toBeLessThanOrEqual(limits.POINTER_PER_MIN + 1);
    expect(pointerEvents.length).toBeGreaterThan(0);
  });

  test('the region is the declared one, or the module, and never an element', () => {
    const { page } = squadPage();
    const plain = new FakeEl('span', {});
    page.append(plain);
    const h = makeHarness(page);

    h.fire('pointermove', plain);
    jest.advanceTimersByTime(200);
    h.fire('pointermove', plain);
    jest.advanceTimersByTime(2000);

    expect(h.names()).toEqual(['pointer_active']);
    expect(h.last().feature).toBe('squad');   // the module, because nothing was declared
  });

  test('leaving a module closes the window rather than carrying it to the next', () => {
    const { page, card } = squadPage();
    const h = makeHarness(page);

    h.fire('pointermove', card);
    jest.advanceTimersByTime(300);
    h.fire('pointermove', card);
    (h.api.nav as (p: string) => void)('training-centre');

    // The pointer window is closed and attributed to Squad, BEFORE the
    // navigation events — not held open and billed to Training.
    expect(h.names()).toEqual(['pointer_active', 'route_changed', 'page_viewed']);
    expect(h.events[0].feature).toBe('player-card');
  });
});

describe('STAGE 4 — scroll is a threshold, not a position', () => {
  test('each of 25/50/75/100 fires once, and scrolling back fires nothing', () => {
    const { page } = squadPage();
    const h = makeHarness(page);

    const scrollTo = (pct: number) => {
      page.scrollTop = (page.scrollHeight - page.clientHeight) * (pct / 100);
      jest.advanceTimersByTime(300);
      h.fire('scroll', page);
    };

    scrollTo(30);
    scrollTo(60);
    scrollTo(80);
    scrollTo(100);
    expect(h.names()).toEqual(['scroll_depth', 'scroll_depth', 'scroll_depth', 'scroll_depth']);
    expect(h.events.map((e) => e.feature)).toEqual(['depth-25', 'depth-50', 'depth-75', 'depth-100']);

    h.reset();
    // Up and down for a minute crosses no NEW threshold.
    for (let i = 0; i < 60; i++) { scrollTo(i % 2 ? 10 : 95); }
    expect(h.names()).toEqual([]);
  });

  test('no offset, no pixel count and no scroll height reaches an event', () => {
    const { page } = squadPage();
    const h = makeHarness(page);
    // Past the end of a 1000px scrollable range: the depth clamps to 100%, so
    // all four thresholds are crossed at once and the offset itself — the one
    // number that would locate this person on the page — is nowhere in any of
    // the four events.
    page.scrollTop = 1234;
    jest.advanceTimersByTime(300);
    h.fire('scroll', page);

    expect(h.names()).toEqual(['scroll_depth', 'scroll_depth', 'scroll_depth', 'scroll_depth']);
    for (const e of h.events) {
      expect(JSON.stringify(e)).not.toContain('1234');
      expect(JSON.stringify(e)).not.toContain('2000');
      expect(e.feature).toMatch(/^depth-(25|50|75|100)$/);
    }
  });

  test('a page with nothing to scroll reports no depth at all', () => {
    const { page } = squadPage();
    page.scrollHeight = 900;
    page.clientHeight = 900;
    const h = makeHarness(page);
    jest.advanceTimersByTime(300);
    h.fire('scroll', page);
    expect(h.names()).toEqual([]);
  });

  test('a new module starts its thresholds again', () => {
    const { page } = squadPage();
    const h = makeHarness(page);
    page.scrollTop = page.scrollHeight;
    jest.advanceTimersByTime(300);
    h.fire('scroll', page);
    expect(h.names().length).toBe(4);

    h.reset();
    (h.api.nav as (p: string) => void)('training-centre');
    h.reset();
    page.scrollTop = 0;
    jest.advanceTimersByTime(300);
    h.fire('scroll', page);
    page.scrollTop = page.scrollHeight;
    jest.advanceTimersByTime(300);
    h.fire('scroll', page);
    expect(h.names().length).toBe(4);
  });
});

describe('STAGE 4 — hover is an opt-in, bucketed dwell', () => {
  test('a declared region dwelt on reports a bucket, not the exact time', () => {
    const { page, card } = squadPage();
    const h = makeHarness(page);
    const elsewhere = new FakeEl('span', {});
    page.append(elsewhere);

    h.fire('pointerover', card);
    jest.advanceTimersByTime(1417);
    h.fire('pointerover', elsewhere);

    expect(h.names()).toEqual(['region_dwell']);
    expect(h.last().feature).toBe('player-card');
    // 1,417ms is a fingerprint; "up to 2 seconds" is the attention signal.
    expect(h.last().durationMs).toBe(2000);
  });

  test('undeclared DOM produces nothing however long the pointer rests on it', () => {
    const { page } = squadPage();
    const plain = new FakeEl('div', { class: 'some-panel' });
    const other = new FakeEl('div', {});
    page.append(plain, other);
    const h = makeHarness(page);

    h.fire('pointerover', plain);
    jest.advanceTimersByTime(30_000);
    h.fire('pointerover', other);
    expect(h.names()).toEqual([]);
  });

  test('passing through a region is not attention', () => {
    const { page, card } = squadPage();
    const elsewhere = new FakeEl('span', {});
    page.append(elsewhere);
    const h = makeHarness(page);

    h.fire('pointerover', card);
    jest.advanceTimersByTime(120);            // below the floor
    h.fire('pointerover', elsewhere);
    expect(h.names()).toEqual([]);
  });

  test('moving inside one region does not restart or re-report it', () => {
    const { page, card } = squadPage();
    const inner = new FakeEl('span', {});
    card.append(inner);
    const elsewhere = new FakeEl('b', {});
    page.append(elsewhere);
    const h = makeHarness(page);

    h.fire('pointerover', card);
    jest.advanceTimersByTime(600);
    h.fire('pointerover', inner);             // same region, deeper element
    jest.advanceTimersByTime(600);
    h.fire('pointerover', elsewhere);

    expect(h.names()).toEqual(['region_dwell']);
    expect(h.last().durationMs).toBe(2000);   // one dwell of ~1.2s, bucketed
  });
});

describe('the ceilings hold', () => {
  test('a pathological screen cannot flood the table', () => {
    const { page } = squadPage();
    const btn = new FakeEl('button', { 'data-action': 'sqTacShare' });
    page.append(btn);
    const h = makeHarness(page);
    const limits = h.api._limits() as Record<string, number>;

    for (let i = 0; i < 1000; i++) h.fire('click', btn);
    expect(h.names().length).toBe(limits.ACTION_PER_MIN);
  });

  test('a failing screen cannot turn an outage into a write storm', () => {
    const { page } = squadPage();
    const h = makeHarness(page);
    const limits = h.api._limits() as Record<string, number>;

    for (let i = 0; i < 500; i++) (h.api.error as (c: string) => void)('SERVER');
    expect(h.names().length).toBe(limits.ERROR_PER_MIN);
  });

  test('every dial is a stated number rather than an emergent one', () => {
    const { api } = makeHarness(squadPage().page);
    expect(api._limits()).toEqual({
      POINTER_SAMPLE_MS: 150, POINTER_IDLE_MS: 1200, POINTER_WINDOW_MS: 3000, POINTER_PER_MIN: 20,
      SCROLL_THROTTLE_MS: 200, SCROLL_THRESHOLDS: [25, 50, 75, 100], SCROLL_PER_MIN: 12,
      HOVER_MIN_MS: 400, HOVER_BUCKETS: [500, 1000, 2000, 5000, 10000, 30000], HOVER_PER_MIN: 12,
      ACTION_PER_MIN: 60, NAV_PER_MIN: 40, ERROR_PER_MIN: 10,
      KEY_MAX: 48,
    });
  });
});

describe('the product calls it, and the product cannot be broken by it', () => {
  test('app.js reports the five facts a listener cannot see', () => {
    const app = decomment(read('public/app.js'));
    for (const call of [
      "FamTelemetry.auth('in')",
      "FamTelemetry.auth('failed')",
      "FamTelemetry.auth('out')",
      'FamTelemetry.club(clubId, _leaving)',
      'FamTelemetry.nav(page)',
      "FamTelemetry.card('player')",
      'FamTelemetry.error(this.code)',
    ]) {
      expect(`${call}: ${app.includes(call)}`).toBe(`${call}: true`);
    }
  });

  test('the API error hook carries the code and never the message', () => {
    const app = decomment(read('public/app.js'));
    const hook = /FamTelemetry\.error\(([^)]*)\)/.exec(app);
    expect(hook?.[1]).toBe('this.code');
    expect(app).not.toContain('FamTelemetry.error(this.message');
    expect(app).not.toContain('FamTelemetry.error(this.userMessage');
  });

  test('the page loads it, after the analytics file it delegates to', () => {
    const html = read('public/index.html');
    expect(html).toContain('fam-telemetry.js');
    expect(html.indexOf('analytics.js')).toBeLessThan(html.indexOf('fam-telemetry.js'));
  });

  test('it is the only way telemetry leaves the browser', () => {
    const src = decomment(SOURCE);
    // No second transport: no fetch, no beacon, no XHR, no socket of its own.
    for (const forbidden of ['fetch(', 'sendBeacon', 'XMLHttpRequest', 'WebSocket', 'EventSource']) {
      expect(`${forbidden}: ${src.includes(forbidden)}`).toBe(`${forbidden}: false`);
    }
    expect(src).toContain('window.FamilistaAnalytics.event');
  });

  test('signed-out events are kept for the sign-in that follows them', () => {
    const analytics = decomment(read('public/analytics.js'));
    // The token is resolved BEFORE the queue is spliced. The other order threw
    // a failed sign-in away, which is exactly the event worth keeping.
    const tokenAt = analytics.indexOf('var token');
    const spliceAt = analytics.indexOf('queue.splice(0, MAX_QUEUE)');
    expect(tokenAt).toBeGreaterThan(-1);
    expect(spliceAt).toBeGreaterThan(tokenAt);
  });
});
