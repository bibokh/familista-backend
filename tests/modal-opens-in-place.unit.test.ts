/**
 * tests/modal-opens-in-place.unit.test.ts
 *
 * A modal overlay covers the viewport. It does not join the page.
 *
 * `.modal-bg` is `position:fixed; inset:0; z-index:9000` — it fills the screen
 * and sits above everything, which is the whole of what an overlay is. The FOS
 * theme's "sit content above the particle layers" rule then listed it beside
 * five elements that really are laid out in normal flow and set
 * `position:relative` on all six. On `.modal-bg` that is not a no-op: it takes
 * the overlay OUT of fixed positioning.
 *
 * Measured, at a 1440x820 viewport, opening a player card:
 *
 *   before   overlay [top 820, height 709.5]   panel top 820   document 1530px
 *   after    overlay [top   0, height   820]   panel top  55   document  820px
 *
 * The overlay stopped covering the viewport and took its height from its
 * contents; the panel opened a full viewport below the fold; and the document
 * grew by seven hundred pixels every time a card was clicked. That is the
 * movement on opening a player card, and because the theme class is on the body
 * everywhere, it happened on every surface that opens one.
 *
 * The overlay never needed the rule: it was positioned already, and its
 * z-index of 9000 is far above the particle layers. It is simply not in the
 * list any more.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const RAW = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');
// Comments name these selectors to explain them; only declarations count.
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '');

// The overlay's own base rule.
const baseRule = (/(^|[},])\s*\.modal-bg\{([^}]*)\}/m.exec(CSS) || [])[2] || null;

describe('the overlay stays fixed to the viewport', () => {
  it('is declared fixed and full-bleed', () => {
    expect(baseRule).toBeTruthy();
    expect(baseRule).toMatch(/position:\s*fixed/);
    expect(baseRule).toMatch(/inset:\s*0/);
    expect(baseRule).toMatch(/z-index:\s*9000/);
  });

  it('and nothing in the theme layers puts it back into normal flow', () => {
    // any rule that both matches .modal-bg and sets position must not make it
    // relative, absolute or static — those all break `inset:0` against the
    // viewport.
    const re = /([^{}]*\.modal-bg[^{}]*)\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    const offenders: string[] = [];
    while ((m = re.exec(CSS))) {
      const decl = /(^|;|\s)position\s*:\s*([a-z-]+)/.exec(m[2]);
      if (decl && decl[2] !== 'fixed') offenders.push(m[1].trim().slice(0, 90) + ' → position:' + decl[2]);
    }
    expect(offenders).toEqual([]);
  });

  it('the particle-layer rule still lifts the five elements that are in flow', () => {
    expect(RAW).toContain('Sit content above the particle layers');
    const at = CSS.indexOf('body.fos-neural-theme .sidebar,');
    expect(at).toBeGreaterThan(-1);
    const block = CSS.slice(at, CSS.indexOf('}', at) + 1);
    ['.sidebar', '.content', '.main-content', '.topbar', '.auth-overlay'].forEach((s) => {
      expect(block).toContain('body.fos-neural-theme ' + s);
    });
    expect(block).toMatch(/position:\s*relative/);
    expect(block).toMatch(/z-index:\s*1/);
  });
});

describe('and the panels settled earlier are still settled', () => {
  it('the Squad player profile keeps its fixed height', () => {
    expect(CSS).toMatch(/\.sq-plm-dialog\{[^}]*height:min\(88vh,760px\)/);
  });
  it('the transfer target panel keeps its own', () => {
    expect(CSS).toMatch(/\.tf-modal-box--wide\{[^}]*height:min\(calc\(100vh - 56px\),820px\)/);
  });
});
