/**
 * tests/panel-geometry-settles.unit.test.ts
 *
 * A panel does not move because its contents changed length.
 *
 * Both tabbed player panels are centred in a fixed overlay and were sized by
 * their contents — `max-height` with no height. Overview, Skills, Playstyle,
 * Stats, Personal trainer and Contract are different lengths, so every tab
 * click resized the box, and centring then moved it: the panel visibly jumped
 * under the pointer on each one. Measured across eighteen tab clicks it was
 * 0.43 of cumulative layout shift, all of it that single element, and it was
 * the only shift produced by any interaction inside the club workspace.
 *
 * The column inside already scrolls its content pane, which is what makes a
 * settled height the correct fix rather than a workaround: the box stays where
 * it is and the section scrolls, exactly as the flex column was built to do.
 * After it, the same eighteen clicks — and Squad ↔ Lineup ten times, eight
 * card open/closes and two full module circuits — measure zero.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const CSS = readFileSync(join(__dirname, '..', 'public', 'app.css'), 'utf8');

// The declaration block for a selector, by brace balance.
function ruleFor(selector: string): string | null {
  const at = CSS.indexOf('\n' + selector + '{');
  if (at < 0) return null;
  const open = CSS.indexOf('{', at);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

describe('the Squad player profile', () => {
  const rule = ruleFor('.sq-plm-dialog');

  it('has a settled height, not one that follows its tab', () => {
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/height:min\(88vh,760px\)/);
  });

  it('still cannot outgrow the viewport', () => {
    expect(rule).toMatch(/max-height:88vh/);
  });

  it('and its content pane is what scrolls, so nothing is cut off', () => {
    expect(ruleFor('.sq-plm-content')).toMatch(/overflow-y:auto/);
    expect(rule).toMatch(/display:flex/);
    expect(rule).toMatch(/flex-direction:column/);
  });
});

describe('the transfer target panel, which is the same panel', () => {
  it('the wide tabbed box is settled the same way', () => {
    expect(ruleFor('.tf-modal-box--wide')).toMatch(/height:min\(calc\(100vh - 56px\),820px\)/);
  });

  it('but the small boxes are not — a confirm dialog keeps its own short height', () => {
    const sm = ruleFor('.tf-modal-box--sm');
    expect(sm).toBeTruthy();
    expect(sm).not.toMatch(/height:/);
  });

  it('and it too scrolls inside rather than growing', () => {
    expect(ruleFor('.tf-modal-box')).toMatch(/overflow:hidden/);
  });
});

describe('what was already holding the rest of the shell still', () => {
  it('the scrollbar gutter is reserved, so a taller page does not shift the width', () => {
    expect(CSS).toMatch(/html,\s*body\{\s*scrollbar-gutter:\s*stable/);
    expect(CSS).toMatch(/\.page,\s*\.content\{\s*scrollbar-gutter:\s*stable/);
  });
});
