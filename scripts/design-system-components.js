// Familista — the Components Registry builder (Stage 3.2.2).
//
// Called by scripts/design-system-discover.js, which writes
// src/design-system/generated/design-system-components.json beside the other
// two manifests and checks all three with --check.
//
// Input is the reviewed registry (tools/components/registry.json): a person's
// list of names, categories, kinds and one-line summaries, plus the CSS classes,
// render function, variants and Storybook story each one claims. This module
// looks for every claim in the repository and THROWS if one cannot be found. It
// never downgrades a claim silently, and it never adds a component the registry
// does not list. Nothing is previewed, executed or evaluated: files are read as
// text, a function is cut out by name and only syntax-checked.
//
// What it measures, per component:
//   source      the render function (symbol, sha256, bytes) and the CSS rules
//               that mention the component's classes (count, sha256, bytes);
//               never the code itself, and never a line number, so editing
//               something else in app.js or app.css cannot make a record stale
//   styling     selectors, states, media queries, custom properties read, and
//               whether the rules carry focus-visible, RTL or reduced-motion
//   anatomy     the component's parts, and which of them its function emits
//   variants    each declared modifier, with its rule count and the Storybook
//               cases and stories that exercise it
//   stories     the story file's exports and the golden snapshot cases
//   accessibility  facts found in the source (aria-hidden, alt, role, focus
//               styles, an RTL case) — never a conformance claim
//   dependencies   the functions a render function calls, and who calls it
//
// Deterministic: no timestamp, no host, no environment value; registry order.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const core = require('../src/design-system/components-core.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Production sources searched for a class in use. Presence only: no counts, which would change with every edit. */
const REFERENCE_FILES = [
  'public/app.js', 'public/index.html', 'public/familista-admin.html',
  'public/system/system.js', 'public/data-vault/data-vault.js', 'public/infrastructure-city/infrastructure-city.js',
  'public/source-core/source-core.js', 'public/familista-vision/familista-vision.js', 'public/cybersecurity/cybersecurity.js',
  'public/algorithms/algorithms.js', 'public/design-system/design-system.js', 'public/design-system/explorer.js',
  'public/design-system/components.js',
];

// ── CSS ─────────────────────────────────────────────────────────────────────

/** Every style rule: its at-rule context, its selector text and its body. Keyframes and font-faces are skipped. */
function cssRules(text) {
  const s = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  (function block(ctx) {
    while (i < s.length) {
      const o = s.indexOf('{', i), c = s.indexOf('}', i);
      if (o < 0 && c < 0) { i = s.length; return; }
      if (c >= 0 && (o < 0 || c < o)) { i = c + 1; return; }
      const pre = s.slice(i, o).trim();
      i = o + 1;
      if (pre.startsWith('@')) {
        if (/^@(media|supports|container|layer)\b/.test(pre)) block((ctx ? ctx + ' ' : '') + squash(pre));
        else { let d = 1; while (d && i < s.length) { if (s[i] === '{') d++; else if (s[i] === '}') d--; i++; } }
      } else {
        const e = s.indexOf('}', i);
        out.push({ ctx, sel: squash(pre), body: squash(s.slice(i, e)) });
        i = e + 1;
      }
    }
  }(''));
  return out;
}

/** Class names a selector mentions, ignoring attribute values and strings. */
function classesOf(sel) {
  const clean = sel.replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"|'[^']*'/g, '');
  return [...clean.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
}

// ── JavaScript: one function, by name ───────────────────────────────────────

function endOfFunction(src, start) {
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '/') {
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      if (j < 0 || '(,=:[!&|?{};'.includes(src[j])) {   // a regex literal
        i++;
        let cls = false;
        while (i < src.length && (cls || src[i] !== '/')) {
          if (src[i] === '\\') i++; else if (src[i] === '[') cls = true; else if (src[i] === ']') cls = false;
          i++;
        }
        i++; continue;
      }
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  throw new Error('unbalanced braces');
}

// The production files a render function may be cut from, and nothing else. A
// registry entry naming any other path, or a path that climbs out of public/, is
// refused before anything is read.
const SOURCE_FILES = ['public/app.js', 'public/design-system/design-system.js'];

function sourceFile(file) {
  if (typeof file !== 'string' || !file || path.isAbsolute(file) || /\\/.test(file) || file.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new Error('render-function file "' + file + '" is not a plain repository path (path traversal is refused)');
  }
  if (SOURCE_FILES.indexOf(file) < 0) throw new Error('render-function file "' + file + '" is not one of the approved sources: ' + SOURCE_FILES.join(', '));
  return file;
}

/**
 * The top level of the one IIFE a file consists of, with its two-space indent
 * removed: a declaration at that level starts at column 0 and one nested deeper
 * does not. Mirrors iifeScope() in tools/storybook/lib/extract-lg.mjs, and a test
 * holds the two to the same text. Read as text; the IIFE is never run.
 */
function iifeScope(src, file) {
  const open = [...src.matchAll(/^\(function \(\) \{$/gm)];
  const close = [...src.matchAll(/^\}\(\)\);$/gm)];
  if (open.length !== 1 || close.length !== 1 || close[0].index < open[0].index) {
    throw new Error(file + ': expected exactly one top-level "(function () {" ... "}());", found ' + open.length + ' and ' + close.length);
  }
  const body = src.slice(open[0].index + open[0][0].length, close[0].index);
  if (!/^\n  'use strict';\n/.test(body)) throw new Error(file + ": the IIFE does not begin with 'use strict'");
  return body.replace(/^  /gm, '');
}

/** The text a declaration is cut from: app.js as it is, design-system.js as the top level of its IIFE. */
function scopeOf(file, text) { return file === 'public/app.js' ? text : iifeScope(text, file); }

function cutFunction(src, file, name, whole = src) {
  const esc$ = name.replace(/[$]/g, '\\$');
  // Declared once anywhere in the file, at any depth; otherwise "the" function is ambiguous.
  const anywhere = [...whole.matchAll(new RegExp('\\bfunction ' + esc$ + '\\s*\\(', 'g'))].length;
  if (anywhere !== 1) throw new Error(file + ': "function ' + name + '" is declared ' + anywhere + ' times at any depth; exactly one is required');
  // Nor is it assigned a new value anywhere, which would make the running function another one.
  if (new RegExp('(?<![\\w$.])' + esc$ + '\\s*=(?![=>])').test(whole)) throw new Error(file + ': "' + name + '" is reassigned; the declaration cut is not the function that runs');
  const re = new RegExp('^function ' + esc$ + '\\(', 'gm');
  const all = [...src.matchAll(re)];
  if (all.length !== 1) throw new Error(file + ': expected exactly one "function ' + name + '" at the top level, found ' + all.length);
  const text = src.slice(all[0].index, endOfFunction(src, all[0].index));
  new vm.Script(text, { filename: file + '#' + name });   // compiled, never run
  return text;
}

// ── Storybook (read as text; the extractor is neither imported nor touched) ──

function readStories(ROOT, base) {
  const rel = 'tools/storybook/stories/' + base + '.stories.js';
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('the registry names story file ' + base + ', which does not exist');
  const text = fs.readFileSync(abs, 'utf8');
  const title = (/title:\s*'([^']+)'/.exec(text) || [])[1];
  if (!title) throw new Error(rel + ': no story title found');
  const cases = [...text.matchAll(/^export const (\w+)\s*=/gm)].map((m) => m[1]);
  const options = [];
  for (const m of text.matchAll(/options:\s*\[([^\]]*)\]/g)) for (const q of m[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)) if (q[1] && options.indexOf(q[1]) < 0) options.push(q[1]);
  return { rel, text, title, cases, options, sha: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) };
}

// ── the build ───────────────────────────────────────────────────────────────

function build({ ROOT }) {
  const regFile = path.join(ROOT, 'tools', 'components', 'registry.json');
  const regBuf = fs.readFileSync(regFile);
  const reg = JSON.parse(regBuf.toString('utf8'));
  const errors = [];
  const fail = (m) => errors.push(m);

  // The registry's own shape.
  const ids = new Set(), cats = new Set(reg.categories.map((x) => x.id)), mods = new Set(reg.modules.map((x) => x.id));
  const kindIds = new Set(reg.kinds.map((x) => x.id));
  if (JSON.stringify(reg.kinds.map((x) => x.id)) !== JSON.stringify(core.KINDS)) fail('the registry kinds must be exactly: ' + core.KINDS.join(', '));
  for (const c of reg.components) {
    if (ids.has(c.id)) fail('registry id "' + c.id + '" is used twice');
    ids.add(c.id);
    if (!cats.has(c.category)) fail(c.id + ': unknown category ' + c.category);
    if (!mods.has(c.module)) fail(c.id + ': unknown module ' + c.module);
    if (!kindIds.has(c.kind)) fail(c.id + ': unknown kind ' + c.kind);
  }

  const readFile = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const cssCache = new Map();
  const css = (f) => { if (!cssCache.has(f)) cssCache.set(f, cssRules(readFile(f))); return cssCache.get(f); };
  // Each approved source, read once: its text, the scope declarations are cut from, and the functions at that level.
  const jsSources = new Map();
  const sourceOf = (file) => {
    if (!jsSources.has(file)) {
      const text = readFile(sourceFile(file));
      const scope = scopeOf(file, text);
      jsSources.set(file, { text, scope, fns: [...scope.matchAll(/^function ([\w$]+)\(/gm)].map((m) => m[1]) });
    }
    return jsSources.get(file);
  };
  const appJs = sourceOf('public/app.js').text;
  const topFunctions = sourceOf('public/app.js').fns;
  const topSet = new Set(topFunctions);
  const refSources = REFERENCE_FILES.filter((f) => fs.existsSync(path.join(ROOT, f))).map((f) => [f, readFile(f)]);

  const golden = JSON.parse(readFile('tools/storybook/tests/golden/lg-primitives.golden.json'));
  const storyFiles = new Map();
  const stories = (base) => { if (!storyFiles.has(base)) storyFiles.set(base, readStories(ROOT, base)); return storyFiles.get(base); };

  // symbol → component id, for dependency edges.
  const symbolOwner = new Map();
  for (const c of reg.components) {
    if (!c.js) continue;
    // A symbol names one render function: the golden snapshot and the previews are keyed by it.
    if (symbolOwner.has(c.js.symbol)) fail(c.id + ': render function "' + c.js.symbol + '" is already registered by ' + symbolOwner.get(c.js.symbol));
    else symbolOwner.set(c.js.symbol, c.id);
  }

  const out = [];
  for (const c of reg.components) {
    try {
      out.push(buildOne(c));
    } catch (e) { fail(c.id + ': ' + e.message); }
  }

  function buildOne(c) {
    const presence = ['css-family', 'page-specific', 'candidate'].indexOf(c.kind) >= 0;
    const files = c.css.files;
    for (const f of files) if (!fs.existsSync(path.join(ROOT, f))) throw new Error('stylesheet ' + f + ' does not exist');

    const variants = (c.variants || []);
    const anatomyNames = (c.anatomy || []);
    const owned = new Set([...(c.css.classes || []), ...variants.map((v) => v.class), ...anatomyNames]);
    const prefixes = c.css.prefixes || [];
    if (!presence && !owned.size) throw new Error('declares no CSS class');
    if (presence && !owned.size && !prefixes.length) throw new Error('declares neither a class nor a prefix');
    const matches = (cls) => owned.has(cls) || prefixes.some((p) => cls.startsWith(p));

    // Rules that mention any of the component's classes.
    const rules = [];
    const defined = new Set();
    for (const f of files) {
      for (const r of css(f)) {
        const cl = classesOf(r.sel);
        for (const k of cl) defined.add(k);
        if (cl.some(matches)) rules.push({ file: f, ...r, cl });
      }
    }
    for (const k of owned) if (!defined.has(k)) throw new Error('class .' + k + ' is declared but no rule in ' + files.join(', ') + ' mentions it');
    for (const p of prefixes) if (![...defined].some((k) => k.startsWith(p))) throw new Error('prefix ' + p + ' is declared but no class in ' + files.join(', ') + ' starts with it');
    if (!rules.length) throw new Error('no CSS rule found');

    const countRules = (cls) => rules.filter((r) => r.cl.indexOf(cls) >= 0).length;

    // source
    let js = null, jsText = '';
    if (c.js) {
      const src = sourceOf(c.js.file);
      jsText = cutFunction(src.scope, c.js.file, c.js.symbol, src.text);
      js = { file: c.js.file, symbol: c.js.symbol, sha256: sha(Buffer.from(squash(jsText))), bytes: Buffer.byteLength(jsText) };
    }
    const cssSource = [];
    const presenceSource = [];
    for (const f of files) {
      const mine = rules.filter((r) => r.file === f);
      if (!mine.length) continue;
      if (presence) presenceSource.push({ file: f, matched: true });
      else {
        const norm = mine.map((r) => (r.ctx ? r.ctx + ' ' : '') + r.sel + ' {' + r.body + '}').join('\n');
        cssSource.push({ file: f, rules: mine.length, sha256: sha(Buffer.from(norm)), bytes: Buffer.byteLength(norm) });
      }
    }

    // styling (full depth only)
    const selectors = [...new Set(rules.map((r) => r.sel))].sort();
    const stateSet = new Set();
    for (const r of rules) {
      for (const m of r.sel.matchAll(/(?<!:):(hover|focus-visible|focus-within|focus|active|disabled|checked|placeholder-shown|first-child|last-child)\b/g)) stateSet.add(':' + m[1]);
      if (/::placeholder/.test(r.sel)) stateSet.add('::placeholder');
      for (const m of r.sel.matchAll(/\.([A-Za-z_][\w-]*)\.(active|on|open|is-[\w-]+|selected|disabled|has|current)(?![\w-])/g)) if (owned.has(m[1])) stateSet.add('.' + m[2]);
    }
    const props = new Set();
    for (const r of rules) for (const m of r.body.matchAll(/var\(\s*(--[\w-]+)/g)) props.add(m[1]);
    const media = [...new Set(rules.map((r) => r.ctx).filter(Boolean))].sort();
    const styling = presence
      ? { selectors: [], selectorsTotal: 0, rules: 0, states: [], mediaQueries: [], customProperties: [], customPropertiesTotal: 0, focusVisible: false, rtl: false, reducedMotion: false }
      : {
        selectors: selectors.slice(0, 80), selectorsTotal: selectors.length, rules: rules.length,
        states: [...stateSet].sort(), mediaQueries: media.slice(0, 40),
        customProperties: [...props].sort().slice(0, 80), customPropertiesTotal: props.size,
        focusVisible: rules.some((r) => /:focus-visible/.test(r.sel)),
        rtl: rules.some((r) => /\[dir=["']?rtl|:dir\(rtl\)|:lang\(ar\)/.test(r.sel)),
        reducedMotion: rules.some((r) => /prefers-reduced-motion/.test(r.ctx)),
      };

    // anatomy: declared parts, which the render function emits
    const emits = (cls) => (jsText ? new RegExp('(?<![\\w-])' + cls.replace(/-/g, '\\-') + '(?![\\w-])').test(jsText) : null);
    const anatomy = presence ? [] : anatomyNames.map((cls) => ({ cls, rules: countRules(cls), emitted: emits(cls) }));
    for (const a of anatomy) if (a.rules < 1) throw new Error('anatomy part .' + a.cls + ' has no rule');

    // stories
    let st = null, goldenLabels = [];
    if (c.stories) {
      const s = stories(c.stories);
      goldenLabels = c.golden ? Object.keys(golden[c.golden] || {}) : [];
      if (c.golden && !goldenLabels.length) throw new Error('golden snapshot "' + c.golden + '" does not exist');
      st = {
        file: s.rel, title: s.title, cases: s.cases, golden: goldenLabels, options: s.options,
        review: { rtl: s.cases.indexOf('RTL') >= 0, tablet: s.cases.indexOf('Tablet') >= 0, mobile: s.cases.indexOf('Mobile') >= 0 },
      };
    }

    // variants: each must have a rule; each case or story it cites must exist
    const vout = variants.map((v) => {
      const n = countRules(v.class);
      if (n < 1) throw new Error('variant "' + v.name + '" (.' + v.class + ') has no CSS rule');
      // A golden case counts only if the real HTML it pinned carries the variant's class.
      for (const k of (v.cases || [])) {
        if (goldenLabels.indexOf(k) < 0) throw new Error('variant "' + v.name + '" cites golden case "' + k + '", which does not exist');
        const html = String(golden[c.golden][k]);
        if (!new RegExp('(?<![\\w-])' + v.class.replace(/-/g, '\\-') + '(?![\\w-])').test(html)) throw new Error('golden case "' + k + '" does not contain .' + v.class + ', so it does not exercise variant "' + v.name + '"');
      }
      // A story counts only if it exists and names the variant: by its own name, or by the class or value it passes.
      for (const k of (v.stories || [])) {
        if (!st || st.cases.indexOf(k) < 0) throw new Error('variant "' + v.name + '" cites story "' + k + '", which does not exist');
        const text = stories(c.stories).text;
        const suffix = v.class.split(/--|-/).pop();
        const named = k.toLowerCase().indexOf(v.name.toLowerCase().replace(/[^a-z0-9]/g, '')) >= 0;
        const quoted = (tok) => new RegExp("'" + tok.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + "'", 'i').test(text);
        if (!named && !quoted(v.class) && !quoted(suffix) && !quoted(v.name)) throw new Error('story "' + k + '" does not name variant "' + v.name + '" (' + v.class + ')');
      }
      const cases = (v.cases || []).slice(), sto = (v.stories || []).slice();
      return { name: v.name, class: v.class, rules: n, cases, stories: sto, exercised: cases.length + sto.length > 0 };
    });

    // accessibility: facts found in the source. Not an audit, not a conformance claim.
    const facts = [];
    const add = (id, label, where) => facts.push({ id, label, evidence: 'MEASURED', where });
    if (jsText) {
      if (/aria-hidden="true"/.test(jsText)) add('aria-hidden', 'The function marks decorative graphics aria-hidden.', 'render function');
      if (/\balt="/.test(jsText)) add('img-alt', 'The function writes alt text on its image.', 'render function');
      if (/\brole="/.test(jsText)) add('role', 'The function writes an ARIA role.', 'render function');
      if (/aria-(label|labelledby|describedby|live|pressed|expanded|current)/.test(jsText)) add('aria-attr', 'The function writes ARIA state or label attributes.', 'render function');
      if (/<button\b/.test(jsText)) add('native-button', 'The function renders a native button element.', 'render function');
      if ((c.js.file === 'public/app.js' ? /\b_esc\(/ : /(?<![\w$.])esc\(/).test(jsText)) add('escapes', 'The function escapes interpolated text before it reaches the page.', 'render function');
    }
    if (!presence) {
      if (styling.focusVisible) add('focus-visible', 'A rule styles :focus-visible.', 'stylesheet');
      if (styling.rtl) add('rtl-rules', 'A rule is written for right-to-left or Arabic.', 'stylesheet');
      if (styling.reducedMotion) add('reduced-motion', 'A rule is written for prefers-reduced-motion.', 'stylesheet');
    }
    if (st && st.review.rtl) add('story-rtl', 'A Storybook case renders it right to left.', st.file);
    if (st && (st.review.tablet || st.review.mobile)) add('story-viewports', 'A Storybook case renders it at a tablet or phone width.', st.file);

    // dependencies
    const calls = [];
    const helpers = [];
    if (jsText) {
      for (const name of sourceOf(c.js.file).fns) {
        if (name === c.js.symbol) continue;
        if (new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '\\(').test(jsText)) {
          const owner = symbolOwner.get(name) || null;
          if (owner) calls.push({ symbol: name, component: owner }); else helpers.push(name);
        }
      }
    }

    // where it is used: presence in a class context, never a count
    const names = [...owned];
    const used = new Set();
    for (const [f, text] of refSources) {
      for (const k of names) {
        const tok = '(?<![\\w-])' + k.replace(/-/g, '\\-') + '(?![\\w-])';
        const hit = k.indexOf('-') >= 0 ? new RegExp(tok).test(text) : new RegExp('class[^\\n]{0,200}' + tok).test(text);
        if (hit) { used.add(f); break; }
      }
      if (!names.length) for (const p of prefixes) if (new RegExp('(?<![\\w-])' + p.replace(/-/g, '\\-')).test(text)) used.add(f);
    }

    const comp = {
      id: c.id, name: c.name, category: c.category, kind: c.kind, tier: 'listed', module: c.module, summary: c.summary,
      depth: presence ? 'presence' : 'full',
      source: { js, css: cssSource, presence: presenceSource },
      styling, anatomy, variants: vout, stories: st,
      accessibility: { facts },
      dependencies: { calls: calls.sort((a, b) => (a.symbol < b.symbol ? -1 : 1)), calledBy: [], helpers: helpers.sort() },
      referencedIn: [...used].sort(),
      sections: null,
    };
    return comp;
  }

  if (errors.length) throw new Error('the Components Registry could not be verified against the repository:\n  ' + errors.join('\n  '));

  // calledBy is the reverse of calls; tiers and sections are computed, never declared.
  for (const c of out) c.dependencies.calledBy = out.filter((o) => o.dependencies.calls.some((x) => x.component === c.id)).map((o) => o.id);
  for (const c of out) { c.tier = core.tierOf(c); c.sections = core.sectionState(c); }

  const file = (id, abs, label) => { const b = fs.readFileSync(abs); return { id, path: path.relative(ROOT, abs).split(path.sep).join('/'), label, sha256: sha(b), bytes: b.length, basis: 'file' }; };
  const storyList = [...storyFiles.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const storyDigest = storyList.map((s) => s.rel + ':' + s.sha).join('\n');
  const slices = out.map((c) => [c.id, c.source.js && c.source.js.sha256, ...c.source.css.map((x) => x.file + ':' + x.sha256), ...c.source.presence.map((x) => x.file)].join('|')).join('\n');
  const sources = [
    file('registry', regFile, 'The reviewed Components Registry'),
    { id: 'storybook-stories', path: 'tools/storybook/stories', label: 'The Storybook story files the registry cites', sha256: sha(Buffer.from(storyDigest)), bytes: Buffer.byteLength(storyDigest), basis: 'derived' },
    file('storybook-golden', path.join(ROOT, 'tools/storybook/tests/golden/lg-primitives.golden.json'), 'The golden snapshot cases of the ten competition primitives'),
    { id: 'production-slices', path: 'public', label: 'The slices of production source each component owns (render function and CSS rules)', sha256: sha(Buffer.from(slices)), bytes: Buffer.byteLength(slices), basis: 'derived' },
  ];

  const manifest = {
    schema: core.SCHEMA,
    generator: 'scripts/design-system-discover.js',
    description: 'The reviewed Components Registry, verified against the repository. Generated; do not edit.',
    sources,
    taxonomy: {
      categories: reg.categories, modules: reg.modules, kinds: reg.kinds,
      tiers: [
        { id: 'verified', label: 'Verified', description: 'Render source, CSS rules and Storybook cases were all found.' },
        { id: 'catalogued', label: 'Catalogued', description: 'Source or CSS rules were found, without a Storybook case.' },
        { id: 'listed', label: 'Listed', description: 'Only the presence of the declared class or prefix was verified.' },
      ],
    },
    coverage: core.coverageOf(out),
    components: out,
  };
  const problems = core.validateManifest(manifest);
  if (problems.length) throw new Error('the components manifest is malformed:\n  ' + problems.slice(0, 20).join('\n  '));
  return manifest;
}

module.exports = { build, cssRules, classesOf, cutFunction, iifeScope, sourceFile, SOURCE_FILES };
