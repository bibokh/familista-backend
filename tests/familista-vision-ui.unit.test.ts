// FAMILISTA VISION — the interface's own promises, pinned
// ─────────────────────────────────────────────────────────────────────────────
// The backend tests in `familista-vision.unit.test.ts` pin what the platform
// reports. These pin what the SCREEN is allowed to do with it, because a
// presentation layer is exactly where a careful system starts being careless:
// an empty panel gets a zero to look finished, a withheld coordinate gets an
// estimate to fill a gap, and a status that was amber becomes green because the
// screen looked nicer that way.
//
// The module was rebuilt as a workstation — a global bar, a module row, a rail
// of sections, and screens that lead with a football surface rather than a
// table. The NAMES below are the new ones; every rule they protect is the same
// rule as before.
//
// They read the shipped files rather than a build artefact, so a change that
// never reaches `public/` cannot make them pass.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'public/familista-vision/familista-vision.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/familista-vision/familista-vision.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

/** Comments say what a rule is for; they are not the rule. */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const SECTIONS = ['live', 'sessions', 'sources', 'device', 'tracking', 'ball',
  'calibration', 'teams', 'events', 'tactical', 'heatmaps', 'timeline', 'reports',
  'performance', 'health', 'models', 'integrations'];

describe('every section exists and is routed', () => {
  it('routes all seventeen', () => {
    const routes = JS.slice(JS.indexOf('var ROUTES = {'), JS.indexOf('function renderSection'));
    for (const s of SECTIONS) expect(routes).toContain(s + ':');
    expect(JS).toContain('function secLive');
    expect(JS).toContain('function secIntegrations');
  });

  it('groups the rail by what a reader is doing, not by what produced the screen', () => {
    for (const g of ['VISION', 'INTELLIGENCE', 'SYSTEM']) {
      expect(JS).toContain("group: '" + g + "'");
    }
  });

  it('opens on Live Analysis, because the hero is the hero', () => {
    const state = JS.slice(JS.indexOf('var FV = {'), JS.indexOf('/* ── primitives'));
    expect(state).toContain("section: 'live'");
  });

  it('carries ONE navigation and no second topbar', () => {
    // A module with its own global bar, module row and rail must hide the
    // platform's chrome by the class names the shell actually uses.
    expect(CSS).toContain('body.fv-vision-open .topbar');
    expect(CSS).toContain('body.fv-vision-open .sidebar');
    expect(CSS).toContain('body.fv-vision-open .mobile-header');
    expect(CSS_RULES).not.toContain('.app-topbar');
    expect(CSS_RULES).not.toContain('.app-sidebar');
    const shell = JS.slice(JS.indexOf('function renderShell'), JS.indexOf('function refreshRail'));
    expect(shell.match(/class="vx-side"/g) || []).toHaveLength(0); // the rail is built by rail()
    expect((JS.match(/class="vx-side"/g) || []).length).toBe(1);
    expect((JS.match(/class="vx-modules"/g) || []).length).toBe(1);
  });

  it('shows the page only when the shell has made it the active one', () => {
    // `.page { display: none }` is a class selector; an ID rule outranks it, so
    // an unscoped `display` here pinned a full-viewport layer over the whole
    // application and the landing's own cards were painted underneath it.
    expect(CSS).toContain('#pg-familista-vision.active {');
    expect(CSS).not.toMatch(/#pg-familista-vision \{[^}]*display:/);
  });

  it('mounts from the page-render registry, which passes no host', () => {
    const mount = JS.slice(JS.indexOf('window.renderFamilistaVision'));
    expect(mount).toContain("host = host || document.getElementById('fv-root')");
  });

  it('drives the platform\u2019s own search and notifications rather than a second set', () => {
    // A search box that searches nothing is a control with a lie in it.
    expect(JS).toContain("document.getElementById('global-search')");
    expect(JS).toContain('[data-tf-notif-open]');
  });

  it('routes the module row to pages the platform already owns', () => {
    const mods = JS.slice(JS.indexOf('var MODULES = ['), JS.indexOf('var SECTIONS = ['));
    for (const p of ['owner-home', 'source-core', 'clubs', 'data-vault',
      'infrastructure-city', 'familista-vision', 'settings']) {
      expect(mods).toContain("id: '" + p + "'");
      if (p !== 'familista-vision') expect(APP).toContain("'" + p + "'");
    }
    expect(JS).toContain("window.navTo === 'function'");
  });

  it('marks an unsupported entry as unavailable instead of pretending it works', () => {
    const rail = JS.slice(JS.indexOf('var SECTIONS = ['), JS.indexOf('/* ── the global bar'));
    // Every `off:` entry carries a reason, and a disabled control is inert.
    expect(rail).toContain('off:');
    expect(JS).toContain('disabled aria-disabled="true"');
    expect(CSS).toContain('.vx-item[disabled]');
  });

  it('gives every section an icon rather than a bullet', () => {
    const rail = JS.slice(JS.indexOf('var SECTIONS = ['), JS.indexOf('/* ── the global bar'));
    for (const s of SECTIONS) {
      expect(rail).toMatch(new RegExp("id: '" + s + "'[^}]*ico: '"));
    }
  });
});

describe('the design system is a system, not seventeen stylesheets', () => {
  it('exposes the reusable primitives the sections compose', () => {
    for (const fn of ['function Panel(', 'function Stat(', 'function Rows(', 'function Tag(',
      'function Chip(', 'function Empty(', 'function Table(', 'function Pitch(', 'function Bar(']) {
      expect(JS).toContain(fn);
    }
  });

  it('defines its tokens once, on the module root', () => {
    const block = CSS.slice(CSS.indexOf('#pg-familista-vision, .vx-drawer'),
      CSS.indexOf('body.fv-vision-open'));
    for (const token of ['--v-cyan:', '--v-green:', '--v-amber:', '--v-grey:',
      '--v-violet:', '--v-red:', '--v-r:', '--v-2:']) {
      expect(block).toContain(token);
    }
  });

  it('keeps one spacing grid and small radii rather than ad-hoc pixels', () => {
    for (const token of ['--v-1: 4px;', '--v-2: 8px;', '--v-3: 12px;', '--v-4: 16px;', '--v-5: 24px;']) {
      expect(CSS).toContain(token);
    }
    // A workstation, not a card wall: nothing is rounded like a marketing tile.
    expect(CSS).toContain('--v-r:    8px;');
    expect(CSS).toContain('--v-r-sm: 6px;');
  });

  it('puts the football surface first and the table last on every screen', () => {
    // The stage/surface appears before the table in each section's `body(...)`.
    for (const [fn, next] of [['function secTracking', 'function secBall'],
      ['function secBall', 'function secCalibration'],
      ['function secCalibration', 'function secTeams']] as [string, string][]) {
      const sec = JS.slice(JS.indexOf(fn), JS.indexOf(next));
      const surface = sec.indexOf('vx-surface');
      const table = sec.indexOf('Table(');
      expect(surface).toBeGreaterThan(-1);
      expect(table).toBeGreaterThan(surface);
    }
  });

  it('gives the Live hero a stage, a tracking rail and two operational rows', () => {
    const live = JS.slice(JS.indexOf('function secLive'), JS.indexOf('function trackFilters'));
    for (const area of ['vx-ga-stage', 'vx-ga-rail', 'vx-ga-r1', 'vx-ga-r2']) {
      expect(live).toContain(area);
    }
    expect(CSS).toContain('grid-template-areas: "stage rail" "r1 r1" "r2 r2"');
    // The whole grid is on one screen at 1080 rather than stacked off it.
    expect(CSS).toMatch(/grid-template-rows:\s*clamp\(/);
  });
});

describe('the interface never fabricates a value', () => {
  it('renders a figure the platform does not hold as an em dash, not a zero', () => {
    const fn = JS.slice(JS.indexOf('function n(v, digits)'), JS.indexOf('function pct('));
    expect(fn).toContain('vx-none');
    expect(fn).toContain('\u2014');
    expect(fn).toContain('not held by the platform');
    // A measured zero survives: only null/undefined/NaN become a dash.
    expect(fn).toMatch(/v === null \|\| v === undefined/);
  });

  it('has no placeholder football statistics anywhere in the module', () => {
    expect(JS).not.toMatch(/Math\.random|lorem |fakeData|mockData|dummyData|sampleStats|demoData/i);
    for (const m of JS.match(/placeholder/g) || []) expect(m).toBe('placeholder');
    expect((JS.match(/placeholder(?!=")/g) || []).length).toBe(0);
  });

  it('offers no rating, score or attribute field', () => {
    // The engine produces none of these, so the screen has nowhere to put one.
    for (const banned of ['overallRating', 'playerRating', 'visionRating', 'composure',
      'finishing', 'stamina', 'decisionRating']) {
      expect(JS).not.toContain(banned);
    }
  });

  it('shows no speed or distance as a player measurement', () => {
    // The engine measures implied speed only as a calibration guard.
    const perf = JS.slice(JS.indexOf('function secPerformance'), JS.indexOf('ROUTES = {'));
    expect(perf).toContain('NOT YET VALIDATED');
    expect(perf).toContain('GUARD, NOT A METRIC');
    const tracking = JS.slice(JS.indexOf('function secTracking'), JS.indexOf('function secBall'));
    expect(tracking).toContain("['Speed / distance', Tag('NOT VALIDATED', 'future')");
  });

  it('labels a session-level calibration verdict as DERIVED', () => {
    const sec = JS.slice(JS.indexOf('function secCalibration'), JS.indexOf('function secTeams'));
    expect(sec).toContain("Tag('DERIVED', 'derived')");
    expect(sec).toContain('the engine publishes a verdict per FRAME');
  });

  it('never merges OBSERVED with PROPAGATED, and says proximity is not possession', () => {
    const sec = JS.slice(JS.indexOf('function secBall'), JS.indexOf('function secCalibration'));
    expect(sec).toContain("['OBSERVED'");
    expect(sec).toContain("['PROPAGATED'");
    expect(sec).toContain('PROXIMITY \u2260 POSSESSION');
    expect(sec).not.toMatch(/OBSERVED[^\n]*\+[^\n]*PROPAGATED/);
    // The warning opens the section, above the table it qualifies.
    expect(sec.indexOf('PROXIMITY \u2260 POSSESSION')).toBeLessThan(sec.indexOf('Ball samples'));
  });

  it('breaks a ball trajectory wherever the record breaks', () => {
    const fn = JS.slice(JS.indexOf('function ballPath('), JS.indexOf('var HEAT_CX'));
    expect(fn).toContain('b.frameNumber - prev.frameNumber > 2');
    // and the screen says why the line has gaps in it, where a reader sees them
    const ball = JS.slice(JS.indexOf('function secBall'), JS.indexOf('function secCalibration'));
    expect(ball).toContain('picture of an assumption');
  });

  it('offers no layer or mode for data the session lacks', () => {
    expect(JS).toContain("needs: 'metricCoordinates'");
    expect(JS).toContain("needs: 'heatmaps'");
    const modes = JS.slice(JS.indexOf('var MODES = ['), JS.indexOf('function modeRail'));
    expect(modes).toContain('off:');
    expect(JS).toContain("m.id === 'pitch' && !caps.metricCoordinates");
  });

  it('says the source video is not served rather than drawing a black rectangle', () => {
    expect(JS).toContain('SOURCE VIDEO NOT SERVED BY THIS DEPLOYMENT');
  });

  it('draws a heatmap only from calibrated positions, and says so when it cannot', () => {
    const sec = JS.slice(JS.indexOf('function secHeatmaps'), JS.indexOf('function secTimeline'));
    expect(sec).toContain('INSUFFICIENT VALIDATED DATA');
    expect(sec).toContain('an empty cell means no calibrated position landed there');
  });

  it('holds tactical intelligence open rather than filling it with cards', () => {
    const sec = JS.slice(JS.indexOf('function secTactical'), JS.indexOf('function secHeatmaps'));
    expect(sec).toContain('TACTICAL INTELLIGENCE');
    expect(sec).toContain('WAITING FOR VALIDATED EVIDENCE');
  });

  it('reports no latency, because this deployment has no live pipeline to measure', () => {
    expect(JS).toContain('there is no live pipeline to measure');
    expect(JS).not.toMatch(/latency['"]?\s*[:=]\s*\d/i);
  });
});

describe('accessibility', () => {
  it('never signals status by colour alone', () => {
    const chip = JS.slice(JS.indexOf('function Chip(label, state'), JS.indexOf('function Panel('));
    expect(chip).toContain('esc(words(s))'); // the state word rides with the dot
    expect(chip).toContain('vx-dot');
  });

  it('keeps a visible focus ring and never removes the outline', () => {
    expect(CSS).toContain(':focus-visible');
    expect(CSS).toContain('outline: 2px solid var(--v-cyan)');
    // A pointer focus may trade the ring for a lit border; a keyboard focus may
    // not, so any removal is scoped to `:not(:focus-visible)`.
    for (const rule of CSS_RULES.split('}')) {
      if (!/outline:\s*(none|0)\b/.test(rule)) continue;
      expect(rule).toContain(':not(:focus-visible)');
    }
  });

  it('marks the current section and module for assistive technology', () => {
    expect(JS).toContain('aria-current="page"');
    expect(JS).toContain('aria-pressed=');
    expect(JS).toContain('role="status"');
  });

  it('gives every table a caption and column scopes', () => {
    const fn = JS.slice(JS.indexOf('function Table('), JS.indexOf('/* ── the pitch'));
    expect(fn).toContain('<caption>');
    expect(fn).toContain('scope="col"');
  });

  it('labels every filter control', () => {
    const controls = JS.match(/<(input|select)[^>]*data-vx-(filter|select|search|scrub)[^>]*>/g) || [];
    expect(controls.length).toBeGreaterThan(4);
    for (const c of controls) expect(c).toMatch(/aria-label=|placeholder=/);
  });

  it('supports reduced motion by removing every animation', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    expect(CSS).toContain('animation: none !important');
  });

  it('keeps a closed drawer out of the tab order', () => {
    // Parked off-screen by transform alone its close button stayed focusable.
    const d = CSS.slice(CSS.indexOf('.vx-drawer {'), CSS.indexOf('.vx-drawer.is-open'));
    expect(d).toContain('visibility: hidden');
  });

  it('can be driven from the keyboard in Live Analysis', () => {
    const fn = JS.slice(JS.indexOf('function onKey('), JS.indexOf('/* ── session and boot'));
    expect(fn).toContain('ArrowRight');
    expect(fn).toContain('ArrowLeft');
    expect(fn).toContain('Escape');
  });
});

describe('the module stays inside its own boundary', () => {
  it('windows long tables rather than laying out ten thousand rows', () => {
    expect(JS).toContain('var TABLE_WINDOW = 300');
    const fn = JS.slice(JS.indexOf('function Table('), JS.indexOf('/* ── the pitch'));
    expect(fn).toContain('nothing was dropped, only not laid out');
  });

  it('opens no stream and polls nothing', () => {
    expect(JS).not.toMatch(/setInterval|EventSource|WebSocket/);
  });

  it('animates only where a link is genuinely live', () => {
    expect(JS).toContain("f.status === 'LIVE' ? ' vx-pipe--live' : ''");
    expect(CSS).toContain('.vx-pipe--live');
  });

  it('is still the sixth top-level card, routed and mounted the same way', () => {
    expect(APP).toContain('oh-card--vision');
    expect(APP).toContain('data-page="familista-vision"');
    expect(APP).toContain("'familista-vision':            ['renderFamilistaVision']");
  });

  it('keeps the platform own mount and teardown convention', () => {
    expect(JS).toContain('window.renderFamilistaVision');
    expect(JS).toContain('window.teardownFamilistaVision');
    expect(APP).toContain('teardownFamilistaVision');
  });

  it('is loaded by the page and carries its own i18n boundary', () => {
    expect(INDEX).toContain('/familista-vision/familista-vision.css');
    expect(INDEX).toContain('/familista-vision/familista-vision.js');
    expect(APP).toContain('id="pg-familista-vision" data-no-i18n');
  });

  it('names no model checkpoint in the frontend', () => {
    // The Model Registry publishes a `weights` field and the Models screen
    // shows it; what the FRONTEND may not do is carry a checkpoint of its own.
    expect(JS).not.toMatch(/['"][^'"\s]*\.(pt|pth|onnx|ckpt|safetensors)['"]/);
  });

  it('exposes no filesystem path', () => {
    expect(JS).not.toMatch(/\/home\/|\/var\/|\/opt\/|C:\\\\/);
  });
});

describe('responsive: it degrades by rearranging, never by crushing', () => {
  it('collapses the rail before it crushes the workspace', () => {
    expect(CSS).toContain('@media (max-width: 1280px)');
    const block = CSS.slice(CSS.indexOf('@media (max-width: 1280px)'), CSS.indexOf('@media (max-width: 900px)'));
    expect(block).toContain('.vx-item-l');
    expect(block).toContain('display: none');
  });

  it('returns the page to document scrolling on a phone rather than shrinking the desktop', () => {
    const block = CSS.slice(CSS.indexOf('@media (max-width: 900px)'), CSS.indexOf('@media (max-width: 560px)'));
    expect(block).toContain('position: static');
    expect(block).toContain('body.fv-vision-open { overflow: auto; }');
  });

  it('keeps the seven workbar readings at every width by wrapping, not hiding', () => {
    expect(CSS).toContain('.vx-workbar-readings');
    expect(CSS).toContain('overflow-x: auto');
    const block = CSS.slice(CSS.indexOf('@media (max-width: 900px)'), CSS.indexOf('@media (max-width: 560px)'));
    expect(block).toContain('.vx-workbar { flex-wrap: wrap; }');
  });

  it('collapses the hero grid to one column before it becomes unreadable', () => {
    const block = CSS.slice(CSS.indexOf('@media (max-width: 1280px)'), CSS.indexOf('@media (max-width: 900px)'));
    expect(block).toContain('.vx-live-grid');
    expect(block).toContain('"stage" "rail" "r1" "r2"');
  });
});
