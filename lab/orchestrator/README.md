# The Multi-Agent Orchestrator lab — AI-0.2

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

## Adding an agent or a domain

1. Add the agent's manifest to the registry (`src/platform/agents/catalog.ts`), as DRAFT or LAB, in a reviewed pull request.
2. Register its LAB operations against tools the manifest holds.

The orchestrator does not change: it discovers the agent through the registry
and routes to it by tool, domain, scope and data class.
