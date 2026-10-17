// Familista — the Specimen Lab's preview manifest builder (Stage 3.2.3 M1).
//
// Called by scripts/design-system-discover.js, which writes
// src/design-system/generated/design-system-previews.json beside the other three
// manifests and checks all four with --check.
//
// WHERE A FIXTURE COMES FROM
//
// Not from this script. The ten verified primitives already have deterministic
// fixtures: Storybook's golden snapshot
// (tools/storybook/tests/golden/lg-primitives.golden.json) is the real
// public/app.js render functions run once, in a test, over the fixed inputs in
// tools/storybook/tests/cases.mjs. This script READS that snapshot as text. It
// does not import the Storybook extractor, does not execute a render function
// and does not evaluate a string; tests/design-system-lab.unit.test.ts runs the
// Storybook golden test under Jest, so CI refuses a snapshot that has drifted
// from public/app.js.
//
// WHAT IT DOES TO ONE
//
//   1. runs it through the shared sanitizer (public/design-system/lab-sanitize.js):
//      a closed tag and attribute list, size and node limits, and the three
//      attributes production writes that must not reach the application the
//      specimen sits in are removed and reported;
//   2. checks every class against a provenance it can show: a class a registered
//      component owns, a class production's CSS defines, one of two reviewed
//      classes a Storybook test passes in that production's CSS does not define,
//      or a reviewed state class that is inert on one component's own element
//      (SCOPED_INERT);
//   3. binds it to the render function and CSS slices the components manifest
//      hashed, so a change to either invalidates it;
//   4. records the call that produced it, as the case file spells it (Recorded).
//
// FAIL CLOSED
//
// One problem anywhere throws, naming it. Nothing is skipped and nothing is
// repaired. Deterministic: no timestamp, no host, no environment value.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sanitizer = require('../public/design-system/lab-sanitize.js');
const core = require('../src/design-system/previews-core.js');
const { cssRules, classesOf } = require('./design-system-components.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Classes a Storybook test passes in as caller-supplied input that production's CSS
// has no rule for. They style nothing; they are accepted by name, with the reason,
// and shown to the owner as "no production rule" — not hidden and not invented.
const REVIEWED_INERT = {
  'lg-ident--hero': 'Passed to _lgIdent by a Storybook case; app.css has no rule for it.',
  'lg-t': 'The class of a table a Storybook case passes to _lgPanel as its body; app.css has no rule for it.',
};

// State classes a production render function writes on its own root element that
// no production rule styles there. Keyed by the component class the element must
// also carry. Not a global allowlist: the class is accepted only on an element of
// that component, and only while no CSS rule could style it there — a rule naming
// the class alone, or together with only that component's classes, fails the
// build so the entry is reviewed again. Rules elsewhere that need another class
// (.tfx-lane.is-empty, .de-vid.is-empty) cannot match the element and are never
// borrowed as provenance.
const SCOPED_INERT = {
  'club-logo': {
    'is-empty': 'clubLogoHtml writes it when the club has no crest (and _clubLogoFallback when a crest fails to load); no production CSS or JS targets .club-logo.is-empty — the shield placeholder is drawn either way.',
  },
};

// Registered components that draw only inside the application's own shell: a
// person recorded this; the generator checks each id exists.
const APPLICATION_SHELL = ['sidebar-nav', 'topbar', 'page-header', 'ds-shell'];

function slug(label) {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'fixture';
}

/**
 * Reads the call each case file entry makes, as text. Nothing is evaluated.
 * `symbols` is the set of render functions the components manifest resolved in
 * public/app.js; a case section or a call naming any other function is refused,
 * so a fixture can only ever be the output of an extracted production function.
 */
function readCalls(casesText, golden, symbols) {
  const calls = {};
  const problems = [];
  const at = casesText.search(/^export const CASES = \{$/m);
  const body = at < 0 ? '' : casesText.slice(at);
  const parts = body.split(/^  (\w+): /m);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    if (!symbols.has(name)) { problems.push('cases.mjs: "' + name + '" is not a render function extracted from public/app.js'); continue; }
    calls[name] = {};
    for (const m of parts[i + 1].matchAll(/^    '((?:[^'\\]|\\.)*)':\s*\(l\)\s*=>\s*l\.(\w+)\((.*)\),?\s*$/gm)) {
      const label = m[1].replace(/\\'/g, "'");
      if (m[2] !== name) { problems.push('cases.mjs: ' + name + ' / ' + label + ' calls ' + m[2] + ', not ' + name); continue; }
      calls[name][label] = m[2] + '(' + m[3] + ')';
    }
  }
  if (problems.length) throw new Error('the Specimen Lab case file could not be read:\n  ' + problems.join('\n  '));
  // _lgStatusChip's cases are generated from a list of raw statuses; the label is the status.
  for (const label of Object.keys(golden._lgStatusChip || {})) {
    if (!calls._lgStatusChip) calls._lgStatusChip = {};
    const arg = label === 'empty falls back to upcoming' ? '' : label;
    calls._lgStatusChip[label] = '_lgStatusChip(' + JSON.stringify(arg).replace(/^"|"$/g, "'") + ')';
  }
  return calls;
}

function build({ ROOT, components }) {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
  const registryRel = 'tools/components/registry.json';
  const goldenRel = 'tools/storybook/tests/golden/lg-primitives.golden.json';
  const casesRel = 'tools/storybook/tests/cases.mjs';
  const sanitizerRel = 'public/design-system/lab-sanitize.js';

  const registry = JSON.parse(read(registryRel).toString('utf8'));
  const golden = JSON.parse(read(goldenRel).toString('utf8'));
  const casesText = read(casesRel).toString('utf8');
  const symbols = new Set(components.components.map((c) => c.source.js && c.source.js.symbol).filter(Boolean));
  const calls = readCalls(casesText, golden, symbols);
  const errors = [];
  const fail = (m) => errors.push(m);
  for (const k of Object.keys(golden)) if (!symbols.has(k)) fail('the golden snapshot has cases for "' + k + '", which is not a render function the components manifest resolved in public/app.js');

  // ── class provenance ────────────────────────────────────────────────────
  const owner = new Map();
  for (const c of registry.components) {
    for (const k of [...(c.css.classes || []), ...(c.variants || []).map((v) => v.class), ...(c.anatomy || [])]) if (!owner.has(k)) owner.set(k, c.id);
  }
  const files = [...new Set(registry.components.flatMap((c) => c.css.files))].sort();
  const ruleCount = new Map();
  const selectors = [];
  for (const f of files) for (const r of cssRules(read(f).toString('utf8'))) { const ks = new Set(classesOf(r.sel)); selectors.push(ks); for (const k of ks) ruleCount.set(k, (ruleCount.get(k) || 0) + 1); }
  // A scoped inert class must stay unstyled on its component: every rule that names
  // it must also need a class the component's element never carries.
  for (const [host, names] of Object.entries(SCOPED_INERT)) {
    const reg = registry.components.find((c) => (c.css.classes || []).indexOf(host) >= 0);
    if (!reg) { fail('SCOPED_INERT names component class "' + host + '", which no registered component owns'); continue; }
    const own = new Set([...(reg.css.classes || []), ...(reg.variants || []).map((v) => v.class)]);
    for (const name of Object.keys(names)) {
      if (owner.has(name)) fail('SCOPED_INERT: "' + name + '" is owned by ' + owner.get(name) + ', so it is not inert');
      for (const ks of selectors) if (ks.has(name) && [...ks].every((k) => k === name || own.has(k))) fail('SCOPED_INERT: a production rule can style .' + host + '.' + name + '; review the entry');
    }
  }
  // Scoped entries the classes on one element answer: { name: host }.
  const scopedOn = (tokens) => {
    const found = {};
    for (const [host, names] of Object.entries(SCOPED_INERT)) if (tokens.indexOf(host) >= 0) for (const n of Object.keys(names)) if (tokens.indexOf(n) >= 0) found[n] = host;
    return found;
  };
  const provenance = (name) => {
    if (owner.has(name)) { const n = ruleCount.get(name) || 0; return n ? { owner: owner.get(name), rules: n } : null; }
    if (ruleCount.get(name)) return { owner: 'css', rules: ruleCount.get(name) };
    if (Object.prototype.hasOwnProperty.call(REVIEWED_INERT, name) && !ruleCount.get(name)) return { owner: 'inert', rules: 0 };
    return null;
  };

  for (const id of APPLICATION_SHELL) if (!components.components.some((c) => c.id === id)) fail('APPLICATION_SHELL names "' + id + '", which is not registered');

  // ── fixtures ────────────────────────────────────────────────────────────
  const out = [];
  const withFixtures = new Set();
  for (const comp of components.components) {
    const symbol = comp.source.js && comp.source.js.symbol;
    if (!symbol || !golden[symbol]) continue;
    withFixtures.add(comp.id);
    const labels = Object.keys(golden[symbol]);
    const taken = new Set();
    const fixtures = [];
    for (const label of labels) {
      const where = comp.id + ' / ' + label;
      const raw = golden[symbol][label];
      const call = calls[symbol] && calls[symbol][label];
      if (!call) { fail(where + ': the case file has no call for this golden label'); continue; }
      const used = {};
      // A scoped inert class is answered by the element it sits on, before any
      // unrelated production rule that merely shares its name.
      const scoped = {};
      for (const m of raw.matchAll(/\bclass="([^"]*)"/g)) { const tokens = m[1].split(/\s+/).filter(Boolean); Object.assign(scoped, scopedOn(tokens)); }
      const bare = [...raw.matchAll(/\bclass="([^"]*)"/g)].some((m) => { const t = m[1].split(/\s+/); return Object.entries(SCOPED_INERT).some(([host, names]) => t.indexOf(host) < 0 && Object.keys(names).some((n) => t.indexOf(n) >= 0)); });
      if (bare) { fail(where + ': a scoped inert class appears on an element that is not its component'); continue; }
      const res = sanitizer.sanitize(raw, {
        classOk: (n) => {
          const p = Object.prototype.hasOwnProperty.call(scoped, n) ? { owner: 'inert', rules: 0 } : provenance(n);
          if (p) used[n] = p; return !!p;
        },
      });
      if (!res.ok) { fail(where + ': ' + res.problems.join('; ')); continue; }
      let id = slug(label), n = 2;
      while (taken.has(id)) id = slug(label) + '-' + n++;
      taken.add(id);
      const variantNames = new Set(comp.variants.map((v) => v.class));
      const classes = res.stats.classes.map((name) => ({ name, owner: used[name].owner, rules: used[name].rules }));
      fixtures.push({
        id: comp.id + '.' + id,
        label,
        call,
        html: res.html,
        sha256: sha(res.html),
        bytes: res.stats.bytes,
        nodes: res.stats.nodes,
        elements: res.stats.elements,
        depth: res.stats.depth,
        tags: res.stats.tags,
        classes,
        variantClasses: res.stats.classes.filter((k) => variantNames.has(k)),
        neutralised: res.neutralised,
        goldenSha256: sha(raw),
      });
    }
    // The golden snapshot and the manifest must agree on the labels the components manifest recorded.
    if (comp.stories && JSON.stringify(comp.stories.golden) !== JSON.stringify(labels)) fail(comp.id + ': the components manifest and the golden snapshot list different cases');
    out.push({
      id: comp.id,
      symbol,
      source: { js: comp.source.js, css: comp.source.css },
      mediaQueries: comp.styling.mediaQueries,
      variants: comp.variants.map((v) => ({ class: v.class, name: v.name, rules: v.rules, exercisedBy: fixtures.filter((f) => f.variantClasses.indexOf(v.class) >= 0).map((f) => f.id) })),
      fixtures,
    });
  }

  // ── availability: one entry for every registered component ──────────────
  const availability = components.components.map((c) => {
    if (withFixtures.has(c.id)) return { id: c.id, state: 'preview', reason: null };
    let reason;
    if (c.source.js) reason = 'no-fixtures';
    else if (APPLICATION_SHELL.indexOf(c.id) >= 0) reason = 'application-shell';
    else if (c.kind === 'css-family') reason = 'css-family';
    else if (c.kind === 'page-specific') reason = 'page-specific';
    else if (c.kind === 'candidate') reason = 'candidate';
    else if (c.kind === 'layout-utility') reason = 'utility';
    else reason = 'css-only';
    return { id: c.id, state: 'unavailable', reason };
  });

  if (errors.length) throw new Error('the Specimen Lab previews could not be verified:\n  ' + errors.join('\n  '));

  const file = (id, rel, label) => { const b = read(rel); return { id, path: rel, label, sha256: sha(b), bytes: b.length, basis: 'file' }; };
  const table = [...ruleCount.entries()].filter(([k]) => out.some((c) => c.fixtures.some((f) => f.classes.some((x) => x.name === k)))).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + ':' + v).join('\n');
  const manifest = {
    schema: core.SCHEMA,
    generator: 'scripts/design-system-discover.js',
    description: 'Fixtures for the Specimen Lab: markup the verified production primitives produced for fixed inputs, checked and neutralised by one sanitizer. Generated; do not edit.',
    sources: [
      file('golden', goldenRel, 'The golden snapshot: the real render functions run over fixed inputs'),
      file('cases', casesRel, 'The fixed inputs and the calls that produced each fixture'),
      file('registry', registryRel, 'The reviewed Components Registry (class ownership)'),
      file('sanitizer', sanitizerRel, 'The sanitizer the build, the server and the browser share'),
      { id: 'class-rules', path: 'public', label: 'How many production CSS rules mention each class the fixtures use', sha256: sha(Buffer.from(table)), bytes: Buffer.byteLength(table), basis: 'derived' },
    ],
    policy: sanitizer.policy(),
    coverage: null,
    components: out,
    availability,
  };
  manifest.coverage = core.coverageOf(manifest);
  const problems = core.validateManifest(manifest, { components });
  if (problems.length) throw new Error('the previews manifest is malformed:\n  ' + problems.slice(0, 20).join('\n  '));
  return manifest;
}

module.exports = { build, readCalls, REVIEWED_INERT, SCOPED_INERT, APPLICATION_SHELL };
