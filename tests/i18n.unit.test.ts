/**
 * tests/i18n.unit.test.ts
 *
 * The invariants that keep the translation system honest.
 *
 * Two of them matter more than the rest:
 *
 *   The client's locale list and the server's must be identical. They are
 *   separate files — one ships to the browser, one validates the save — and a
 *   language offered in the dropdown but refused by the API would look to the
 *   user like a setting that silently will not stick.
 *
 *   Every bundle must carry every key of en-GB. A partial bundle does not fail
 *   loudly; it falls through to English for the keys it lacks, so a half-
 *   translated language looks finished until someone reads it.
 *
 * And the rule that is easy to lose later: non-English bundles must not be
 * English. A locale file filled with the English strings passes a "key exists"
 * check perfectly and is worthless.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const root = (p: string) => join(__dirname, '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');
const LOCALE_DIR = root('public/i18n/locales');

type Flat = Record<string, string>;
function flatten(o: Record<string, unknown>, prefix = '', out: Flat = {}): Flat {
  for (const k of Object.keys(o)) {
    const v = o[k], key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else out[key] = String(v);
  }
  return out;
}
const bundle = (tag: string) => flatten(JSON.parse(readFileSync(join(LOCALE_DIR, `${tag}.json`), 'utf8')));

const serverTags = [...read('src/i18n/locales.ts').matchAll(/tag: '([^']+)'/g)].map((m) => m[1]);
const clientTags = [...read('public/i18n/config.js').matchAll(/tag: '([^']+)'/g)].map((m) => m[1]);
const files = readdirSync(LOCALE_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));

describe('the locale registry is one list, in three places', () => {
  it('the server and the client offer exactly the same languages', () => {
    // Offered but unsavable is worse than not offered at all.
    expect(clientTags).toEqual(serverTags);
  });

  it('and every offered language has a bundle on disk', () => {
    expect([...files].sort()).toEqual([...serverTags].sort());
  });

  it('all 31 requested languages are present', () => {
    expect(serverTags).toHaveLength(31);
    for (const t of ['en-GB', 'en-US', 'de-DE', 'ar', 'he-IL', 'zh-CN', 'zh-TW',
                     'ja-JP', 'ko-KR', 'pt-BR', 'es-MX', 'nb-NO', 'th-TH', 'ms-MY']) {
      expect(serverTags).toContain(t);
    }
  });

  it('Arabic and Hebrew are the RTL ones, and only those', () => {
    const rtl = [...read('src/i18n/locales.ts').matchAll(/tag: '([^']+)',\s*label: '[^']*',\s*dir: 'rtl'/g)]
      .map((m) => m[1]);
    expect(rtl.sort()).toEqual(['ar', 'he-IL']);
  });
});

describe('every bundle is complete, and actually translated', () => {
  const base = bundle('en-GB');
  const keys = Object.keys(base);

  it('en-GB defines the canonical key set', () => {
    expect(keys.length).toBeGreaterThan(90);
    for (const k of ['navigation.squad', 'navigation.settings', 'common.save',
                     'settings.interfaceLanguage', 'settings.languageHelp',
                     'transfer.market', 'academy.stageObjectives']) {
      expect(keys).toContain(k);
    }
  });

  it('no bundle is missing a key', () => {
    for (const tag of files) {
      const b = bundle(tag);
      const missing = keys.filter((k) => b[k] == null);
      expect({ tag, missing }).toEqual({ tag, missing: [] });
    }
  });

  it('and non-English bundles are not just English', () => {
    // A file full of English passes every structural check and is useless. The
    // English variants are exempt: en-US differs from en-GB only where usage
    // actually differs.
    for (const tag of files.filter((f) => !f.startsWith('en-'))) {
      const b = bundle(tag);
      const identical = keys.filter((k) => b[k] === base[k]).length;
      // Some values legitimately match (proper nouns, "Status", "Familista").
      // Requiring the great majority to differ is what catches a placeholder file.
      expect({ tag, identical }).toEqual({ tag, identical: identical });
      expect(identical).toBeLessThan(keys.length * 0.4);
    }
  });

  it('football terminology is translated as football, not word-for-word', () => {
    expect(bundle('de-DE')['navigation.squad']).toBe('Kader');
    expect(bundle('de-DE')['squad.lineup']).toBe('Aufstellung');
    expect(bundle('es-ES')['navigation.squad']).toBe('Plantilla');
    expect(bundle('it-IT')['squad.formation']).toBe('Modulo');
    expect(bundle('pt-BR')['squad.lineup']).toBe('Escalação');
    expect(bundle('fr-FR')['navigation.squad']).toBe('Effectif');
  });
});

describe('the runtime never returns nothing', () => {
  const RT = read('public/i18n/i18n.js');

  it('falls through selected locale → en-GB → a humanised key', () => {
    expect(RT).toContain('function lookup(key)');
    expect(RT).toContain('bundles[FALLBACK]');
    expect(RT).toContain('return humanise(key);');
  });

  it('and logs a miss in development only', () => {
    expect(RT).toContain("console.warn('[i18n] missing key:'");
    expect(RT).toContain('if (isDev && !missing[key])');
  });

  it('resolves saved preference → browser → en-GB', () => {
    const A = read('public/i18n/apply.js');
    expect(A).toContain('I.cached() || I.fromBrowser()');
    // A server null means "never chosen" and must not overwrite anything.
    expect(A).toContain('if (data.locale && I.canonical(data.locale)');
  });

  it('bundles are fetched on demand, not all at boot', () => {
    expect(RT).toContain('function load(tag)');
    expect(RT).toContain('if (bundles[t]) return Promise.resolve(bundles[t]);');
    expect(RT).toContain('if (inflight[t]) return inflight[t];');
    expect(RT).not.toMatch(/LOCALES\.forEach\([^)]*load\(/);
  });

  it('formats with Intl, and never converts currency', () => {
    expect(RT).toContain('new Intl.NumberFormat(current');
    expect(RT).toContain('new Intl.DateTimeFormat(current');
    // The currency code comes from the data; only its presentation is localised.
    expect(RT).toContain('currency: code || \'EUR\'');
  });
});

describe('language is a user preference, stored on the user', () => {
  const CTRL = read('src/controllers/user-settings.controller.ts');

  it('is keyed by the authenticated subject and carries no club', () => {
    expect(CTRL).toContain('req.user!.id');
    // Check the CODE, not the prose — the file's own comment explains why there
    // is no clubId, and matching that would pass for the wrong reason.
    const code = CTRL.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toContain('clubId');
  });

  it('refuses a locale the interface cannot render', () => {
    expect(CTRL).toContain('canonicalLocale(body.locale)');
    expect(CTRL).toContain("throw new BadRequestError('Unsupported locale')");
  });

  it('and the column exists on User, not on Club', () => {
    const schema = read('prisma/schema.prisma');
    const user = schema.slice(schema.indexOf('model User {'), schema.indexOf('model User {') + 2600);
    expect(user).toContain('locale String?');
    expect(existsSync(root('prisma/migrations/20250901000000_add_user_locale/migration.sql'))).toBe(true);
  });

  it('re-resolves on sign-in, so one browser can serve two people', () => {
    const APP = read('public/app.js');
    expect(APP).toContain('if (window.I18N_APPLY) await I18N_APPLY.boot();');
    expect(APP).toContain("localStorage.removeItem('familista.locale')");
  });
});

describe('RTL flips the interface and not the football', () => {
  const CSS = read('public/app.css');

  it('the pitch, boards and charts are pinned back to ltr', () => {
    const block = CSS.slice(CSS.indexOf('RIGHT-TO-LEFT'));
    for (const sel of ['.sqmd-pitch--shared', '.sqfp-pitch', '.at-formation-cmd', 'canvas', 'svg']) {
      expect(block).toContain(`[dir="rtl"] ${sel}`);
    }
    expect(block).toContain('direction:ltr;');
  });

  it('while ordinary chrome does flip', () => {
    expect(CSS).toContain('[dir="rtl"] .sidebar{ direction:rtl; }');
  });

  it('and the document direction comes from the locale table', () => {
    expect(read('public/i18n/i18n.js')).toContain("d.setAttribute('dir', dirOf(current))");
  });
});

describe('Settings is reachable and sits where it was asked to', () => {
  const HTML = read('public/index.html');

  it('sits outside the nav, anchored between it and the account block', () => {
    // Being the LAST item in the nav is not the same as being anchored: on a
    // tall window it would trail Coaches with the empty space below it, and on
    // a short one it would scroll away with the rest of the list. It is a
    // sibling of the nav instead, and `.sidebar-nav{flex:1}` takes the slack.
    const nav = HTML.slice(HTML.indexOf('CLUB WORKSPACE'), HTML.indexOf('</nav>'));
    expect(nav).not.toContain('id="nav-settings"');
    expect(HTML).toContain('class="sidebar-settings"');
    expect(HTML.indexOf('</nav>')).toBeLessThan(HTML.indexOf('id="nav-settings"'));
    expect(HTML.indexOf('id="nav-settings"')).toBeLessThan(HTML.indexOf('sidebar-footer'));
    // and exactly one of them
    expect(HTML.match(/id="nav-settings"/g)).toHaveLength(1);
  });

  it('and the nav keeps the slack so it stays anchored at any height', () => {
    const CSS = read('public/app.css');
    expect(CSS).toContain('.sidebar-nav{flex:1;');
    expect(CSS).toContain('.sidebar-settings{');
    expect(CSS).toMatch(/\.sidebar-settings\{[^}]*flex-shrink:0/);
  });

  it('and the i18n runtime loads before the app that uses it', () => {
    expect(HTML.indexOf('/i18n/i18n.js')).toBeLessThan(HTML.indexOf('/app.js'));
    expect(HTML.indexOf('/i18n/config.js')).toBeLessThan(HTML.indexOf('/i18n/i18n.js'));
  });

  it('the page offers General → Interface Language with its helper text', () => {
    const APP = read('public/app.js');
    expect(APP).toContain('data-i18n="settings.interfaceLanguage"');
    expect(APP).toContain('data-i18n="settings.languageHelp"');
    expect(APP).toContain('data-change="onLocaleChange"');
  });

  it('and changing language re-renders rather than reloading', () => {
    const A = read('public/i18n/apply.js');
    expect(A).toContain('repaintAll()');
    expect(A).not.toContain('location.reload');
    expect(read('public/app.js')).not.toMatch(/onLocaleChange[\s\S]{0,400}location\.reload/);
  });
});

describe('the audit exists so migration is a number, not an impression', () => {
  it('ships and can run', () => {
    expect(existsSync(root('scripts/i18n-audit.js'))).toBe(true);
    const S = read('scripts/i18n-audit.js');
    expect(S).toContain('--max=');
    // Position codes are conventional worldwide and deliberately not counted.
    expect(S).toContain('POSITIONS');
  });
});
