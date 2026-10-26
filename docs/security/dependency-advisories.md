# Dependency advisories

How a HIGH or CRITICAL dependency advisory is handled: fixed, or, when no
compatible fix exists, excepted for a short, dated period behind measured
compensating controls, with a plan that removes the exception.

The audit gate (`scripts/npm-audit-gate.js`) runs `npm audit --audit-level=high`
in CI and fails on every HIGH or CRITICAL advisory except one recorded in
[`npm-audit-exceptions.json`](npm-audit-exceptions.json) that still matches in
full: advisory id, package, severity, vulnerable range and installed version.
An exception lasts at most 31 days from its approval. The gate fails closed: a
missing, malformed or inconsistent audit report, an exception that no longer
matches, an expired exception, and an exception that matches nothing all fail
the build.

## 2026-10-25: two advisories found on `main`

Both were published after the last green `main` run, against dependencies
`main` already had. The Platform Owner decided on 2026-10-25.

| Advisory | Package | Installed | Decision |
|---|---|---|---|
| [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), HIGH: denial of service via trailing bytes after a compressed request body | `body-parser`, via `express@4.22.1` (`~1.20.3`) | 1.20.6 | **Fixed:** 1.20.9, lockfile only. `overrides.qs: ^6.16.0` already satisfies its `qs ~6.16.0` range, so no other package moved. |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (CVE-2023-54404, CWE-770), HIGH: memory exhaustion validating oversized collections | `zod` (direct) | 3.25.76 | Excepted until 2026-11-01T00:00:00Z behind the controls below, then **fixed:** zod 4.6.7 and the exception removed (see *2026-10-26: the zod 4 migration*). |

## Zod exposure assessment (GHSA-mrhx-c7xc-m3w5)

**The defect, on the installed zod.**
- An array schema keeps one issue for every failing element, with no cap and no early stop.
- A declared `.max()` does not prevent it. zod 3 checks the length, records that issue, and then still parses every element.
- `z.array(z.string()).max(10)` given a 2 MB JSON array of a million numbers returned 1,000,001 issues and allocated **≈ 290 MB** in 0.9 s, in one validation.
- A record behaves the same way, key by key.

**What reaches a zod schema from outside, and how large it can be.**

| Input | Reaches zod? | Bound before validation |
|---|---|---|
| JSON body (`express.json`, 2 MB) | yes: `src/controllers/*`, `src/utils/*.validators.ts` | **None on collections before this change.** A 2 MB body is a million-element array. |
| Form body (`express.urlencoded`) | yes | 100 kB, and over 1,000 parameters is refused by the parser (measured) |
| Query string (`qs`) | yes | 1,000 parameters (measured), inside Node's 16 KB header limit (431 past it) |
| Signed raw bodies (billing webhook 1 MB, vision webhooks 10 MB, transcode callback) | only after HMAC verification | unreachable without the worker or Stripe secret |
| WebSocket messages (`/ws/match`, `/ws/market`) | no: `JSON.parse`, then `ping` only | — |
| Admin asset upload (multipart) | metadata fields only, admin capability required | multer, one file |
| `src/contracts/*`, `src/algorithms/*` schemas | no request input: contracts are test-side; algorithm schemas read committed files | — |

An AST inventory of the request-side schemas found 328 array or record
schemas with no length bound, among them:
- `training.controller.ts`: `playerIds`, `drills`, `marks` and `performance`, reachable by a signed-in coach;
- record-valued `metadata`, `terms` and `payload` fields across the executive, franchise, investor, AI engine, vision and white-label validators.

The largest declared bound behind the JSON parser is 1,000 (provisioning
serials). The vision inference webhook declares up to 50,000 events, but it is a
signed raw-body path. **Conclusion: meaningful exposure exists, through
the JSON body, to any authenticated user, and on a few routes before auth.**

## Compensating controls

1. **The body shape guard** (`src/middleware/body-shape-guard.ts`):
   - **Where it runs:** in `src/app.ts`, after the body parsers and before every route, limiter and auth check.
   - **What it does:** walks each parsed body iteratively and refuses it with **413** past any of these limits: 5,000 items in one list, 1,000 keys in one object, depth 32, or 50,000 values in all.
   - **What it leaves alone:** signed raw bodies (Buffers) go to their own verifier.
   - **Why these limits:** each is several times the largest legitimate body the platform documents:
     - a device batch of 500 packets of about fifteen values each (`docs/fusion-protocol.md`);
     - 1,000 provisioning serials;
     - a 500-user notification.
2. **What it bounds** (measured, zod 3.25.76):

   | Body | Issues | Heap | Time |
   |---|---|---|---|
   | Unguarded 2 MB array | 1,000,001 | 290 MB | 895 ms |
   | Worst accepted: 9 lists of 5,000 failing items | 45,000 | 23 MB | 44 ms |
   | Worst accepted: 4,999 objects × 9 failing fields | 44,991 | 17 MB | 46 ms |
   | Reference: `JSON.parse` of the same 2 MB body, which happens before any guard | — | 10 MB | 26 ms |

   Zod's cost on an accepted body is now about twice the parse cost, instead
   of about twenty-nine times. The guard itself costs 56 ms on the widest
   object a 2 MB body can hold, against 137 ms for its `JSON.parse`.
3. **The bounds already in place, verified rather than assumed:** form bodies (1,000 parameters), query strings (1,000 parameters) and HMAC verification before parsing on every raw-body path.

Tests: `tests/body-shape-guard.unit.test.ts` covers:
- the advisory reproduced;
- each limit, at the limit and one past;
- no recursion;
- the legitimate bodies;
- the bound on issues;
- in the real application: 413 before auth, a signed Buffer left alone, and the mount order.

Its negative control: without the guard, the oversized body reaches auth (401) and then zod.

## Remaining risk while the exception stood

- An accepted body can still cost about 23 MB and 44 ms of validation. Rate limits and the 2 MB parse cost bound concurrency as they did before.
- A holder of a worker secret can send the vision webhook up to 10 MB, and its schema declares up to 50,000 events: trusted, not guarded.
- WebSocket servers keep the `ws` default `maxPayload` (100 MiB). It is not a zod path, but it is a separate memory exposure worth bounding.
- The application's error handler answers body-parser's own 413 (`parameters.too.many`, `entity.too.large`) as 500. The request is still refused; only the status is wrong.

## Zod 4 migration plan (removes the exception)

*The plan as approved on 2026-10-25. What was done, and where it departs from the plan, is in the next section.*

Target: `zod@^4.6.6`, imported as `zod` (the v4 API). The legacy `zod/v3`
entry point is not a remediation and is forbidden by a check added in stage 1.

Scale on `main`:
- 76 source files import zod;
- 68 `z.record(` calls (the one-argument form is gone in v4);
- 169 `ZodError` references and 40 reads of `.errors` (renamed `.issues`);
- 2 `AnyZodObject` (removed);
- 4 `z.nativeEnum`;
- 9 `z.string().email()`;
- the error handler returns zod messages to clients, and v4 words them differently.

| Stage | Change | Gate |
|---|---|---|
| 0. Pin behaviour (zod 3) | A golden corpus per request schema: valid and invalid inputs, and the resulting success, issue paths and codes. Contract tests for the 400 response shape (`errors[].field`, `message`). | the corpus is green on zod 3 |
| 1. Bound and pre-adapt (zod 3) | Explicit `.max()` on every untrusted collection, from the inventory and measured legitimate sizes. Mechanical changes valid in both versions: `.issues` for `.errors`, two-argument `z.record(z.string(), …)`, `ZodTypeAny` for `AnyZodObject`. A check that forbids `zod/v3` imports. | corpus unchanged; full Jest; contract check |
| 2. Upgrade | `zod@^4.6.6`. Fix the type errors. An error map that keeps the API's messages, so clients see no change. `.default()`, `.int()` and number-infinity semantics reviewed schema by schema. | corpus identical, or every difference reviewed; `tsc`; full Jest; PostgreSQL suites; both browser-proof shards; the advisory reproduction now bounded |
| 3. Close | Remove the exception, and keep the body shape guard as defence in depth. The gate fails if the exception stays. | `npm audit` clean at HIGH |

Each stage is its own pull request, under the Platform Owner's approval. The
exception expires on 2026-11-01. If the upgrade is not merged by then, CI
fails until the owner extends the exception (at most 31 days, recorded) or the
upgrade lands.

## 2026-10-26: the zod 4 migration

Two pull requests, under the Platform Owner's decision of 2026-10-26: phase 1 on zod 3, phase 2 the upgrade.

**Phase 1, on zod 3, behaviour unchanged.**
- A behaviour baseline (`tests/zod-baseline/`), recorded on zod 3.25.76 before any edit: 481 schemas, every module that imports zod outside `src/contracts`, `src/algorithms` and the evidence reader, 15,314 inputs. For each it records the success and the parsed data, or the issue paths and messages a client is told. `tests/zod-request-baseline.unit.test.ts` replays it.
- The 400 response bodies, pinned exactly: `tests/zod-error-responses.unit.test.ts`, covering the error handler, a controller's own `zerr()`, and zod's default messages for each kind of failure.
- Changes that mean the same in both versions:
  - two-argument `z.record(z.string(), …)`;
  - `.issues` for `.errors`;
  - `ZodType` for `AnyZodObject`;
  - `.optional()` on object fields of `z.any()` / `z.unknown()`, which zod 4 otherwise requires.
- The baseline replays with 0 differences on zod 3. A check forbids the `zod/v3` (and any other version subpath) entry point.

**Phase 2, the upgrade.**
- `zod@^4.6.7`. It is the only zod in the dependency tree, and `npm audit` reports 0 vulnerabilities at every level.
- `src/config/zod.ts` is loaded first by `src/server.ts`, `src/app.ts` and the Jest setup. It holds:
  - an error map that returns zod 3's wording for every kind of issue, so clients are told what they were told before;
  - `partialUpdate()`, which is zod 3's `.partial()`. zod 4's `.partial()` still fills a missing field's `.default()`, so a PATCH would have written the defaults over stored values (found by the baseline in 6 update schemas, 27 inputs). Every `.partial()` now goes through it;
  - `nativeEnum()`, which keeps zod 3's message for a number given to a native enum.
- `.uuid()` became `.guid()` everywhere, which keeps what is accepted. zod 4's `.uuid()` checks the RFC version and variant nibbles, where zod 3 accepted any 8-4-4-4-12 hex id; `.guid()` is zod 3's pattern. Ids Prisma generates are RFC v4 and pass either way. A fixed id such as `00000000-0000-0000-0000-000000000001`, used throughout the test fixtures, or any id written outside Prisma would otherwise be refused.
- The advisory, measured on zod 4.6.7: `z.array(z.string()).max(10)` given the 2 MB array of a million numbers returns **1 issue** (zod 3: 1,000,001, ≈ 290 MB) and parses no element.
- The worst body the guard accepts (9 unbounded lists of 5,000 failing items, 45,000 issues), the same harness on both versions, 7 runs, warm:

  | Version | Time | Heap |
  |---|---|---|
  | zod 3.25.76 | 58–72 ms | ≈ 20 MB |
  | zod 4.6.7, with the message map | 59–84 ms | ≈ 22 MB |

- The exception was removed from `npm-audit-exceptions.json` (now `"exceptions": []`). The gate keeps the mechanism and its tests, now on a fixture of the removed exception.
- The body shape guard stays, as defence in depth.

**What zod 4 answers differently, accepted and pinned.** 530 of the 15,314 replayed inputs answer differently. Each one is classified, and the count of each kind is pinned in the baseline test. A difference of any other kind fails it: a value accepted that was refused, other parsed data, another message, another path.

| Kind | Count | What changed |
|---|---|---|
| Unsafe integer refused | 166 | `.int()` takes safe integers only. 1e21 and 2^53, accepted by zod 3, are refused as past ±(2^53 − 1). No integer column holds them, and JavaScript cannot tell them from their neighbours. A tightening. |
| Unsafe integer, also out of range | 295 | The same values on fields with a range: refused before, now told the safe-integer bound first. |
| Length checked after a type failure | 48 | An array given for a string, or a string for an array, is also told the length bound. |
| Stops earlier on a refused input | 20 | zod 4 stops at a fraction given to `.int()`, and skips an object's refinement once one of its fields has failed. The input is refused as before, with the same first issues and without the later ones. |
| Same issues, reordered | 1 | An array's own length issue and its elements' issues, the other way round. |

No valid input parses differently, and no input zod 3 refused is accepted.

The safe-integer tightening cannot refuse a legitimate value:
- **The fields it touches carry small values.** There are 48 of them: timestamps in milliseconds or microseconds, money in cents, sizes in bytes, counts and frame numbers. A microsecond epoch timestamp is about 1.8 × 10^15, below 2^53 (about 9.0 × 10^15) until the year 2255.
- **No client could send such a value exactly.** `JSON.parse` already turns any integer above 2^53 into the nearest double before validation runs.

**Departures from the plan.**
- Stage 1's explicit `.max()` on every untrusted collection was not done. It changes what requests are accepted, which phase 1 was not to do. The body shape guard bounds every collection at 5,000 items, and zod 4 now stops at a declared `.max()`. Per-field bounds remain a separate hardening, for the Platform Owner to decide.
- `.default()` semantics were reviewed through the baseline rather than schema by schema. The one difference it found is the `.partial()` one above.

