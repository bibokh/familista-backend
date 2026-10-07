// Golden HTML snapshots for the ten _lg* primitives, produced from the REAL
// source in public/app.js.
//
//   npm run test:golden          compare against tests/golden/lg-primitives.golden.json
//   npm run golden:update        rewrite the snapshot (review the diff!)
//
// A later PR that moves these functions out of app.js must reproduce every
// string below byte for byte. That is what "no behaviour change" means here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLg, readAppJs } from '../lib/extract-lg.mjs';
import { buildLg, PRIMITIVES } from '../lib/build-lg.mjs';
import { CASES, seedClubs } from './cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden', 'lg-primitives.golden.json');
const APP = readAppJs();
const lg = seedClubs(buildLg(extractLg()));

test('all ten primitives are defined exactly once in public/app.js', () => {
  assert.equal(PRIMITIVES.length, 10);
  for (const name of PRIMITIVES) {
    const n = (APP.match(new RegExp(`^function ${name}\\(`, 'gm')) || []).length;
    assert.equal(n, 1, `${name} is defined ${n} times`);
    assert.equal(typeof lg[name], 'function');
  }
});

test('every primitive has cases, and every case returns a string', () => {
  for (const name of PRIMITIVES) {
    assert.ok(Object.keys(CASES[name] || {}).length >= 3, `${name} needs at least three cases`);
    for (const [label, run] of Object.entries(CASES[name])) {
      assert.equal(typeof run(lg), 'string', `${name} / ${label}`);
    }
  }
});

test('the primitives are deterministic', () => {
  for (const name of PRIMITIVES) for (const [label, run] of Object.entries(CASES[name])) {
    assert.equal(run(lg), run(lg), `${name} / ${label}`);
  }
});

test('the bar-width applier Storybook mirrors still exists in app.js', () => {
  // _lgVersus draws widths as data-mc-width; production applies them in one
  // place. The Storybook decorator reproduces exactly this line.
  assert.ok(APP.includes("el.style.setProperty('width', el.getAttribute('data-mc-width'));"),
    'production applier changed: update tools/storybook/.storybook/preview.js to match');
});

test('golden snapshots match', () => {
  const actual = {};
  for (const name of PRIMITIVES) {
    actual[name] = {};
    for (const [label, run] of Object.entries(CASES[name])) actual[name][label] = run(lg);
  }
  if (process.env.GOLDEN_UPDATE === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    return;
  }
  assert.ok(fs.existsSync(GOLDEN), 'no golden file yet: run npm run golden:update');
  const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(actual), Object.keys(expected), 'primitive set changed');
  for (const name of PRIMITIVES) {
    assert.deepEqual(Object.keys(actual[name]), Object.keys(expected[name]), `${name}: case set changed`);
    for (const label of Object.keys(actual[name])) {
      assert.equal(actual[name][label], expected[name][label], `${name} / ${label}`);
    }
  }
});
