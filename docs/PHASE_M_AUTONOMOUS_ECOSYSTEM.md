# Phase M — Autonomous Sports Ecosystem Execution Layer

This document covers the architecture, claim surfaces, replay, security,
scalability, and deployment posture of Phase M. It composes on top of
Phases B–L and changes nothing in those phases.

---

## 1. Architecture

```
ORGANIZATION DIGITAL TWIN            EXECUTIVE AI COUNCIL
OrganizationTwin                     ExecutiveAgent (ExecAgentRole)
ClubTwin                             ExecutiveDecision (audit-anchored)
AcademyTwin                          DecisionCouncil (consensusScore)
DepartmentTwin                       CouncilVote (sorted-deterministic)
StaffTwin

RECRUITMENT ENGINE                   TRAINING ENGINE
PlayerTarget                         TrainingOptimizationPlan
RecruitmentScoutReport               RecoveryPlan
RecruitmentScore (m1)                LoadDistributionPlan
TransferProbability (m1)             MicrocyclePlan
TalentProjection (m1)                SeasonPlan (unique per season)

PERFORMANCE ECONOMICS                GLOBAL SCOUTING GRAPH
PlayerAssetValue (m1)                TalentGraph (snapshot)
ContractRisk (m1)                    ScoutNetwork (directory)
SponsorImpact                        PlayerSimilarityGraph (snapshot)
CommercialScore                      CareerProjectionGraph (snapshot)
AcademyROI (unique per season)

MARKETPLACE (no payments)            KNOWLEDGE ENGINE
MarketplaceItem (5 kinds)            KnowledgeDocument (per-club + global)
  TRANSFER_LISTING gates             KnowledgeGraph (snapshot)
  through Phase I approval           TacticalPatternLibrary (catalog)
                                     MedicalKnowledgeNode (catalog)
```

All anchored to:
- Phase A SaaS tenancy (`clubId` everywhere)
- Phase I SecurityAuditEvent chain (every twin capture, decision, listing, target hashes in)
- Phase I AIApprovalRequest gate (HIGH-impact decisions + TRANSFER_LISTING activation)

---

## 2. Claim surfaces

| # | Surface | Defensibility |
|---|---|---|
| M-1 | Autonomous sports organization | OrganizationTwin synthesizes financial + sporting + staffing + HW state into deterministic snapshot |
| M-2 | Federated talent intelligence | RecruitmentScore + TransferProbability + TalentProjection — versioned pure functions over scout + telemetry |
| M-3 | AI executive council | DecisionCouncil aggregates votes from N AI agents + humans; consensus is deterministic over sorted voterIds |
| M-4 | Digital organization twin | 5 snapshot tables form a multi-resolution org twin |
| M-5 | Deterministic recruitment engine | Every score / probability / projection carries `modelVersion = "m1"`; replay reproduces identical outputs |
| M-6 | Tactical-economic intelligence | PlayerAssetValue + ContractRisk + CommercialScore + AcademyROI fuse sporting state with economic outcomes |

All compose with Phase D-IP fusion, Phase F outbox, Phase I audit chain, Phase J federated aggregation, Phase K vision, and Phase L federated cognition.

---

## 3. Replay analysis

- **All twin tables** carry server-set `capturedAt`; never mutated.
- **All scoring rows** carry `modelVersion = "m1"`. Same inputs → identical components + score on replay.
- **DecisionCouncil.consensusScore** recomputed deterministically by `recomputeConsensus` (sorted by `voterId`).
- **Training plans** immutable once created; only `status` transitions (DRAFT → ACTIVE → COMPLETED / CANCELED).
- **Marketplace items** append-only; close sets status only.
- **KnowledgeDocument** uses `isActive=false` for soft-delete; old rows retained for replay.

---

## 4. Security analysis

- **Tenant gating**: every read/write uses `clubId === actor.clubId` + Phase I `tenantGuard`.
- **Audit chain**: every decision, target creation, listing, twin capture hashes into Phase I.
- **Approval gating**: HIGH-impact executive decisions (TRANSFER_APPROVAL, CONTRACT_TERMINATION, MASS_RELEASE, BUDGET_REALLOCATION, SPONSORSHIP_AGREEMENT, ACADEMY_RESTRUCTURE, COACH_DISMISSAL) route through Phase I AIApprovalRequest (48h TTL). TRANSFER_LISTING activation in marketplace also gates through approval.
- **Knowledge access**: `KnowledgeDocument.kind` enables role-gated reads (medical, financial).
- **No new external dependencies** introduced.

---

## 5. Scalability analysis

- **Twins**: O(captures/day). Operator-driven; capped to one per kind per capture call.
- **Executive decisions**: bounded by approval-gate cadence; ~10s/day at full club scale.
- **Recruitment**: 50 active targets/club cap; service-level guard rejects extras.
- **Training plans**: O(N teams × 1/week). Trivial.
- **Economics**: O(N players × 1/week). Bounded.
- **Scouting graphs**: derived; written on demand.
- **Marketplace**: bounded by listing volume.
- **Council votes**: bounded by participant count (~7 AI + few humans).
- **Knowledge docs**: bounded by editor cadence.

All `findMany` calls cap with `take`. No new realtime hot paths.

---

## 6. Deployment impact

- **Migration**: 33 new tables + 7 new enums. All additive.
- **Build**: TypeScript clean within Phase M scope.
- **Runtime**: no new workers, no new realtime channels, no new env vars.
- **Endpoints**: 35+ new endpoints under `/api/v1/phase-m/*`.
- **Existing surface**: all Phase B–L endpoints behave identically.
- **Frontend**: Tactical OS (Phase H) untouched.
- **Render**: standard build pipeline; pre-existing `seed.ts` rootDir warning unchanged.

---

## 7. Modified files

```
prisma/schema.prisma (+ root mirror)            33 models, 7 enums
src/twins/twin.service.ts
src/executive/executive.service.ts
src/executive/decision-council.service.ts
src/recruitment/recruitment.service.ts
src/training-engine/training-plan.service.ts
src/economics/economics.service.ts
src/scouting-graph/scouting-graph.service.ts
src/marketplace/marketplace.service.ts
src/knowledge/knowledge.service.ts
src/controllers/phase-m.controller.ts
src/routes/phase-m.routes.ts
src/routes/index.ts                              mounted /phase-m
scripts/boot-probe.js                            extended
docs/PHASE_M_AUTONOMOUS_ECOSYSTEM.md
```

---

## 8. Endpoint surface

```
/api/v1/phase-m/twins/{organization,club,academy,department,staff}
/api/v1/phase-m/twins                                      GET (rollup)

/api/v1/phase-m/executive/agents                            POST · GET
/api/v1/phase-m/executive/decisions                         POST · GET

/api/v1/phase-m/councils                                    POST
/api/v1/phase-m/councils/:councilId/votes                   POST
/api/v1/phase-m/councils/:councilId/close                   POST
/api/v1/phase-m/councils/:councilId                         GET

/api/v1/phase-m/recruitment/targets                         POST · GET
/api/v1/phase-m/recruitment/reports                         POST
/api/v1/phase-m/recruitment/scores                          POST
/api/v1/phase-m/recruitment/transfer-probability            POST
/api/v1/phase-m/recruitment/projections                     POST

/api/v1/phase-m/training/{optimization,recovery,microcycle,season}  POST
/api/v1/phase-m/training/plans                              GET

/api/v1/phase-m/economics/asset-value                       POST
/api/v1/phase-m/economics/contract-risk                     POST

/api/v1/phase-m/scouting/talent-graph                       POST
/api/v1/phase-m/scouting/scouts                             POST · GET

/api/v1/phase-m/marketplace/listings                        POST · GET
/api/v1/phase-m/marketplace/listings/:id/activate           POST   (approval gated for TRANSFER_LISTING)
/api/v1/phase-m/marketplace/listings/:id/close              POST

/api/v1/phase-m/knowledge/documents                         POST · GET
/api/v1/phase-m/knowledge/tactical-patterns                 POST
/api/v1/phase-m/knowledge/medical                           POST

/api/v1/phase-m/snapshot                                    GET (rollup)
```

---

## 9. What this does NOT change

- All Phase B–L endpoints behave exactly as before.
- Tactical OS (Phase H) frontend is untouched.
- No new external dependencies installed.
- No payment gateway wired (marketplace remains architecture-only).
- No real AI dependency (pure-function deterministic helpers).
- Render deployment continues to use the existing build pipeline.

Familista is now structurally an **autonomous sports operating ecosystem** capable of managing organisations, talent, performance, finance, scouting, hardware, and AI intelligence within one deterministic architecture.
