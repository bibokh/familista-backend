// Familista's official languages — the registry, the runtime and the gate
//
// The registry (src/i18n/locales.ts, mirrored by public/i18n/config.js) marks
// the languages Familista promises in full with `official: n`. Everything else
// follows from that one mark: the top bar's switch, every owner room's
// language list, the transactional email, and two rules of the localization
// gate. These tests pin each link, and each rule is watched failing on a
// repository broken on purpose before it is trusted on the real one.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { OFFICIAL_LOCALES, isOfficialLocale, LOCALES } from '../src/i18n/locales';
import { platformI18n, officialRoomLocales } from './helpers/platform-i18n';

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CHECK = path.join(ROOT, 'scripts/i18n-check.js');

describe('the registry names the official languages, in order, on both sides', () => {
  it('is English, German, Arabic, French and Spanish, in that order, with the base first', () => {
    expect(OFFICIAL_LOCALES.map((l) => l.tag)).toEqual(['en-GB', 'de-DE', 'ar', 'fr-FR', 'es-ES']);
    expect(OFFICIAL_LOCALES.map((l) => l.official)).toEqual([1, 2, 3, 4, 5]);
    expect(OFFICIAL_LOCALES.map((l) => l.dir)).toEqual(['ltr', 'ltr', 'rtl', 'ltr', 'ltr']);
  });

  it('marks nothing else official — a regional variant is not', () => {
    expect(LOCALES.filter((l) => !l.official).length).toBeGreaterThan(0);
    for (const t of ['en-US', 'es-MX', 'pt-BR', 'it-IT']) expect(isOfficialLocale(t)).toBe(false);
    for (const t of ['en-GB', 'DE-de', 'ar', 'fr-FR', 'es-ES']) expect(isOfficialLocale(t)).toBe(true);
    expect(isOfficialLocale(undefined)).toBe(false);
  });

  it('is mirrored entry for entry in the client registry', () => {
    const client = [...read('public/i18n/config.js').matchAll(/\{ tag: '([^']+)',\s*label: '([^']+)',\s*dir: '(ltr|rtl)'(?:, official: (\d+))? \}/g)]
      .map((m) => ({ tag: m[1], label: m[2], dir: m[3], official: m[4] ? Number(m[4]) : undefined }));
    expect(client).toEqual(LOCALES.map((l) => ({ tag: l.tag, label: l.label, dir: l.dir, official: l.official })));
  });
});

describe('the runtime gives every room the same list, and one way to change language', () => {
  it('lists the official languages as a room reads them: code, own name, direction, tag', () => {
    expect(officialRoomLocales()).toEqual([
      ['en', 'English (UK)', 'ltr', 'en-GB'],
      ['de', 'Deutsch', 'ltr', 'de-DE'],
      ['ar', 'العربية', 'rtl', 'ar'],
      ['fr', 'Français', 'ltr', 'fr-FR'],
      ['es', 'Español (ES)', 'ltr', 'es-ES'],
    ]);
  });

  it.each([
    ['en-GB', 'en'], ['de-DE', 'de'], ['ar', 'ar'], ['fr-FR', 'fr'], ['es-ES', 'es'],
    // A platform language that is not official keeps its rooms in the official
    // language of the same family, or in English — never in a missing file.
    ['es-MX', 'es'], ['en-US', 'en'], ['it-IT', 'en'], ['ja-JP', 'en'],
  ])('a platform in %s opens its rooms in %s', async (tag, code) => {
    const p = await platformI18n();
    await p.I18N.setLocale(tag);
    expect(p.I18N.roomLocale()).toBe(code);
  });

  it('a room’s own button moves the platform language, once, through I18N_APPLY.change', async () => {
    const p = await platformI18n('en');
    await p.I18N.roomChoose('fr');
    expect(p.chosen).toEqual(['fr-FR']);
    expect(p.I18N.locale()).toBe('fr-FR');
    // The language already in force is not asked for again.
    await p.I18N.roomChoose('fr');
    expect(p.chosen).toEqual(['fr-FR']);
    await p.I18N.roomChoose('ar');
    expect(p.chosen).toEqual(['fr-FR', 'ar']);
    expect(p.I18N.dir()).toBe('rtl');
  });

  it('(control) a code that is not official changes nothing', async () => {
    const p = await platformI18n('de');
    for (const code of ['it', 'pt', 'xx', '', 'en-GB']) expect(await p.I18N.roomChoose(code)).toBeNull();
    expect(p.chosen).toEqual([]);
    expect(p.I18N.locale()).toBe('de-DE');
  });

  it('(control) without the shell’s apply path a room’s button changes nothing, and does not throw', async () => {
    const p = await platformI18n('en', { apply: false });
    await expect(p.I18N.roomChoose('fr')).resolves.toBeNull();
    expect(p.I18N.locale()).toBe('en-GB');
  });

  it('no room keeps a language of its own, and every room reads the one list', () => {
    const rooms = fs.readdirSync(path.join(ROOT, 'public'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'public', d.name, 'i18n', 'en.json'))).map((d) => d.name);
    expect(rooms.length).toBe(12);
    for (const room of rooms) {
      const files = fs.readdirSync(path.join(ROOT, 'public', room)).filter((f) => f.endsWith('.js'));
      const src = files.map((f) => read(`public/${room}/${f}`)).join('\n');
      expect(`${room}: ${/_LOCALES = window\.I18N && typeof window\.I18N\.roomLocales === 'function'|var LOCALES = window\.I18N && typeof window\.I18N\.roomLocales === 'function'/.test(src)}`).toBe(`${room}: true`);
      expect(`${room}: ${/localStorage\.setItem\([^)]*locale/i.test(src)}`).toBe(`${room}: false`);
      expect(`${room}: ${/\[\['en', 'English'/.test(src)}`).toBe(`${room}: false`);
      expect(fs.readdirSync(path.join(ROOT, 'public', room, 'i18n')).sort())
        .toEqual(officialRoomLocales().map((l) => `${l[0]}.json`).sort());
    }
  });
});

// ── rules 7 and 8 of the gate, watched failing ───────────────────────────────
const SLOT = '\u0000';
const run = (root: string) => spawnSync(process.execPath, [CHECK, '--fast'], {
  encoding: 'utf8', env: { ...process.env, FAMILISTA_I18N_ROOT: root },
});

type Fx = { root: string; write: (rel: string, body: unknown) => void };
function fixture(official = { 'en-GB': 1, 'de-DE': 2 } as Record<string, number>): Fx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'familista-official-'));
  for (const d of ['src/i18n', 'public/i18n/locales', 'public/i18n/catalogue', 'public/room-x/i18n', 'scripts']) {
    fs.mkdirSync(path.join(root, d), { recursive: true });
  }
  const defs = [['en-GB', 'English (UK)', 'ltr'], ['de-DE', 'Deutsch', 'ltr'], ['ja-JP', '日本語', 'ltr']];
  const entries = defs.map(([tag, label, dir]) => `  { tag: '${tag}', label: '${label}', dir: '${dir}'${official[tag] ? `, official: ${official[tag]}` : ''} },`).join('\n');
  fs.writeFileSync(path.join(root, 'src/i18n/locales.ts'), `export const LOCALES = [\n${entries}\n];\nexport const DEFAULT_LOCALE = 'en-GB';\n`);
  fs.writeFileSync(path.join(root, 'public/i18n/config.js'), `var LOCALES = [\n${entries}\n];\nvar CFG = { DEFAULT_LOCALE: 'en-GB' };\n`);
  const write = (rel: string, body: unknown) =>
    fs.writeFileSync(path.join(root, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  for (const [t, v] of [['en-GB', 'Squad'], ['de-DE', 'Kader'], ['ja-JP', 'スカッド']]) write(`public/i18n/locales/${t}.json`, { navigation: { squad: v } });
  const players = `${SLOT} players`;
  write('public/i18n/catalogue/en-GB.json', { Standings: 'Standings', [players]: players, 'Match Center': 'Match Center' });
  write('public/i18n/catalogue/de-DE.json', { Standings: 'Tabelle', [players]: `${SLOT} Spieler`, 'Match Center': 'Match Center' });
  write('public/i18n/catalogue/ja-JP.json', { Standings: '順位表', [players]: `${SLOT}人の選手`, 'Match Center': 'Match Center' });
  write('public/room-x/i18n/en.json', { 'Open the room': 'Open the room', '%d agents': '%d agents', '%d of %d': '%d of %d', Commit: 'Commit' });
  write('public/room-x/i18n/de.json', { 'Open the room': 'Raum öffnen', '%d agents': '%d Agenten', '%d of %d': '%d von %d', Commit: 'Commit' });
  write('scripts/i18n-baseline.json', { backlog: 0, inventory: 0, recordedAt: '2026-01-01', note: 'fixture' });
  write('scripts/i18n-same-as-english.json', { note: 'fixture', rooms: { 'room-x/de': ['Commit'] }, catalogue: { 'de-DE': ['Match Center'] } });
  return { root, write };
}

describe('rule 7 · every owner room ships every official language, key for key', () => {
  let fx: Fx;
  beforeEach(() => { fx = fixture(); });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it('passes a room that does', () => {
    const r = run(fx.root);
    expect(`${r.status}\n${r.stdout}${r.stderr}`).toMatch(/^0\n/);
    expect(r.stdout).toContain('rooms     1 owner room(s) × 2 official languages');
  });

  it('fails when an official language file is missing', () => {
    fs.rmSync(path.join(fx.root, 'public/room-x/i18n/de.json'));
    const r = run(fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('public/room-x/i18n/de.json is missing');
  });

  it('demands a new official language from every room the moment the registry names it', () => {
    const more = fixture({ 'en-GB': 1, 'de-DE': 2, 'ja-JP': 3 });
    try {
      const r = run(more.root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('public/room-x/i18n/ja.json is missing');
    } finally { fs.rmSync(more.root, { recursive: true, force: true }); }
  });

  it('fails on a missing key, an extra key and an empty value', () => {
    fx.write('public/room-x/i18n/de.json', { 'Open the room': '', '%d agents': '%d Agenten', '%d of %d': '%d von %d', Commit: 'Commit', Extra: 'Extra' });
    const r = run(fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('1 empty entr(ies) — Open the room');
    expect(r.stderr).toContain('1 entr(ies) the English catalogue does not have — Extra');
  });

  it('fails on a dropped or added placeholder, but allows a counted noun written as a word', () => {
    fx.write('public/room-x/i18n/de.json', { 'Open the room': 'Raum öffnen', '%d agents': 'ein Agent', '%d of %d': '%d von', Commit: 'Commit' });
    const r = run(fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('1 entr(ies) with different placeholders — %d of %d');
    expect(r.stderr).not.toContain('%d agents');
  });

  it('fails when English is not its own key', () => {
    fx.write('public/room-x/i18n/en.json', { 'Open the room': 'Open room', '%d agents': '%d agents', '%d of %d': '%d of %d', Commit: 'Commit' });
    const r = run(fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('English must be its own key');
  });

  it('fails when the official numbering has a gap', () => {
    const gap = fixture({ 'en-GB': 1, 'de-DE': 3 });
    try {
      const r = run(gap.root);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('the official languages must be numbered 1..2');
    } finally { fs.rmSync(gap.root, { recursive: true, force: true }); }
  });
});

describe('rule 8 · nothing in an official language reads as English unless reviewed', () => {
  let fx: Fx;
  beforeEach(() => { fx = fixture(); });
  afterEach(() => fs.rmSync(fx.root, { recursive: true, force: true }));

  it('fails on a room entry left in English that nobody reviewed', () => {
    fx.write('public/room-x/i18n/de.json', { 'Open the room': 'Open the room', '%d agents': '%d Agenten', '%d of %d': '%d von %d', Commit: 'Commit' });
    const r = run(fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('public/room-x/i18n/de.json: 1 entr(ies) still read as English — Open the room');
  });

  it('fails on a platform catalogue entry left in English in an official language, and not in another', () => {
    fx.write('public/i18n/catalogue/de-DE.json', { Standings: 'Standings', [`${SLOT} players`]: `${SLOT} Spieler`, 'Match Center': 'Match Center' });
    fx.write('public/i18n/catalogue/ja-JP.json', { Standings: 'Standings', [`${SLOT} players`]: `${SLOT}人の選手`, 'Match Center': 'Match Center' });
    const r = run(fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('de-DE is an official language and 1 entr(ies) still read as English — Standings');
    expect(r.stderr).not.toContain('ja-JP is an official language');
  });

  it('(control) a reviewed entry passes, and one that was since translated is only a note', () => {
    fx.write('public/room-x/i18n/de.json', { 'Open the room': 'Raum öffnen', '%d agents': '%d Agenten', '%d of %d': '%d von %d', Commit: 'Übertragung' });
    const r = run(fx.root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reviewed same-as-English entr(ies) are now translated or gone');
  });

  it('fails on an English placeholder recorded for an official language, and only notes one for another', () => {
    fx.write('public/i18n/_pending-translation.json', { note: 'fixture', locales: { 'de-DE': ['catalogue:1 entr(ies) filled with English'], 'ja-JP': ['catalogue:1 entr(ies) filled with English'] } });
    const r = run(fx.root);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('de-DE is an official language and still has 1 English placeholder record(s)');
    expect(r.stderr).not.toContain('ja-JP is an official language');
    expect(r.stdout).toContain('ja-JP:1');
  });
});

describe('the real repository', () => {
  it('passes rules 7 and 8 for every room and every official language', () => {
    const r = spawnSync(process.execPath, [CHECK, '--fast'], { encoding: 'utf8' });
    expect(`${r.status}\n${r.stderr}`).toBe('0\n');
    expect(r.stdout).toMatch(/rooms {5}12 owner room\(s\) × 5 official languages/);
  });

  it('records no English placeholder for any official language', () => {
    const pending = JSON.parse(read('public/i18n/_pending-translation.json')) as { locales: Record<string, string[]> };
    for (const l of OFFICIAL_LOCALES) expect(`${l.tag}: ${(pending.locales[l.tag] || []).length}`).toBe(`${l.tag}: 0`);
  });
});
