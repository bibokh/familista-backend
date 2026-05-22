# Phase N — Global Sports Knowledge Graph + Universal Identity + Reasoning

This document covers Phase N's architecture, claim surfaces, security,
scalability, replay determinism, and deployment posture. It composes on
top of Phases B–M and changes nothing in those phases.

---

## 1. Architecture

```
GLOBAL SPORTS KNOWLEDGE GRAPH               UNIVERSAL ATHLETE IDENTITY
GlobalKnowledgeNode (polymorphic)           UniversalAthleteId (sha256 fingerprint)
  PLAYER · CLUB · COACH · SCOUT · AGENT     AthleteIdentityLink (clubId scoped)
  TOURNAMENT · STADIUM · COMPETITION        AthletePerformanceHistory
  COUNTRY · ACADEMY                         AthleteMedicalHistory (k-anon)
GlobalKnowledgeEdge (typed)                 AthleteTransferHistory
  PLAYS_FOR · COACHES · REPRESENTS          TalentEvolutionGraph
  HOSTS · IN_COMPETITION · BELONGS_TO
  DEVELOPS · NATIVE_OF · SCOUTED_BY
  SIGNED_WITH · CUSTOM

GLOBAL SCOUTING INTELLIGENCE                AUTONOMOUS MARKET INTELLIGENCE
WorldwideScoutingNode                       MarketTransferPrediction (n1)
TalentDiscoveryEvent                        ContractIntelligenceSnapshot (n1)
GlobalRecommendationRanking (HMAC-signed)   AcademyDevelopmentForecast (n1)
ConfidenceScore (n1)
ScoutingEvaluation (n1)

KNOWLEDGE REASONING LAYER                   SECURITY EXTENSIONS
ReasoningTrace                              CryptographicGraphAnchor (sha256 → audit)
ExplainableDecision (HMAC-signed)           RecommendationSignature (HMAC durable record)
DeterministicReasoningRule (versioned)      TrustScore (per source, running average)

MULTI-SPORT EXPANSION (additive)
SportKind += FUTSAL, VOLLEYBALL
src/sports/futsal.adapter.ts
src/sports/volleyball.adapter.ts
```

---

## 2. Patent claim surfaces

| # | Surface |
|---|---|
| N-1 | Global polymorphic sports knowledge graph (10 node kinds + typed edges) with per-tenant + global node visibility |
| N-2 | Universal athlete identity via SHA-256(firstName \| lastName \| dob \| sport) — cross-club identity without PII leakage |
| N-3 | Deterministic global scouting evaluation (n1 model version) with HMAC-signed recommendations |
| N-4 | Replay-safe knowledge reasoning trace with explainable per-rule attribution |
| N-5 | Multi-sport polymorphic geometry/event taxonomy — single core engine, N adapters |
| N-6 | Cryptographic graph anchoring — every knowledge mutation hashes into the Phase I audit chain |
| N-7 | Deterministic running trust score per source (audit-replayable) |

---

## 3. Replay determinism

- All scoring rows carry `modelVersion = "n1"`.
- Reasoning rules use deterministic predicate evaluation; rule library is versioned per (clubId, code).
- Graph anchor is `SHA-256( sorted-nodeIds | sorted-edgeIds | asOf )` — replayable.
- Recommendation signatures use HMAC-SHA256 over canonical-stringified payload (sorted keys).
- TrustScore update rule: `newScore = (oldScore * obs + delta) / (obs + 1)` — deterministic.

---

## 4. Security analysis

| Threat | Mitigation |
|---|---|
| Cross-tenant leakage | Per-tenant nodes carry `clubId`; global nodes (clubId=null) read-visible but write-restricted to SUPER_ADMIN |
| PII leakage in athlete ID | SHA-256 fingerprint only; raw PII never persisted in UniversalAthleteId |
| Tampered recommendation | HMAC-SHA256 with per-club derived key over canonical JSON; RecommendationSignature persists the durable record |
| Tampered graph | CryptographicGraphAnchor + Phase I audit chain; `verifyAnchor()` re-runs sha256 |
| Untrusted source | TrustScore decreases on low-confidence outcomes; observable per (sourceKind, sourceRef) |
| Replay attack on signatures | Canonical body includes `clubId + kind + payload` → can't be replayed for a different tenant |
| Medical PII | Plain payload sha256-hashed, only k-anonymised body stored; access requires MEDICAL_STAFF / CLUB_ADMIN / HEAD_COACH / SUPER_ADMIN |

---

## 5. Scalability analysis

- 22 new models + 4 enums + 2 SportKind values. All additive.
- Knowledge graph indexes: `(nodeKind, isActive)`, `(externalRef)`, `(fromNodeId)`, `(toNodeId)`.
- Graph anchor reads cap at 50k nodes + 200k edges per anchor call.
- All `findMany` calls cap with `take`.
- No new realtime channels, no new workers, no new env vars.

---

## 6. Modified files

| Path | Purpose |
|---|---|
| `prisma/schema.prisma` (+ root mirror) | 22 new models, 4 new enums, 2 new `SportKind` values |
| `src/knowledge-graph/knowledge-graph.service.ts` | Node + edge writers + graph anchor + verify |
| `src/knowledge-graph/reasoning.service.ts` | Deterministic rules + reasoning execution + signed decisions |
| `src/identity/universal-identity.service.ts` | SHA-256 fingerprint + identity link + history |
| `src/global-scouting/global-scouting.service.ts` | Worldwide nodes + discovery + ranking + confidence + evaluation |
| `src/market-intelligence/market.service.ts` | Transfer prediction + contract intel + academy forecast |
| `src/security-n/signed-recommendations.service.ts` | HMAC-SHA256 sign + verify + TrustScore |
| `src/sports/futsal.adapter.ts` | Additive — futsal sport adapter |
| `src/sports/volleyball.adapter.ts` | Additive — volleyball sport adapter |
| `src/sports/index.ts` | Register futsal + volleyball in adapter map |
| `src/controllers/phase-n.controller.ts` | Bundled controller |
| `src/routes/phase-n.routes.ts` | Mounted at `/api/v1/phase-n/*` |
| `src/routes/index.ts` | Mount `/phase-n` |
| `scripts/boot-probe.js` | Phase N probes |
| `docs/PHASE_N_GLOBAL_INTELLIGENCE.md` | This file |

---

## 7. Endpoint surface

```
/api/v1/phase-n/kg/{nodes,edges,anchor,anchors,anchors/:id/verify}
/api/v1/phase-n/reasoning/{rules,run,traces}
/api/v1/phase-n/identity/{athletes,links,performance,medical,transfers}
/api/v1/phase-n/scouting/{nodes,discoveries,rankings,evaluations}
/api/v1/phase-n/market/{transfer-prediction,contract,academy-forecast}
/api/v1/phase-n/trust/{update,GET}
/api/v1/phase-n/snapshot
```

All endpoints behind `authenticate` + `tenantGuard` + role-based `authorize` middleware.

---

## 8. What this does NOT change

- All Phase B–M endpoints behave exactly as before.
- Tactical OS (Phase H) frontend is untouched.
- No new external dependencies installed.
- No payment gateway wired.
- No real ML/AI in the reasoning layer — pure-function deterministic.
- Existing football behavior is byte-for-byte unchanged: the futsal + volleyball additions are pure extension points.
- Render deployment continues to use the existing build pipeline.

Familista now has a globally federated polymorphic knowledge graph, universal athlete identity (PII-safe), deterministic reasoning, and cryptographic graph anchoring — all within one tenant-isolated, audit-anchored, deterministic architecture.
