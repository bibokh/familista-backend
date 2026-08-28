// Familista — the supported locales, and the rules for resolving one.
// ─────────────────────────────────────────────────────────────────────────────
// One list, on the server, so the API can refuse a locale the interface cannot
// actually render. The client ships the same list (public/i18n/config.js) and a
// test asserts the two never drift apart — a language offered in the dropdown
// but rejected on save would be a silent, confusing failure.
//
// The tag is what we store. It is an IETF language tag, so `Intl` can consume it
// directly for dates, numbers and percentages without a translation table of our
// own. `dir` is the only presentational fact here, and it exists because the
// document direction has to be settled before any text is drawn.

export interface LocaleDef {
  /** IETF tag. Stored on the user, sent to Intl, used as the bundle filename. */
  tag: string;
  /** The language's own name for itself — never translated. */
  label: string;
  dir: 'ltr' | 'rtl';
}

export const LOCALES: LocaleDef[] = [
  { tag: 'en-GB', label: 'English (UK)',      dir: 'ltr' },
  { tag: 'en-US', label: 'English (US)',      dir: 'ltr' },
  { tag: 'de-DE', label: 'Deutsch',           dir: 'ltr' },
  { tag: 'it-IT', label: 'Italiano',          dir: 'ltr' },
  { tag: 'es-ES', label: 'Español (ES)',      dir: 'ltr' },
  { tag: 'es-MX', label: 'Español (MX)',      dir: 'ltr' },
  { tag: 'pt-PT', label: 'Português (PT)',    dir: 'ltr' },
  { tag: 'pt-BR', label: 'Português (BR)',    dir: 'ltr' },
  { tag: 'fr-FR', label: 'Français',          dir: 'ltr' },
  { tag: 'sr-RS', label: 'Srpski',            dir: 'ltr' },
  { tag: 'zh-CN', label: '简体中文',            dir: 'ltr' },
  { tag: 'zh-TW', label: '繁體中文',            dir: 'ltr' },
  { tag: 'cs-CZ', label: 'Čeština',           dir: 'ltr' },
  { tag: 'da-DK', label: 'Dansk',             dir: 'ltr' },
  { tag: 'fi-FI', label: 'Suomi',             dir: 'ltr' },
  { tag: 'el-GR', label: 'Ελληνικά',          dir: 'ltr' },
  { tag: 'he-IL', label: 'עברית',              dir: 'rtl' },
  { tag: 'ja-JP', label: '日本語',              dir: 'ltr' },
  { tag: 'nl-NL', label: 'Nederlands',        dir: 'ltr' },
  { tag: 'nb-NO', label: 'Norsk',             dir: 'ltr' },
  { tag: 'pl-PL', label: 'Polski',            dir: 'ltr' },
  { tag: 'ro-RO', label: 'Română',            dir: 'ltr' },
  { tag: 'ru-RU', label: 'Русский',           dir: 'ltr' },
  { tag: 'ko-KR', label: '한국어',              dir: 'ltr' },
  { tag: 'sv-SE', label: 'Svenska',           dir: 'ltr' },
  { tag: 'tr-TR', label: 'Türkçe',            dir: 'ltr' },
  { tag: 'vi-VN', label: 'Tiếng Việt',        dir: 'ltr' },
  { tag: 'ar',    label: 'العربية',            dir: 'rtl' },
  { tag: 'id-ID', label: 'Bahasa Indonesia',  dir: 'ltr' },
  { tag: 'ms-MY', label: 'Bahasa Melayu',     dir: 'ltr' },
  { tag: 'th-TH', label: 'ไทย',                dir: 'ltr' },
];

export const DEFAULT_LOCALE = 'en-GB';

const BY_TAG = new Map(LOCALES.map((l) => [l.tag.toLowerCase(), l]));

/** Is this a tag the interface can actually render? */
export function isSupportedLocale(tag: unknown): tag is string {
  return typeof tag === 'string' && BY_TAG.has(tag.toLowerCase());
}

/** The canonical spelling of a tag, or null. Accepts any casing. */
export function canonicalLocale(tag: unknown): string | null {
  if (typeof tag !== 'string') return null;
  return BY_TAG.get(tag.toLowerCase())?.tag ?? null;
}

export function localeDir(tag: string): 'ltr' | 'rtl' {
  return BY_TAG.get(String(tag).toLowerCase())?.dir ?? 'ltr';
}
