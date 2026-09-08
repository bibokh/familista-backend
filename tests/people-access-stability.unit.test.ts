/**
 * tests/people-access-stability.unit.test.ts
 *
 * People & Access sat on top of whatever page you were actually looking at.
 *
 * `renderPeopleAccessHTML` returned `class="page active"` — the only page
 * template in the application that shipped itself switched on. `navTo` clears
 * `.active` from every page and THEN mounts the target, so this one arrived
 * active after the clearing had already happened, beside the page that was
 * really open. Two `.page.active` elements, both in flow, both `height:100%`:
 * measured in Chromium, the document became exactly twice the viewport and this
 * page's content sat at y=900, underneath the other one.
 *
 * From there the visible instability follows. `.page` carries
 * `animation: fadeIn .2s ease both`, whose keyframes move `translateY(5px)` to
 * none, and every navigation toggles `display` on every page — so the animation
 * replayed on content stacked below the real screen. And
 * `document.querySelector('.page.active')`, which seven call sites read as "the
 * page the reader is looking at", had two matches to choose between, so
 * repaints landed on a page nobody was looking at.
 *
 * Underneath that, this was also the one workspace that was not a fixed-height
 * column: it scrolled the document, so the members list arriving after the
 * skeleton toggled the window's own scrollbar — and a scrollbar appearing takes
 * its width out of the page and moves every column sideways.
 *
 * Measured after the fix, in real Chromium at 1280x900, sampling 40 frames per
 * state: one `.page.active`, `scrollHeight` 900 against a 900 viewport, and one
 * distinct geometry in every one of the five states — page open, invite modal
 * open, typing, the role dropdown, team scope. Typing eight characters produces
 * zero mutations outside the panel and does not touch the page header.
 *
 * Nothing about permissions, membership, invitations or roles is touched here,
 * and the tests below assert that too.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const PA = fs.readFileSync(path.join(ROOT, 'public/people-access.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'public/app.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

const decomment = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

function rule(selector: string): string {
  const at = CSS.indexOf(selector);
  expect(`${selector} present: ${at > -1}`).toBe(`${selector} present: true`);
  return CSS.slice(at, CSS.indexOf('}', at) + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('1 · exactly one page is active, and navTo decides which', () => {
  it('the template ships the page switched off, like every other one', () => {
    const fn = decomment(PA.slice(PA.indexOf('window.renderPeopleAccessHTML = function () {')));
    expect(fn).toContain('\'<div class="page" id="pg-people-access">\'');
    expect(fn).not.toContain('page active');
  });

  it('and no LAZILY MOUNTED page ships itself active', () => {
    // The defect in one line, so it cannot come back in another module. Video
    // Intelligence had it too and is fixed with this; owner-home still carries
    // it and may, because it is an EAGER page — built at boot, before any
    // navigation, as the landing screen. A lazy page is mounted from inside
    // navTo, after the clearing sweep, which is what makes this fatal there.
    const active = [...APP.matchAll(/<div class="page active" id="pg-([a-z-]+)"/g)].map((m) => m[1]);
    const eager = APP.slice(APP.indexOf('var _EAGER_PAGES = ['), APP.indexOf('];', APP.indexOf('var _EAGER_PAGES = [')));
    for (const slug of active) {
      expect(`${slug} ships active and is eager: ${eager.includes(`'${slug}'`)}`)
        .toBe(`${slug} ships active and is eager: true`);
    }
    expect(APP).not.toContain('<div class="page active" id="pg-video-intelligence"');
    expect(PA).not.toMatch(/<div class="page active"/);
  });

  it('navTo clears every page, then mounts, then activates — in that order', () => {
    // The order is the whole reason a self-activating template is fatal: the
    // clearing has already happened by the time the page is inserted.
    const clear = APP.indexOf("document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));");
    const mount = APP.indexOf('_ensurePageMounted(page)', clear);
    const activate = APP.indexOf("pg.classList.add('active')", mount);
    expect(clear).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(clear);
    expect(activate).toBeGreaterThan(mount);
  });

  it('so the one reader of "the active page" has one answer to read', () => {
    // _famRenderPage is driven by this on every data change. With two matches
    // it repainted whichever came first in the container.
    expect(APP).toContain("var el = document.querySelector('.page.active');");
    expect((APP.match(/querySelector\('\.page\.active'\)/g) || []).length).toBeGreaterThan(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('2 · the page is a fixed-height column, so nothing shifts as it loads', () => {
  it('the shell is the workspace geometry every other module has', () => {
    const shell = rule('#pg-people-access.active{');
    expect(shell).toContain('height:calc(100vh - 92px)');
    expect(shell).toContain('overflow:hidden');
    expect(shell).toContain('display:flex');
  });

  it('and the body scrolls inside itself with the gutter always reserved', () => {
    const body = rule('#pg-people-access.active > .pa-wrap{');
    expect(body).toContain('overflow-y:auto');
    expect(body).toContain('scrollbar-gutter:stable');
    expect(body).toContain('min-height:0');
  });

  it('with the escape hatch a small viewport needs', () => {
    // Below it the page returns to ordinary scrolling rather than crushing the
    // panels — the same hatch CLAUDE.md requires of every workspace.
    expect(CSS).toMatch(/@media \(max-width:980px\), \(max-height:620px\)\{[\s\S]{0,400}#pg-people-access\.active\{ height:auto/);
  });

  it('and the module was not otherwise redesigned', () => {
    // The one width line it already had, kept.
    expect(CSS).toContain('.pa-wrap{ padding:22px 24px 40px; max-width:1240px; margin:0 auto;');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3 · the modal floats, and typing in it touches nothing else', () => {
  it('the scrim is fixed, and neither it nor the panel animates a layout property', () => {
    const scrim = rule('.pa-scrim{');
    expect(scrim).toContain('position:fixed');
    expect(scrim).toContain('inset:0');
    // An animation from the first frame, not a transition waiting on a class.
    expect(scrim).toContain('animation:paFade');
    const panel = rule('.pa-panel{');
    expect(panel).toContain('animation:paRise');
    for (const r of [scrim, panel]) {
      expect(r).not.toMatch(/(transition|animation):[^;]*(width|height|top|left|margin|padding)/);
    }
  });

  it('opening it inserts one node and repaints no part of the page', () => {
    const open = PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {'));
    // A panel appended to the body; the page behind it is never redrawn.
    expect(open).toContain("var wrap = document.createElement('div')");
    expect(open).not.toContain('paint()');
    expect(open).not.toMatch(/renderPeopleAccessPage|load\(\)/);
  });

  it('typing changes nothing at all — there is no input handler to redraw', () => {
    const open = decomment(PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {')));
    // The panel listens for submit, and for the one change that reveals the
    // team list. Nothing listens to typing, so nothing can repaint on it.
    expect(open).toContain("addEventListener('submit', submitInvite)");
    expect(open).not.toContain("addEventListener('input'");
    expect(open).not.toContain("addEventListener('keyup'");
  });

  it('and selecting a scope toggles one element, not a rebuild', () => {
    const open = PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {'));
    expect(open).toContain("if (e.target && e.target.name === 'scope')");
    expect(open).toContain("list.hidden = (e.target.value !== 'teams')");
    // `hidden`, not an innerHTML replacement and not a repaint of the panel.
    expect(open).not.toMatch(/scope[\s\S]{0,200}innerHTML/);
  });

  it('the role dropdown is a plain select with no handler of its own', () => {
    expect(PA).toContain('field(\'Role\', \'<select class="pa-in" name="role" required>\'');
    const open = PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {'));
    expect(open).not.toMatch(/name === 'role'/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3b · and the panel arrives in one movement', () => {
  /**
   * The last of it was in the opening sequence itself, and it was two things.
   *
   * `first.focus()` ran synchronously after the insertion, while the panel was
   * still at its starting transform — so the browser scrolled the field into
   * view against a position the panel was about to leave, then corrected that
   * scroll while the animation was still running. A scrolling ancestor moving
   * under a moving panel is a shake.
   *
   * And the panel scaled: `translateY(8px) scale(.99)` to none. Scaling a box
   * full of inputs and labels re-rasterises every glyph on every frame. On a
   * form that reads as the panel shivering as it lands.
   *
   * Measured in Chromium before: `matrix(0.99, 0, 0, 0.99, 0, 8)`, panel
   * 554x593 mid-animation. After: `matrix(1, 0, 0, 1, 0, 10)` — a pure
   * translate — and the panel already 560x599, its final size, at frame one.
   */
  it('the field is focused without scrolling anything', () => {
    const open = PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {'));
    expect(open).toContain('first.focus({ preventScroll: true })');
    // With a plain focus left as the fallback for a browser without it, and
    // never as the first choice.
    expect(open).toMatch(/catch \(_\) \{ first\.focus\(\); \}/);
    expect(open).not.toMatch(/if \(first\) first\.focus\(\);/);
  });

  it('and it opens on an animation, with no class toggled a frame later', () => {
    const open = PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {'));
    expect(open).toContain('document.body.appendChild(wrap);');
    // A class added in rAF after an insertion is not reliably a separate style
    // resolution: the browser may fold the two into one recalc, so the panel
    // either snaps or animates from a half-resolved state.
    expect(open).not.toContain('requestAnimationFrame');
    expect(open).not.toContain('is-open');
    // And nothing anywhere in the module still toggles it.
    expect(PA).not.toContain('is-open');
    expect(CSS).not.toContain('.pa-scrim.is-open');
  });

  it('the animation moves opacity and a pure translate, and nothing else', () => {
    const scrim = rule('.pa-scrim{');
    expect(scrim).toContain('animation:paFade');
    expect(scrim).not.toContain('transition');
    const panel = rule('.pa-panel{');
    expect(panel).toContain('animation:paRise');
    expect(panel).not.toContain('transition');

    const fade = CSS.slice(CSS.indexOf('@keyframes paFade{'), CSS.indexOf('}', CSS.indexOf('@keyframes paFade{')) + 2);
    expect(fade).toMatch(/from\{ opacity:0; \}/);
    const rise = CSS.slice(CSS.indexOf('@keyframes paRise{'), CSS.indexOf('\n}', CSS.indexOf('@keyframes paRise{')));
    expect(rise).toContain('transform:translate3d(0,10px,0)');
    expect(rise).toContain('opacity:0');
    // No scale: it is a form, and scaling text re-rasterises it every frame.
    expect(rise).not.toContain('scale(');
    // And no layout property is animated by either of them.
    for (const kf of [fade, rise]) {
      expect(kf).not.toMatch(/\b(width|height|top|left|right|bottom|margin|padding)\s*:/);
    }
  });

  it('the panel is at its final size from the first frame', () => {
    // `both` fills the starting state, so the box is laid out once and the
    // animation only composites. A panel that grows into place is a panel that
    // reflows on every frame of its own arrival.
    expect(rule('.pa-panel{')).toContain('animation:paRise .18s cubic-bezier(.2,.8,.2,1) both');
    expect(rule('.pa-scrim{')).toContain('animation:paFade .16s ease-out both');
  });

  it('and opening it locks no scroll, pads no body and moves no sidebar', () => {
    const open = PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {'));
    const close = PA.slice(PA.indexOf('function closePanel() {'), PA.indexOf('function showErr(msg) {'));
    for (const fn of [open, close]) {
      expect(fn).not.toMatch(/body\.style|overflow\s*=|paddingRight|scrollTop\s*=|scrollTo|classList\.add\('modal/);
    }
    // The scrim is fixed, so inserting it changes no document dimension.
    expect(rule('.pa-scrim{')).toContain('position:fixed');
    expect(rule('.pa-scrim{')).toContain('inset:0');
  });

  it('one click opens exactly one panel, and reopening starts from none', () => {
    const open = PA.slice(PA.indexOf('function openInvite() {'), PA.indexOf('function field(label, control) {'));
    // The first thing it does is remove any panel already there, so a second
    // click can never leave two scrims stacked.
    expect(open.slice(0, 200)).toContain('closePanel();');
    const close = PA.slice(PA.indexOf('function closePanel() {'), PA.indexOf('function showErr(msg) {'));
    expect(close).toContain("document.getElementById('pa-panel')");
    expect(close).toContain('p.remove()');
  });

  it('and the click that opens it is dispatched once, from one listener', () => {
    // One delegated listener for the module, matching on the action attribute —
    // not a handler bound per render, which is how duplicates accumulate.
    // One button carries the action, one entry in the handler map answers it,
    // and one delegated listener connects them.
    expect((PA.match(/data-pa="paInvite"/g) || []).length).toBe(1);
    expect((PA.match(/^\s*paInvite: openInvite,$/gm) || []).length).toBe(1);
    const dispatch = PA.slice(PA.indexOf("document.addEventListener('click'"));
    expect(dispatch).toContain("t.getAttribute('data-pa')");
    const paint = PA.slice(PA.indexOf('function paint() {'), PA.indexOf('function openInvite() {'));
    expect(paint).not.toContain('addEventListener');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('3c · and the backdrop does not shimmer, which is what was left', () => {
  /**
   * The last of it was not layout at all, and that is why four rounds of layout
   * fixes could not touch it.
   *
   * Measured in Chromium at 1440x900, at five points across the opening —
   * before the click, after the activation, on each of the first two frames,
   * and once settled. EVERY geometry value identical at all five: html and body
   * width, the scrollbar's 3px, the scroll position, body overflow and padding,
   * and the rects of the sidebar, the main column, the page, the content and
   * the panel. One scrim in the document, one handler execution, and no
   * ancestor carrying a transform or a filter. Nothing moved, and the screen
   * still shook.
   *
   * `.pa-scrim` carried `backdrop-filter: blur(6px)` and `inset: 0`. This file
   * already contains the finding, written after CSS isolation and quoted in the
   * FLICKER FIX block: a blurred backdrop over a continuously animating
   * background is recomposited every frame for as long as the panel is open —
   * "it moves nothing … which is why getBoundingClientRect, ResizeObserver and
   * layout-shift all report the panel perfectly still while the screen visibly
   * vibrates". `.modal-bg`, `.sq-plm-backdrop`, `.tf-modal-bd` and
   * `.mobile-overlay` were all stripped of it then. `.pa-scrim` is newer than
   * that block, was written with a blur because its neighbours had one, and was
   * never added to the list.
   *
   * Behind it, `body::before` and `body::after` are two full-viewport particle
   * layers running infinite transform-and-opacity animations. The rule that
   * pauses them while a panel is open named three panels and not this one.
   *
   * Both halves are the fix. Neither is a new mechanism: both are this file's
   * own, extended to cover the panel that was missing from them.
   */
  it('the scrim carries no backdrop filter, like every other full-viewport backdrop', () => {
    expect(CSS).toContain('.pa-scrim        { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }');
    // And it is not reintroduced in the panel's own rule.
    expect(rule('.pa-scrim{')).not.toContain('backdrop-filter:blur');
  });

  it('and it is in the same list as the four that were stripped before it', () => {
    const block = CSS.slice(CSS.indexOf('/* Part 1 — permanent: no backdrop-filter */'), CSS.indexOf('/* And nothing animates behind an open panel'));
    for (const sel of ['.modal-bg', '.sq-plm-backdrop', '.tf-modal-bd', '.mobile-overlay', '.pa-scrim']) {
      expect(`${sel} stripped: ${block.includes(sel + ' ')}`).toBe(`${sel} stripped: true`);
    }
  });

  it('the dim is deepened, so the separation the blur gave is still there', () => {
    const r = rule('.pa-scrim{');
    expect(r).toContain('background:rgba(4,6,12,.74)');
  });

  it('nothing behind it animates while it is open', () => {
    // The two particle layers, which are the only thing on the page that moves
    // by itself, and the page containers.
    const pause = CSS.slice(CSS.indexOf('body:has(.sq-plm.is-open)::before,'), CSS.indexOf('animation: none !important;', CSS.indexOf('body:has(.sq-plm.is-open)::before,')));
    expect(pause).toContain('body:has(.pa-scrim)::before');
    expect(pause).toContain('body:has(.pa-scrim)::after');
    const containers = CSS.slice(CSS.indexOf('body:has(.sq-plm.is-open) .page,'));
    expect(containers.slice(0, 700)).toContain('body:has(.pa-scrim) .page');
    expect(containers.slice(0, 700)).toContain('body:has(.pa-scrim) #pages-container');
    expect(containers.slice(0, 700)).toContain('body:has(.pa-scrim) .content');
  });

  it('and no full-viewport backdrop anywhere still blurs', () => {
    // The rule this codebase learned once and had to learn again: an
    // `inset: 0` fixed backdrop with a blur recomposites the whole viewport.
    const backdrops = ['.pa-scrim', '.modal-bg', '.sq-plm-backdrop', '.tf-modal-bd', '.mobile-overlay'];
    for (const sel of backdrops) {
      const off = CSS.includes(`${sel} `) && CSS.includes('backdrop-filter: none !important');
      expect(`${sel} has a kill rule: ${off}`).toBe(`${sel} has a kill rule: true`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('4 · nothing here observes, polls or re-registers', () => {
  it('the module installs no observer and no timer', () => {
    const code = decomment(PA);
    expect(code).not.toContain('ResizeObserver');
    expect(code).not.toContain('MutationObserver');
    expect(code).not.toContain('setInterval');
    expect(code).not.toContain('setTimeout');
    // The three enter transitions used to be classes added a frame after the
    // insertion. They are CSS animations now, so the module schedules nothing
    // at all — there is no frame to wait for and none to get wrong.
    expect(code).not.toContain('requestAnimationFrame');
  });

  it('and its document listeners are registered once, at module scope', () => {
    // Two delegated listeners for the whole module — not one per render.
    const doc = (PA.match(/document\.addEventListener\(/g) || []).length;
    expect(doc).toBe(2);
    const paint = PA.slice(PA.indexOf('function paint() {'), PA.indexOf('function openInvite() {'));
    expect(paint).not.toContain('addEventListener');
  });

  it('a repaint replaces one region, and never the page element', () => {
    const paint = PA.slice(PA.indexOf('function paint() {'), PA.indexOf('function openInvite() {'));
    expect(paint).toContain("var el = document.getElementById('pa-content');");
    expect(paint).toContain("el.innerHTML = ''");
    expect(paint).not.toContain('outerHTML');
    expect(paint).not.toContain("getElementById('pg-people-access')");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('5 · and none of the behaviour changed', () => {
  it('the invitation workflow is exactly what it was', () => {
    expect(PA).toContain('function submitInvite');
    expect(PA).toContain("A.get('/invitations')");
    expect(PA).toContain('teamIds');
    expect(PA).toContain('scope');
  });

  it('the roles offered are unchanged, and CLUB_OWNER is not among them', () => {
    const inv = PA.slice(PA.indexOf('var INVITABLE'), PA.indexOf(';', PA.indexOf('var INVITABLE')));
    expect(inv).toContain('HEAD_COACH');
    expect(inv).not.toContain('CLUB_OWNER');
  });

  it('management is still shown on the server\'s answer, and it is not the guard', () => {
    const can = PA.slice(PA.indexOf('function canManage()'), PA.indexOf('function summary()'));
    expect(can).toContain('currentClubRole');
    // No new source of authority, and no capability invented on this side.
    expect(can).not.toContain('effectiveAccess');
  });

  it('and this change touched no server file at all', () => {
    // The fix is one class name and one block of layout CSS.
    const shell = decomment(PA.slice(PA.indexOf('window.renderPeopleAccessHTML')));
    expect(shell).not.toMatch(/Membership|authorize|requireMembership|privateTeamScope/);
  });
});
