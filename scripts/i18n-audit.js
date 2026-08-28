#!/usr/bin/env node
// Familista — hard-coded UI string audit
// ─────────────────────────────────────────────────────────────────────────────
// Reports user-visible text that is still written directly into markup instead
// of coming from a translation key, so migration progress is a number rather
// than an impression, and so new work cannot quietly bypass i18n.
//
// What it counts, and what it deliberately does not:
//
//   COUNTED   text between tags (>Save<), and the values of placeholder=,
//             title= and aria-label= — the four places a person actually reads.
//
//   IGNORED   anything already carrying data-i18n / t(), single glyphs and
//             emoji, numbers and units, CSS and SVG path data, football
//             position abbreviations (GK, CB, LB, CM, ST — conventional in
//             every language and deliberately left alone), and template
//             placeholders. These are not translation failures.
//
// Exit code is 0 by default: this reports, it does not block. `--max=N` makes
// it fail above a ceiling, which is how a build can hold the line without
// demanding the whole backlog be cleared first.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['public/app.js', 'public/index.html'];

// Football position codes stay as they are — conventional worldwide.
const POSITIONS = /^(GK|CB|LB|RB|LWB|RWB|WB|FB|DM|CM|AM|LM|RM|MC|MR|ML|LW|RW|ST|CF|CAM|CDM|DL|DC|DR|AMC|AML|AMR|SW|XI)$/;

function isNoise(s) {
  const v = s.trim();
  if (!v) return true;
  if (v.length < 2) return true;                       // single glyphs
  if (!/[A-Za-z]/.test(v)) return true;                // numbers, punctuation, emoji
  if (POSITIONS.test(v)) return true;
  if (/^[\d\s.,:%+\-—·/]+$/.test(v)) return true;      // numeric/units
  if (/^\$\{/.test(v) || /^\{\{/.test(v)) return true; // interpolation
  if (/^[a-z][a-zA-Z0-9]*$/.test(v) && v.length < 4) return true;
  if (/^(px|rem|em|vh|vw|auto|none|true|false|null|undefined)$/i.test(v)) return true;
  if (/^[#.][a-zA-Z0-9_-]+$/.test(v)) return true;     // selectors
  if (/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,-]+/.test(v)) return true; // svg paths
  if (/^(https?:|\/|data:)/.test(v)) return true;
  return true === false ? true : false;
}

function scan(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const hits = [];
  const seen = new Set();

  const push = (text, kind, idx) => {
    const v = String(text).trim();
    if (isNoise(v)) return;
    // Already translated, or the immediate context declares a key.
    const around = src.slice(Math.max(0, idx - 220), idx + 40);
    if (/data-i18n(-\w+)?=/.test(around)) return;
    if (/\bt\(\s*['"]/.test(around)) return;
    const key = kind + '|' + v;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, text: v.slice(0, 70), line: src.slice(0, idx).split('\n').length });
  };

  // Text between tags.
  for (const m of src.matchAll(/>([^<>{}]{2,80})</g)) push(m[1], 'text', m.index);
  // Reader-visible attributes.
  for (const m of src.matchAll(/\b(placeholder|title|aria-label)=["']([^"']{2,80})["']/g)) {
    push(m[2], m[1], m.index);
  }
  return hits;
}

const all = [];
for (const f of TARGETS) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const hits = scan(f);
  all.push([f, hits]);
}

const total = all.reduce((n, [, h]) => n + h.length, 0);
console.log('Familista i18n audit — remaining hard-coded user-facing strings\n');
for (const [f, hits] of all) {
  console.log(`  ${f.padEnd(22)} ${String(hits.length).padStart(5)}`);
}
console.log(`  ${'TOTAL'.padEnd(22)} ${String(total).padStart(5)}\n`);

if (process.argv.includes('--list')) {
  for (const [f, hits] of all) {
    for (const h of hits.slice(0, 60)) console.log(`  ${f}:${h.line}  [${h.kind}] ${h.text}`);
  }
}

const cap = (process.argv.find((a) => a.startsWith('--max=')) || '').split('=')[1];
if (cap && total > Number(cap)) {
  console.error(`\nFAIL: ${total} hard-coded strings exceeds the agreed ceiling of ${cap}.`);
  console.error('Migrate the new strings to translation keys, or raise the ceiling deliberately.');
  process.exit(1);
}
process.exit(0);
