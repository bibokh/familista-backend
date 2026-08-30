/**
 * tests/i18n-catalogue.unit.test.ts
 *
 * The invariants of the layer that actually translates this application.
 *
 * The key-per-call-site system next door (tests/i18n.unit.test.ts) covers the
 * markup somebody remembered to mark up. This covers the one that reaches the
 * other sixty-two thousand lines: a catalogue keyed by the English text itself,
 * applied to the document as it renders.
 *
 * Four properties carry the whole design, and each is a bug the moment it slips:
 *
 *   A catalogue is complete or it is a half-translated screen. Every locale
 *   offered in Settings must answer for every key en-GB defines, because a
 *   language that translates the navigation and not the Training Centre is
 *   precisely the fault this was built to remove.
 *
 *   Names are never translated. The catalogue is authored, and the test below
 *   asserts that no demo player's or coach's name is in it — because a name in
 *   the catalogue is a name that would be rewritten on screen.
 *
 *   The Content-Security-Policy is respected. style-src and script-src carry no
 *   'unsafe-inline', so the layer may not size anything with a style attribute
 *   nor react with an onerror/onclick attribute; both would be refused silently.
 *
 *   A miss is invisible. There is no key to leak, because the key IS the
 *   English — a string with no entry renders as the English it already was.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const root = (p: string) => join(__dirname, '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');
const CAT_DIR = root('public/i18n/catalogue');

const DOM = read('public/i18n/dom.js');
const APPLY = read('public/i18n/apply.js');
const cat = (tag: string) => JSON.parse(readFileSync(join(CAT_DIR, `${tag}.json`), 'utf8')) as Record<string, string>;

const tags = [...read('public/i18n/config.js').matchAll(/tag: '([^']+)'/g)].map((m) => m[1]);
const english = cat('en-GB');
const keys = Object.keys(english);
const SLOT = '\u0000';

describe('every offered language has a complete catalogue', () => {
  it('there is one catalogue per offered locale', () => {
    const files = readdirSync(CAT_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => f.replace('.json', ''));
    expect([...files].sort()).toEqual([...tags].sort());
    expect(tags.length).toBe(31);
  });

  it('and every one answers for every key en-GB defines', () => {
    // The exceptions are the English variants: the markup is already English,
    // so en-US carries only the handful of words where usage differs.
    for (const tag of tags.filter((t) => !/^en(-|$)/.test(t))) {
      const c = cat(tag);
      // A `…|plural` entry holds one form per CLDR category the language uses.
      // Chinese, Japanese, Korean, Thai, Vietnamese, Indonesian and Malay have
      // a single category, so the plain shape entry already answers every count
      // and a plural entry would only repeat it. Ask those for the shape.
      const oneForm = new Intl.PluralRules(tag).resolvedOptions().pluralCategories.length === 1;
      const missing = keys.filter((k) => {
        if (oneForm && k.endsWith('|plural')) return c[k.slice(0, -'|plural'.length)] == null;
        return c[k] == null && c[`${k}|plural`] == null;
      });
      expect({ tag, missing: missing.slice(0, 8), count: missing.length })
        .toEqual({ tag, missing: [], count: 0 });
    }
  });

  it('en-US differs from en-GB only where usage differs', () => {
    const us = cat('en-US');
    expect(Object.keys(us).length).toBeGreaterThan(0);
    expect(Object.keys(us).length).toBeLessThan(20);
    expect(us['Training Centre']).toBe('Training Center');
    expect(us['Defence']).toBe('Defense');
  });

  it('and a translation is a translation, not the English copied across', () => {
    for (const tag of tags.filter((t) => !/^en(-|$)/.test(t))) {
      const c = cat(tag);
      const identical = keys.filter((k) => c[k] === english[k]).length;
      // Some entries legitimately match — "Tiki-taka", position codes inside a
      // string, "Video Intelligence". A catalogue that mostly matches is a
      // placeholder file, and would pass every structural check while being
      // worthless.
      expect({ tag, identical }).toEqual({ tag, identical });
      expect(identical).toBeLessThan(keys.length * 0.15);
    }
  });

  it('football is translated as football', () => {
    expect(cat('de-DE')['Squad']).toBe('Kader');
    expect(cat('de-DE')['Starting XI']).toBe('Startelf');
    expect(cat('de-DE')['Possession']).toBe('Ballbesitz');
    expect(cat('es-ES')['Squad']).toBe('Plantilla');
    expect(cat('fr-FR')['Squad']).toBe('Effectif');
    expect(cat('it-IT')['Formation']).toBe('Modulo');
    expect(cat('pt-BR')['Bench']).toBe('Banco');
    expect(cat('ar')['Possession']).toBe('الاستحواذ');
  });

  it('and position codes are never translated', () => {
    // GK, CB, ST are conventional in every language. They appear inside longer
    // catalogue strings ("CB · %d"), and must survive there untouched.
    for (const tag of tags) {
      const c = cat(tag);
      for (const code of ['CB', 'CM', 'DM', 'GK', 'LW', 'RB', 'ST']) {
        const k = `${code} · ${SLOT}`;
        if (c[k] == null) continue;
        expect({ tag, code, value: c[k] }).toEqual({ tag, code, value: expect.stringContaining(code) });
      }
      expect(c['GK']).toBeUndefined();
      expect(c['CB']).toBeUndefined();
    }
  });
});

describe('what is data is never translated', () => {
  it('no demo player or coach name is in any catalogue', () => {
    // The seed data's people. A name here would be a name rewritten on screen,
    // which is the one thing requirement 6 forbids outright.
    const people = ['Almeida', 'Bautista', 'Brenner', 'Carter', 'Greco', 'Haddad',
                    'Korhonen', 'Lefevre', 'Mbeki', 'Novak', 'Oliveira', 'Pinto',
                    'Roberts', 'Ruiz', 'Sorensen', 'Tanaka', 'Vidalli', 'Watanabe',
                    'Marco Rossi', 'David Silva', 'Rafael Pinto'];
    for (const tag of tags) {
      const c = cat(tag);
      for (const name of people) expect({ tag, name, present: c[name] != null }).toEqual({ tag, name, present: false });
    }
  });

  it('nor any club name', () => {
    for (const tag of tags) {
      const c = cat(tag);
      for (const club of ['FC Familista', 'FC FAMILISTA', 'Familista HSR', 'Familista']) {
        expect({ tag, club, present: c[club] != null }).toEqual({ tag, club, present: false });
      }
    }
  });

  it('and the layer skips the containers that hold names outright', () => {
    // Belt and braces: even if a name somehow matched an entry, these never ask.
    for (const sel of ['.sqlu-id-nm', '.sqmd-card-nm', '.sqfp-name', '#ctx-club',
                       '.user-name', '.club-name', '[data-no-i18n]']) {
      expect(DOM).toContain(`'${sel}'`);
    }
    expect(DOM).toContain('var USER_CONTENT = [');
  });

  it('the language list itself is exempt, since it is written in its own languages', () => {
    expect(read('public/app.js')).toContain('id="set-lang" data-no-i18n');
  });
});

describe('the Content-Security-Policy is respected, not worked around', () => {
  it('style-src and script-src still refuse inline', () => {
    const A = read('src/app.ts');
    expect(A).not.toMatch(/styleSrc:[^\]]*unsafe-inline/);
    expect(A).not.toMatch(/scriptSrc:[^\]]*unsafe-inline/);
  });

  it('so the layer writes no inline style or handler attribute', () => {
    // It only ever sets text and the four attributes a person reads.
    expect(DOM).not.toMatch(/setAttribute\('style'/);
    expect(DOM).not.toMatch(/setAttribute\('on[a-z]+'/);
    expect(DOM).toContain("var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];");
  });
});

describe('the runtime cannot show a key, and cannot break a screen', () => {
  it('a miss returns null and leaves the English standing', () => {
    // There is no key to leak: the key is the English.
    expect(DOM).toContain('function noteMiss(s)');
    expect(DOM).toMatch(/noteMiss\(s\);\s*\n\s*return null;/);
    expect(DOM).toContain("console.warn('[i18n] no translation for:'");
    expect(DOM).toContain('if (isDev)');
  });

  it('numbers are lifted out so one entry answers for every count', () => {
    expect(DOM).toContain('var shape = s.replace(NUM, SLOT);');
    expect(english[`${SLOT} players`]).toBeDefined();
    expect(cat('de-DE')[`${SLOT} players`]).toContain(SLOT);
  });

  it('and plural forms are chosen by the locale, not by an English n === 1', () => {
    expect(DOM).toContain('new Intl.PluralRules(activeTag).select(n)');
    expect(DOM).toContain('resolvedOptions().pluralCategories');
    // Arabic has six categories and supplies six forms.
    const ar = cat('ar')[`${SLOT} players|plural`];
    expect(ar).toBeDefined();
    expect(String(ar).split('||')).toHaveLength(6);
    // Polish has four.
    expect(String(cat('pl-PL')[`${SLOT} players|plural`]).split('||')).toHaveLength(4);
  });

  it('casing differences are matched, and the casing is put back', () => {
    // "PLAYERS" and "Players" are one entry, and the heading stays a heading.
    expect(DOM).toContain('function lowerLookup(s)');
    expect(DOM).toContain('function recase(source, translated)');
    expect(DOM).toContain('return translated.toUpperCase();');
  });

  it('and one bad node never takes the pass down', () => {
    expect(DOM).toContain('try {');
    expect(DOM).toContain('} finally { if (was) observe(); }');
  });
});

describe('it keeps up with a document that repaints itself', () => {
  it('a MutationObserver catches what renders after the language was set', () => {
    expect(DOM).toContain('new MutationObserver(');
    expect(DOM).toContain('childList: true, subtree: true, characterData: true');
    // Batched into a frame, so thirty renders cost one pass.
    expect(DOM).toContain('requestAnimationFrame');
  });

  it('and it stops observing while it writes, so it cannot chase itself', () => {
    expect(DOM).toMatch(/var was = observer;\s*\n\s*if \(was\) was\.disconnect\(\);/);
  });

  it('changing language restores the English first, then translates again', () => {
    // Which is why no screen has to re-render and no screen state is lost.
    expect(DOM).toContain('function restoreAll()');
    expect(DOM).toMatch(/restoreAll\(\);[\s\S]{0,200}translateTree\(root\.document\.body\)/);
    expect(APPLY).not.toContain('location.reload');
  });

  it('and disconnected nodes are dropped as it goes', () => {
    expect(DOM).toContain('if (!node.isConnected) { tracked.delete(node); return; }');
  });
});

describe('both mechanisms are driven from one place', () => {
  it('a language change applies keys and then the document', () => {
    expect(APPLY).toContain('function applyEverywhere(tag)');
    expect(APPLY).toMatch(/root\.I18N_DOM\.setLocale\(tag\)/);
    expect(APPLY).toMatch(/change\(tag\)[\s\S]{0,400}applyEverywhere\(t2\)/);
    expect(APPLY).toMatch(/function boot\(\)[\s\S]{0,600}applyEverywhere\(first\)/);
  });

  it('and the observer is running before the first screen paints', () => {
    expect(APPLY).toMatch(/root\.I18N_DOM\.start\(\)[\s\S]{0,200}setLocale\(first/);
  });

  it('the layer loads with the rest of the runtime, before the app', () => {
    const HTML = read('public/index.html');
    expect(HTML.indexOf('/i18n/i18n.js')).toBeLessThan(HTML.indexOf('/i18n/dom.js'));
    expect(HTML.indexOf('/i18n/dom.js')).toBeLessThan(HTML.indexOf('/i18n/apply.js'));
    expect(HTML.indexOf('/i18n/apply.js')).toBeLessThan(HTML.indexOf('/app.js'));
  });
});

describe('the guard, so tomorrow does not undo this', () => {
  it('the audit ships and refuses an incomplete catalogue', () => {
    expect(existsSync(root('scripts/i18n-audit.js'))).toBe(true);
    const S = read('scripts/i18n-audit.js');
    expect(S).toContain('are not complete against en-GB');
    expect(S).toContain('--max=');
  });

  it('and the walk that measures the running product ships too', () => {
    expect(existsSync(root('scripts/i18n-walk.js'))).toBe(true);
    const W = read('scripts/i18n-walk.js');
    // It must refuse to touch anything that changes data — an audit that sends
    // an offer is not an audit.
    expect(W).toContain('const DESTRUCTIVE =');
    expect(W).toContain('process.exit(report.english && report.english.length ? 1 : 0);');
  });

  it('the extractor writes an inventory, not the shipped catalogue', () => {
    // The catalogue is authored; letting the extractor overwrite it would put
    // uncurated strings — names among them — in front of a translator.
    expect(read('scripts/i18n-extract.js')).toContain('_source-inventory.json');
    expect(read('scripts/i18n-extract.js')).not.toContain("catalogue/en-GB.json');");
  });
});

describe('RTL flips the interface and not the football', () => {
  it('Arabic and Hebrew are the right-to-left ones, and they are complete', () => {
    for (const tag of ['ar', 'he-IL']) {
      expect(Object.keys(cat(tag)).length).toBeGreaterThanOrEqual(keys.length);
    }
    const rtl = [...read('public/i18n/config.js').matchAll(/tag: '([^']+)',\s*label: '[^']*',\s*dir: 'rtl'/g)]
      .map((m) => m[1]);
    expect(rtl.sort()).toEqual(['ar', 'he-IL']);
  });

  it('and the pitch, boards and charts stay left-to-right', () => {
    const CSS = read('public/app.css');
    const block = CSS.slice(CSS.indexOf('RIGHT-TO-LEFT'));
    for (const sel of ['.sqmd-pitch--shared', '.sqfp-pitch', '.at-formation-cmd', 'canvas', 'svg']) {
      expect(block).toContain(`[dir="rtl"] ${sel}`);
    }
  });

  it('and text that is longer than English is allowed to fit', () => {
    // The two shapes that break under translation: a fixed-height control whose
    // label wraps, and a single word wider than its column.
    const CSS = read('public/app.css');
    expect(CSS).toMatch(/\.tf-btn\{[\s\S]{0,600}white-space:nowrap/);
    expect(CSS).toMatch(/\.sqf-title\{[\s\S]{0,200}overflow-wrap: anywhere/);
  });
});
