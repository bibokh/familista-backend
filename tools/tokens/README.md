# Familista Design Core — tokens (Stage 2a, published in 2b.1)

The canonical source of Familista's design values, and the first layer of the
future **Familista Design Core**. Tokens are the source of truth; everything
that renders them — the CSS generator, Storybook, later the Owner Design System
Control and the Club Product Design Studio — is a consumer.

Stage 2b.1 publishes the generated CSS as `public/tokens/familista-tokens.css` and
links it **once, from the main app only** (`public/index.html`), ahead of every
other first-party stylesheet. Nothing in production reads a `--fam-*` property
yet, so the link changes no computed style and no pixel; every live value is
preserved exactly. The admin page, the invitation page and the React SPA do not
link it. Aliasing legacy variables (Stage 2c onwards) is a separate, approved
step.

## Files

| File | What it is |
|---|---|
| `familista.tokens.json` | The source of truth, in the W3C Design Tokens Community Group (DTCG) format. |
| `targets/web.json` | The web binding: CSS prefix and the selector each context, module, theme, language, direction and preference applies on. Platform-specific; the token file stays platform-free. |
| `dist/familista-tokens.css` | Generated. Declares only `--fam-*` custom properties. Do not edit. |
| `../../public/tokens/familista-tokens.css` | The same bytes, published for production. Written by `build.mjs`; `verify.mjs` fails if it differs from `dist/`. The legacy inventory excludes it (it is the canonical source rendered, not a legacy stylesheet). |
| `legacy-map.json` | Every custom property production declares today (720), its exact live value, and the token it maps to. |
| `contrast-baseline.json` | WCAG ratios of every token pair, and the failures recorded at Stage 2a. |
| `lib/` | Dependency-free ES modules: `dtcg.mjs` (validate, resolve, format), `build-css.mjs` (generator), `css-inventory.mjs` (CSS scanner), `color.mjs` (colour science), `checks.mjs` (ratchet logic), `production.mjs` (reads `public/`, Node only). Everything except `production.mjs` also runs in a browser. |
| `scripts/` | `build.mjs`, `inventory.mjs`, `verify.mjs` — the command-line entry points. |

## Layers

```
ref        raw values, named by family and step      --fam-ref-navy-950
semantic   meaning; defaults are the live Club values --fam-surface-canvas
context    owner re-declares the semantic layer        [data-fam-context="owner"], #pg-system, …
module     identity accent per module                 [data-fam-module="vision"], #pg-familista-vision, …
theme      light, high-contrast — reserved, empty      [data-theme="light"]
lang       ar: every tracking step is 0                :lang(ar)
dir        rtl: direction multiplier is -1             [dir="rtl"]
media      reduced motion: every duration is 0ms       @media (prefers-reduced-motion: reduce)
```

Reference tokens hold raw values only; semantic colours must reference the
palette. An override layer names the base subtree it re-declares in
`$extensions["com.familista"].overrides`. Because a CSS custom property
inherits its *computed* value, the generator re-declares every alias of an
overridden token in the same block (the Owner block re-declares
`--fam-module-accent` and `--fam-team-us`), so the cascade matches the model.
The default Club context re-asserts its values under `[data-fam-context="club"]`,
so a Club preview nested inside an Owner screen still reads Club values.

Familista additions to DTCG live under `$extensions["com.familista"]` only:
`unit` (em for letter-spacing, which DTCG dimensions cannot express), `angle`
(DTCG gradients carry none), `source` (the live production value a token came
from), `overrides` and `default`.

## Commands

```
node tools/tokens/scripts/build.mjs            # regenerate dist/ and public/tokens/ (byte-identical)
node tools/tokens/scripts/build.mjs --check    # fail if it is stale
node tools/tokens/scripts/inventory.mjs        # summary of production custom properties
node tools/tokens/scripts/inventory.mjs --check
node tools/tokens/scripts/inventory.mjs --write  # refresh the legacy map's live columns
node tools/tokens/scripts/verify.mjs           # every guarantee below
```

`npm test` runs `tests/design-tokens.unit.test.ts`, which runs `verify.mjs`, so
CI enforces all of it.

## Guarantees (`verify.mjs`)

- Valid DTCG; every reference resolves; no reference loops.
- Deterministic output; the committed `dist/` file is current.
- The generated CSS declares only `--fam-*` custom properties on bound selectors,
  so linking it cannot change anything a reader sees.
- **Stage 2b.1:** the published copy is byte-identical to `dist/`; the main app
  links it exactly once, first among first-party stylesheets, with the version
  string from `targets/web.json`; admin, invite and the React SPA do not; and no
  file production serves, other than the token file itself, references `--fam-`.
- **Inventory ratchet:** every custom property in every stylesheet production
  serves is in `legacy-map.json` with its exact live value, and every
  `equal` / `diverges` verdict is re-verified against the tokens. A stylesheet
  no page loads also fails.
- The names production references but never declares (18 in CSS, 6 in
  `app.js`, e.g. `--tx-1`, `--lg-line`) stay undefined. Defining one would
  visibly change production.
- No contrast failure beyond `contrast-baseline.json`.
- Arabic tracking is 0, Noto Sans Arabic is in the sans stack, direction
  mirrors under RTL, durations are 0ms under reduced motion, and the light and
  high-contrast layers exist.

## When the ratchet goes red

You added or changed a custom property in a production stylesheet. Run
`node tools/tokens/scripts/inventory.mjs --write`. New declarations appear as
`"status": "unmapped"`, changed ones as `"status": "review"`. Give each a
`category`, a `target` token (or `null`), a `context` and a status (`equal`,
`diverges`, `component-param`, `no-canonical-role`, `dead-redeclared`,
`dead-overridden`, `light-theme`, `separate-surface`). `verify.mjs` checks the
verdict against the tokens, so a wrong `equal` cannot pass.

## Storybook

`tools/storybook` loads `dist/familista-tokens.css` before the production
stylesheets — the order production now uses — and draws the Foundations stories
from this folder. Storybook never writes here, and nothing here imports
Storybook.
