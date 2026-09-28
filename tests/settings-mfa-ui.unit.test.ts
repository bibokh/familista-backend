/**
 * Cyber Defense · Step 6 — the Settings card for two-step sign-in
 *
 * The card builds its i18n keys at runtime (`tr('x')` → `settings.mfa.x`), so
 * the i18n checker cannot see them; this suite does. It also pins where the
 * card lives, who it is for, and what it must never do with a secret.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const MODULE = read('public/settings-mfa.js');
const APP = read('public/app.js');
const INDEX = read('public/index.html');
const LOCALES = fs.readdirSync(path.join(ROOT, 'public/i18n/locales')).filter((f) => f.endsWith('.json'));

/** Code only: comments name things the code must not do. */
const CODE = MODULE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const EN_KEYS = Object.keys(JSON.parse(read('public/i18n/locales/en-GB.json')).settings.mfa).sort();
// Keys reach `tr` directly, through `codeForm(action, labelKey, helpKey, submitKey)`, and as `{ key: … }` notes.
const usedKeys = [...new Set([
  ...[...CODE.matchAll(/\btr\('([a-zA-Z0-9]+)'/g)].map((m) => m[1]),
  ...[...CODE.matchAll(/\bkey: '([a-zA-Z0-9]+)'/g)].map((m) => m[1]),
  ...[...CODE.matchAll(/codeForm\('[a-z]+', '([a-zA-Z0-9]+)', (?:null|'([a-zA-Z0-9]+)'), '([a-zA-Z0-9]+)'\)/g)].flatMap((m) => [m[1], m[2], m[3]]).filter(Boolean),
])].sort();

describe('every string the card shows is translated in every language', () => {
  it('every key the card uses exists, and every key in the bundle is used', () => {
    expect(usedKeys).toEqual(EN_KEYS);
  });

  it.each(LOCALES)('%s has every settings.mfa key, non-empty', (file) => {
    const bundle = JSON.parse(read(`public/i18n/locales/${file}`));
    const mfa = bundle.settings && bundle.settings.mfa;
    expect(mfa).toBeDefined();
    for (const k of usedKeys) {
      expect(`${k}: ${typeof mfa[k] === 'string' && mfa[k].trim().length > 0}`).toBe(`${k}: true`);
    }
  });

  it('non-English bundles are actually translated, not English copies', () => {
    const en = JSON.parse(read('public/i18n/locales/en-GB.json')).settings.mfa;
    for (const file of LOCALES.filter((f) => !f.startsWith('en-'))) {
      const mfa = JSON.parse(read(`public/i18n/locales/${file}`)).settings.mfa;
      // Sentences only: a short word can legitimately be the same (Danish "Download").
      const same = usedKeys.filter((k) => mfa[k] === en[k] && en[k].length > 12);
      expect(`${file}: ${same.join(',')}`).toBe(`${file}: `);
    }
  });

  it('has no visible text outside the translation function', () => {
    // Every text node the module writes is `esc(tr(...))` or a code/key/date;
    // a bare English word in markup would escape both i18n mechanisms.
    const markup = MODULE.match(/'>[^'<]*[A-Za-z]{3,}[^'<]*</g) ?? [];
    expect(markup).toEqual([]);
  });
});

describe('placement', () => {
  it('lives in Settings › Account, hidden until the owner check passes, owned by the bundle', () => {
    const account = APP.slice(APP.indexOf('data-set-panel="account"'), APP.indexOf('data-set-panel="platform"'));
    expect(account).toContain('<div class="set-card set-mfa" id="set-mfa-card" data-no-i18n hidden></div>');
  });

  it('is mounted when Settings is drawn, and loaded after app.js', () => {
    const fn = APP.slice(APP.indexOf('function renderSettingsPage()'), APP.indexOf('window.renderSettingsPage'));
    expect(fn).toContain('window.SettingsMfa.mount()');
    expect(INDEX.indexOf('/settings-mfa.js')).toBeGreaterThan(INDEX.indexOf('/app.js?'));
  });

  it('asks the owner check before showing anything or calling the API', () => {
    const mount = MODULE.slice(MODULE.indexOf('function mount()'));
    expect(mount.indexOf('_isPlatformOwner')).toBeLessThan(mount.indexOf('el.hidden = false'));
    expect(mount.indexOf('if (!yes')).toBeLessThan(mount.indexOf('load()'));
  });
});

describe('secrets stay out of the browser’s storage', () => {
  it('never writes to localStorage, sessionStorage or IndexedDB', () => {
    expect(CODE).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('drops recovery codes and the setup key when the reader moves on', () => {
    expect(MODULE).toMatch(/a === 'codes-saved'\) \{\s*S\.codes = null/);
    expect(MODULE).toMatch(/a === 'cancel'\) \{\s*S\.mode = null; S\.setup = null/);
  });

  it('escapes every server value it writes into the page', () => {
    for (const v of ['esc(group(S.setup.base32, 4))', 'esc(S.setup.otpauth)', 'esc(codeShown(c))',
      'esc(when(st.enabledAt))', 'esc(String(st.recoveryCodesRemaining))']) {
      expect(CODE).toContain(v);
    }
    // And no server value reaches innerHTML any other way.
    expect(CODE).not.toMatch(/\+ (?:S\.setup\.|st\.)[a-zA-Z]+ \+/);
  });
});
