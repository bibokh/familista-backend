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
npm ci --ignore-scripts --prefix tools/components
CHROMIUM=$(command -v google-chrome) node tools/components/lab-browser-proof.cjs <output-dir> [--axe]
```

It is a required CI job (`browser-proof` in `.github/workflows/ci.yml`, in two shards: sections `1,2,2b,3,4,5,8,9`, and
`6,7` with `--axe`). Its two tools, `playwright-core` and `axe-core`, are pinned exactly in this folder's own
`package.json` and lockfile and are installed with `npm ci --ignore-scripts`; they are not production dependencies and
the root `package.json` does not list them. No browser is downloaded: it uses Google Chrome from the runner image and
the job fails if there is none. A failed, skipped or missing proof fails the job, a failed job fails the `ci` workflow,
and `deploy.yml` deploys only after a successful `ci`. The job names must also be marked as required checks in the
repository's branch protection, which is a setting and not part of the code.
Every proof is paired with a control that removes the thing being proved: the focus controls serve a `lab.js`
with `restoreFocus` disabled, or with its 2.5 s limit removed, and require the same measurement to fail.

Console errors and CSP violations are never filtered away. A violation is the Lab's if it was raised on an element
inside `.lab`, by a Lab script (its `sourceFile`: Chromium reports against the document, not the element, once the
element has been removed, and the Lab redraws by removing nodes), or names a Lab file. The application's own
pre-existing inline-style violations (`style-src-attr`, raised by `/app.js` or by the page's own HTML) are counted and
reported apart, because their number depends on how much of the application has painted. Anything that can be placed
nowhere is "unexplained". The Lab's count and the unexplained count must both be zero, in every view. The one
exception is named: axe-core's own fetch of the web-font stylesheet, refused by `connect-src`, is counted as `axeProbe`
when it happens inside an axe run. Probes that find the room mid-redraw wait for it and retry at most twice; the retries
are reported with the result.
`PROOF_ONLY=7` runs the focus, error and CSP proofs alone (they need no axe).
