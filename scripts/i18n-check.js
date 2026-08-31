#!/usr/bin/env node
// Familista — the localization gate
// ─────────────────────────────────────────────────────────────────────────────
// One command that answers "is this branch shippable in every language we
// offer?", so that shipping a feature and localizing it stop being two separate
// pieces of work. It is the check CLAUDE.md points at, the check `npm test`
// runs, and the check to run before calling any feature finished.
//
// Everything it knows about which languages exist it reads from
// src/i18n/locales.ts. That file is the single source of truth: add a locale
// there and to its client mirror, and this script starts demanding files for
// it on the next run without anybody editing this script. Nothing here counts
// languages, and no number of languages appears anywhere in it.
//
// What it checks, and why each one is a real defect rather than a preference:
//
//   1 · registry   The server list and the client mirror must be identical.
//                  A language offered in the dropdown but refused by the API
//                  lets someone choose a setting that silently never saves.
//   2 · files      Every locale needs a bundle and a catalogue, and both must
//                  parse as an object of strings. A malformed file is a locale
//                  that throws on load and leaves the interface half-drawn.
//   3 · bundles    Every key in the base bundle must exist in every locale, and
//                  no locale may carry a key the base does not have. The first
//                  is a missing translation; the second is a dead entry, and
//                  usually a typo hiding a missing translation somewhere else.
//   4 · references A key the source asks for by name must exist in the base
//                  bundle. This is the check that catches a new feature the
//                  moment it is written, before anybody switches language.
//   5 · catalogue  Every locale's catalogue must answer every entry the English
//                  one has, allowing for languages with a single plural form.
//   6 · backlog    The number of displayable source strings with no catalogue
//                  entry may not grow. This does not demand the pre-existing
//                  backlog be cleared; it demands a new feature not add to it.
//
// Checks 1–5 are absolute: they fail on any violation, because each one is a
// visible fault in a language somebody selected. Check 6 is a ratchet against
// a recorded baseline, because the alternative — failing on a backlog that
// predates the rule — would mean the gate is switched off on day one.
//
//   node scripts/i18n-check.js                    → full report
//   node scripts/i18n-check.js --quiet            → failures only
//   node scripts/i18n-check.js --fast             → skip the backlog scan
//   node scripts/i18n-check.js --update-baseline  → record today's backlog
//
// Uses nothing but Node and what the repository already ships. No new
// dependency: the inventory comes from scripts/i18n-extract.js, which already
// exists, and the plural rules come from Intl, which is in the runtime.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// The repository, unless a test points this somewhere else. The override exists
// so the gate itself can be tested — a check nobody has ever seen fail is a
// check nobody knows works. Nothing in normal use sets it.
const ROOT = process.env.FAMILISTA_I18N_ROOT
  ? path.resolve(process.env.FAMILISTA_I18N_ROOT)
  : path.join(__dirname, '..');
const SERVER_REGISTRY = path.join(ROOT, 'src/i18n/locales.ts');
const CLIENT_REGISTRY = path.join(ROOT, 'public/i18n/config.js');
const BUNDLES = path.join(ROOT, 'public/i18n/locales');
const CATALOGUE = path.join(ROOT, 'public/i18n/catalogue');
const BASELINE = path.join(ROOT, 'scripts/i18n-baseline.json');
const SLOT = '\u0000';

const ARGS = process.argv.slice(2);
const QUIET = ARGS.includes('--quiet');
const FAST = ARGS.includes('--fast');
const UPDATE = ARGS.includes('--update-baseline');

const failures = [];
const notes = [];
const fail = (check, message) => failures.push({ check, message });
const say = (line) => { if (!QUIET) console.log(line); };

const readText = (p) => fs.readFileSync(p, 'utf8');

// ── the registry ─────────────────────────────────────────────────────────────
// Both halves are written in the same shape, so one expression reads both. If
// the shape of either file changes, this returns nothing and check 1 fails
// loudly rather than passing on an empty list.
const LOCALE_RE = /\{\s*tag:\s*'([^']+)',\s*label:\s*'([^']+)',\s*dir:\s*'(ltr|rtl)'\s*\}/g;
const parseRegistry = (text) =>
  [...text.matchAll(LOCALE_RE)].map((m) => ({ tag: m[1], label: m[2], dir: m[3] }));

const server = parseRegistry(readText(SERVER_REGISTRY));
const client = parseRegistry(readText(CLIENT_REGISTRY));

if (!server.length) {
  fail('registry', `no locales could be read from ${path.relative(ROOT, SERVER_REGISTRY)} — the registry is the source of truth and cannot be empty`);
}
if (server.length !== client.length) {
  fail('registry', `the server declares ${server.length} locales and the client mirror ${client.length}`);
}
for (let i = 0; i < Math.max(server.length, client.length); i++) {
  const a = server[i];
  const b = client[i];
  const one = (x) => (x ? `${x.tag}/${x.label}/${x.dir}` : '—');
  if (one(a) !== one(b)) {
    fail('registry', `entry ${i + 1} differs: server ${one(a)}, client ${one(b)}`);
  }
}

const serverDefault = (readText(SERVER_REGISTRY).match(/DEFAULT_LOCALE\s*=\s*'([^']+)'/) || [])[1];
const clientDefault = (readText(CLIENT_REGISTRY).match(/DEFAULT_LOCALE:\s*'([^']+)'/) || [])[1];
if (!serverDefault || serverDefault !== clientDefault) {
  fail('registry', `base locale differs: server ${serverDefault || '—'}, client ${clientDefault || '—'}`);
}

const TAGS = server.map((l) => l.tag);
const BASE = serverDefault || 'en-GB';
say(`Familista i18n check\n\n  registry  ${path.relative(ROOT, SERVER_REGISTRY)} → ${TAGS.length} locales, base ${BASE}`);

// ── files, and whether they are well formed ──────────────────────────────────
// A file that will not parse is reported once, and the locale is then skipped
// for the content checks: every later complaint about it would be noise.
const bundles = {};
const catalogues = {};

const loadJson = (check, tag, file) => {
  if (!fs.existsSync(file)) {
    fail(check, `${tag}: ${path.relative(ROOT, file)} does not exist`);
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(file));
  } catch (e) {
    fail(check, `${tag}: ${path.relative(ROOT, file)} is not valid JSON — ${e.message}`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(check, `${tag}: ${path.relative(ROOT, file)} is not a JSON object`);
    return null;
  }
  return parsed;
};

// The bundle is nested for the sake of whoever edits it; the runtime flattens
// it. Flattening here too means a key is compared the way it is used.
const flatten = (obj, prefix, out, bad) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, bad);
    else if (typeof v === 'string') out[key] = v;
    else bad.push(key);
  }
  return out;
};

for (const tag of TAGS) {
  const raw = loadJson('files', tag, path.join(BUNDLES, `${tag}.json`));
  if (raw) {
    const bad = [];
    bundles[tag] = flatten(raw, '', {}, bad);
    if (bad.length) fail('files', `${tag}: bundle values must be strings — ${bad.slice(0, 5).join(', ')}`);
  }
  const cat = loadJson('files', tag, path.join(CATALOGUE, `${tag}.json`));
  if (cat) {
    const bad = Object.entries(cat).filter(([, v]) => typeof v !== 'string').map(([k]) => k);
    if (bad.length) fail('files', `${tag}: catalogue values must be strings — ${bad.slice(0, 5).join(', ')}`);
    catalogues[tag] = cat;
  }
}

// ── bundle completeness, and orphans ─────────────────────────────────────────
const baseBundle = bundles[BASE];
if (!baseBundle) {
  fail('bundles', `the base bundle for ${BASE} could not be read, so nothing can be compared against it`);
} else {
  const baseKeys = Object.keys(baseBundle);
  say(`  bundles   ${baseKeys.length} keys in the base bundle`);
  for (const tag of TAGS) {
    const b = bundles[tag];
    if (!b || tag === BASE) continue;
    const missing = baseKeys.filter((k) => typeof b[k] !== 'string' || b[k] === '');
    const orphan = Object.keys(b).filter((k) => baseBundle[k] === undefined);
    if (missing.length) fail('bundles', `${tag}: ${missing.length} missing key(s) — ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}`);
    if (orphan.length) fail('bundles', `${tag}: ${orphan.length} key(s) the base bundle does not have — ${orphan.slice(0, 6).join(', ')}${orphan.length > 6 ? ' …' : ''}`);
  }
}

// ── keys the source asks for by name ─────────────────────────────────────────
// Only literal keys are collected. A key assembled at runtime — `'league.col.'
// + name` — cannot be resolved statically, and guessing at it would produce
// false failures, so those are left to the runtime's own missing-key logging.
const sourceFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
    else if (/\.(js|html)$/.test(entry.name)) sourceFiles.push(full);
  }
};
walk(path.join(ROOT, 'public'));

const referenced = new Map(); // key -> first file that asks for it
if (baseBundle) {
  const patterns = [
    /data-i18n(?:-placeholder|-title|-aria)?="([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)"/g,
    /\bt\(\s*'([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)'/g,
    /\bt\(\s*"([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)"/g,
  ];
  for (const file of sourceFiles) {
    // The i18n runtime itself names keys in prose and in its own fallbacks.
    if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
    const text = readText(file);
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        if (!referenced.has(m[1])) referenced.set(m[1], path.relative(ROOT, file));
      }
    }
  }
  // A key does not always reach `t()` where it is written. The navigation table
  // carries `i18nKey:` and the League's column table carries `key:` and
  // `fullKey:`, and the markup is assembled from those later — a typo there
  // would otherwise surface only as one wrong-looking column in one language.
  // The property name is what makes this safe to read as a key: a bare dotted
  // string is not enough, or an internal token like 'auth.event' would qualify.
  const declared = /\b(?:i18nKey|fullKey|key)\s*:\s*'([a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)+)'/g;
  for (const file of sourceFiles) {
    if (file.includes(`${path.sep}i18n${path.sep}`)) continue;
    for (const m of readText(file).matchAll(declared)) {
      if (!referenced.has(m[1])) referenced.set(m[1], path.relative(ROOT, file));
    }
  }

  const unknown = [...referenced].filter(([k]) => baseBundle[k] === undefined);
  say(`  keys      ${referenced.size} literal key reference(s) in public/`);
  for (const [key, file] of unknown) {
    fail('references', `${file} asks for "${key}", which the base bundle does not define`);
  }
  // Reported, never failed: a key with no literal reference may still be built
  // at runtime, and deleting one on this evidence alone would break a screen.
  const unreferenced = Object.keys(baseBundle).filter((k) => !referenced.has(k));
  if (unreferenced.length) {
    notes.push(`${unreferenced.length} base bundle key(s) have no literal reference in public/ — expected for keys built at runtime, worth a look if a group was removed`);
  }
}

// ── catalogue completeness ───────────────────────────────────────────────────
// The catalogue is keyed by the English the interface already says, so a
// missing entry renders as English rather than as a raw key — invisible, and
// therefore exactly the kind of gap that needs a machine to notice it.
const baseCatalogue = catalogues[BASE];
if (!baseCatalogue) {
  fail('catalogue', `the base catalogue for ${BASE} could not be read`);
} else {
  const keys = Object.keys(baseCatalogue);
  say(`  catalogue ${keys.length} entries in the base catalogue`);
  for (const tag of TAGS) {
    const cat = catalogues[tag];
    if (!cat) continue;
    // English variants are translated by not being translated: the markup is
    // already English and only usage differences need entries.
    if (/^en(-|$)/.test(tag)) continue;
    // A `…|plural` key holds one form per CLDR category the language uses, so
    // a language with a single category is answered by the plain shape alone.
    let oneForm = false;
    try { oneForm = new Intl.PluralRules(tag).resolvedOptions().pluralCategories.length === 1; } catch (_) {}
    const missing = keys.filter((k) => {
      if (oneForm && k.endsWith('|plural')) return cat[k.slice(0, -'|plural'.length)] == null;
      return cat[k] == null && cat[k + '|plural'] == null;
    });
    if (missing.length) {
      const show = missing.slice(0, 4).map((s) => JSON.stringify(s.split(SLOT).join('%d'))).join(', ');
      fail('catalogue', `${tag}: ${missing.length} entr(ies) missing — ${show}${missing.length > 4 ? ' …' : ''}`);
    }
  }
}

// ── placeholders waiting for a real translation ──────────────────────────────
// scripts/i18n-sync.js can fill a gap with the base value so the interface
// resolves. That is a placeholder, not a translation, and it is recorded rather
// than forgotten — otherwise a complete-looking file would hide a screen that
// still reads English, which is precisely the failure this gate exists to stop.
const PENDING = path.join(ROOT, 'public/i18n/_pending-translation.json');
if (fs.existsSync(PENDING)) {
  try {
    const pending = JSON.parse(readText(PENDING));
    const entries = Object.entries(pending.locales || {}).filter(([, v]) => v && v.length);
    const count = entries.reduce((n, [, v]) => n + v.length, 0);
    if (count) {
      notes.push(`${count} placeholder(s) across ${entries.length} locale(s) are English standing in for a translation (${entries.map(([t, v]) => `${t}:${v.length}`).join(', ')}) — see ${path.relative(ROOT, PENDING)}`);
    }
  } catch (e) {
    fail('files', `${path.relative(ROOT, PENDING)} is not valid JSON — ${e.message}`);
  }
}

// ── the hardcoded-string ratchet ─────────────────────────────────────────────
let backlog = null;
if (!FAST && baseCatalogue) {
  let inventory = [];
  try {
    inventory = execFileSync(process.execPath, [path.join(__dirname, 'i18n-extract.js'), '--list'], {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }).split('\n').filter(Boolean).map((s) => s.split('%d').join(SLOT));
  } catch (e) {
    fail('backlog', `the source inventory could not be produced — ${e.message}`);
  }
  if (inventory.length) {
    backlog = inventory.filter((s) => baseCatalogue[s] == null).length;
    const recorded = fs.existsSync(BASELINE) ? JSON.parse(readText(BASELINE)) : null;
    say(`  backlog   ${backlog} of ${inventory.length} displayable source strings have no catalogue entry`);
    if (UPDATE) {
      fs.writeFileSync(BASELINE, JSON.stringify({
        backlog,
        inventory: inventory.length,
        recordedAt: new Date().toISOString().slice(0, 10),
        note: 'Strings the source can display that no catalogue entry answers. This may fall; it may not rise. Lower it when you translate something, and raise it only as a deliberate, explained decision.',
      }, null, 2) + '\n');
      say(`            baseline rewritten to ${backlog}`);
    } else if (!recorded) {
      fail('backlog', `no baseline recorded — run: node scripts/i18n-check.js --update-baseline`);
    } else if (backlog > recorded.backlog) {
      fail('backlog', `${backlog} uncatalogued strings, up from the recorded ${recorded.backlog}. New user-facing text was added without translations. Run: npm run i18n:sync`);
    } else if (backlog < recorded.backlog) {
      notes.push(`the backlog fell from ${recorded.backlog} to ${backlog} — lower the baseline with --update-baseline so it cannot drift back`);
    }
  }
}

// ── the verdict ──────────────────────────────────────────────────────────────
if (notes.length && !QUIET) {
  console.log('\n  ── notes ──');
  for (const n of notes) console.log(`  · ${n}`);
}

if (failures.length) {
  console.error('\n  ── failures ──');
  for (const f of failures) console.error(`  ✗ [${f.check}] ${f.message}`);
  console.error(`\nFAIL: ${failures.length} localization problem(s).`);
  console.error('A feature with user-facing text is not finished until this passes. See CLAUDE.md.');
  process.exitCode = 1;
} else {
  say('\nOK — every declared locale is complete, and nothing new was left untranslated.');
}
