// Familista Design System Control — the components core (Stage 3.2.2).
//
// Plain JavaScript, no dependency, shared by the three readers of the
// Components Registry so they can never disagree about what a well-formed one is:
//
//   scripts/design-system-components.js   builds the manifest, then validates it
//   src/design-system/design-system.service.ts   validates it again before it
//                                         serves a single component
//   tests/design-system-components.unit.test.ts   the same two, as evidence
//
// WHAT THE REGISTRY IS
//
// A reviewed list, in tools/components/registry.json: a person decided that
// these are the components, named them, classified them and wrote one line about
// each. The generator then looks for every claim in the repository and refuses
// to write the manifest if one cannot be found. What reaches this module is
// therefore three different things, kept apart on every record:
//
//   RECORDED   a person's reviewed statement (name, category, kind, summary)
//   MEASURED   found in the repository files by the generator (a rule, a symbol,
//              a hash, a Storybook case, a class a function emits)
//   NONE       nothing records it. The screen says "Not instrumented".
//
// Nothing here is inferred, and nothing is a usage statistic: the platform keeps
// none, and the Overview says so.
'use strict';

const SCHEMA = 1;

const KINDS = ['component', 'primitive', 'pattern', 'css-family', 'layout-utility', 'page-specific', 'candidate'];
/** How much of a record the generator could verify. Computed, never declared. */
const TIERS = ['verified', 'catalogued', 'listed'];
const EVIDENCE = ['MEASURED', 'RECORDED', 'NONE'];
const SECTIONS = ['overview', 'anatomy', 'styling', 'source', 'variants', 'stories', 'accessibility', 'dependencies'];
const DEPTHS = ['full', 'presence'];

const MAX_TEXT = 400;
const ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CLASS_RE = /^[A-Za-z_][\w-]*$/;
const SHA_RE = /^[0-9a-f]{64}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= (max || MAX_TEXT) && !/[\u0000-\u001f]/.test(v);
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 1e7;
const isBool = (v) => typeof v === 'boolean';
const textList = (v, max) => Array.isArray(v) && v.length <= (max || 500) && v.every((x) => isText(x));

/**
 * The tier a record has earned. The generator calls this; the validator checks
 * that the manifest agrees, so a record cannot claim more than it has.
 *   verified    render source, CSS rules and Storybook cases are all found
 *   catalogued  source or CSS rules are found, without a Storybook case
 *   listed      only the presence of the declared class or prefix is verified
 */
function tierOf(c) {
  if (c.depth === 'presence') return 'listed';
  const hasSource = !!(c.source && c.source.js);
  const hasRules = !!(c.styling && c.styling.rules > 0);
  const hasCases = !!(c.stories && (c.stories.cases.length > 0 || c.stories.golden.length > 0));
  if (hasSource && hasRules && hasCases) return 'verified';
  return 'catalogued';
}

/** Which of the eight inspector sections have any evidence at all. Used by the card's evidence ring and by the filters. */
function sectionState(c) {
  const none = 'NONE';
  const full = c.depth === 'full';
  return {
    overview: 'RECORDED',
    anatomy: c.anatomy.length ? 'MEASURED' : none,
    styling: full && c.styling.rules > 0 ? 'MEASURED' : none,
    source: (c.source.js || c.source.css.length || c.source.presence.length) ? 'MEASURED' : none,
    variants: c.variants.length ? 'MEASURED' : none,
    stories: c.stories ? 'MEASURED' : none,
    accessibility: c.accessibility.facts.length ? 'MEASURED' : none,
    dependencies: (c.dependencies.calls.length || c.dependencies.calledBy.length || (full && c.styling.customProperties.length)) ? 'MEASURED' : none,
  };
}

function validateComponent(c, ctx, where) {
  const problems = [];
  const p = (m) => problems.push(where + ': ' + m);
  if (!isObj(c)) return [where + ': is not an object'];
  if (!isText(c.id, 80) || !ID_RE.test(c.id)) p('has no valid id');
  for (const k of ['name', 'summary']) if (!isText(c[k])) p('needs a ' + k);
  if (!ctx.categories.has(c.category)) p('has unknown category "' + c.category + '"');
  if (!ctx.modules.has(c.module)) p('has unknown module "' + c.module + '"');
  if (KINDS.indexOf(c.kind) < 0) p('has unknown kind "' + c.kind + '"');
  if (TIERS.indexOf(c.tier) < 0) p('has unknown tier "' + c.tier + '"');
  if (DEPTHS.indexOf(c.depth) < 0) p('has unknown depth');
  if (c.kind === 'candidate' && c.tier !== 'listed') p('is a candidate, which can only be listed');
  if (c.kind === 'candidate' && c.category !== 'candidates') p('is a candidate outside the candidates category');
  if (c.category === 'candidates' && c.kind !== 'candidate') p('is in the candidates category but is not a candidate');

  // source
  const s = c.source;
  if (!isObj(s) || !Array.isArray(s.css) || !Array.isArray(s.presence)) { p('has no source'); return problems; }
  if (s.js !== null) {
    if (!isObj(s.js) || !isText(s.js.file) || !isText(s.js.symbol, 120) || !SHA_RE.test(s.js.sha256 || '') || !isCount(s.js.bytes)) p('has a malformed js source');
  }
  for (const x of s.css) if (!isObj(x) || !isText(x.file) || !isCount(x.rules) || !SHA_RE.test(x.sha256 || '') || !isCount(x.bytes)) p('has a malformed css source');
  for (const x of s.presence) if (!isObj(x) || !isText(x.file) || x.matched !== true) p('has a malformed presence source');
  if (c.depth === 'presence' && (s.js !== null || s.css.length)) p('is presence-only but carries hashes');
  if (c.depth === 'full' && !(s.js || s.css.length)) p('is full-depth but has no source');

  // styling
  const st = c.styling;
  if (!isObj(st) || !isCount(st.rules) || !isCount(st.selectorsTotal) || !textList(st.selectors, 80) || !textList(st.states, 40)
    || !textList(st.mediaQueries, 40) || !textList(st.customProperties, 80) || !isCount(st.customPropertiesTotal)
    || !isBool(st.focusVisible) || !isBool(st.rtl) || !isBool(st.reducedMotion)) p('has malformed styling');
  else if (c.depth === 'presence' && st.rules !== 0) p('is presence-only but counts rules');

  // anatomy and variants
  if (!Array.isArray(c.anatomy)) p('has no anatomy list');
  else c.anatomy.forEach((a, i) => { if (!isObj(a) || !CLASS_RE.test(a.cls || '') || !isCount(a.rules) || !(a.emitted === null || isBool(a.emitted))) p('anatomy #' + i + ' is malformed'); });
  if (!Array.isArray(c.variants)) p('has no variants list');
  else c.variants.forEach((v, i) => {
    if (!isObj(v) || !isText(v.name, 80) || !CLASS_RE.test(v.class || '') || !isCount(v.rules) || !textList(v.cases, 40) || !textList(v.stories, 40) || !isBool(v.exercised)) p('variant #' + i + ' is malformed');
    else if (v.rules < 1) p('variant "' + v.name + '" has no CSS rule, so it is not verified');
    else if (v.exercised !== (v.cases.length + v.stories.length > 0)) p('variant "' + v.name + '" exercised flag is wrong');
  });

  // stories
  if (c.stories !== null) {
    const t = c.stories;
    if (!isObj(t) || !isText(t.file) || !isText(t.title) || !textList(t.cases, 200) || !textList(t.golden, 200) || !textList(t.options, 200)
      || !isObj(t.review) || !isBool(t.review.rtl) || !isBool(t.review.tablet) || !isBool(t.review.mobile)) p('has malformed stories');
  }

  // accessibility facts: source facts, never a conformance claim
  if (!isObj(c.accessibility) || !Array.isArray(c.accessibility.facts)) p('has no accessibility facts list');
  else c.accessibility.facts.forEach((f, i) => { if (!isObj(f) || !isText(f.id, 60) || !isText(f.label) || f.evidence !== 'MEASURED' || !isText(f.where, 160)) p('accessibility fact #' + i + ' is malformed'); });

  // dependencies
  const d = c.dependencies;
  if (!isObj(d) || !Array.isArray(d.calls) || !Array.isArray(d.calledBy) || !textList(d.helpers, 200)) p('has malformed dependencies');
  else {
    for (const x of d.calls) {
      if (!isObj(x) || !isText(x.symbol, 120) || !(x.component === null || (isText(x.component, 80) && ctx.ids.has(x.component)))) p('has a call that names a component that does not exist');
    }
    for (const id of d.calledBy) if (!ctx.ids.has(id)) p('is called by "' + id + '", which does not exist');
  }

  if (!textList(c.referencedIn, 20)) p('has malformed referencedIn');
  if (!isObj(c.sections) || SECTIONS.some((k) => EVIDENCE.indexOf(c.sections[k]) < 0)) p('has malformed sections');
  else if (JSON.stringify(c.sections) !== JSON.stringify(sectionState(c))) p('sections disagree with what the record holds');
  if (TIERS.indexOf(c.tier) >= 0 && c.tier !== tierOf(c)) p('claims tier "' + c.tier + '" but its evidence earns "' + tierOf(c) + '"');
  return problems;
}

/** Every problem with the whole manifest, as strings. [] means well-formed. Nothing is repaired. */
function validateManifest(m) {
  if (!isObj(m)) return ['the components manifest is not an object'];
  const problems = [];
  if (m.schema !== SCHEMA) problems.push('the components manifest is not schema ' + SCHEMA);
  if (!Array.isArray(m.sources) || !Array.isArray(m.components) || !isObj(m.taxonomy)) return problems.concat('sources, components and taxonomy are required');

  const ids = new Set();
  for (const s of m.sources) {
    if (!isObj(s) || !isText(s.id, 80) || !isText(s.path) || !isText(s.label) || !SHA_RE.test(s.sha256 || '') || !isCount(s.bytes) || ['file', 'derived'].indexOf(s.basis) < 0) problems.push('a source is malformed');
    else if (ids.has(s.id)) problems.push('source "' + s.id + '" is listed twice');
    else ids.add(s.id);
  }

  const t = m.taxonomy;
  const keyed = (list, name) => {
    const out = new Set();
    if (!Array.isArray(list) || !list.length) { problems.push('taxonomy.' + name + ' is missing'); return out; }
    for (const x of list) {
      if (!isObj(x) || !isText(x.id, 80) || !ID_RE.test(x.id) || !isText(x.label)) problems.push('taxonomy.' + name + ' has a malformed entry');
      else if (out.has(x.id)) problems.push('taxonomy.' + name + ' lists "' + x.id + '" twice');
      else out.add(x.id);
    }
    return out;
  };
  const categories = keyed(t.categories, 'categories');
  const modules = keyed(t.modules, 'modules');
  const kinds = keyed(t.kinds, 'kinds');
  const tiers = keyed(t.tiers, 'tiers');
  if (JSON.stringify([...kinds]) !== JSON.stringify(KINDS)) problems.push('taxonomy.kinds must be exactly: ' + KINDS.join(', '));
  if (JSON.stringify([...tiers]) !== JSON.stringify(TIERS)) problems.push('taxonomy.tiers must be exactly: ' + TIERS.join(', '));

  const seen = new Set();
  const all = new Set(m.components.map((c) => c && c.id));
  const ctx = { categories, modules, ids: all };
  m.components.forEach((c, i) => {
    const where = 'component ' + (c && c.id ? '"' + c.id + '"' : '#' + i);
    if (c && seen.has(c.id)) problems.push(where + ': id is used twice');
    if (c) seen.add(c.id);
    for (const x of validateComponent(c, ctx, where)) problems.push(x);
  });

  // calledBy must be the exact reverse of calls.
  for (const c of m.components) {
    if (!c || !c.dependencies || !Array.isArray(c.dependencies.calledBy)) continue;
    const expect = m.components.filter((o) => o && o.dependencies && Array.isArray(o.dependencies.calls) && o.dependencies.calls.some((x) => x.component === c.id)).map((o) => o.id);
    if (JSON.stringify(expect) !== JSON.stringify(c.dependencies.calledBy)) problems.push('component "' + c.id + '": calledBy is not the reverse of calls');
  }

  if (!isObj(m.coverage) || !isObj(m.coverage.byKind) || !isObj(m.coverage.byTier) || !isObj(m.coverage.byCategory) || !isCount(m.coverage.total)) problems.push('coverage is missing');
  else if (JSON.stringify(m.coverage) !== JSON.stringify(coverageOf(m.components))) problems.push('coverage does not match the components');
  return problems;
}

function coverageOf(components) {
  const count = (key) => {
    const out = {};
    for (const c of components) out[key(c)] = (out[key(c)] || 0) + 1;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  };
  return {
    total: components.length,
    byKind: count((c) => c.kind),
    byTier: count((c) => c.tier),
    byCategory: count((c) => c.category),
    withStories: components.filter((c) => c.stories).length,
    withVariants: components.filter((c) => c.variants.length).length,
    withSource: components.filter((c) => c.source.js).length,
  };
}

module.exports = { SCHEMA, KINDS, TIERS, EVIDENCE, SECTIONS, DEPTHS, tierOf, sectionState, validateComponent, validateManifest, coverageOf };
