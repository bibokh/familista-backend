// The forgotten-password and password-reset screens speak every official
// language, and a back arrow in a right-to-left language points back.
//
// Both screens are catalogue-translated: their English is written into
// public/index.html and set by the reset flow in public/app.js, and
// public/i18n/dom.js swaps it as it appears. Until this test, none of it was in
// the catalogue, so an Arabic, French, German or Spanish session reset its
// password in English. The strings are read from the source here, not listed by
// hand, so a string added to these screens later is held to the same rule.
//
// The arrow: "← Back to sign in" was carried into Arabic as "← …". On a
// right-to-left line the first character sits at the right, so that arrow
// pointed into the text — forward. A back arrow in a right-to-left language is →.

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel: string): any => JSON.parse(read(rel));

// ── the registry, as the client holds it ─────────────────────────────────────
interface Locale { tag: string; dir: 'ltr' | 'rtl'; official?: number }
function registry(): Locale[] {
  const ctx: any = {};
  ctx.window = ctx;
  vm.runInNewContext(read('public/i18n/config.js'), ctx);
  return ctx.FAMILISTA_I18N_CONFIG.LOCALES as Locale[];
}
const OFFICIAL = registry().filter((l) => l.official).sort((a, b) => (a.official as number) - (b.official as number));
const BASE = 'en-GB';
const TRANSLATED = OFFICIAL.filter((l) => l.tag !== BASE);

// ── the catalogue's own lookup (public/i18n/dom.js: norm, exact, case-insensitive, digit slots) ──
const SLOT = '\u0000';
const NUM = /\d+(?:[.,  ]\d+)*/g;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
export function lookup(cat: Record<string, string>, english: string): string | null {
  const s = norm(english);
  if (cat[s] != null) return cat[s];
  const lower = Object.keys(cat).find((k) => k.toLowerCase() === s.toLowerCase());
  if (lower != null) return cat[lower];
  const shape = s.replace(NUM, SLOT);
  if (shape !== s && cat[shape] != null) return cat[shape];
  return null;
}
const keyOf = (english: string) => norm(english).replace(NUM, SLOT);
const decodeHtml = (s: string) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// ── what the two screens can show ────────────────────────────────────────────
const VIEWS = ['forgot', 'forgot-sent', 'reset-checking', 'reset-invalid', 'reset', 'reset-success'];
/** An example address in an empty field, the same on every screen and in every language. */
const NOT_PROSE = new Set(['you@club.com']);

function markupStrings(html: string): string[] {
  const start = html.indexOf('<div data-auth-view="forgot">');
  const end = html.indexOf('<!-- MAIN APP -->');
  if (start < 0 || end < start) throw new Error('the reset views were not found in public/index.html');
  const block = html.slice(start, end).replace(/<!--[\s\S]*?-->/g, '');
  for (const v of VIEWS) if (!block.includes(`data-auth-view="${v}"`)) throw new Error(`view ${v} missing`);
  const out: string[] = [];
  for (const m of block.matchAll(/>([^<]+)</g)) out.push(decodeHtml(norm(m[1])));
  for (const m of block.matchAll(/\s(?:placeholder|title|aria-label)="([^"]+)"/g)) out.push(decodeHtml(norm(m[1])));
  return out.filter((s) => /[A-Za-z]/.test(s) && !NOT_PROSE.has(s));
}

/** Messages the reset flow writes itself: what it sets as text, and its fallbacks. */
function flowStrings(app: string): string[] {
  const start = app.indexOf('// ── PASSWORD RESET FLOW');
  const end = app.indexOf("window.addEventListener('DOMContentLoaded'", start);
  if (start < 0 || end < start) throw new Error('the reset flow was not found in public/app.js');
  const region = app.slice(start, end).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  return [...region.matchAll(/(?:textContent\s*=\s*|\|\|\s*)'([^']+)'/g)].map((m) => m[1]);
}

/** What the server says about a reset link that will not do; the screen shows it as it comes. */
function serverStrings(): string[] {
  const svc = read('src/services/password-reset.service.ts');
  const out = [...svc.matchAll(/BadRequestError\('([^']+)'\)/g)].map((m) => m[1]);
  // A request the server refuses as malformed (an address it cannot accept) arrives as this.
  expect(read('src/middleware/error.middleware.ts')).toContain("message: 'Validation error'");
  return [...new Set(out), 'Validation error'];
}

/**
 * What the client says when the request itself fails, for the failures these unauthenticated
 * endpoints can have: no connection, a timeout, a malformed request, too many requests, a server
 * fault. Each is checked to be the client's text today, so a change to it is a change to this list.
 */
const CLIENT_FAILURES = [
  'You appear to be offline. Check your internet connection.',
  'Backend waking up… Please retry in a few seconds.',
  'Connection timeout. The server is taking too long to respond.',
  'Connection timeout. Please retry.',
  'Something went wrong. Please retry.',
  'Some fields are invalid.',
  'Too many requests. Slow down and retry shortly.',
  'Server unavailable. The backend may be restarting — please retry in 30s.',
  'Server error. Please retry shortly.',
];

export function resetScreenStrings(html: string, app: string): string[] {
  for (const s of CLIENT_FAILURES) if (!app.includes(`'${s}'`)) throw new Error(`client message changed: ${s}`);
  return [...new Set([...markupStrings(html), ...flowStrings(app), ...serverStrings(), ...CLIENT_FAILURES])];
}

/** Every string a reset screen can show that a language does not translate. */
export function untranslated(strings: string[], cat: Record<string, string>, sameAsEnglish: string[]): string[] {
  const reviewed = new Set(sameAsEnglish);
  return strings.filter((s) => {
    const v = lookup(cat, s);
    if (v == null || v === '') return true;
    return v === norm(s) && !reviewed.has(keyOf(s));
  });
}

// ── arrows ────────────────────────────────────────────────────────────────────
/** Every entry whose English leads with a back arrow, in a flat or nested catalogue. */
function backEntries(cat: any, prefix = ''): Array<[string, string, string]> {
  const out: Array<[string, string, string]> = [];
  for (const [k, v] of Object.entries(cat)) {
    if (v && typeof v === 'object') out.push(...backEntries(v, prefix + k + '.'));
    else if (typeof v === 'string' && /^← /.test(k)) out.push([prefix + k, k, v]);
  }
  return out;
}
/** A back arrow in a right-to-left language leads with →, and carries no ←. */
export function wrongWayBack(cat: any): string[] {
  return backEntries(cat).filter(([, , v]) => !/^→ /.test(v) || v.includes('←')).map(([p, , v]) => `${p} = ${JSON.stringify(v)}`);
}
/** In a left-to-right language the same entries keep ←. */
export function ltrBackChanged(cat: any): string[] {
  return backEntries(cat).filter(([, , v]) => !/^← /.test(v)).map(([p, , v]) => `${p} = ${JSON.stringify(v)}`);
}
/** Every catalogue a language has: the platform's and each owner room's. */
function cataloguesFor(tag: string): Array<[string, any]> {
  const out: Array<[string, any]> = [[`public/i18n/catalogue/${tag}.json`, json(`public/i18n/catalogue/${tag}.json`)]];
  const code = tag.split('-')[0];
  for (const d of fs.readdirSync(path.join(ROOT, 'public'), { withFileTypes: true })) {
    const rel = `public/${d.name}/i18n/${code}.json`;
    if (d.isDirectory() && fs.existsSync(path.join(ROOT, rel))) out.push([rel, json(rel)]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
const HTML = read('public/index.html');
const APP = read('public/app.js');
const SAME = json('scripts/i18n-same-as-english.json');
const STRINGS = resetScreenStrings(HTML, APP);

describe('the forgotten-password and reset screens, in every official language', () => {
  it('reads what the screens can show from the source', () => {
    expect(OFFICIAL.map((l) => l.tag)).toContain(BASE);
    expect(TRANSLATED.length).toBeGreaterThanOrEqual(1);
    for (const s of ['Reset your password', 'Send Reset Link', 'Check your inbox', 'Link expired or invalid',
      'Set new password', 'Minimum 8 characters', 'Password updated', 'Passwords do not match.',
      'Reset token missing — please use the link from your email.', 'Reset token has expired']) {
      expect(STRINGS).toContain(s);
    }
    expect(STRINGS.length).toBeGreaterThanOrEqual(40);
    expect(STRINGS).not.toContain('you@club.com');
  });

  it.each(TRANSLATED.map((l) => [l.tag]))('%s translates every one of them', (tag) => {
    const cat = json(`public/i18n/catalogue/${tag}.json`);
    expect(untranslated(STRINGS, cat, (SAME.catalogue || {})[tag] || [])).toEqual([]);
  });

  it('the base language holds each of them as itself', () => {
    const cat = json(`public/i18n/catalogue/${BASE}.json`);
    expect(STRINGS.filter((s) => lookup(cat, s) == null)).toEqual([]);
  });

  it('a translation keeps the number it was given', () => {
    for (const l of TRANSLATED) {
      const cat = json(`public/i18n/catalogue/${l.tag}.json`);
      for (const s of STRINGS.filter((x) => /\d/.test(x))) {
        const v = lookup(cat, s) as string;
        expect([l.tag, s, (v.match(/\u0000/g) || []).length]).toEqual([l.tag, s, (s.match(NUM) || []).length]);
      }
    }
  });
});

describe('a back arrow points back', () => {
  const rtl = OFFICIAL.filter((l) => l.dir === 'rtl');
  const ltr = OFFICIAL.filter((l) => l.dir === 'ltr' && l.tag !== BASE);

  it('the registry has a right-to-left official language to hold to this', () => {
    expect(rtl.length).toBeGreaterThanOrEqual(1);
  });

  it.each(rtl.map((l) => [l.tag]))('%s: every back arrow, platform and owner rooms, leads with →', (tag) => {
    const found = cataloguesFor(tag);
    expect(found.reduce((n, [, c]) => n + backEntries(c).length, 0)).toBeGreaterThanOrEqual(3);
    expect(found.flatMap(([rel, c]) => wrongWayBack(c).map((x) => `${rel}: ${x}`))).toEqual([]);
    const cat = json(`public/i18n/catalogue/${tag}.json`);
    expect(lookup(cat, '← Back to sign in')).toMatch(/^→ /);
  });

  it.each(ltr.map((l) => [l.tag]))('%s: left to right, the back arrows stay ←', (tag) => {
    expect(cataloguesFor(tag).flatMap(([rel, c]) => ltrBackChanged(c).map((x) => `${rel}: ${x}`))).toEqual([]);
    expect(lookup(json(`public/i18n/catalogue/${tag}.json`), '← Back to sign in')).toMatch(/^← /);
  });

  it('the sign-in screens write ← in English, and the code-owned back link carries no arrow', () => {
    const links = HTML.match(/<a class="auth-link" data-show-auth="login">[^<]*<\/a>/g) || [];
    expect(links.length).toBe(3);
    for (const a of links) expect(a).toContain('>← Back to sign in<');
    expect(HTML).toContain('<a class="auth-link" data-show-auth="login" data-i18n="auth.mfa.back"></a>');
    for (const l of OFFICIAL) {
      const b = json(`public/i18n/locales/${l.tag}.json`);
      expect([l.tag, /[←→]/.test(b.auth.mfa.back)]).toEqual([l.tag, false]);
    }
  });
});

describe('the checks, watched working', () => {
  it('(control) a back arrow left pointing forward in a right-to-left catalogue is reported, nested or flat', () => {
    expect(wrongWayBack({ '← Back to sign in': '← العودة إلى تسجيل الدخول' })).toHaveLength(1);
    expect(wrongWayBack({ room: { '← Back to Home': 'العودة ←' } })).toHaveLength(1);
    expect(wrongWayBack({ '← Back to sign in': '→ العودة إلى تسجيل الدخول', 'Open →': 'فتح ←' })).toEqual([]);
    expect(ltrBackChanged({ '← Back to sign in': '→ Zurück' })).toHaveLength(1);
  });

  it('(control) a reset string with no translation, or left in English, is reported; a reviewed one is not', () => {
    const cat = { 'Reset your password': 'Passwort zurücksetzen', 'Set new password': 'Set new password', 'Email': 'Email' };
    expect(untranslated(['Reset your password', 'Send Reset Link', 'Set new password', 'Email'], cat, ['Email']))
      .toEqual(['Send Reset Link', 'Set new password']);
    expect(lookup({ 'Minimum \u0000 characters': 'Mindestens \u0000 Zeichen' }, 'Minimum 8 characters')).toBe('Mindestens \u0000 Zeichen');
  });

  it('(control) a string added to a reset view is picked up from the markup', () => {
    const html = HTML.replace('<div class="auth-title">Check your inbox</div>', '<div class="auth-title">Check your inbox</div><p>A brand new sentence</p>');
    expect(resetScreenStrings(html, APP)).toContain('A brand new sentence');
  });
});
