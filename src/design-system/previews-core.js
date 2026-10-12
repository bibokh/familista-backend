// Familista Design System Control — the Specimen Lab's one definition of a
// well-formed preview manifest (Stage 3.2.3 M1).
//
// Plain JavaScript so the generator (scripts/design-system-previews.js), the
// server (design-system.service.ts, copied to dist beside the compiled service
// by scripts/copy-runtime-assets.js) and the test suite share it.
//
// A fixture is markup that a production render function produced for a fixed
// input, stored here already checked and neutralised. This validator takes
// nothing on trust: it runs EVERY fixture back through the shared sanitizer
// (public/design-system/lab-sanitize.js), insists the stored markup is exactly
// what the sanitizer produces, recomputes its hash, size and node count, checks
// every class it names against the provenance it declares, and — when the
// components manifest is given — that each preview is still bound to the very
// source and CSS slices that manifest recorded. One failure refuses the whole
// manifest, and nothing is repaired or partly served.
'use strict';

const crypto = require('crypto');
// The server runs from src/ in development and from dist/ in production; both
// sit beside public/, so one relative path serves both.
const sanitizer = require('../../public/design-system/lab-sanitize.js');

const SCHEMA = 1;
const AVAILABILITY = ['preview', 'unavailable'];
const REASONS = ['no-fixtures', 'css-only', 'application-shell', 'utility', 'css-family', 'page-specific', 'candidate'];
const OWNERS_SPECIAL = ['css', 'inert'];
const COMPONENT_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FIXTURE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SYMBOL = /^_?[A-Za-z][A-Za-z0-9_]*$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX = { components: 100, fixturesPerComponent: 40, label: 120, call: 600, totalBytes: 128 * 1024 };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= (max || 400) && !sanitizer.hasBadChars(v);
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 1e7;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const NEUTRAL_CODES = sanitizer.NEUTRALISED.map((n) => n.code);

/** The same count the generator writes: every figure is recomputed from the components, never kept separately. */
function coverageOf(m) {
  const neutralised = {};
  let fixtures = 0, bytes = 0, nodes = 0;
  for (const c of m.components) {
    for (const f of c.fixtures) {
      fixtures++; bytes += f.bytes; nodes += f.nodes;
      for (const n of f.neutralised) neutralised[n.code] = (neutralised[n.code] || 0) + n.count;
    }
  }
  const byReason = {};
  for (const a of m.availability) if (a.state === 'unavailable') byReason[a.reason] = (byReason[a.reason] || 0) + 1;
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    registered: m.availability.length,
    previewable: m.components.length,
    unavailable: m.availability.length - m.components.length,
    fixtures, bytes, nodes,
    neutralised: sorted(neutralised),
    byReason: sorted(byReason),
  };
}

function validateFixture(f, comp, where, ctx, problems) {
  const p = (m) => problems.push(where + ': ' + m);
  if (!isObj(f)) { p('is not an object'); return; }
  if (!isText(f.id, 120) || f.id.indexOf(comp.id + '.') !== 0 || !FIXTURE_SLUG.test(f.id.slice(comp.id.length + 1))) { p('has an invalid fixture id'); return; }
  if (!isText(f.label, MAX.label)) p('needs a label');
  if (!isText(f.call, MAX.call)) p('needs the call it records');
  if (!SHA.test(f.sha256 || '') || !SHA.test(f.goldenSha256 || '')) p('has a malformed hash');
  // An empty string is a real answer: _lgVersus draws nothing when both sides are missing.
  if (typeof f.html !== 'string') { p('has no markup'); return; }

  // The classes it declares are the only ones its markup may use.
  if (!Array.isArray(f.classes)) { p('has no class list'); return; }
  const declared = new Map();
  for (const c of f.classes) {
    if (!isObj(c) || !isText(c.name, 64) || !isCount(c.rules)) { p('has a malformed class entry'); return; }
    const knownOwner = c.owner === 'css' || c.owner === 'inert' || (typeof c.owner === 'string' && ctx.ids.has(c.owner));
    if (!knownOwner) p('class "' + c.name + '" names an owner that does not exist');
    if (c.owner === 'inert' && c.rules !== 0) p('class "' + c.name + '" is declared inert but has rules');
    if (c.owner !== 'inert' && c.rules < 1) p('class "' + c.name + '" is declared as styled but has no rule');
    if (declared.has(c.name)) p('class "' + c.name + '" is listed twice');
    declared.set(c.name, c);
  }
  const names = [...declared.keys()];
  if (JSON.stringify(names) !== JSON.stringify(names.slice().sort())) p('class list is not sorted');

  const out = sanitizer.sanitize(f.html, { classOk: (n) => declared.has(n) });
  if (!out.ok) { p('fails the sanitizer: ' + out.problems.slice(0, 2).join('; ')); return; }
  if (out.html !== f.html) p('is not exactly what the sanitizer produces');
  if (sha256(f.html) !== f.sha256) p('hash does not match its markup');
  if (out.stats.bytes !== f.bytes || out.stats.nodes !== f.nodes || out.stats.elements !== f.elements || out.stats.depth !== f.depth) p('size, node count or depth does not match its markup');
  if (JSON.stringify(out.stats.tags) !== JSON.stringify(f.tags)) p('tag list does not match its markup');
  if (JSON.stringify(out.stats.classes) !== JSON.stringify(names)) p('class list does not match the classes its markup uses');

  if (!Array.isArray(f.neutralised)) p('has no neutralisation report');
  else for (const n of f.neutralised) {
    if (!isObj(n) || NEUTRAL_CODES.indexOf(n.code) < 0 || !isText(n.action, 80) || !Number.isInteger(n.count) || n.count < 1) { p('has a malformed neutralisation entry'); break; }
  }

  // Variant classes: the ones the fixture really carries, from the component's own list.
  const variantNames = comp.variants.map((v) => v.class);
  if (!Array.isArray(f.variantClasses) || JSON.stringify(f.variantClasses) !== JSON.stringify(names.filter((n) => variantNames.indexOf(n) >= 0))) p('variant classes do not match the classes its markup carries');
}

function validateManifest(m, ctx) {
  if (!isObj(m)) return ['the previews manifest is not an object'];
  const problems = [];
  if (m.schema !== SCHEMA) problems.push('the previews manifest is not schema ' + SCHEMA);
  if (!isText(m.generator) || !isText(m.description, 600)) problems.push('generator and description are required');
  if (!Array.isArray(m.sources) || !Array.isArray(m.components) || !Array.isArray(m.availability) || !isObj(m.policy) || !isObj(m.coverage)) return problems.concat('sources, policy, components, availability and coverage are required');

  // The policy it was generated under must be the policy the sanitizer enforces now.
  if (JSON.stringify(m.policy) !== JSON.stringify(sanitizer.policy())) problems.push('the sanitizer policy changed since this manifest was generated');

  const seenSource = new Set();
  for (const s of m.sources) {
    if (!isObj(s) || !isText(s.id, 80) || !isText(s.path) || !isText(s.label) || !SHA.test(s.sha256 || '') || !isCount(s.bytes) || ['file', 'derived'].indexOf(s.basis) < 0) problems.push('a source is malformed');
    else if (seenSource.has(s.id)) problems.push('source "' + s.id + '" is listed twice');
    else seenSource.add(s.id);
  }

  const known = ctx && ctx.components ? ctx.components : null;
  const registered = known ? known.components.map((c) => c.id) : m.availability.map((a) => a && a.id);
  const ids = new Set(registered);
  const byId = known ? new Map(known.components.map((c) => [c.id, c])) : new Map();

  // Availability: one entry per registered component, in registry order.
  if (m.availability.length > MAX.components) problems.push('too many entries');
  if (JSON.stringify(m.availability.map((a) => a && a.id)) !== JSON.stringify(registered)) problems.push('availability does not list exactly the registered components, in order');
  const previewIds = new Set(m.components.map((c) => c && c.id));
  for (const a of m.availability) {
    if (!isObj(a) || AVAILABILITY.indexOf(a.state) < 0) { problems.push('an availability entry is malformed'); continue; }
    if (a.state === 'preview' && (a.reason !== null || !previewIds.has(a.id))) problems.push('"' + a.id + '" is marked previewable but has no fixtures');
    if (a.state === 'unavailable' && (REASONS.indexOf(a.reason) < 0 || previewIds.has(a.id))) problems.push('"' + a.id + '" is marked unavailable with an invalid reason or has fixtures');
  }

  const seen = new Set();
  let totalBytes = 0;
  m.components.forEach((c, i) => {
    const where = 'component ' + (c && c.id ? '"' + c.id + '"' : '#' + i);
    const p = (x) => problems.push(where + ': ' + x);
    if (!isObj(c) || !isText(c.id, 80) || !COMPONENT_ID.test(c.id)) { p('has no valid id'); return; }
    if (seen.has(c.id)) p('id is used twice');
    seen.add(c.id);
    if (!ids.has(c.id)) { p('is not a registered component'); return; }
    if (!isText(c.symbol, 120) || !SYMBOL.test(c.symbol)) p('has an invalid symbol');
    if (!isObj(c.source) || !isObj(c.source.js) || !Array.isArray(c.source.css)) { p('has no source binding'); return; }
    const js = c.source.js;
    if (!isText(js.file) || js.symbol !== c.symbol || !SHA.test(js.sha256 || '') || !isCount(js.bytes)) p('has a malformed render-function binding');
    for (const x of c.source.css) if (!isObj(x) || !isText(x.file) || !isCount(x.rules) || !SHA.test(x.sha256 || '') || !isCount(x.bytes)) p('has a malformed CSS binding');
    if (!Array.isArray(c.mediaQueries) || !c.mediaQueries.every((q) => isText(q, 120))) p('has malformed media queries');
    if (!Array.isArray(c.variants) || !Array.isArray(c.fixtures) || !c.fixtures.length) { p('has no fixtures'); return; }
    if (c.fixtures.length > MAX.fixturesPerComponent) p('has too many fixtures');

    // Still bound to what the components manifest recorded.
    const rec = byId.get(c.id);
    if (known) {
      if (!rec || !rec.source.js) { p('has no render function in the components manifest'); return; }
      if (JSON.stringify(rec.source.js) !== JSON.stringify(js)) p('is bound to a render function that is not the one the components manifest records');
      if (JSON.stringify(rec.source.css) !== JSON.stringify(c.source.css)) p('is bound to CSS that is not what the components manifest records');
      if (JSON.stringify(rec.styling.mediaQueries) !== JSON.stringify(c.mediaQueries)) p('media queries differ from the components manifest');
    }
    const recVariants = rec ? rec.variants : c.variants;
    const view = { id: c.id, variants: recVariants };
    for (const v of c.variants) {
      if (!isObj(v) || !isText(v.class, 80) || !isText(v.name, 80) || !isCount(v.rules) || !Array.isArray(v.exercisedBy)) { p('has a malformed variant'); return; }
      const want = recVariants.find((x) => x.class === v.class);
      if (known && (!want || want.rules !== v.rules || want.name !== v.name)) p('variant "' + v.class + '" is not one the components manifest records');
    }
    if (known && JSON.stringify(c.variants.map((v) => v.class)) !== JSON.stringify(recVariants.map((v) => v.class))) p('does not list every verified variant of the component');

    const fx = new Set();
    for (const f of c.fixtures) {
      validateFixture(f, view, where + ' / ' + (f && f.id ? f.id : 'fixture'), { ids }, problems);
      if (isObj(f) && f.id) { if (fx.has(f.id)) p('fixture id "' + f.id + '" is used twice'); fx.add(f.id); }
      if (isObj(f) && typeof f.bytes === 'number') totalBytes += f.bytes;
    }
    for (const v of c.variants) {
      const want = c.fixtures.filter((f) => isObj(f) && Array.isArray(f.variantClasses) && f.variantClasses.indexOf(v.class) >= 0).map((f) => f.id);
      if (JSON.stringify(want) !== JSON.stringify(v.exercisedBy)) p('variant "' + v.class + '" lists fixtures that do not carry it');
    }
  });
  if (totalBytes > MAX.totalBytes) problems.push('the fixtures are larger than ' + MAX.totalBytes + ' bytes together');

  if (!problems.length && JSON.stringify(m.coverage) !== JSON.stringify(coverageOf(m))) problems.push('coverage does not match the components');
  return problems;
}

module.exports = { SCHEMA, REASONS, OWNERS_SPECIAL, MAX, COMPONENT_ID, SYMBOL, validateManifest, validateFixture, coverageOf, sanitizer, sha256 };
