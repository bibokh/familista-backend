#!/usr/bin/env node
// Familista — building the English catalogue from the source
// ─────────────────────────────────────────────────────────────────────────────
// The catalogue is the list of English strings a reader can see. It is built
// from string literals in the frontend source rather than from a running
// browser, and that choice is what makes the whole translation layer safe:
//
//   A player's name, a club's name, an email address, an uploaded filename —
//   none of them are literals in app.js, so none of them can enter the
//   catalogue, so none of them can ever be translated. There is no name
//   detector to tune and nothing to get wrong.
//
// What is extracted:
//
//   · text between tags in the HTML these files build            >Save Squad<
//   · the attributes a person reads      placeholder / title / aria-label / alt
//   · the label-ish properties of the data tables that drive the UI
//        label: 'Stage Objectives'   lbl: 'Players'   title: 'Coaching Focus'
//   · the messages passed to showToast / confirm dialogs
//
// What is not, and why each one would be a bug if it were: numbers and units,
// emoji and single glyphs, CSS, SVG path data, selectors, URLs, class-name
// soup, template placeholders, and the football position codes (GK, CB, ST …)
// which are conventional in every language.
//
// Numbers inside an otherwise-fixed string are replaced by a slot, so
// "13 players" and "4 players" both become one entry — see dom.js.
//
// Usage:
//   node scripts/i18n-extract.js            → write the source inventory
//   node scripts/i18n-extract.js --list     → print the strings instead
//   node scripts/i18n-extract.js --count    → print the total only

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['public/app.js', 'public/index.html'];
const OUT = path.join(ROOT, 'public/i18n/catalogue/_source-inventory.json');

const SLOT = '\u0000';
const NUM = /\d+(?:[.,\u00A0\u202F]\d+)*/g;

const POSITIONS = /^(GK|CB|LB|RB|LWB|RWB|WB|FB|DM|CM|AM|LM|RM|MC|MR|ML|LW|RW|ST|CF|CAM|CDM|DL|DC|DR|AMC|AML|AMR|SW|XI)$/;

// Words that only ever appear as code: CSS values, DOM API names, keys of
// internal tables. A string made only of these is not prose.
const CODEY = /^(px|rem|em|vh|vw|auto|none|true|false|null|undefined|inherit|initial|unset|flex|grid|block|inline|absolute|relative|fixed|sticky|hidden|visible|pointer|center|left|right|top|bottom|middle|normal|bold|italic|solid|dashed|dotted|round|butt|square|currentColor|transparent)$/i;

function isNoise(v) {
  if (!v) return true;
  const s = v.trim();
  if (s.length < 2 || s.length > 400) return true;
  if (!/[A-Za-z]/.test(s)) return true;                 // numbers, punctuation, emoji
  if (!/[A-Za-z]{2}/.test(s)) return true;              // needs a real word somewhere
  if (POSITIONS.test(s)) return true;
  if (CODEY.test(s)) return true;
  if (/[${]/.test(s) && /\}/.test(s)) return true;      // a template being built
  if (/^['"`]/.test(s)) return true;
  if (/^[#.][a-zA-Z0-9_-]+$/.test(s)) return true;      // a selector
  if (/^[a-z]+(-[a-z0-9]+)+$/.test(s)) return true;     // kebab-case: a class or key
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(s)) return true; // camelCase: an identifier
  if (/^[A-Z][a-z]*([A-Z][a-z0-9]*)+$/.test(s) && !/\s/.test(s)) return true; // PascalCase
  if (/^[MmLlHhVvCcSsQqTtAaZz][\d\s.,-]{4,}/.test(s)) return true;  // svg path data
  if (/^(https?:|\/\/|data:|blob:|mailto:|#)/.test(s)) return true;
  if (/^[\w.+-]+@[\w.-]+$/.test(s)) return true;        // an email address
  if (/^[\d\s.,:%+\-\u2014\u00b7/()]+$/.test(s)) return true;     // numbers and units only
  if (/^(rgba?|hsla?|var|calc|url|linear-gradient|radial-gradient)\s*\(/.test(s)) return true;
  if (/^&[a-z]+;$/.test(s)) return true;                // a bare entity
  if (/^\d+(\.\d+)?(px|rem|em|%|s|ms|vh|vw|fr|deg)$/.test(s)) return true;
  if (isCode(s)) return true;
  // The same technical exclusions the runtime applies, so the inventory and the
  // interface agree on what is prose. A route, a slug, an enum constant and a
  // written-out rule are all things a person may see and none of them is text
  // anybody should translate.
  if (/^\/[a-z0-9]/i.test(s)) return true;
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(s)) return true;
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s)) return true;
  if (/[<>]=?\s*\d|\d\s*[<>]=?/.test(s)) return true;
  if (/^\w+\.\w+$/.test(s)) return true;
  return false;
}

// The between-tags pattern cannot tell a tag from a comparison: `a > 0 ? b : c`
// followed anywhere by a `<` looks exactly like `>text<`. That put hundreds of
// JavaScript fragments into the inventory — "%d ? a.control * %d : %d) + (a.counter"
// — which are not strings anybody reads and were never translation gaps. They
// are rejected here so the backlog figure means what it says.
function isCode(s) {
  if (/[?;{}]|=>|\|\||&&|\+\+|!==|===|\+=|\bvar |\blet |\bconst |\breturn\b|\bfunction\b|\btypeof\b/.test(s)) return true;
  if (/\w\.\w+/.test(s) && !/\.\s/.test(s)) return true;   // property access, not a sentence
  if (/\w\(|\)\s*[.[]/.test(s)) return true;               // a call
  if (/\[\d+\]|\[['"]/.test(s)) return true;               // an index
  if (/^[^A-Za-z]*[)\]]/.test(s)) return true;              // starts inside an expression
  return false;
}

// The shape a string is stored under: whitespace collapsed, and any number
// replaced by a slot so one entry answers for every count.
function shape(v) {
  return v.replace(/\s+/g, ' ').trim().replace(NUM, SLOT);
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
}

function scan(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const found = new Map();   // shape -> { kind, line }

  const add = (raw, kind, idx) => {
    if (raw == null) return;
    const v = decodeEntities(String(raw)).replace(/\s+/g, ' ').trim();
    if (isNoise(v)) return;
    const k = shape(v);
    if (!k || found.has(k)) return;
    found.set(k, { kind, line: src.slice(0, idx).split('\n').length });
  };

  // Text between tags, in the markup these files build. `[^<>{}]` keeps out
  // anything with an interpolation in it — those are assembled from pieces that
  // are picked up separately.
  for (const m of src.matchAll(/>([^<>{}'"`]{2,180})</g)) add(m[1], 'text', m.index);

  // The attributes a person reads.
  for (const m of src.matchAll(/\b(placeholder|title|aria-label|alt)=["']([^"'<>{}]{2,180})["']/g)) {
    add(m[2], m[1], m.index);
  }

  // The label-ish properties of the data tables that drive this interface —
  // nav items, KPI rows, academy stages, tactical options, status maps. These
  // never appear between tags in the source because they are assembled at
  // render time, and they are a large part of what a reader actually sees.
  const LABEL_KEYS = 'label|lbl|l|title|name|sub|subtitle|heading|head|text|txt|msg|message|detail|details|desc|description|hint|help|caption|tooltip|placeholder|note|reason|summary|status|pill|plabel|btnLabel|kicker|cta|empty|unit|short|long|value|v|answer|question|tab|group|category|section|legend|footer|prefix|suffix';
  const labelRe = new RegExp('\\b(' + LABEL_KEYS + ')\\s*:\\s*([\'"])((?:(?!\\2)[^\\\\]|\\\\.){2,180})\\2', 'g');
  for (const m of src.matchAll(labelRe)) add(m[3], 'label', m.index);

  // Strings in the label tables that are written as bare array entries —
  // ['Players', 13], ['Coaches', 4] — which is how several of these screens
  // hold their rows.
  for (const m of src.matchAll(/\[\s*(['"])((?:(?!\1)[^\\]|\\.){2,120})\1\s*,/g)) add(m[2], 'row', m.index);

  // What the app says to the user directly.
  for (const m of src.matchAll(/\b(showToast|alert|confirm)\(\s*(['"])((?:(?!\2)[^\\]|\\.){2,240})\2/g)) {
    add(m[3], 'message', m.index);
  }

  return found;
}

const all = new Map();
const perFile = [];
for (const f of SOURCES) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const found = scan(f);
  perFile.push([f, found.size]);
  for (const [k, meta] of found) if (!all.has(k)) all.set(k, meta);
}

const keys = [...all.keys()].sort((a, b) => a.localeCompare(b));

// Print and stop, but never process.exit(): on a pipe stdout is written
// asynchronously and exiting drops whatever has not flushed yet, so --list
// silently lost a third of the inventory and every count taken from it read low.
const listing = process.argv.includes('--count') ? String(keys.length)
  : process.argv.includes('--list') ? keys.map((k) => k.replace(/\u0000/g, '%d')).join('\n')
  : null;
if (listing !== null) {
  console.log(listing);
} else {

// The inventory is every English string the SOURCE contains. It is wider than
// the catalogue on purpose — it includes screens no route reaches and code
// paths nothing calls — so it is a backlog to draw from, not the shipped list.
// The shipped English key set is catalogue/en-GB.json, which is authored.
const out = {};
for (const k of keys) out[k] = k;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 0) + '\n');

console.log('Familista i18n — English catalogue extracted\n');
for (const [f, n] of perFile) console.log(`  ${f.padEnd(22)} ${String(n).padStart(5)}`);
console.log(`  ${'DISTINCT'.padEnd(22)} ${String(keys.length).padStart(5)}`);
console.log(`\n  → ${path.relative(ROOT, OUT)}`);
}
