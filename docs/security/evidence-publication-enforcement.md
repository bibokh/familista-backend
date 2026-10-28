# Evidence publication: provenance and enforced owner approval

What must be true before the first genuine LAB execution may be published to
the AI Agents Operations Room, which parts the repository enforces today, and
the exact repository settings the rest needs. Nothing here changes a setting:
the settings are the Platform Owner's to make.

## 1. Provenance: what produced a dossier

A v2 dossier (`src/platform/agents/execution-evidence.ts`) proves two things:

- it is internally consistent;
- it is the dossier whose digest was approved.

Its hash chains are unkeyed, so they cannot prove where it came from.
Provenance closes that gap by reproduction:

| Part | Where | What it holds |
|---|---|---|
| Definition | `lab/orchestrator/definitions/<name>.json` (`familista.lab-definition/v1`) | The synthetic request and every operator step (decisions, cancellations, the kill switch), with the answer each step must get. Inputs only. |
| Provenance record | `src/platform/agents/published/<pub>.provenance.json` (`familista.evidence-provenance/v1`) | The definition's path and digest, the commit it ran at, the source digest, the steps replayed, and the dossier and record digests it describes. |
| Source digest | `lab/orchestrator/source.ts` | The exact bytes of every file the replay imports, transitively from `lab/orchestrator/replay.ts`, plus every package version it loads from `package-lock.json` (26 files and 2 packages today). |
| Replay | `lab/orchestrator/replay.ts` | The definition run from nothing through the AI-0.4 engine, in a store of its own. The record holds no clock and no random value, so the replay is exact or it is different. Nothing is normalised. |

**The server** (`execution-provenance.ts`) shows an approved publication only
if its provenance record:

- is beside the dossier;
- is strict and correctly digested;
- names a definition file that matches its name;
- describes that exact dossier and record;
- is not a rehearsal (revision `000…0`).

It cannot replay, because production runs nothing from the Lab.

**The publication gate** (`lab/orchestrator/publication-gate.ts`) believes none
of the record. It runs as a step of the `validate` job on every pull request
and every push to main. For each publication the change adds or alters, it
re-derives everything:

1. the definition is at the head, with the digest named;
2. the commit named exists and is **already on the base branch**, so the code
   was reviewed and merged before it ran;
3. the definition is the same file at that commit;
4. the source digest at that commit **and** at the head is the one named;
5. replaying the definition reproduces the record digest and the dossier, byte
   for byte;
6. the provenance record is exactly the one the replay implies;
7. the entry names this pull request.

It is not a signature. It proves the dossier is what the reviewed engine
computes from a reviewed definition. It does not prove who ran it.

## 2. Owner approval: found on 2026-10-27

Read from GitHub's API, without credentials:
`GET /repos/bibokh/familista-backend/rules/branches/main` and
`GET /repos/bibokh/familista-backend/rulesets/25019943`.

| Finding | Value |
|---|---|
| Repository | public; one collaborator, `bibokh` (admin) |
| Identity the agent's GitHub tools act as | `bibokh` (the Platform Owner's own account) |
| Ruleset | 25019943 "Familista Main Protection", active, `refs/heads/main` |
| Deletion, force push | blocked |
| Pull request required | yes, but `required_approving_review_count: 0`, `require_code_owner_review: false`, `require_last_push_approval: false` |
| Required status checks | the 4 CI jobs, from GitHub Actions (app 15368), `strict: false` |
| Bypass actors | `[]` as returned to an unauthenticated reader (unverified) |
| Classic branch protection | not readable (403 without admin credentials) |

**What this means:**

- **CI is enforced.** Main cannot change unless the 4 checks pass, and the
  publication gate runs inside `validate`.
- **Review is not enforced.** CODEOWNERS is advisory, which is why earlier pull
  requests merged with zero reviews.
- **The agent can merge.** It acts as the Platform Owner's account, so any
  approval or merge it makes is indistinguishable from the owner's. While that
  holds, nothing in the repository's content is a boundary against it. That
  includes the gate itself: a pull request can edit `ci.yml`.
- **The publication gate refuses every real publication** while the rules on
  main do not enforce code-owner approval by someone other than the author.
  This is a tripwire: until the settings below exist, someone who can merge
  could edit the gate itself.

## 3. The arrangement that enforces it

GitHub never counts a pull request author's approval of their own pull
request. So the approver must hold a credential the author does not. Two
arrangements satisfy that, and both need the same ruleset.

**A. The agent works as its own machine account (recommended).**

- Connect a separate machine account to Claude Code, used only for the agent.
  The agent then opens pull requests and pushes as that account.
- `@bibokh`, the Platform Owner, stays the code owner and approves with their
  own login, which the agent never holds.
- GitHub's Terms of Service allow one free machine account per person, "used
  exclusively for performing automated tasks".
- The approval is the owner's, it is genuine, and it is enforced.

**B. A distinct trusted reviewer.**

- Add a second person's own account as a collaborator with write access.
- Make that account the code owner of the paths below.
- The approval is enforced, but it is that person's, not the owner's.
- A second account for the same person is not a machine account. GitHub's
  Terms of Service allow one free personal account per person.

**Ruleset 25019943, Settings → Rules → Rulesets:**

- **Require a pull request before merging:**
  - required approvals: **1**;
  - **Dismiss stale pull request approvals when new commits are pushed**;
  - **Require review from Code Owners**;
  - **Require approval of the most recent reviewable push**.
- **Require status checks to pass:**
  - keep the four checks;
  - turn on **Require branches to be up to date before merging**.
- **Bypass list: empty.** Confirm that no role, team or app is listed.
- Keep "Block force pushes" and "Restrict deletions".

**CODEOWNERS:** the reviewing account owns:

- `/src/platform/agents/published/`
- `/lab/orchestrator/definitions/`
- `/lab/orchestrator/`
- `/src/platform/agents/`
- `/.github/`

These cover the gate, the workflow that runs it, and this file.

**Machine account permissions (arrangement A):** write access, but not admin,
so it cannot edit the ruleset.

**Whether the gate counts it as enforced:**

- The gate reads the active rules on every run. It reports
  `owner-approval-enforced` as MET only when all of these hold:
  - code-owner review;
  - at least one approval;
  - last-push approval;
  - the `validate` check from GitHub Actions;
  - blocked force push and deletion;
  - a code owner of the publications other than the pull request's author.
- GitHub does not disclose bypass actors to the CI token. The gate reports
  that one as UNVERIFIED, so the owner confirms it in the ruleset page.

## 4. The first publication, once the above holds

1. Merge the pull request that adds the definition. Its merge commit becomes
   the source revision.
2. On a branch from that commit, run the canonical execution:
   `FAMILISTA_ENV=LAB npm run lab:execute -- run lab/orchestrator/definitions/matchday-staff-notice.json`.
3. Open the publication pull request, then prepare into it with its number:
   `FAMILISTA_ENV=LAB npm run lab:publish -- prepare <exec-id> --definition lab/orchestrator/definitions/matchday-staff-notice.json --reference bibokh/familista-backend#<pr>`.
4. Commit the three files and push. The gate replays it, and the reviewer
   approves it.
