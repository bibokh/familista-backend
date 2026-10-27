# The Multi-Agent Orchestrator lab — AI-0.2, AI-0.3, AI-0.4

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

## Adding an agent or a domain

1. Add the agent's manifest to the registry (`src/platform/agents/catalog.ts`), as DRAFT or LAB, in a reviewed pull request.
2. Register its LAB operations against tools the manifest holds.

The orchestrator does not change: it discovers the agent through the registry
and routes to it by tool, domain, scope and data class.
