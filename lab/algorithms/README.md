# The algorithm lab — Propose → Simulate → Test

This directory is where a **candidate** — a proposed new version of an approved
algorithm — is written, simulated and tested against the approved version. It
is Algorithms Step 4 of the Continuous Intelligence Loop:

```
Observe → Learn → Propose → Simulate → Test → Human approval → Deploy → Measure
                  └──────── this directory ────────┘
```

Nothing here is production code, and nothing here can reach production:

- **Outside the build.** `tsconfig.json` compiles `src/` only. No file under
  `src/` imports anything from `lab/`. The production server never runs a
  candidate; it reads the evidence file the lab writes
  (`src/algorithms/generated/candidate-evidence.json`), validates it against
  its schema (`src/algorithms/candidate-evidence.ts`) and shows it in the
  Algorithms room, under **Proposals**.
- **In a separate process.** Every job runs in a child process
  (`runner.ts`). The parent holds the clock: past the time limit it sends
  `SIGKILL` to the child's whole process group, so even a synchronous infinite
  loop is stopped. The child's heap is capped, its stdout is counted and cut
  off, and it starts with an empty environment, so no secret of the parent's
  can reach candidate code. After every child the parent confirms that no live
  process remains in its group.
- **Never approved here.** Every candidate is `EXPERIMENTAL` and
  `NOT_APPROVED` by type. Approval exists only in the registry
  (`src/algorithms/registry.ts`) as a reviewed record of an exact version and
  fingerprint. Promoting a candidate is Step 5 (below): a reviewed pull
  request that records the platform owner's approval, never anything the lab
  does on its own.
- **Synthetic only.** No club data, no health data, no production telemetry.

The Cybersecurity control `algorithm-candidate-isolation` fails the build if
any of the above stops holding.

## What the lab measures, and what it cannot

Synthetic outcomes have to be drawn from some model. Drawn from the approved
version, the approved version wins by construction; drawn from the candidate,
the candidate wins. So the lab **decides** only on what synthetic inputs can
establish, and **reports** score differences as a bracket — never a winner:

| Decides the Test verdict | Reported, decides nothing |
|---|---|
| Properties the approved version keeps, re-checked on the candidate (`spec.ts`, `PROPERTIES`) | Paired Brier and log-loss differences in the world built from each version, with 95% intervals |
| The properties the candidate declared it would fix | How many shots change, by how much, and where |
| No new invalid outputs | A **conditional** sample-size estimate — see below |
| The comparison method passing its own checks | What the run cost: time, CPU, memory, per-call speed |

The sample-size estimate answers one conditional question: *if real shots
looked like this synthetic mix and real outcomes followed one of the two
versions, how many shots would a paired Brier test need to tell them apart?*
It is not a real-world requirement. It is `UNDEFINED` when the versions never
differ, and `UNSTABLE` when too few shots differ or a resample shows no
difference at all.

The verdict reads **held-out** seeds and a held-out shot mix only. They are
disjoint from the development seeds a proposer works with, but they can be
read in an open repository: the split guards against tuning to sample noise,
and it is not a blind test.

## Adding a candidate — the same reviewed process every time

1. **Write the candidate** as `lab/algorithms/candidates/<algorithm>-v<version>.ts`.
   Copy the approved algorithm's fingerprinted declarations (the symbols listed
   for it in `src/algorithms/registry.ts`) verbatim, keep their names, and
   change only what your hypothesis needs. Keeping the names is what makes the
   candidate's fingerprint the one production would carry if it were promoted.
2. **Declare it** in the same file as `export const CANDIDATE`:
   - `version` — new, never used in the registry;
   - `baseline` — the registry's current approved version and fingerprint;
   - `rationale` — why, in plain words;
   - `hypothesis.targets` — the property ids (`spec.ts`) it claims to fix,
     written **before** you run it, and `hypothesis.region` — where it should
     change outputs;
   - `evidence` — what the rationale rests on;
   - `proposedBy` — a role (`PLATFORM_OWNER` or `AI_ASSISTANT`), never a name.
3. **Keep it pure.** A candidate file may have `import type` lines only, and no
   `require`, `process`, globals, timers, I/O, randomness or clock. The
   isolation control checks this.
4. **Add it to the allow-list** in `candidates/index.ts`. A child process loads
   only what this list names, by id.
5. **Run the lab:** `npm run algorithms:candidates`. It runs the method checks,
   then each candidate in its own process, and rewrites the evidence file.
   Read the result. **Do not tune the candidate, the probes or the rules to
   turn a result into a pass** — change the hypothesis, if you must, in a
   separate, explained commit.
6. **Translate** every new sentence the room will show — the rationale, the
   hypothesis region, each evidence note — into `public/algorithms/i18n/` (all
   three files), then run `npm test`.
7. **Open a pull request.** CI recomputes the evidence and fails if the
   committed file is stale (`npm run algorithms:candidates:check` does the same
   locally), runs the isolation control, and the code owner reviews the change.
   Merging it adds an experimental candidate and its evidence — nothing else.

A candidate may only be proposed for an algorithm in `CANDIDATE_ALGORITHMS`
(`spec.ts`): one with a synthetic generator and a declared property set, never
one that reads health data. Adding an algorithm there means declaring its
properties first, in their own reviewed change.

## Releasing a candidate — Step 5, only with the owner's approval

```
… Test → Human approval → Deploy → Measure
         └── release/ ──┘
```

The release tool turns a candidate the platform owner has decided to approve
into the change a pull request carries. It approves nothing, commits nothing,
merges nothing and deploys nothing: the approval takes effect when the owner
merges the reviewed pull request, and reaches production only through the
CI-gated deploy workflow.

```
npm run algorithms:release -- plan <candidate>                        # writes nothing
npm run algorithms:release -- apply <candidate> --reference <owner>/<repo>#<pr>
npm run algorithms:release -- verify [--deep]                         # gates, bindings, reproduction
npm run algorithms:release -- rollback <candidate>                    # apply's exact inverse
npm run algorithms:release -- rehearse <candidate>                    # all of it, in a temporary copy
npm run algorithms:release -- engine                                  # the engine pin, as of now
```

**`plan`** refuses, with a reason, unless the candidate is judged against
today's approval; its code changes something; the promotion can be made as
text — only the changed declarations replaced, the result carrying exactly the
candidate's fingerprint, every other algorithm in the file keeping its own; a
fresh run in child processes passes the method checks and the held-out Test
**and agrees with the committed evidence the owner saw in Proposals**; and
every registered algorithm whose code reaches the changed code is a declared
dependant that could be run and broke nothing.

**Dependants** are classified from the code, not assumed (`release/
dependants.ts`). `CODE`: its own code calls the changed code, so the promoted
version changes its output — it must be simulated, on the same held-out probes
and shots (`release/spec.ts`). `DATA`: it only reads values something else
stored (xA copies a shot's stored xG; the match rating sums stored values) —
promoting changes none of its inputs today, nothing is run, and the dossier
says so. The classification reads names, so it can only mistake DATA for CODE,
never the reverse.

**`apply`** writes the dossier (`src/algorithms/approvals/<id>.json`, see its
README), the changed declarations into the approved file, the registry entry —
new version, a `change({...})` approval bound to the dossier's digest, one line
of history — removes the candidate from the allow-list, keeps what a rollback
and a reproduction need in `archive/`, and regenerates the algorithm manifest,
the candidate evidence and the Cybersecurity manifest. It needs the pull
request's reference, and refuses if anything moved since the plan.

**The engine is pinned.** A dossier records the lab spec version, a
fingerprint of every engine module (`release/engine.ts`: the import closure of
the jobs, the evidence assembly, the verdict and the release tool, minus the
code under test, the candidates, the archive and the registry) and a commit
that holds it. While that fingerprint is unchanged, `verify` re-runs the
evidence and requires it to agree with the dossier; after the engine has
changed it reports `PINNED` and runs nothing — reproduce it at the pinned
commit.

**Rolling back.** Before a promotion merges, `rollback` undoes it exactly.
After it has merged and deployed, a rollback is a pull request like any other —
its diff produced by `rollback` or by `git revert` of the promotion — reviewed,
CI-gated and deployed. The dossier leaves the tree with the approval it bound;
both stay in the repository's history. `rehearse` proves the whole path —
plan, apply, verify, rollback, byte-for-byte comparison, verify — in a copy,
with a pull-request reference that cannot exist, and checks the repository
itself was not touched. CI runs it on every pull request.

**What it cannot show.** Every figure is synthetic: how a change behaves on
invented shots and which properties it keeps, never real-world accuracy. An
algorithm with no production caller is not measured after release either; the
room says `NOT_OBSERVABLE`, and that is never read as proof the code is unused.
Whether a deploy is live is Render's to say: check the Render dashboard for
the deploy of the merge commit.

## Files

| File | What it is |
|---|---|
| `spec.ts` | Every seed, mix, property, rule, justification and limit, declared before anything runs |
| `candidates/` | The allow-list and the candidates |
| `engine/` | Shot mixes, statistics, property probes, the comparison, the method checks, the verdict, the static code diff |
| `runner.ts` | Child processes: time, memory and output limits, an empty environment, process-group cleanup |
| `jobs.ts`, `child.ts` | What a child process does |
| `evidence.ts`, `cli.ts` | Assembling, writing and checking the evidence |
| `release/`, `release-cli.ts` | Step 5: plan, apply, verify, rollback and rehearse a promotion; the engine pin; dependants |
| `archive/` | Written by `apply` only: the version a promotion replaced and the candidate it promoted, for rollback and reproduction |
