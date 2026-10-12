# Components Registry

`registry.json` is the reviewed list behind Design System Control → Components.
A person writes the name, category, kind, module, one-line summary and the claims
(CSS classes, render function, variants, Storybook story). Nothing else is typed in.

`scripts/design-system-components.js` checks every claim against the repository and
**throws** if one cannot be found. It never downgrades a claim silently and never adds
a component the registry does not list. The result is
`src/design-system/generated/design-system-components.json`, written by
`node scripts/design-system-discover.js` beside the other two manifests.

```
node scripts/design-system-discover.js          # regenerate all three manifests
node scripts/design-system-discover.js --check  # exit 1 if any is stale (the build runs this)
```

## Adding a component

Add an entry; run the generator; read the error. A class with no rule, a function that
does not exist, a variant no golden case contains, a story that does not name it — each is
refused with the component's id. Pick the honest `kind`:

| kind | use for |
| --- | --- |
| `component`, `primitive`, `pattern` | something with a render function or a documented class contract |
| `css-family`, `layout-utility` | a set of classes with no render function |
| `page-specific` | styles that belong to one page and are not reusable |
| `candidate` | looks reusable, has not been reviewed; always `listed`, category `candidates` |

Tiers are never typed. `verified` = render source + CSS rules + a Storybook case;
`catalogued` = source or CSS found, no Storybook case; `listed` = only the presence of the
declared class or prefix. Do not register a page prefix (`trn-`, `tf-`, `sqcc-`) as a component.

## What is deliberately not recorded

Line numbers and usage counts (they go stale on unrelated edits), source text (only hashes),
and any accessibility conformance claim (only facts found in the source).

## Staleness

A record hashes only its own slice: the render function (whitespace-squashed) and the CSS
rules that mention its classes. Editing one of those requires regenerating the manifest;
editing anything else does not.

## The Specimen Lab (Stage 3.2.3 M1)

`scripts/design-system-previews.js` turns the ten verified primitives' Storybook golden
fixtures into `src/design-system/generated/design-system-previews.json`. It reads the golden
snapshot as text and executes nothing; `tests/design-system-lab.unit.test.ts` re-runs the Storybook
golden test so CI refuses a snapshot that has drifted from `public/app.js`.

One sanitizer — `public/design-system/lab-sanitize.js` — is used by the generator, by the server's
validator (`src/design-system/previews-core.js`) and by the browser. It is a closed allowlist that
fails closed, and it neutralises (and reports) `data-action`, `data-i18n-aria`, `aria-modal` and
button tab stops.

The boundaries the Lab claims — events stop at the stage, a fixed overlay stays in it, the application's
translator leaves it alone — are proved in a real browser, not assumed:

```
npm run build
PLAYWRIGHT_CORE=/path/to/playwright-core node tools/components/lab-browser-proof.cjs <output-dir> [--axe]
```

It needs a Playwright driver and a Chromium on the machine, adds no dependency and is not part of CI.
Every proof is paired with a control that removes the thing being proved.
