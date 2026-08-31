#!/usr/bin/env node
// Familista — locale synchronization
// ─────────────────────────────────────────────────────────────────────────────
// The other half of scripts/i18n-check.js. The check says which locales are
// behind; this fills them in. Together they are what makes localization part of
// building a feature instead of a separate errand somebody has to remember.
//
// Two rules govern everything below, and neither has an override flag:
//
//   1. An existing translation is never touched. A value that is already in a
//      locale file was put there by a person or by an earlier run that somebody
//      reviewed, and no automatic process gets to overwrite that judgement.
//      Only keys that are absent are ever written.
//
//   2. A placeholder is never passed off as a translation. Filling a gap with
//      English makes the file look complete while the screen still reads
//      English, which is the exact failure this tooling exists to catch. So
//      when the passthrough provider is used, every key it fills is recorded in
//      public/i18n/_pending-translation.json and reported by the check until a
//      real translation replaces it.
//
// ── Providers
//
// Translation itself is pluggable, because the repository cannot decide on its
// own to start spending money:
//
//   report        the default. Writes nothing. Prints exactly what is missing,
//                 per locale, so the work is visible and can be done by hand.
//   passthrough   fills missing keys with the base value so the interface
//                 resolves rather than falls back, and records every one of
//                 them as pending. Costs nothing, translates nothing.
//   anthropic     real translation through @anthropic-ai/sdk, which this
//                 repository already depends on and already configures
//                 (src/config/index.ts → anthropic). Runs only when
//                 ANTHROPIC_API_KEY is set and only when asked for by name,
//                 so no run ever bills anybody by accident.
//
// Adding another provider means adding one entry to PROVIDERS below. Nothing
// else in the pipeline knows which one ran.
//
//   node scripts/i18n-sync.js                                  → what is missing
//   node scripts/i18n-sync.js --write --provider=passthrough   → fill, mark pending
//   node scripts/i18n-sync.js --write --provider=anthropic     → translate
//   node scripts/i18n-sync.js --locales=de-DE,fr-FR            → narrow the scope
//   node scripts/i18n-sync.js --bundles | --catalogue          → one file kind only

const fs = require('fs');
const path = require('path');

// The repository, unless a test points this somewhere else — see the same note
// in scripts/i18n-check.js. Nothing in normal use sets it.
const ROOT = process.env.FAMILISTA_I18N_ROOT
  ? path.resolve(process.env.FAMILISTA_I18N_ROOT)
  : path.join(__dirname, '..');
const SERVER_REGISTRY = path.join(ROOT, 'src/i18n/locales.ts');
const BUNDLES = path.join(ROOT, 'public/i18n/locales');
const CATALOGUE = path.join(ROOT, 'public/i18n/catalogue');
const PENDING = path.join(ROOT, 'public/i18n/_pending-translation.json');
const SLOT = '\u0000';

const ARGS = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const WRITE = ARGS.includes('--write');
const PROVIDER = flag('provider', 'report');
const ONLY = (flag('locales', '') || '').split(',').filter(Boolean);
const DO_BUNDLES = !ARGS.includes('--catalogue');
const DO_CATALOGUE = !ARGS.includes('--bundles');

const readText = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(readText(p));

// ── the registry, which is the only place locales are declared ───────────────
const LOCALE_RE = /\{\s*tag:\s*'([^']+)',\s*label:\s*'([^']+)',\s*dir:\s*'(ltr|rtl)'\s*\}/g;
const REGISTRY = [...readText(SERVER_REGISTRY).matchAll(LOCALE_RE)]
  .map((m) => ({ tag: m[1], label: m[2], dir: m[3] }));
const BASE = (readText(SERVER_REGISTRY).match(/DEFAULT_LOCALE\s*=\s*'([^']+)'/) || [])[1] || 'en-GB';

if (!REGISTRY.length) {
  console.error(`No locales could be read from ${path.relative(ROOT, SERVER_REGISTRY)}.`);
  process.exit(1);
}

const targets = REGISTRY.filter((l) => l.tag !== BASE)
  .filter((l) => !ONLY.length || ONLY.includes(l.tag));

// ── providers ────────────────────────────────────────────────────────────────
// translate(items, locale) → array of strings, same length and order as items.
// An entry may come back null, meaning "I could not translate this one"; the
// caller then leaves the key absent rather than writing something wrong.
const PROVIDERS = {
  report: {
    fills: false,
    describe: () => 'report only — nothing will be written',
    translate: async (items) => items.map(() => null),
  },

  passthrough: {
    fills: true,
    marksPending: true,
    describe: () => 'passthrough — the base value, recorded as pending translation',
    translate: async (items) => items.map((i) => i.source),
  },

  anthropic: {
    fills: true,
    describe: () => (process.env.ANTHROPIC_API_KEY
      ? `@anthropic-ai/sdk, model ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514'}`
      : 'unavailable — ANTHROPIC_API_KEY is not set'),
    available: () => !!process.env.ANTHROPIC_API_KEY,
    translate: async (items, locale) => {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });
      const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
      const out = [];
      // Batched, because one string per request would be slow and would lose
      // the shared context that makes a set of column headings agree with
      // each other.
      for (let i = 0; i < items.length; i += 40) {
        const batch = items.slice(i, i + 40);
        const prompt = [
          `Translate the following interface strings for a football club management platform into ${locale.label} (${locale.tag}).`,
          '',
          'Rules:',
          '- Return a JSON array of strings, same length and same order as the input. Nothing else.',
          '- Keep every %d placeholder exactly as it appears, in a position that is natural for the language.',
          '- Never translate proper names: club names, player names, coach names, stadium names, competition names, or the product name Familista.',
          '- Keep the register of a sports interface: short, plain, no marketing tone.',
          '- Preserve capitalisation style: an ALL CAPS source is a label and stays ALL CAPS.',
          '- If a string cannot be translated safely, return null in its place.',
          '',
          JSON.stringify(batch.map((b) => b.source.split(SLOT).join('%d')), null, 1),
        ].join('\n');
        const res = await client.messages.create({
          model, max_tokens: 4000, messages: [{ role: 'user', content: prompt }],
        });
        const text = (res.content || []).map((c) => c.text || '').join('');
        const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
        let arr;
        try { arr = JSON.parse(json); } catch (_) { arr = []; }
        for (let n = 0; n < batch.length; n++) {
          const v = arr[n];
          out.push(typeof v === 'string' && v.trim() ? v.split('%d').join(SLOT) : null);
        }
        process.stdout.write('.');
      }
      return out;
    },
  },
};

const provider = PROVIDERS[PROVIDER];
if (!provider) {
  console.error(`Unknown provider "${PROVIDER}". Available: ${Object.keys(PROVIDERS).join(', ')}.`);
  process.exit(1);
}
if (WRITE && provider.available && !provider.available()) {
  console.error(`Provider "${PROVIDER}" is not usable here: ${provider.describe()}.`);
  console.error('Nothing was written. Set the key, or use --provider=passthrough and translate later.');
  process.exit(1);
}

// ── what is missing ──────────────────────────────────────────────────────────
const flatten = (obj, prefix, out) => {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
};
const setPath = (obj, key, value) => {
  const parts = key.split('.');
  let node = obj;
  for (const p of parts.slice(0, -1)) {
    if (!node[p] || typeof node[p] !== 'object') node[p] = {};
    node = node[p];
  }
  node[parts.at(-1)] = value;
};

const baseBundle = readJson(path.join(BUNDLES, `${BASE}.json`));
const baseBundleFlat = flatten(baseBundle, '', {});
const baseCatalogue = readJson(path.join(CATALOGUE, `${BASE}.json`));
const baseCatalogueKeys = Object.keys(baseCatalogue);

const singleForm = (tag) => {
  try { return new Intl.PluralRules(tag).resolvedOptions().pluralCategories.length === 1; } catch (_) { return false; }
};

const work = [];
for (const locale of targets) {
  const bundleFile = path.join(BUNDLES, `${locale.tag}.json`);
  const catFile = path.join(CATALOGUE, `${locale.tag}.json`);
  const item = { locale, bundleFile, catFile, bundle: [], catalogue: [] };

  if (DO_BUNDLES && fs.existsSync(bundleFile)) {
    const have = flatten(readJson(bundleFile), '', {});
    item.bundle = Object.keys(baseBundleFlat)
      .filter((k) => typeof have[k] !== 'string' || have[k] === '')
      .map((k) => ({ key: k, source: baseBundleFlat[k] }));
  }
  // An English variant is translated by not being translated: the markup is
  // already English, and only the handful of usage differences — "soccer",
  // "field" — get entries, which a person writes deliberately. Asking a
  // provider to translate English into English would only add noise.
  const englishVariant = /^en(-|$)/.test(locale.tag);
  if (DO_CATALOGUE && !englishVariant && fs.existsSync(catFile)) {
    const have = readJson(catFile);
    const one = singleForm(locale.tag);
    item.catalogue = baseCatalogueKeys
      .filter((k) => {
        if (one && k.endsWith('|plural')) return have[k.slice(0, -'|plural'.length)] == null;
        return have[k] == null && have[k + '|plural'] == null;
      })
      // A language with one plural form is answered by the plain shape, so
      // asking a provider for a plural it does not have would waste the call.
      .filter((k) => !(one && k.endsWith('|plural')))
      .map((k) => ({ key: k, source: baseCatalogue[k] }));
  }
  if (item.bundle.length || item.catalogue.length) work.push(item);
}

const totalBundle = work.reduce((n, w) => n + w.bundle.length, 0);
const totalCat = work.reduce((n, w) => n + w.catalogue.length, 0);

console.log('Familista i18n sync\n');
console.log(`  registry   ${REGISTRY.length} locales, base ${BASE}${ONLY.length ? `, narrowed to ${ONLY.join(', ')}` : ''}`);
console.log(`  provider   ${PROVIDER} — ${provider.describe()}`);
console.log(`  missing    ${totalBundle} bundle key(s), ${totalCat} catalogue entr(ies), across ${work.length} locale(s)\n`);

for (const w of work) {
  const bits = [];
  if (w.bundle.length) bits.push(`${w.bundle.length} bundle`);
  if (w.catalogue.length) bits.push(`${w.catalogue.length} catalogue`);
  console.log(`  ${w.locale.tag.padEnd(8)} ${bits.join(', ')}`);
  if (!WRITE) {
    for (const b of w.bundle.slice(0, 6)) console.log(`      ${b.key} = ${JSON.stringify(b.source)}`);
    if (w.bundle.length > 6) console.log(`      … and ${w.bundle.length - 6} more`);
    for (const c of w.catalogue.slice(0, 6)) console.log(`      ${JSON.stringify(c.source.split(SLOT).join('%d'))}`);
    if (w.catalogue.length > 6) console.log(`      … and ${w.catalogue.length - 6} more`);
  }
}

if (!work.length) {
  console.log('  Every locale is already synchronized with the base.');
  process.exit(0);
}

if (!WRITE) {
  console.log('\n  Nothing was written — this was a report.');
  console.log('  To fill these: node scripts/i18n-sync.js --write --provider=<name>');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\n  For real translations rather than placeholders this needs a translation');
    console.log('  provider. The repository already depends on @anthropic-ai/sdk and already');
    console.log('  reads ANTHROPIC_API_KEY (src/config/index.ts), so setting that key in the');
    console.log('  environment is the whole requirement — no new dependency, no new account.');
    console.log('  Without it, --provider=passthrough fills the gaps with English and records');
    console.log('  every one as pending so nothing is silently passed off as translated.');
  }
  process.exit(0);
}

// ── writing ──────────────────────────────────────────────────────────────────
(async () => {
  const pending = fs.existsSync(PENDING) ? readJson(PENDING) : { note: '', locales: {} };
  pending.note = 'Keys filled with the base value rather than translated. Each one renders as English in a locale that is not English. Replace with a real translation and remove the entry; scripts/i18n-check.js reports the count on every run.';
  pending.locales = pending.locales || {};

  let wroteBundle = 0;
  let wroteCat = 0;

  for (const w of work) {
    const tag = w.locale.tag;

    if (w.bundle.length) {
      const doc = readJson(w.bundleFile);
      const values = await provider.translate(w.bundle, w.locale);
      const filled = [];
      w.bundle.forEach((item, i) => {
        const v = values[i];
        if (typeof v !== 'string' || !v) return;
        // Belt and braces: re-read the current value and refuse to touch a key
        // that already has one. Rule 1 is not left to the caller's arithmetic.
        const have = flatten(doc, '', {})[item.key];
        if (typeof have === 'string' && have !== '') return;
        setPath(doc, item.key, v);
        filled.push(item.key);
      });
      if (filled.length) {
        fs.writeFileSync(w.bundleFile, JSON.stringify(doc, null, 2) + '\n');
        wroteBundle += filled.length;
        if (provider.marksPending) {
          const seen = new Set([...(pending.locales[tag] || []), ...filled]);
          pending.locales[tag] = [...seen].sort();
        }
      }
    }

    if (w.catalogue.length) {
      const doc = readJson(w.catFile);
      const values = await provider.translate(w.catalogue, w.locale);
      let filled = 0;
      w.catalogue.forEach((item, i) => {
        const v = values[i];
        if (typeof v !== 'string' || !v) return;
        if (doc[item.key] != null) return;
        doc[item.key] = v;
        filled++;
      });
      if (filled) {
        fs.writeFileSync(w.catFile, JSON.stringify(doc, null, 2) + '\n');
        wroteCat += filled;
      }
      if (provider.marksPending && filled) {
        // The catalogue is keyed by English, so a passthrough value there is
        // indistinguishable from a translation that happens to match. Count it
        // separately so the pending figure stays truthful.
        const seen = new Set([...(pending.locales[tag] || []), `catalogue:${filled} entr(ies) filled with English`]);
        pending.locales[tag] = [...seen].sort();
      }
    }
    process.stdout.write(`\r  writing ${tag}…            `);
  }

  if (provider.marksPending) fs.writeFileSync(PENDING, JSON.stringify(pending, null, 2) + '\n');

  console.log(`\n\n  wrote ${wroteBundle} bundle key(s) and ${wroteCat} catalogue entr(ies).`);
  console.log('  No existing value was changed.');
  if (provider.marksPending) {
    console.log(`  Recorded as pending translation in ${path.relative(ROOT, PENDING)}.`);
  }
  console.log('\n  Now run: npm run i18n:check');
})().catch((e) => {
  console.error('\nSync failed:', e.message);
  console.error('Nothing further was written. Locale files already written are valid and unchanged in their existing values.');
  process.exit(1);
});
