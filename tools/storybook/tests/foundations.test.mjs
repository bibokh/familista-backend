// Storybook is a consumer of the Familista Design Core tokens, never their
// owner. These checks keep it that way and keep the Foundations stories honest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SB = join(HERE, '..');
const TOKENS = join(SB, '..', 'tokens');
const preview = readFileSync(join(SB, '.storybook', 'preview.js'), 'utf8');
const dist = readFileSync(join(TOKENS, 'dist', 'familista-tokens.css'), 'utf8');
const storyDir = join(SB, 'stories', 'foundations');
const stories = readdirSync(storyDir).filter((f) => f.endsWith('.stories.js'));

test('the token CSS is loaded before the production stylesheets', () => {
  const tokensAt = preview.indexOf("['familista-tokens.css");
  const appAt = preview.indexOf("['app.css'");
  assert.ok(tokensAt > 0 && appAt > tokensAt, 'familista-tokens.css must be the first sheet, as Stage 2b would link it');
  assert.match(preview, /import tokensCss from '\.\.\/\.\.\/tokens\/dist\/familista-tokens\.css\?raw'/);
});

test('the token source does not depend on Storybook', () => {
  for (const dir of ['lib', 'scripts']) {
    for (const f of readdirSync(join(TOKENS, dir))) {
      // Comments may name Storybook as a consumer; code may not import from it.
      assert.doesNotMatch(readFileSync(join(TOKENS, dir, f), 'utf8'), /(from|import\()\s*['"][^'"]*storybook/i, `${dir}/${f} must not import Storybook`);
    }
  }
});

test('every Stage 2a foundation has a story', () => {
  const required = ['Colours', 'Semantic', 'Contexts', 'Typography', 'ArabicRtl', 'Spacing', 'Radius', 'BorderWidths', 'Elevation', 'Motion', 'Sizing', 'Football', 'DataViz', 'LegacyMap'];
  for (const r of required) assert.ok(stories.includes(`${r}.stories.js`), `missing Foundations story ${r}`);
});

test('every --fam-* name a story or the Foundations CSS uses exists in the generated CSS', () => {
  const declared = new Set([...dist.matchAll(/(--fam-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const sources = [...stories.map((f) => join(storyDir, f)), join(SB, '.storybook', 'foundations.css')];
  for (const f of sources) {
    for (const m of readFileSync(f, 'utf8').matchAll(/var\((--fam-[a-z0-9-]+)\)/g)) assert.ok(declared.has(m[1]), `${f} uses ${m[1]}, which the tokens do not declare`);
  }
});

test('the Foundations CSS is scoped and cannot reach a Stage 1 story', () => {
  const css = readFileSync(join(SB, '.storybook', 'foundations.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@keyframes[^{]*\{([^{}]*\{[^{}]*\})*\s*\}/g, '').replace(/@[^{]+\{/g, '{');
  const selectors = [...css.matchAll(/([^{}@]+)\{/g)].map((m) => m[1].trim()).filter((s) => s && !/^(to|from|\d+%)$/.test(s) && !s.startsWith('('));
  for (const s of selectors) for (const part of s.split(',')) assert.match(part.trim(), /^\.fam-fd/, `unscoped selector: ${part.trim()}`);
});
