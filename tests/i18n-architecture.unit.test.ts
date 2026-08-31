// Familista — the localization gate, tested against itself.
//
// scripts/i18n-check.js is what stops a feature shipping half-translated, and
// scripts/i18n-sync.js is what fills the gap it finds. A gate nobody has watched
// fail is not a gate, so most of what follows builds a small repository in a
// temporary directory, breaks it on purpose, and checks that the tooling
// noticed. The last group runs the same check against the real repository.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.join(__dirname, '..');
const CHECK = path.join(ROOT, 'scripts/i18n-check.js');
// The catalogue's digit sentinel, spelled the way every other file spells it.
const SLOT = '\u0000';
const SYNC = path.join(ROOT, 'scripts/i18n-sync.js');

const run = (script: string, args: string[], root?: string) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: root ? { ...process.env, FAMILISTA_I18N_ROOT: root } : process.env,
  });

// ── a minimal repository, in the shape the real one has ──────────────────────
type Fixture = { root: string; write: (rel: string, body: unknown) => void };

const LOCALES = [
  { tag: 'en-GB', label: 'English (UK)', dir: 'ltr' },
  { tag: 'de-DE', label: 'Deutsch', dir: 'ltr' },
  { tag: 'ja-JP', label: '日本語', dir: 'ltr' },
];

const makeFixture = (): Fixture => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'familista-i18n-'));
  for (const d of ['src/i18n', 'public/i18n/locales', 'public/i18n/catalogue', 'scripts']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  const entries = LOCALES.map((l) => `  { tag: '${l.tag}', label: '${l.label}', dir: '${l.dir}' },`).join('\n');
  fs.writeFileSync(path.join(root, 'src/i18n/locales.ts'),
    `export const LOCALES = [\n${entries}\n];\nexport const DEFAULT_LOCALE = 'en-GB';\n`);
  fs.writeFileSync(path.join(root, 'public/i18n/config.js'),
    `var LOCALES = [\n${entries}\n];\nvar CFG = { DEFAULT_LOCALE: 'en-GB' };\n`);

  const write = (rel: string, body: unknown) =>
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');

  write('public/i18n/locales/en-GB.json', { navigation: { squad: 'Squad' }, league: { pts: 'PTS' } });
  write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' }, league: { pts: 'PKT' } });
  write('public/i18n/locales/ja-JP.json', { navigation: { squad: 'スカッド' }, league: { pts: '勝点' } });
  // The catalogue is keyed by the English the screen says, with a digit run
  // replaced by the slot sentinel — the same shape the real files have.
  const players = `${SLOT} players`;
  write('public/i18n/catalogue/en-GB.json', { Standings: 'Standings', [players]: players });
  write('public/i18n/catalogue/de-DE.json', { Standings: 'Tabelle', [players]: `${SLOT} Spieler` });
  write('public/i18n/catalogue/ja-JP.json', { Standings: '順位表', [players]: `${SLOT}人の選手` });
  write('scripts/i18n-baseline.json', { backlog: 0, inventory: 0, recordedAt: '2026-01-01', note: 'fixture' });
  return { root, write };
};

let fx: Fixture;
beforeEach(() => { fx = makeFixture(); });
afterEach(() => { fs.rmSync(fx.root, { recursive: true, force: true }); });

describe('the gate detects what it exists to detect', () => {
  it('passes a repository that is actually synchronized', () => {
    const r = run(CHECK, ['--fast'], fx.root);
    expect(`${r.status}\n${r.stdout}${r.stderr}`).toMatch(/^0\n/);
  });

  it('fails on a bundle key a locale is missing', () => {
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' } });
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('[bundles] de-DE: 1 missing key(s) — league.pts');
  });

  it('fails on a key a locale has that the base does not', () => {
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' }, league: { pts: 'PKT', gd: 'TD' } });
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('league.gd');
  });

  it('fails on a catalogue entry a locale is missing', () => {
    fx.write('public/i18n/catalogue/de-DE.json', { Standings: 'Tabelle' });
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[catalogue\] de-DE: 1 entr\(ies\) missing/);
  });

  it('fails on a malformed locale file', () => {
    fx.write('public/i18n/locales/de-DE.json', '{ "navigation": { "squad": "Kader" ');
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[files\] de-DE:.*is not valid JSON/);
  });

  it('fails on a locale file that is not there at all', () => {
    fs.rmSync(path.join(fx.root, 'public/i18n/catalogue/ja-JP.json'));
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[files\] ja-JP:.*does not exist/);
  });

  it('fails when the client registry has drifted from the server one', () => {
    const cfg = path.join(fx.root, 'public/i18n/config.js');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace("label: 'Deutsch'", "label: 'German'"));
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[registry\] entry 2 differs/);
  });

  it('fails when the two halves disagree about the base locale', () => {
    const cfg = path.join(fx.root, 'public/i18n/config.js');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace("DEFAULT_LOCALE: 'en-GB'", "DEFAULT_LOCALE: 'de-DE'"));
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[registry\] base locale differs/);
  });

  it('fails when the source asks for a key the base bundle does not define', () => {
    fs.writeFileSync(path.join(fx.root, 'public/app.js'), "el.innerHTML = '<b data-i18n=\"league.form\"></b>' + t('navigation.squad');\n");
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('asks for "league.form"');
  });

  it('reads a key declared in a table, not only one passed to t()', () => {
    // The League's column table and the navigation list both name their keys
    // as properties and assemble the markup later. A typo there is a real
    // defect, and it is invisible until somebody switches language.
    fs.writeFileSync(path.join(fx.root, 'public/app.js'),
      "var COLS = [{ abbr: 'PTS', key: 'league.ptz', fullKey: 'league.pts' }];\n");
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('asks for "league.ptz"');
  });

  it('does not read an internal dotted token as a translation key', () => {
    // 'auth.event' is a kind tag in the network log, not a key. A heuristic
    // loose enough to claim it would make the gate cry wolf and get ignored.
    fs.writeFileSync(path.join(fx.root, 'public/app.js'),
      "if (p.indexOf('/api/auth') >= 0) return { kind: 'navigation.event', color: '#FCA5A5' };\n");
    expect(run(CHECK, ['--fast'], fx.root).status).toBe(0);
  });

  it('does not object to a key the source builds at runtime', () => {
    fs.writeFileSync(path.join(fx.root, 'public/app.js'), "el.setAttribute('data-i18n', 'league.' + col);\n");
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(0);
  });

  it('picks up a locale added to the registry, without being told how many there are', () => {
    for (const f of ['src/i18n/locales.ts', 'public/i18n/config.js']) {
      const p = path.join(fx.root, f);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
        .replace("{ tag: 'de-DE'", "{ tag: 'fi-FI', label: 'Suomi', dir: 'ltr' },\n  { tag: 'de-DE'"));
    }
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[files\] fi-FI:.*does not exist/);
    // …and no number of languages is written down anywhere in the tooling.
    for (const s of [CHECK, SYNC]) {
      expect(fs.readFileSync(s, 'utf8')).not.toMatch(/\b31 (languages|locales)\b/);
    }
  });

  it('ratchets the backlog: growth fails, and the pre-existing figure does not', () => {
    // The real inventory scan needs the real source, so the ratchet is exercised
    // against the repository rather than the fixture. Recorded ≥ actual passes;
    // a baseline one lower than reality is the same shape as new untranslated
    // text arriving, and must fail.
    const baseline = path.join(ROOT, 'scripts/i18n-baseline.json');
    const saved = fs.readFileSync(baseline, 'utf8');
    try {
      const recorded = JSON.parse(saved);
      expect(run(CHECK, ['--quiet'], undefined).status).toBe(0);
      fs.writeFileSync(baseline, JSON.stringify({ ...recorded, backlog: recorded.backlog - 1 }, null, 2) + '\n');
      const r = run(CHECK, ['--quiet'], undefined);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/uncatalogued strings, up from the recorded/);
    } finally {
      fs.writeFileSync(baseline, saved);
    }
  }, 60000);
});

describe('sync fills gaps and never overwrites', () => {
  it('writes nothing at all unless asked to', () => {
    const p = path.join(fx.root, 'public/i18n/locales/de-DE.json');
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' } });
    const before = fs.readFileSync(p, 'utf8');
    const r = run(SYNC, [], fx.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Nothing was written');
    expect(r.stdout).toContain('1 bundle key(s)');
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  it('fills only the missing key, and leaves every existing translation alone', () => {
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' } });
    fx.write('public/i18n/catalogue/de-DE.json', { Standings: 'Tabelle' });
    const r = run(SYNC, ['--write', '--provider=passthrough'], fx.root);
    expect(r.status).toBe(0);

    const bundle = JSON.parse(fs.readFileSync(path.join(fx.root, 'public/i18n/locales/de-DE.json'), 'utf8'));
    expect(bundle.navigation.squad).toBe('Kader');   // the human translation survives
    expect(bundle.league.pts).toBe('PTS');           // the gap is filled with the base value
    const cat = JSON.parse(fs.readFileSync(path.join(fx.root, 'public/i18n/catalogue/de-DE.json'), 'utf8'));
    expect(cat.Standings).toBe('Tabelle');
    expect(Object.keys(cat).length).toBe(2);

    // Untouched locales stay byte-identical.
    expect(JSON.parse(fs.readFileSync(path.join(fx.root, 'public/i18n/locales/ja-JP.json'), 'utf8')).league.pts).toBe('勝点');

    // And the check is satisfied afterwards.
    expect(run(CHECK, ['--fast'], fx.root).status).toBe(0);
  });

  it('records a placeholder as pending rather than passing it off as translated', () => {
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' } });
    run(SYNC, ['--write', '--provider=passthrough'], fx.root);
    const pending = JSON.parse(fs.readFileSync(path.join(fx.root, 'public/i18n/_pending-translation.json'), 'utf8'));
    expect(pending.locales['de-DE']).toContain('league.pts');
    // The check then says so on every run, so the gap cannot be forgotten.
    const r = run(CHECK, ['--fast'], fx.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/placeholder\(s\).*English standing in for a translation/);
  });

  it('running twice changes nothing the second time', () => {
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' } });
    run(SYNC, ['--write', '--provider=passthrough'], fx.root);
    const p = path.join(fx.root, 'public/i18n/locales/de-DE.json');
    const once = fs.readFileSync(p, 'utf8');
    run(SYNC, ['--write', '--provider=passthrough'], fx.root);
    expect(fs.readFileSync(p, 'utf8')).toBe(once);
  });

  it('narrows to the locales it is given', () => {
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' } });
    fx.write('public/i18n/locales/ja-JP.json', { navigation: { squad: 'スカッド' } });
    run(SYNC, ['--write', '--provider=passthrough', '--locales=de-DE'], fx.root);
    expect(JSON.parse(fs.readFileSync(path.join(fx.root, 'public/i18n/locales/de-DE.json'), 'utf8')).league).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(fx.root, 'public/i18n/locales/ja-JP.json'), 'utf8')).league).toBeUndefined();
  });

  it('refuses a provider it cannot actually run, instead of writing something wrong', () => {
    fx.write('public/i18n/locales/de-DE.json', { navigation: { squad: 'Kader' } });
    const r = spawnSync(process.execPath, [SYNC, '--write', '--provider=anthropic'], {
      encoding: 'utf8',
      env: { ...process.env, FAMILISTA_I18N_ROOT: fx.root, ANTHROPIC_API_KEY: '' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ANTHROPIC_API_KEY is not set');
    expect(JSON.parse(fs.readFileSync(path.join(fx.root, 'public/i18n/locales/de-DE.json'), 'utf8')).league).toBeUndefined();
  });

  it('has no flag that overwrites an existing translation', () => {
    const src = fs.readFileSync(SYNC, 'utf8');
    expect(src).not.toMatch(/--force|--overwrite/);
    // Every write is guarded by an absence test, in both file kinds.
    expect(src).toMatch(/if \(typeof have === 'string' && have !== ''\) return;/);
    expect(src).toMatch(/if \(doc\[item\.key\] != null\) return;/);
  });
});

describe('the repository itself', () => {
  it('passes the gate', () => {
    const r = run(CHECK, ['--quiet'], undefined);
    expect(`${r.status}\n${r.stderr}`).toMatch(/^0\n/);
  }, 60000);

  it('carries the permanent rule where the tooling and the reader both find it', () => {
    const rules = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
    expect(rules.replace(/>\s*/g, '').replace(/\s+/g, ' ')).toContain(
      'Any feature containing user-facing text is incomplete until all text uses the '
      + 'Familista i18n system and all supported locale files are synchronized. Never wait '
      + 'for a separate localization request.',
    );
    // It names the mechanisms rather than inviting a third one.
    expect(rules).toContain('Do not add a third');
    expect(rules).toContain('src/i18n/locales.ts');
  });

  it('exposes the check and the sync as npm scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['i18n:check']).toBe('node scripts/i18n-check.js');
    expect(pkg.scripts['i18n:sync']).toBe('node scripts/i18n-sync.js');
  });

  it('adds no dependency to do any of this', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const forbidden of ['i18next', 'react-i18next', 'formatjs', '@formatjs/intl', 'polyglot', 'lingui', 'vue-i18n']) {
      expect(Object.keys(all)).not.toContain(forbidden);
    }
    // The only translation provider is the SDK the repository already had.
    expect(fs.readFileSync(SYNC, 'utf8')).toContain("require('@anthropic-ai/sdk')");
    expect(all['@anthropic-ai/sdk']).toBeTruthy();
  });

  it('leaves the runtime fallback in place, and visible in development', () => {
    const runtime = fs.readFileSync(path.join(ROOT, 'public/i18n/i18n.js'), 'utf8');
    // Never undefined, never a raw key path, never a blank control.
    expect(runtime).toContain('function humanise(key)');
    expect(runtime).toContain('missingKeys');
    // …and a real gap is still reported. The guard is `b && f`: a key is only
    // missing once there is a bundle for it to be missing from, so the first
    // paint — which runs before the fetch lands — does not report every key it
    // touches. A warning list that is always wrong is one nobody reads.
    expect(runtime).toMatch(/isDev && b && f && !missing\[key\]/);
    // A bundle arriving later clears anything it answers, so the list stays a
    // list of gaps rather than a history of them.
    expect(runtime).toMatch(/for \(var k in bundles\[t\]\) \{ if \(missing\[k\]\) delete missing\[k\]; \}/);
  });
});
