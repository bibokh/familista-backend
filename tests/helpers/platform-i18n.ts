// The platform's language runtime, for a room under test
// ─────────────────────────────────────────────────────────────────────────────
// Every owner room follows the platform's language: it reads I18N.roomLocales(),
// I18N.roomLocale() and, when its own switch is pressed, I18N.roomChoose(). A
// room tested in a sandbox therefore needs the real runtime there, not a
// stand-in that could drift from it — so this evaluates public/i18n/config.js
// and public/i18n/i18n.js themselves, in a context of their own, and sets the
// platform language the way the shell does.
//
// What a room asked for through roomChoose() is recorded, so a test can show
// that pressing a room's button moved the platform language (and nothing else).

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export interface PlatformI18n {
  /** The runtime's own I18N object, to be set as `window.I18N` in a room's sandbox. */
  I18N: any;
  /** Every platform locale a room asked for through roomChoose(), in order. */
  chosen: string[];
}

/** Familista's official languages as a room lists them: [code, label, dir, tag]. */
export function officialRoomLocales(): Array<[string, string, 'ltr' | 'rtl', string]> {
  const ctx: any = { console };
  ctx.window = ctx;
  vm.runInNewContext(read('public/i18n/config.js'), ctx);
  vm.runInNewContext(read('public/i18n/i18n.js'), ctx);
  return ctx.I18N.roomLocales();
}

/**
 * The runtime with the platform language set.
 *
 * `lang` may be a full tag ("de-DE") or a room code ("de"); a room code is
 * matched to its official language. Anything else leaves the platform on its
 * base language, as the shell would.
 */
export async function platformI18n(lang?: string | null): Promise<PlatformI18n> {
  const chosen: string[] = [];
  const ctx: any = {
    console, Promise, Object, Array, String, Number, Date, Math, JSON, Intl,
    document: { documentElement: { setAttribute() {} } },
    location: { hostname: 'test.invalid' },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  };
  ctx.window = ctx;
  vm.runInNewContext(read('public/i18n/config.js'), ctx);
  vm.runInNewContext(read('public/i18n/i18n.js'), ctx);
  ctx.I18N_APPLY = {
    change: (tag: string) => { chosen.push(tag); return ctx.I18N.setLocale(tag); },
  };
  if (lang) {
    const code = String(lang).toLowerCase().split('-')[0];
    const hit = (ctx.I18N.roomLocales() as string[][]).find((l) => l[0] === code || l[3].toLowerCase() === String(lang).toLowerCase());
    if (hit) await ctx.I18N.setLocale(hit[3]);
  }
  return { I18N: ctx.I18N, chosen };
}

/** The room codes of the official languages, in the registry's order: ['en', 'de', …]. */
export function officialCodes(): string[] {
  return officialRoomLocales().map((l) => l[0]);
}

/**
 * Every line of a room's source that touches the platform's language runtime
 * other than to follow it.
 *
 * A room may read the official list (roomLocales), the language in force
 * (roomLocale, locale) and, from its own switch, ask the platform to change
 * (roomChoose, or I18N_APPLY.change — the shell's one path). It may not load the
 * platform's bundles or catalogues, set the language behind the shell's back, or
 * keep a language of its own in storage. Empty means it only follows.
 */
export function i18nBeyondRoomApi(src: string): string[] {
  const allowed = /\bwindow\.I18N(?:_APPLY)?\b(?:\.(?:roomLocales|roomLocale|roomChoose|locale|change)\b)?/g;
  const lines = src.split('\n').filter((line) => /\bI18N\b|\/i18n\/(?:locales|catalogue)\/|familista\.locale|setItem\([^)]*locale/i.test(line));
  return lines.filter((line) => /\/i18n\/(?:locales|catalogue)\/|familista\.locale|setItem\([^)]*locale|\.setLocale\(/i.test(line)
    || /\bI18N\b/.test(line.replace(allowed, ''))).map((l) => l.trim());
}
