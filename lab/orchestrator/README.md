# The Multi-Agent Orchestrator lab — AI-0.2 to AI-0.5

The first slice of the orchestrator that will let Familista's agents work
together under one set of rules. It lives in the Lab, next to the algorithm
lab, and it is the **Simulate → Test** part of the Continuous Intelligence Loop:

```
Observe → Learn → Propose → Simulate → Test → Human approval → Deploy → Measure
                            └─ this directory ─┘
```

A plan is a small acyclic set of tasks (`contracts.ts`, `familista.orchestration/v1`).
Each task names a LAB operation (`operations.ts`), and its `dependsOn` edges
are the outputs it consumes. The orchestrator (`engine.ts`) handles each plan:

1. **Refuses** the plan before anything runs unless all of these hold:
   - this process is the Lab;
   - the plan is bounded and refers only to synthetic `lab-…` clubs and people;
   - every edge is an exchange the consuming operation declares;
   - the requester belongs to the plan's scope;
   - every task routes to an agent in the **Agent Registry** (`routing.ts`);
   - the requester may read everything those agents write (the AI read matrix).
2. **Runs** each task in a fixed order, and only when all of these pass:
   - **authorization:** the tool registry's `authorizeTool`, acting as the routed
     agent in the Lab, allows it. The kill switch stops actions, and an action
     waits for a person.
   - **input:** no other tenant's id, no health data outside a medical agent,
     within size, and valid for the operation.
   - **handoffs:** every upstream output is within what the receiving agent may
     read, and a medical record reaches a medical agent only.
   - **output:** valid, within size, never health data unless declared
     RESTRICTED, and within what the agent may write.
3. **Records** every decision in a hash-chained trace (`trace.ts`). The same
   plan over the same registry gives the same trace, byte for byte.

A person's decision on an action (`decideApproval`) is accepted only from an
approver role (`src/security/approver-roles.ts`) of the plan's club who is not
the requester and who may read what the task writes.

## What it reuses, and what it never touches

| Reuses | From |
|---|---|
| Agent Registry, manifests, digest | `src/platform/agents` |
| Tool registry, autonomy, environment check, kill switch | `src/platform/intelligence/agents.ts` |
| Data-class ceilings | `src/platform/intelligence/data-classes.ts` |
| AI read matrix, record classes, health fields | `src/security/ai-read-policy.ts` |
| Approver roles, segregation of duties | `src/security/approver-roles.ts`, the AI Approval Gate's rules |
| The Lab's identity | `src/platform/environment.ts` |

It never touches a database, the AI Gateway, a model provider or the
network. No action is ever made: a LAB action operation describes the change
a person approved. Production cannot contain or load it, because the build
compiles `src/` only and nothing in `src/` imports `lab/`.
`tests/orchestrator-lab.unit.test.ts` pins all of this.

## What it is not

Two systems with similar names already exist. This orchestrator duplicates neither of them.

- **The AI Decision Engine** (`src/services/ai-orchestrator.service.ts`) runs one decision through scoring and explanation, then persists an `AIDecision` row.
  - When an agent's LAB output is promoted to production, the Decision Engine is the natural place to record it.
- **The Multi-Agent Decision Council** (`src/executive/decision-council.service.ts`) collects agents' votes on one proposal.
  - A council can later become one kind of operation.

Neither routes tasks to registry agents, or governs what passes between them. That is the gap this directory fills.

## Running it

```
FAMILISTA_ENV=LAB npm run lab:orchestrator              # every scenario, summarised
FAMILISTA_ENV=LAB npm run lab:orchestrator -- --trace   # with each run's trace
```

## Controlled execution (AI-0.4)

AI-0.2 decides what a plan's agents may do. AI-0.4 adds how a plan comes to be
run at all: on demand, by a named LAB operator, through a terminal.
`execution.ts` holds the rules and `execute-cli.ts` the commands. Neither has
an endpoint, and neither runs outside the Lab.

```
FAMILISTA_ENV=LAB npm run lab:execute -- submit lab/orchestrator/requests/matchday.json
FAMILISTA_ENV=LAB npm run lab:execute -- decide <execution-id> notice APPROVED --by lab-user-club-admin --role CLUB_ADMIN --club lab-club-north
FAMILISTA_ENV=LAB npm run lab:execute -- show <execution-id> --trace
FAMILISTA_ENV=LAB npm run lab:execute -- verify <execution-id>
FAMILISTA_ENV=LAB npm run lab:execute -- cancel <execution-id> --operator lab-user-head-coach --role HEAD_COACH
FAMILISTA_ENV=LAB npm run lab:execute -- kill-switch engage --reason "…" --operator lab-user-head-coach --role HEAD_COACH
FAMILISTA_ENV=LAB npm run lab:execute -- demo
```

An execution request (`familista.lab-execution/v1`) carries four things: an
operator, an idempotency key (`requestId`), a v1 plan and an optional step limit.

**Refused before anything runs**, unless all of these hold:
1. **Place and switch:** it is the Lab, and the kill switch is released.
2. **Size and shape:** the request is at most 64 KiB and valid (strict zod 4).
3. **Operator:** the operator is on the roster (`operators.ts`), holds SUBMIT for
   the plan's scope, and may read every record class the plan's agents write. A
   head coach cannot operate a medical plan.
4. **Plan:** it passes the orchestrator's own checks.

**Idempotency.** An execution's id is derived from its operator and `requestId`.
Submitting the same plan again returns the record and runs nothing. A different
plan under the same key is refused.

**Running.** The plan runs with a guard the engine asks before every task
starts:
- the kill switch halts it there;
- so does a step past its limit.

Every task not yet finished is then `CANCELLED`, in the trace. The kill switch
here stops the whole workflow, which is stricter than the tool registry's stop on
actions alone. It also halts executions that are waiting for a decision:
- any decision made while it is engaged is not applied;
- `kill-switch engage` halts every open execution in the store.

Releasing the switch is the Platform Owner operator's alone, and it resumes
nothing.

**Approvals** keep the orchestrator's rules (an approver role, of the plan's
club, not the requester, who may read what it writes) and add two more:
- **No self-approval:** the operator who submitted an execution never decides its
  approvals.
- **Invalidation:** each execution records a digest of its security context:
  - the registry;
  - the operations;
  - the approver roles;
  - the read matrix;
  - the tool registry;
  - the roster.

  A decision made after any of these changed is not applied, and the execution
  halts with `APPROVAL_CONTEXT_CHANGED`.

**The record** (`.executions/<id>.json`, git-ignored, LAB only) holds:
- the security context and the plan's validation;
- the routing: why each agent was chosen, and why every other was passed over;
- the run, with its chained trace of transitions, handoffs, approvals, failures
  and cancellations;
- a second chain of execution events, committing to the trace's head at every
  step;
- a digest over all of it.

`verify` checks every part. `publicationCandidate` shows the record as AI-0.3
evidence, checked by production's own verifier, and publishes nothing. A
stopped run is never a candidate: the published v1 contract has no word for it.

The AI-0.3 evidence keeps to `labOperations()`. Controlled execution routes over
`labExecutionOperations()`, which adds the club manager's staff notice
(`sendNotification`, an action that waits for a person).

## Approved evidence publication (AI-0.5)

A controlled execution can become something the AI Agents Operations Room
shows. It does so only as v2 evidence, and only after the Platform Owner
approves it by merging the pull request that carries it.

```
FAMILISTA_ENV=LAB npm run lab:publish -- candidate <execution-id>      # writes nothing
FAMILISTA_ENV=LAB npm run lab:publish -- prepare <execution-id> --reference bibokh/familista-backend#<pr>
FAMILISTA_ENV=LAB npm run lab:publish -- verify                         # the directory, read as the server reads it
FAMILISTA_ENV=LAB npm run lab:publish -- rehearse <execution-id>        # prepare → verify in a throwaway directory
FAMILISTA_ENV=LAB npm run lab:publish -- demo                           # end to end, stopping at the owner's boundary
```

**The pipeline** runs in this order:

1. The record is verified by the Lab's own rule (`verifyExecution`).
2. It is projected into one dossier, `familista.orchestration-evidence/v2`. The
   dossier carries what was decided, never an input or an output:
   - the routing;
   - every task transition and handoff;
   - the decisions;
   - the stop;
   - both chains, the run trace and the execution log;
   - the security context's digests.
3. Production's verifier (`src/platform/agents/execution-evidence.ts`) must
   accept the dossier.
4. `prepare` writes the dossier and an entry in
   `src/platform/agents/published/approvals.json` for the pull request named. It
   then reads the directory back exactly as the server will.

**The approval is the merge.** An entry names its:
- publication;
- execution;
- dossier file and digest;
- pull request.

It never names who approved it.

- **An entry that claims an approver is refused.** That includes any
  `approvedBy`, `owner`, `signature` or `approvedAt`, because a typed name
  proves nothing. The AI-0.4 operator name is not authenticated either.
- **The tool cannot approve.** It has no `approve` and no `publish` command, and
  it refuses any flag that names an approver.
- **The boundary is GitHub's.** The approval is the Platform Owner's review and
  merge of the reviewed pull request, with the directory code-owned in
  `.github/CODEOWNERS`. It is not cryptographic owner authentication.
- **Until the merge, production shows nothing.** The build it runs holds no
  entry.

**The server shows a publication only if all of this holds:**
- the record lists it exactly once, with that digest, for a pull request of this
  repository;
- the dossier verifies as a whole, on every one of these points:
  - its version;
  - its strict shape;
  - its digest and derived ids;
  - both hash chains, and the log's commitment to the trace;
  - every state, agent, decision and stop against the chains;
  - an outcome that follows from its tasks;
  - its governance: no self-approval, no medical approval, every kill-switch
    refusal halted;
  - synthetic data only;
  - every agent and tool registered.

Anything else makes the whole read `INVALID`, and nothing is shown. The other
cases:
- **A dossier with no entry** is listed as unapproved, and is never read.
- **A rehearsal** uses `#9999999`, a pull request that cannot exist. The server
  refuses it.

**What the chains do not prove.** The hash chains are unkeyed. They prove that a
dossier is internally consistent, and that it is exactly the one whose digest
was approved. They do not prove that the Lab produced it: a fabricated dossier
that is consistent in every part would verify. Two things stop that from
reaching production:
- the owner's review of the pull request;
- the digest that pins what was reviewed.

The demonstration's dossiers are reproducible from their scenarios
(`publication-demo.ts`), byte for byte, and
`tests/fixtures/agents/publications-room-view.json` is checked against them.

## Trusted provenance and the publication gate

The chains above prove consistency, not origin. A publication therefore also
carries a provenance record (`src/platform/agents/execution-provenance.ts`):
the reviewed definition it ran and the commit on main it ran at. CI does not
believe it. It reproduces it.

```
FAMILISTA_ENV=LAB npm run lab:execute -- run lab/orchestrator/definitions/matchday-staff-notice.json
FAMILISTA_ENV=LAB npm run lab:publish -- replay lab/orchestrator/definitions/matchday-staff-notice.json
FAMILISTA_ENV=LAB npm run lab:publish -- prepare <execution-id> --definition lab/orchestrator/definitions/matchday-staff-notice.json --reference bibokh/familista-backend#<pr>
FAMILISTA_ENV=LAB npm run lab:publication-gate                     # what CI runs, in the validate check
```

The pieces:

- **A definition** (`definition.ts`, `definitions/`) holds the synthetic
  request and every operator step, with the answer each step must get.
  `lab:execute -- run` makes the operator's execution of it through the same
  functions the other commands call.
- **The replay** (`replay.ts`) runs the definition from nothing, in a store of
  its own. The record holds no clock and no random value, so a replay is the
  same record byte for byte, or a difference.
- **`prepare`** requires the replay to reproduce the stored execution. It also
  requires the working tree's execution source to be the commit it names.
- **The source digest** (`source.ts`) covers every file the replay imports,
  transitively, and every locked package version they load.
- **The gate** (`publication-gate.ts`) runs for every publication a change adds
  or alters:
  - it re-checks the definition, at the head and at the commit;
  - it requires that commit to be on main already;
  - it checks the source digest at both;
  - it replays the definition and compares the dossier and the provenance
    record byte for byte;
  - it requires the entry to name the pull request.
- **Enforcement.** A real publication is also refused while the rules on main
  do not enforce code-owner approval by someone other than the pull request's
  author. Today they do not:
  [docs/security/evidence-publication-enforcement.md](../../docs/security/evidence-publication-enforcement.md)
  lists what was found and the exact settings needed.

## Adding an agent or a domain

1. Add the agent's manifest to the registry (`src/platform/agents/catalog.ts`), as DRAFT or LAB, in a reviewed pull request.
2. Register its LAB operations against tools the manifest holds.

The orchestrator does not change: it discovers the agent through the registry
and routes to it by tool, domain, scope and data class.
