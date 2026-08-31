# Familista — repository rules

Rules that apply to every change made in this repository, by anybody, with or
without an assistant. They are here because each one has already been learned
the expensive way.

---

## Localization is part of the feature, not a follow-up

> **Any feature containing user-facing text is incomplete until all text uses the
> Familista i18n system and all supported locale files are synchronized. Never
> wait for a separate localization request.**

A feature that renders English into a Spanish session is a broken feature, in
the same sense as one that renders the wrong number. It does not become finished
when somebody later asks for translations; it was never finished. Treat
"the strings are not translated yet" exactly as you would treat "the endpoint is
not written yet".

### How Familista translates, in one paragraph each

There are two mechanisms, and both were here before you. **Do not add a third.**

**The catalogue** — `public/i18n/catalogue/<tag>.json` — is the one that carries
most of the interface. It is keyed by the English the screen already says, so
`"Match Centre"` is itself the key, and `public/i18n/dom.js` swaps the text as
the DOM is drawn. Nothing at the call site changes: you write English into the
markup and the string is translated because it is in the catalogue. A digit run
is replaced by a slot, so `"%d players"` is one entry that answers every count,
and `…|plural` holds one form per plural category the language actually uses.

**The bundle** — `public/i18n/locales/<tag>.json` — is the key-based one, read
through `t('navigation.squad')` or `data-i18n="navigation.squad"`, and applied by
`public/i18n/apply.js`. Use it where the English cannot be the key: an
abbreviation whose translation collides with an ordinary word (`TEAM` → Brazilian
Portuguese `TIME`), an `aria-label` with no visible text, anything where two
different English strings must stay distinct. A cell owned by a bundle key must
carry `data-no-i18n` so the catalogue pass does not translate it a second time.

### What is never translated

Club names, player names, coach names, stadium names, competition names, and
anything a user typed. These are data, and translating them is a bug. Mark them
`data-user-content` in the markup so the catalogue pass leaves them alone. The
same goes for IDs, API routes, enum tokens, code identifiers and technical
strings — do not invent translations for them to make a number look better.

### The locale registry is the single source of truth

`src/i18n/locales.ts` declares which languages exist. `public/i18n/config.js`
mirrors it and a test pins the two together. Nothing else may hold a list of
languages, and no script, test or comment should state how many there are —
adding a locale to the registry must be enough for the tooling to start
demanding files for it. The base locale is `en-GB` and does not change.

### Before you call a feature done

```
npm run i18n:check      # every locale complete; nothing new left untranslated
npm run i18n:sync       # what is missing, per locale — writes nothing by default
npm test                # includes the same check, so CI cannot miss it
```

`i18n:check` fails on a missing bundle key, a key the source asks for that does
not exist, an incomplete catalogue, a malformed locale file, a registry that has
drifted from its mirror, or a growth in the number of untranslated strings. The
last of these is a ratchet against `scripts/i18n-baseline.json`: the backlog that
predates the rule is tolerated, adding to it is not.

`i18n:sync` fills only keys that are **absent**. It never overwrites an existing
translation — there is no flag that makes it. Without a translation provider it
reports the work rather than inventing it; with `--provider=passthrough` it fills
gaps with English and records every one in
`public/i18n/_pending-translation.json`, so a placeholder is never mistaken for a
translation. Real translation runs through `--provider=anthropic`, which uses the
`@anthropic-ai/sdk` dependency the repository already has and the
`ANTHROPIC_API_KEY` it already reads, and only when that key is set.

`scripts/i18n-walk.js` opens the running app in a browser and reports what is
still English on screen. That is the check that proves a language works; run it
when you have changed a lot of interface.

### Adding a language

Add the entry to `src/i18n/locales.ts` and the identical entry to
`public/i18n/config.js`, create `public/i18n/locales/<tag>.json` and
`public/i18n/catalogue/<tag>.json`, then `npm run i18n:sync` to see what is
missing and `npm run i18n:check` to confirm it is complete. Set `dir: 'rtl'` for
a right-to-left language and check the dynamically opened panels — modals,
drawers and dropdowns are where RTL breaks, not the page behind them.

### Runtime behaviour you can rely on

A missing key never renders as `undefined`, as a raw key path, or as a blank
button: `public/i18n/i18n.js` falls through the active locale, then `en-GB`, then
a humanised form of the key's last segment. In development the miss is logged
once per key and listed by `I18N.missingKeys()`; in production it is silent. The
fallback exists so a gap is not a visible break — it is not a reason to leave the
gap.
