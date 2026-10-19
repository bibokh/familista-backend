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

`scripts/design-system-previews.js` turns the verified components' Storybook golden
fixtures into `src/design-system/generated/design-system-previews.json`. It reads the golden
snapshot as text and executes nothing; `tests/design-system-lab.unit.test.ts` re-runs the Storybook
golden test so CI refuses a snapshot that has drifted from `public/app.js`.

Eighteen components are previewable, with 122 fixtures: the ten `_lg*` primitives (65 fixtures, pinned
byte for byte by digest), since M3 / S2.1b `_lgIcon` (12), `clubLogoHtml` (9) and `clubIdentityHtml` (8)
(the 94 together pinned by digest), since M3 / S2.2a the Owner Kit's `kv` (6) (the 100 together pinned by
digest), since M3 / S2.2b-1 the Owner Kit's `panel` (3, untitled) (the 103 together pinned by digest), and since
M3 / S2.2b-2 `chip` (8), `emptyState` (3), `skeleton` (3) and five more `panel` fixtures. The `app.js` ones are
each cut by name from `public/app.js` by `tools/storybook/lib/extract-lg.mjs` and run over the fixed inputs in
`tools/storybook/tests/cases.mjs`. A case section, a call or a golden key that names a function the components
manifest did not resolve in `public/app.js` fails the build. Three exclusions are deliberate, and the sanitizer
was not widened for any of them:

- the `lock` icon is not previewed: it draws a `<rect>`, which the sanitizer does not carry;
- `clubLogoHtml` is previewed with `title: false` only, as fourteen of its fifteen production call sites pass it;
  the default writes a `title` attribute the sanitizer does not allow;
- crests are the deterministic sample data URI; the sanitizer's crest rules (an image `data:` URI of at most
  2048 characters) are unchanged.

`clubIdentityHtml` is exported on `window` but has no production caller today; the registry records that.

Since M3 / S2.2a a render function may also come from the Owner Kit in `public/design-system/design-system.js`,
whose functions live at the top level of the one IIFE that is that file. They are cut from that level, with its
two-space indent removed, by the same cutter (`extractDs()` in `tools/storybook/lib/extract-lg.mjs`, and
`iifeScope()` in `scripts/design-system-components.js`, which a test holds to the same text); the IIFE is never run.
`ds-kv` is the first: the real `kv(label, value)` with the room's own `T` and `esc`, `T` at its initial state
(English, an empty dictionary), 6 fixtures. The registry's `js.file` must be exactly `public/app.js` or
`public/design-system/design-system.js`; any other path, a `..`, `.` or absolute path, a backslash, a symbol
registered twice, a name declared more than once anywhere in its file, or one found only nested deeper than the
IIFE's top level fails the build. Storybook loads `design-system.css` for these stories; every rule in it is
`.ds-*` or scoped to the room's root.

`ds-panel` (M3 / S2.2b-1) is the real `panel(title, body, note, extra)`, previewed **untitled only**, as six
production call sites write it (`panel('', body)`). A title draws `<h2 class="ds-panel-title">`, and the
sanitizer does not allow `class` on `h2`; a test runs the real titled call and shows the unchanged sanitizer
refusing it, so the head, title and note are not shown. The bodies production passes to an untitled panel
(`emptyState`, `skeleton`, `notGenerated`, the token tables) are themselves refused today (`role="status"`,
`aria-label` on a `div`, `<code>`, `<thead>`), so the fixtures' bodies are the room's own key-value list and
note: real `kv()` rows in the `.ds-kv-list` wrapper and the `.ds-note` line production writes. The sanitizer
was not changed.

M3 / S2.2b-2 widened the sanitizer by exactly four rules, each with the value rule it already had: `aria-hidden`
on `span` (`true` or `false`, for the chip's decorative dot), `class` on `h2` (token rules and provenance, for the
panel title), `role="status"` beside `role="dialog"` (the only tag that takes a role is `div`), and `aria-label` on
`div`, admitted **only** on a `div` that also carries `role="status"` (the skeleton's name), checked after every
attribute is read so the order does not matter. The parser's duplicate-attribute check was made prototype-free
(`Object.create(null)`), so `constructor` or `toString` is refused as an attribute the list does not allow rather
than as "written twice". The policy version stays 1: the manifest embeds the whole policy and the sanitizer's
hash, and either change makes it stale. With that, `ds-panel` gains production's own untitled bodies
(`panel('', emptyState(...))` and `panel('', skeleton(8, 'row'))`, lines 527 and 528) and its titled form, and
`ds-chip`, `ds-empty` and `ds-skeleton` are previewed. Chips are untitled only: `title` on `span` is still refused,
so titled chips and `evChip` are not shown. `ds-empty` and `ds-skeleton` carry `role="status"` live regions into
the specimen, as production writes them; how a screen reader voices a status region inserted into the stage is not
something this proof can hear (see the S2.2b-2 report).

`is-empty` is the one class accepted by a component-scoped reviewed entry (`SCOPED_INERT` in the generator):
`clubLogoHtml` writes it when a club has no crest, and no production rule styles `.club-logo.is-empty`. It is
accepted only on an element that also carries `club-logo`; the unrelated `.tfx-lane.is-empty` and
`.de-vid.is-empty` rules are never borrowed as its provenance, and a rule that could style it on a club logo
(`.is-empty`, `.club-logo.is-empty`) fails the build so the entry is reviewed again.

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

It is a required CI job (`browser-proof` in `.github/workflows/ci.yml`, in two shards: sections `1,2,2b,3,4,5,8,9,10,11,12,13`,
and `6,7,13a` with `--axe`). Its two tools, `playwright-core` and `axe-core`, are pinned exactly in this folder's own
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

### What each later section proves

| Section | Stage | Proves |
| --- | --- | --- |
| 8 | M2 / S1 | The same walls hold with the specimen zoomed (25 %–200 %), no tool is covered, and the browser's own Ctrl/Cmd zoom keys are left alone. |
| 9 | M2 / S2 | The walls hold at every content width (Fill, the presets, custom 320–1600 px), Fit is recomputed, and a width written as an inline style is refused by the unchanged policy. |
| 10 | M2 / S3 | Compare: Preview B draws exactly what A draws, each pane keeps its own walls and events, nothing is fetched, Swap is announced once, and B is removed node for node. |
| 11 | M2 / S4 | Navigation: the buttons and the `[ ]` `{ }` keys step through fixtures and listed components, Ctrl/Cmd/Alt stay the browser's, focus and the live region follow. |
| 12 | M3 / S1 | The room is left alone by club data, which it does not read (no redraw, request, lost click, scroll, focus or caret; no DOM, heap or listener growth), and every redraw that must happen still does: first entry, every later entry, Refresh, the room's language, its sections, a rebuilt page. |
| 13 | M3 / S2.0 | Every previewable component, found in the server's index (a different set enabled in the Lab fails): each fixture's served markup hashes to its recorded sha256 and is drawn with the recorded elements and classes in Single, Compare and RTL; cycling its fixtures leaves the Lab as large as it was; no event escapes, nothing in the specimen is tabbable, no CSP violation is the Lab's, and the Lab asks for nothing but that component's fixtures. Then application memory over three warm passes. |
| 13a | M3 / S2.0 | axe (WCAG 2.2 A/AA) on the stage, for every fixture of every previewable component, in English and in Arabic right to left. |

Section 12's controls serve `app.js` or `lab.js` with one part of the fix taken out (the room back among the club-data
pages, the entry hook removed, the hook without its check on the drawn root, the Lab's listener cleanup removed) and
require the matching proof to fail. A control whose edit cannot be applied is a FAIL that says so, never a pass.

Compare opening and Fit recalculation are measured 40 times after 3 warm-ups, from the input to the second frame, and
written to the log as `BUDGET` lines against the owner's 100 ms p95 budget. Wall-clock time is the machine's (a local run
measured two to three times CI's figures), so these are reported, not gated; what is gated is that they were measured as
specified.

### The performance budget report (M3 / S3.2)

The proof also prints one `METRIC {json}` line per measurement the budget report owes, from samples its loops have
already taken. `budget-report.cjs` reads them after the proof's own pass/fail step, in the same browser-proof job, and
writes a table to the GitHub Actions job summary. It keeps a closed list of metrics:

- **OFFICIAL**, the eight approved budgets, each from one named measurement and no other:
  - navigation median ≤ 50 ms and p95 ≤ 80 ms: section 11's component navigation;
  - Compare opening p95 ≤ 100 ms and Fit recalculation p95 ≤ 100 ms: section 12's budget block (40 samples after 3 warm-ups);
  - application-memory growth ≤ 32 KB, listener growth = 0, detached-node growth ≤ 0 and DOM growth ≤ 0: section 13.

  Each is PASS or OVER. Timing is report-only, so an OVER never fails the build. The memory, listener, detached-node and DOM
  checks in the proof still enforce those budgets, unchanged.
- **DIAGNOSTIC**, everything that explains a figure without being one:
  - section 10's Compare toggles, shown against a 100 ms reference as `INFO (above reference)` when over it;
  - fixture navigation;
  - the Lab's own work and the browser's time per sample;
  - frames per sample, counted in the frame interval measured on the page after its loops.

  A diagnostic is INFO and never carries an official status.

The report fails its step when an official measurement is missing or invalid, or when any line names an unknown or
duplicate id, the wrong unit, a non-finite number or a negative duration. A metric whose section did not run in the
shard is `NOT IN THIS SHARD`, never PASS. The p95 estimator is the proof's own (`sorted[floor(0.95 n)]`), shown with n and
the maximum.

### Coverage grows the proofs, not the other way round

Sections 2b, 6, 8, 13 and 13a read the previewable components from the server's index. A component added to the manifest
is checked by every one of them the day it is added; no proof names a count. The unit tests keep exact pins on the manifest
(how many components, how many fixtures) on purpose: a change in coverage has to be made, and seen, in a reviewed commit.

### Memory: what is measured, and what is not counted against the Lab

`JSHeapUsedSize` includes V8's compiled code. Measured in M3 / S2.0 over 24 passes of every fixture, about 95% of what it
gains is compiled code and the browser's own performance-timeline buffers (which fill to their caps and stop); JavaScript
objects, strings and DOM stay within a few kilobytes, listeners and detached nodes do not move. So section 13 takes a heap
snapshot after two forced collections, before and after three warm passes (one unmeasured pass first), and splits it:

| Category | Counted as | Gate |
| --- | --- | --- |
| JavaScript objects, arrays, closures, strings, numbers, regexps, DOM nodes | application | at most 32 KB growth |
| Listeners on window, document, `<html>`, `<body>` and under the Lab's root | application | no growth |
| Detached DOM nodes | application | no growth |
| Compiled code | V8 | reported only |
| Everything else (browser internals, timeline buffers) | browser | reported only |

The listener count does not walk the whole document: listing listeners there makes Chrome compile the application's own
inline `onerror` attributes, which the page's policy refuses, so the measurement would raise violations of its own.
The 32 KB budget is about ten times the largest growth measured over twelve warm passes (3.2 KB); a Lab that kept every
specimen it drew measured 66 KB and 222 detached nodes over the same three passes, and is one of section 13's controls.
