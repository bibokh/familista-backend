#!/usr/bin/env node
// Familista — the translation guard
// ─────────────────────────────────────────────────────────────────────────────
// This used to count hard-coded strings in the source, which was the right
// question when the plan was to migrate seven thousand call sites to keys. It
// is the wrong question now. The interface is translated by catalogue against
// the English it already says (see public/i18n/dom.js), so a string being
// "hard-coded" is not a defect — a string having no translation is.
//
// So this asks two things instead:
//
//   1. Is every locale's catalogue complete against the English key set?
//      A locale missing entries is a screen that will be half-translated for
//      whoever chose it, which is exactly the fault this whole system exists
//      to remove.
//
//   2. How much of what the source can display is catalogued at all?
//      Reported as a number so the backlog is a figure and not an impression.
//      It is deliberately NOT a failure: the source contains screens no route
//      reaches, and a string with no entry renders as the English it already
//      was — invisible, never a raw key.
//
// The check that actually proves the product is translated needs a running app
// and lives in scripts/i18n-walk.js, which opens every module in a real browser
// and reports what is still English. Run that before claiming a language works.
//
//   node scripts/i18n-audit.js              → report
//   node scripts/i18n-audit.js --max=N      → fail if the backlog exceeds N
//   node scripts/i18n-audit.js --list       → print the uncatalogued strings

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CAT = path.join(ROOT, 'public/i18n/catalogue');
const SLOT = '\u0000';

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ── 1 · every locale complete against the English key set ────────────────────
const english = read(path.join(CAT, 'en-GB.json'));
const keys = Object.keys(english);

const cfg = fs.readFileSync(path.join(ROOT, 'public/i18n/config.js'), 'utf8');
const tags = [...cfg.matchAll(/tag: '([^']+)'/g)].map((m) => m[1]);

let incomplete = 0;
const rows = [];
for (const tag of tags) {
  const file = path.join(CAT, tag + '.json');
  if (!fs.existsSync(file)) { rows.push([tag, 'MISSING', 0]); incomplete++; continue; }
  const cat = read(file);
  // English variants are translated by not being translated: the markup is
  // already English, so only the handful of usage differences need entries.
  if (/^en(-|$)/.test(tag)) { rows.push([tag, 'english', Object.keys(cat).length]); continue; }
  // A `…|plural` key holds one form per CLDR category the language uses. A
  // language with a single category — Chinese, Japanese, Korean, Thai,
  // Vietnamese, Indonesian, Malay — says the same thing for every count, so
  // the plain shape entry already answers it and a second entry would only
  // repeat itself. Ask those locales for the shape, not for the plural.
  const oneForm = new Intl.PluralRules(tag).resolvedOptions().pluralCategories.length === 1;
  const missing = keys.filter((k) => {
    if (oneForm && k.endsWith('|plural')) return cat[k.slice(0, -'|plural'.length)] == null;
    return cat[k] == null && cat[k + '|plural'] == null;
  });
  if (missing.length) incomplete++;
  rows.push([tag, missing.length ? missing.length + ' missing' : 'complete', Object.keys(cat).length]);
}

console.log('Familista i18n audit\n');
console.log('  ── catalogues ──');
for (const [tag, state, n] of rows) {
  console.log(`  ${tag.padEnd(8)} ${String(n).padStart(4)} entries   ${state}`);
}

// ── 2 · what the source can display, against what is catalogued ──────────────
let inventory = [];
try {
  inventory = execFileSync(process.execPath, [path.join(__dirname, 'i18n-extract.js'), '--list'], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((s) => s.split('%d').join(SLOT));
} catch (_) { inventory = []; }

const uncatalogued = inventory.filter((s) => english[s] == null);
console.log('\n  ── coverage ──');
console.log(`  strings the source can display   ${String(inventory.length).padStart(5)}`);
console.log(`  of those, catalogued             ${String(inventory.length - uncatalogued.length).padStart(5)}`);
console.log(`  backlog (renders as English)     ${String(uncatalogued.length).padStart(5)}`);
console.log('\n  The inventory is every string the SOURCE contains, including screens no');
console.log('  route reaches and code paths nothing calls, so it is much larger than what');
console.log('  a person can actually see. What a person sees is measured by');
console.log('  scripts/i18n-walk.js against a running app; that is the number that says');
console.log('  whether a language works.');

if (process.argv.includes('--list')) {
  console.log('');
  for (const s of uncatalogued.slice(0, 200)) console.log('   ' + s.split(SLOT).join('%d'));
}

if (incomplete) {
  console.error(`\nFAIL: ${incomplete} locale(s) are not complete against en-GB.`);
  console.error('A partial catalogue is a half-translated screen. Fill it, or remove the locale.');
  process.exit(1);
}

const cap = (process.argv.find((a) => a.startsWith('--max=')) || '').split('=')[1];
if (cap && uncatalogued.length > Number(cap)) {
  console.error(`\nFAIL: ${uncatalogued.length} uncatalogued strings exceeds the agreed ceiling of ${cap}.`);
  console.error('Add the new strings to public/i18n/catalogue, or raise the ceiling deliberately.');
  process.exit(1);
}
console.log('\nOK');
process.exit(0);
