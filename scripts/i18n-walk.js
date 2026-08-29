#!/usr/bin/env node
// Familista — walking the real interface and reading what it says
// ─────────────────────────────────────────────────────────────────────────────
// The source extractor answers "what strings exist". This answers the question
// that actually matters: "what does a person see, module by module, and is any
// of it still English".
//
// It signs in as a real user, opens a real club, visits every module, opens the
// tabs and panels inside them, and asks the translation layer itself — through
// I18N_DOM.scan() — what is on screen. Same rules as the runtime, so the audit
// cannot drift from what actually gets translated.
//
//   node scripts/i18n-walk.js                 → English inventory, per module
//   node scripts/i18n-walk.js --locale=ar     → what is STILL English in Arabic
//   node scripts/i18n-walk.js --json=out.json → machine-readable
//   node scripts/i18n-walk.js --shots=DIR     → screenshot every module
//
// Requires the app running locally; that is the point — this measures the
// running product, not the source.

const fs = require('fs');
const path = require('path');
// Playwright is a developer tool, not a dependency of the product, so it is
// resolved from wherever the machine happens to have it rather than added to
// package.json for a script that never runs in production.
const { chromium } = (() => {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright',
                 '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const t of tries) { try { return require(t); } catch (_) { /* next */ } }
  console.error('playwright not found. Install it, or set PLAYWRIGHT_PATH to its directory.');
  process.exit(2);
})();

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const LOCALE = arg('locale', 'en-GB');
// English variants have no catalogue to speak of — the markup is already
// English. Counting its English as "untranslated" would be measuring the
// interface against itself.
const IS_ENGLISH = /^en(-|$)/.test(LOCALE);
const ORIGIN = arg('origin', 'http://127.0.0.1:4000');
const SHOTS = arg('shots', '');
const JSON_OUT = arg('json', '');
// Credentials of an account that can open a club. Supplied rather than created,
// so this script needs no fixtures and never writes to the database.
const EMAIL = arg('email', process.env.I18N_WALK_EMAIL || '');
const PASSWORD = arg('password', process.env.I18N_WALK_PASSWORD || '');
if (!EMAIL || !PASSWORD) {
  console.error('Usage: node scripts/i18n-walk.js --email=… --password=… [--locale=ar] [--json=out.json] [--shots=DIR]');
  process.exit(2);
}

// Every module the brief names, in the order a person would meet them.
// The shipped English key set. A string in here that did not translate is a
// gap in a catalogue; a string not in here is one nobody has catalogued yet,
// and is reported separately because much of it is data — a person's name, a
// club's name — that must never be translated at all.
let KEYS = {};
try { KEYS = require(path.join(__dirname, '..', 'public/i18n/catalogue/en-GB.json')); } catch (_) { KEYS = {}; }

const MODULES = [
  { page: 'club-home', name: 'Home' },
  { page: 'squad', name: 'Squad', tabs: ['lineup', 'formation', 'tactics'] },
  { page: 'training', name: 'Training Centre' },
  { page: 'academy', name: 'Academy' },
  { page: 'video-intelligence', name: 'Video Intelligence' },
  { page: 'transfers', name: 'Transfers' },
  { page: 'coach-market', name: 'Coach Market' },
  { page: 'coaches', name: 'Coaches' },
  { page: 'settings', name: 'Settings' },
  { page: 'clubs', name: 'Clubs' },
];

// Controls that are safe to open in order to see what is behind them. A tab, a
// sub-view, a filter, a drawer. Anything that could change data, sign the
// session out, or send something to another club is never touched — this is an
// audit, and an audit that places a bid is not an audit.
const DESTRUCTIVE = /\b(delete|remove|discard|clear|reset|sign ?out|log ?out|logout|save|submit|publish|send|confirm|withdraw|accept|reject|decline|approve|sell|buy|bid|offer|sign|release|terminate|cancel|pay|purchase|upgrade|invite|archive|unlist|list now|create|add|new|start|end|finish|complete|promote|demote|transfer)\b/i;

const until = async (p, f, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await p.evaluate(f).catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await p.waitForTimeout(100);
  }
};

(async () => {
  const br = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const p = await br.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

  await p.goto(ORIGIN + '/index.html', { waitUntil: 'domcontentloaded' });
  await until(p, () => { const e = document.getElementById('login-email'); return !!(e && e.offsetParent !== null); });
  await p.fill('#login-email', EMAIL);
  await p.fill('#login-password', PASSWORD);
  await p.click('#login-btn');
  await until(p, () => { const e = document.getElementById('login-email'); return !(e && e.offsetParent !== null); }, 40000);
  await p.waitForTimeout(1500);

  await p.evaluate(() => { try { navTo('clubs'); } catch (_) {} });
  const cid = await until(p, () => {
    const n = document.querySelector('[data-action="openClub"][data-club-id]');
    return n ? n.getAttribute('data-club-id') : null;
  });
  await p.evaluate((c) => openClub(c), cid);
  await until(p, () => !!document.querySelector('#workspace-nav-items .nav-item[data-page="squad"]'), 40000);
  await p.waitForTimeout(2000);

  if (LOCALE !== 'en-GB') {
    await p.evaluate(async (tag) => { await window.I18N_APPLY.change(tag); }, LOCALE);
    await p.waitForTimeout(2500);
  }

  const report = { locale: LOCALE, modules: {}, all: [] };
  const seen = new Set();
  const englishAnywhere = new Set();
  const unknownAnywhere = new Set();

  for (const m of MODULES) {
    await p.evaluate((pg) => { try { navTo(pg); } catch (_) {} }, m.page);
    await p.waitForTimeout(1800);
    const views = [null, ...(m.tabs || [])];
    const strings = [];
    const collect = async () => {
      const got = await p.evaluate(() => (window.I18N_DOM ? window.I18N_DOM.scan() : []));
      for (const g of got) strings.push(g);
    };
    for (const tab of views) {
      if (tab) {
        await p.evaluate((t) => { try { squadNav(t); } catch (_) {} }, tab);
        await p.waitForTimeout(1400);
      }
      await collect();

      // …then open what is behind the tabs and sub-views on this screen. The
      // landing view of a module is a fraction of its text; the brief is
      // explicit that drawers, panels and empty states count too.
      const controls = await p.evaluate((deny) => {
        const re = new RegExp(deny.source, deny.flags);
        const out = [];
        const seen = new Set();
        const sel = [
          '[role="tab"]', '.tab', '[data-tab]', '[data-sub]', '[data-view]',
          '[data-squad-page]', '[data-ac-open]', '[data-tf-tab]', '[data-st-view]',
          '[data-co-view]', '[data-set-cat]', '[data-vi-tab]', '[data-trn-open]',
          '.sqf-card', '.co-cc', '.ac-tcard', '.set-rail-b', '.tf-tabs button',
        ].join(',');
        document.querySelectorAll('.page.active ' + sel.split(',').join(', .page.active ')).forEach((el) => {
          if (out.length >= 30) return;
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) return;
          const label = (el.textContent || '').trim().slice(0, 60);
          if (re.test(label)) return;
          const path = el.id ? '#' + el.id : null;
          const key = label + '|' + (el.className || '');
          if (seen.has(key)) return;
          seen.add(key);
          el.setAttribute('data-i18n-walk', String(out.length));
          out.push({ idx: out.length, label: label });
        });
        return out;
      }, DESTRUCTIVE);

      for (const c of controls) {
        const before = await p.evaluate(() => { const a = document.querySelector('.page.active'); return a ? a.id : ''; });
        await p.evaluate((i) => {
          const el = document.querySelector('[data-i18n-walk="' + i + '"]');
          if (el) el.click();
        }, c.idx).catch(() => {});
        await p.waitForTimeout(650);
        await collect();
        const after = await p.evaluate(() => { const a = document.querySelector('.page.active'); return a ? a.id : ''; });
        if (after !== before) {
          // A control that navigated elsewhere; come back and carry on here.
          await p.evaluate((pg) => { try { navTo(pg); } catch (_) {} }, m.page);
          await p.waitForTimeout(1200);
        }
      }
    }
    // In a non-English run, anything the layer still reports as translatable
    // English is by definition an untranslated string on that screen.
    const uniq = [];
    const stillEnglish = [];
    const local = new Map();
    for (const s of strings) {
      // One string can be seen twice, translated in one place and not in
      // another; if it was ever translated it is not an untranslated string.
      if (local.has(s.text)) { if (s.translated) local.set(s.text, true); continue; }
      local.set(s.text, !!s.translated);
      uniq.push(s.text);
      if (!seen.has(s.text)) { seen.add(s.text); report.all.push(s.text); }
    }
    const uncatalogued = [];
    for (const [text, done] of local) {
      if (done) continue;
      if (IS_ENGLISH) continue;
      if (KEYS[text] != null) stillEnglish.push(text); else uncatalogued.push(text);
    }
    report.modules[m.name] = { seen: uniq.length, english: stillEnglish, uncatalogued: uncatalogued };
    for (const e of stillEnglish) englishAnywhere.add(e);
    for (const e of uncatalogued) unknownAnywhere.add(e);
    const mark = IS_ENGLISH ? '' : (stillEnglish.length ? '  ← gap' : '  ✓');
    console.log(`  ${m.name.padEnd(20)} ${String(uniq.length).padStart(5)} seen` +
      (IS_ENGLISH ? '' : `  ${String(stillEnglish.length).padStart(4)} untranslated` +
        `  ${String(uncatalogued.length).padStart(4)} uncatalogued${mark}`));
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await p.screenshot({ path: path.join(SHOTS, `${LOCALE}-${m.page}.png`) });
    }
  }

  // In a translated run, what is left English is what still needs a catalogue
  // entry. Measured against the strings the layer could not answer for.
  if (!IS_ENGLISH) {
    report.english = [...englishAnywhere].sort();
    report.uncatalogued = [...unknownAnywhere].sort();
    report.stats = await p.evaluate(() => (window.I18N_DOM ? window.I18N_DOM.stats() : null));
    report.dir = await p.evaluate(() => document.documentElement.getAttribute('dir'));
  }

  console.log(`  ${'DISTINCT'.padEnd(20)} ${String(report.all.length).padStart(5)} seen`);
  if (report.english) {
    console.log(`  ${'STILL ENGLISH'.padEnd(20)} ${String(report.english.length).padStart(5)}  (catalogued but untranslated)`);
    console.log(`  ${'UNCATALOGUED'.padEnd(20)} ${String(report.uncatalogued.length).padStart(5)}  (names, data, and strings not yet added)`);
    console.log(`  ${'DIRECTION'.padEnd(20)} ${String(report.dir).padStart(5)}`);
  }
  if (errs.length) console.log('\n  page errors:', JSON.stringify(errs.slice(0, 3)));

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
    console.log(`\n  → ${JSON_OUT}`);
  }

  await br.close();
  process.exit(report.english && report.english.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
