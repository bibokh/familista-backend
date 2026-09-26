// FAMILISTA VISION — the interface's own promises, pinned
// ─────────────────────────────────────────────────────────────────────────────
// The backend tests in `familista-vision.unit.test.ts` pin what the platform
// reports. These pin what the SCREEN is allowed to do with it, because a
// presentation layer is exactly where a careful system starts being careless:
// an empty card gets a zero to look finished, a withheld coordinate gets an
// estimate to fill a gap, and a status that was amber becomes green because the
// dashboard looked nicer that way.
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

const SECTIONS = ['overview', 'live', 'sources', 'sessions', 'tracking', 'ball',
  'calibration', 'teams', 'events', 'tactical', 'heatmaps', 'physical', 'timeline',
  'reports', 'device', 'models', 'integrations'];

describe('every section exists and is routed', () => {
  it('routes all seventeen', () => {
    const routes = JS.slice(JS.indexOf('var ROUTES = {'), JS.indexOf('function renderSection'));
    for (const s of SECTIONS) {
      expect(routes).toContain(s + ':');
      expect(JS).toContain('function sec' + s[0].toUpperCase() + s.slice(1));
    }
  });

  it('groups the navigation into the four bands', () => {
    // The bands name the JOB a reader is doing, not the code that produced the
    // screen. They were VISION / TRACKING / ANALYSIS / SYSTEM, which named the
    // latter.
    for (const g of ['COMMAND', 'EVIDENCE', 'INTELLIGENCE', 'OPERATIONS']) {
      expect(JS).toContain("group: '" + g + "'");
    }
  });

  it('carries ONE navigation and no second topbar', () => {
    // A module with its own command bar and its own rail must hide the
    // platform's chrome by the class names the shell actually uses. Naming
    // selectors that exist nowhere hid nothing, and two topbars sat on top of
    // each other.
    expect(CSS).toContain('body.fv-vision-open .topbar');
    expect(CSS).toContain('body.fv-vision-open .sidebar');
    // and not by names that exist nowhere in the shell. Comments are stripped
    // first: the rule's own comment names the wrong selectors in order to say
    // why they were wrong.
    const rules = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toContain('.app-topbar');
    expect(rules).not.toContain('.app-sidebar');
    // One rail in the shell, and the shell holds no horizontal section list.
    const shell = JS.slice(JS.indexOf('function renderShell'), JS.indexOf('function refreshNav'));
    expect(shell.match(/class="fv-nav"/g) || []).toHaveLength(1);
  });

  it('shows the page only when the shell has made it the active one', () => {
    // `.page { display: none }` is how every room in Familista is hidden. An ID
    // selector outranks it, so an unscoped `display: flex` here pinned a
    // full-viewport fixed layer over the whole application — the landing's own
    // cards were painted underneath it.
    expect(CSS).toContain('#pg-familista-vision.active {');
    expect(CSS).not.toMatch(/#pg-familista-vision \{[^}]*display:/);
  });

  it('mounts from the page-render registry, which passes no host', () => {
    // The navigation switch passes the root element; `_famRenderPage` calls
    // every renderer with no argument at all, and that is the path a
    // navigation from Owner Home takes. Guarding on the argument mounted an
    // empty page.
    const mount = JS.slice(JS.indexOf('window.renderFamilistaVision'));
    expect(mount).toContain("host = host || document.getElementById('fv-root')");
  });

  it('gives the command bar the seven readings, and colours only their dots', () => {
    const bar = JS.slice(JS.indexOf('function commandReadings'), JS.indexOf('function refreshBar'));
    for (const k of ['Current session', 'Source', 'Engine', 'Processing target', 'Rate',
      'Evidence health', 'Device']) {
      expect(bar).toContain("Reading('" + k + "'");
    }
    // A reading is a slot in a bar, not a pill: the state paints the dot and
    // gives back the box.
    expect(CSS).toContain('.fv-read[class*="fv-s-"]');
  });

  it('gives every section an icon rather than a bullet', () => {
    const nav = JS.slice(JS.indexOf('var SECTIONS = ['), JS.indexOf('var STRIP'));
    for (const s of SECTIONS) {
      expect(nav).toMatch(new RegExp("id: '" + s + "'[^}]*ico: '"));
    }
  });
});

describe('the design system is a system, not seventeen stylesheets', () => {
  it('exposes the reusable primitives the sections compose', () => {
    for (const fn of ['function Panel(', 'function Metric(', 'function Chip(', 'function Tag(',
      'function Table(', 'function Empty(', 'function Pitch(', 'function Rows(']) {
      expect(JS).toContain(fn);
    }
  });

  it('defines its tokens once, on the module root', () => {
    const block = CSS.slice(CSS.indexOf('#pg-familista-vision, .fv-drawer'), CSS.indexOf('body.fv-vision-open'));
    for (const token of ['--fv-accent:', '--fv-measured:', '--fv-propagated:', '--fv-withheld:',
      '--fv-crit:', '--fv-unver:', '--fv-gap:', '--fv-r:']) {
      expect(block).toContain(token);
    }
  });

  it('keeps one spacing grid rather than ad-hoc pixels', () => {
    // ONE 8px grid, declared once. 4px exists for a hairline of separation and
    // nothing else.
    for (const token of ['--fv-1:          4px;', '--fv-2:          8px;', '--fv-3:         16px;',
      '--fv-4:         24px;', '--fv-5:         32px;']) {
      expect(CSS).toContain(token);
    }
    expect(CSS).toContain('--fv-gap:        8px;');
    expect(CSS).toContain('--fv-pad:       16px;');
  });
});

describe('the interface never fabricates a value', () => {
  it('renders a figure the platform does not hold as an em dash, not a zero', () => {
    const fn = JS.slice(JS.indexOf('function n(v, digits)'), JS.indexOf('function pct('));
    expect(fn).toContain('fv-none');
    expect(fn).toContain('—');
    // The guard comes BEFORE any numeric formatting, so a null can never fall
    // through into `toFixed` and arrive on screen as "0.00".
    expect(fn.indexOf('fv-none')).toBeLessThan(fn.indexOf('toFixed'));
  });

  it('has no placeholder football statistics anywhere in the module', () => {
    // The words a decorative dashboard reaches for when a card looks empty.
    for (const forbidden of ['Math.random', 'lorem ', 'fakeData', 'mockData',
      'dummyData', 'sampleStats', 'demoData']) {
      expect(JS).not.toContain(forbidden);
    }
    // `placeholder` appears, and only ever as the HTML attribute on a search
    // box. Anywhere else it would be placeholder DATA, which is the thing this
    // whole module exists to avoid.
    for (const hit of JS.match(/placeholder[^\s]*/g) || []) {
      expect(hit).toMatch(/^placeholder="/);
    }
  });

  it('offers no rating, score or attribute field', () => {
    for (const forbidden of ['playerRating', 'overallQuality', 'visionScore', 'decisionsScore',
      'composureScore', 'passingScore', 'finishingScore', 'staminaScore']) {
      expect(JS).not.toContain(forbidden);
    }
  });

  it('labels a session-level calibration verdict as DERIVED', () => {
    // The engine publishes a verdict per FRAME. The session-level VALID /
    // DEGRADED / NONE summary is the interface's own, and saying so is the
    // difference between a summary and a claim.
    const sec = JS.slice(JS.indexOf('function secCalibration'), JS.indexOf('function secTeams'));
    expect(sec).toContain("Tag('DERIVED', 'derived')");
    expect(sec).toContain('the engine publishes no');
  });

  it('never merges OBSERVED with PROPAGATED into one figure', () => {
    const sec = JS.slice(JS.indexOf('function secBall'), JS.indexOf('function secCalibration'));
    expect(sec).toContain("['OBSERVED'");
    expect(sec).toContain("['PROPAGATED'");
    // The warning opens the section and rides the scroll, because the table it
    // qualifies is read below it.
    expect(sec).toContain('PROXIMITY \u2260 POSSESSION');
    expect(sec).toContain('fv-banner--sticky');
    expect(CSS).toContain('.fv-banner--sticky');
    expect(sec).not.toMatch(/OBSERVED[^\n]*\+[^\n]*PROPAGATED/);
  });

  it('breaks a ball trajectory wherever the record breaks', () => {
    const sec = JS.slice(JS.indexOf('function secBall'), JS.indexOf('function secCalibration'));
    expect(sec).toContain('b.frameNumber - prev.frameNumber > 2');
    expect(sec).toContain('picture of an assumption');
  });

  it('offers no overlay toggle for data the session lacks', () => {
    const fn = JS.slice(JS.indexOf('function availableOverlays'), JS.indexOf('function secLive'));
    expect(fn).toContain('caps.metricCoordinates');
    expect(fn).toContain("filter(function (o) { return o.ok; })");
  });

  it('says the original feed is not served rather than drawing a black rectangle', () => {
    expect(JS).toContain('ORIGINAL FEED NOT SERVED BY THIS DEPLOYMENT');
  });
});

describe('accessibility', () => {
  it('never signals status by colour alone', () => {
    const chip = JS.slice(JS.indexOf('function Chip('), JS.indexOf('function Tag('));
    expect(chip).toContain('fv-chip-glyph');   // a shape
    expect(chip).toContain('fv-chip-state');   // and a word
    expect(JS).toContain('var GLYPH = {');
  });

  it('keeps a visible focus ring and never removes the outline', () => {
    expect(CSS).toContain(':focus-visible');
    expect(CSS).toContain('outline: 2px solid var(--fv-accent)');
    expect(CSS).not.toMatch(/outline:\s*(none|0)\b/);
  });

  it('marks the current section for assistive technology, not just visually', () => {
    expect(JS).toContain('aria-current="page"');
    expect(JS).toContain("aria-label=\"Familista Vision sections\"");
  });

  it('gives every table a caption and column scopes', () => {
    const fn = JS.slice(JS.indexOf('function Table('), JS.indexOf('function needSession'));
    expect(fn).toContain('<caption>');
    expect(fn).toContain('scope="col"');
  });

  it('labels every filter control', () => {
    const controls = JS.match(/<(select|input)[^>]*class="fv-(select|input)"[^>]*>/g) || [];
    expect(controls.length).toBeGreaterThan(4);
    for (const c of controls) {
      expect(c).toMatch(/aria-label=|id="fv-f-/);
    }
  });

  it('supports reduced motion by removing every animation', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
    const block = CSS.slice(CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toContain('animation: none !important');
  });

  it('can be driven from the keyboard in Live Analysis', () => {
    expect(JS).toContain("e.key === 'ArrowRight'");
    expect(JS).toContain("e.key === 'Escape'");
  });
});

describe('performance', () => {
  it('windows long tables rather than laying out ten thousand rows', () => {
    expect(JS).toContain('var TABLE_WINDOW');
    const fn = JS.slice(JS.indexOf('function Table('), JS.indexOf('function needSession'));
    expect(fn).toContain('rows.slice(0,');
    // A truncated table that did not say so would have lied about its size.
    expect(fn).toContain('nothing was dropped');
  });

  it('opens no stream and polls nothing', () => {
    expect(JS).not.toContain('setInterval');
    expect(JS).not.toContain('WebSocket');
    expect(JS).not.toContain('EventSource');
  });

  it('animates only where a link is genuinely live', () => {
    expect(CSS).toContain('.fv-conduit--live');
    expect(JS).toContain("f.status === 'LIVE' ? ' fv-conduit--live'");
  });
});

describe('the module stays inside the Familista shell', () => {
  it('is still the sixth top-level card, routed and mounted the same way', () => {
    expect(APP).toContain("'familista-vision': 1,");
    expect(APP).toContain("'familista-vision':            ['renderFamilistaVision'],");
    expect(APP).toContain('renderFamilistaVisionHTML');
    expect(APP).toContain('oh-card--vision');
  });

  it('keeps the platform own mount and teardown convention', () => {
    expect(JS).toContain('window.renderFamilistaVision = function (host)');
    expect(JS).toContain('window.teardownFamilistaVision');
  });

  it('is loaded by the page and carries its own i18n boundary', () => {
    expect(INDEX).toContain('/familista-vision/familista-vision.css');
    expect(INDEX).toContain('/familista-vision/familista-vision.js');
    expect(APP).toContain('id="pg-familista-vision" data-no-i18n');
  });

  it('names no model checkpoint in the frontend', () => {
    expect(JS).not.toMatch(/\.pt["']|\.pth["']/);
    expect(JS).not.toContain('yolo11');
  });

  it('exposes no filesystem path', () => {
    expect(JS).not.toContain('/home/');
    expect(JS).not.toContain('/usr/');
  });
});

describe('responsive layout', () => {
  it('collapses the sidebar before it crushes the workspace', () => {
    expect(CSS).toContain('@media (max-width: 1080px)');
    const block = CSS.slice(CSS.indexOf('@media (max-width: 1080px)'), CSS.indexOf('@media (max-width: 860px)'));
    expect(block).toContain('.fv-nav-label, .fv-nav-group, .fv-nav-badge { display: none; }');
  });

  it('returns the page to document scrolling on a phone rather than shrinking the desktop', () => {
    const block = CSS.slice(CSS.indexOf('@media (max-width: 860px)'), CSS.indexOf('@media (max-width: 520px)'));
    expect(block).toContain('position: static');
    expect(block).toContain('flex-direction: row');   // nav becomes a strip
    expect(block).toContain('position: sticky');      // and it stays reachable
  });

  it('keeps the live status strip at every width', () => {
    const block = CSS.slice(CSS.indexOf('@media (max-width: 860px)'));
    expect(block).not.toContain('.fv-strip { display: none');
  });

  it('collapses split layouts before they become two cramped columns', () => {
    expect(CSS).toContain('@media (max-width: 1180px)');
  });
});
