/**
 * tests/panel-compositing.unit.test.ts
 *
 * Nothing recomposites the whole screen while a player panel is open.
 *
 * This file already carries a flicker layer that found, and names, the cause:
 * "backdrop-filter blur forces a full GPU layer re-composition", and
 * "the dominant GPU cost and the source of micro-shimmer that reads as
 * 'shaking'". It removed backdrop-filter from `.modal-bg`, `.header` and
 * `.backend-banner`, and froze animation/transform/filter/will-change on
 * everything still painted behind a `.modal-bg` while it is open.
 *
 * The two panels a manager opens most were never in either list. The player
 * card's own backdrop — `.sq-plm-backdrop`, used by First Team, Squad, Lineup
 * and every Academy age group — was `position:fixed; inset:0` with
 * `backdrop-filter: blur(3px)`, so opening a player made the browser
 * re-rasterise a blur of the entire viewport for as long as the panel stayed
 * open. Behind it, `body::before` and `body::after` are full-viewport particle
 * layers running `fosNeuralDrift` and `fosConnectionDrift` — transform and
 * opacity, `infinite alternate`.
 *
 * None of that moves anything. The panel's rectangle is identical frame to
 * frame, which is why getBoundingClientRect, ResizeObserver and layout-shift
 * all report it perfectly still while the screen visibly shimmers. Measured in
 * a browser with prefers-reduced-motion off, `.sq-plm-backdrop` computed
 * `backdrop-filter: blur(3px)` before this change and `none` after it.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const APP = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');

// Every declaration block whose selector list contains this selector, joined —
// a base rule and its later override both count.
const decl = (selector: string): string => {
  const re = new RegExp('(^|[},;])\\s*[^{}]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^{}]*\\{([^}]*)\\}', 'gm');
  let m: RegExpExecArray | null; const out: string[] = [];
  while ((m = re.exec(CSS))) out.push(m[2]);
  return out.join(' ');
};

describe('no panel blurs the whole viewport behind itself', () => {
  it.each([
    ['.sq-plm-backdrop', 'the player card, on First Team and every Academy age group'],
    ['.tf-modal-bd', 'the transfer target and Contract / Transfer'],
    ['.mobile-overlay', 'the mobile nav scrim'],
  ])('%s has no backdrop-filter (%s)', (sel) => {
    const d = decl(sel);
    expect(d).toBeTruthy();
    expect(d).toMatch(/backdrop-filter:\s*none\s*!important/);
    expect(d).toMatch(/-webkit-backdrop-filter:\s*none\s*!important/);
  });

  it('and the ones the layer already covered are still covered', () => {
    expect(decl('.modal-bg')).toMatch(/backdrop-filter:\s*none\s*!important/);
    expect(decl('.header')).toMatch(/backdrop-filter:\s*none\s*!important/);
  });

  it('the dimming itself is kept — only the blur went', () => {
    // the backdrops still darken what is behind them
    expect(CSS).toMatch(/\.sq-plm-backdrop\{[^}]*background:rgba\(3,6,15,\.72\)/);
    expect(CSS).toMatch(/\.tf-modal-bd\{[^}]*background:rgba\(4,6,10,\.72\)/);
  });
});

describe('and nothing animates behind an open panel', () => {
  it('the two particle layers stop while one is open', () => {
    const at = CSS.indexOf('body:has(.sq-plm.is-open)::before');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}', at) + 1);
    ['body:has(.sq-plm.is-open)::after', 'body:has(.tf-modal)::before',
     'body:has(.modal-bg.open)::before'].forEach((s) => expect(block).toContain(s));
    expect(block).toMatch(/animation:\s*none\s*!important/);
  });

  it('the page and the cards behind stop compositing too', () => {
    expect(CSS).toContain('body:has(.sq-plm.is-open) .page');
    expect(CSS).toContain('body:has(.sq-plm.is-open) .card');
    expect(CSS).toContain('body:has(.tf-modal) .page');
  });

  it('all of it keyed to an open panel, never a hidden one', () => {
    // #sq-pl-modal.sq-plm stays in the document, so `open` has to be explicit
    // or these rules would apply for the entire session.
    expect(CSS).not.toMatch(/body:has\(\.sq-plm\)\s/);
    expect(APP).toContain("m.classList.add('is-open')");
    expect(APP).toContain("m.classList.remove('is-open')");
    // the academy panel exists only while open, so it is born with the flag
    expect(APP).toContain("'<div class=\"sq-plm at-plm is-open\"");
  });

  it('and every path that hides the player overlay clears it', () => {
    // sqClosePlayer and the delete path both hide #sq-pl-modal; each one
    // removes the flag in the same statement that hides it.
    const cleared = (APP.match(/classList\.remove\('is-open'\)/g) || []).length;
    expect(cleared).toBeGreaterThanOrEqual(2);
    // and no path hides it without clearing
    const hidden = (APP.match(/sq-pl-modal[\s\S]{0,120}?display = 'none'/g) || []).length;
    expect(cleared).toBeGreaterThanOrEqual(hidden);
  });
});
