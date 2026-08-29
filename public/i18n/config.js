// Familista — i18n configuration
// ─────────────────────────────────────────────────────────────────────────────
// The client half of the locale registry. It mirrors src/i18n/locales.ts, and a
// test asserts the two lists are identical: a language offered here but refused
// by the API would let a user pick something that silently never saves.
//
// Loaded as a plain script before app.js, so there is no build step and no
// module system to introduce. FAMILISTA_I18N_CONFIG is the only global it adds.

(function (root) {
  var LOCALES = [
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

  root.FAMILISTA_I18N_CONFIG = {
    LOCALES: LOCALES,
    DEFAULT_LOCALE: 'en-GB',
    // Where the bundles live. One file per locale, fetched on demand.
    BUNDLE_PATH: '/i18n/locales/',
    // And where the catalogues live — the English-keyed translation of the
    // whole interface, which is what makes a screen nobody migrated translate.
    // Also fetched on demand, and never for English.
    CATALOGUE_PATH: '/i18n/catalogue/',
    // The browser cache of the user's choice. A cache, not the truth: the
    // server row wins whenever it can be read.
    STORAGE_KEY: 'familista.locale',
  };
})(typeof window !== 'undefined' ? window : globalThis);
