# Phase L — Federated Cognition + Real Hardware + Distributed Sports Cognition

This document covers the architecture, claim surfaces, determinism, security,
and roadmap of Phase L. It composes on top of Phases B–K and changes nothing
in those phases.

---

## 1. Architecture

```
HARDWARE                    FEDERATED INTELLIGENCE
HardwareProvisioningSession FederatedTrainingJob ─ aggregationSeed
DeviceCapabilityProfile     FederatedGradientEnvelope (signed, nonce'd)
DeviceSensorMatrix          FederatedModelCheckpoint  (sha256 anchor)
DeviceClockDiscipline       ClubModelPartition
DeviceTrustAnchor           PrivacyBoundary (DP ε, k-anon)
DeviceAttestation           AggregatedSportsModel
                            FederatedTrustBoundary

AUTONOMOUS COACHING         DIGITAL TWIN SIMULATION
CoachAgent                  TwinSimulationSession ─ seed (BigInt)
CoachRecommendation         MatchSimulationState
  kinds:                    TacticalBranch
    TACTICAL                PredictedPossessionFlow
    INJURY_RISK             PredictedFatigueCurve
    SUBSTITUTION            CounterfactualScenario
    TACTICAL_ADAPTATION
    MATCH_ADJUSTMENT        COGNITIVE GAME GRAPH
    FORMATION_OPTIMIZATION  GameGraph (nodes + edges)
    CUSTOM                  SpatialPressureGraph
                            PassingNetworkGraph
BIOMECH + BIOCHEM           DynamicThreatMap
BiochemicalSignal           CognitiveInfluenceScore
HydrationEstimate
StressIndex                 SPORT CATALOG (admin-registerable)
NeuromuscularLoad           SportPlugin · TacticalDomain
TendonRiskEstimate          SportFieldGeometry · SportEventTaxonomy
                            SportSpatialRules

QUANTUM RESEARCH (no DB)    OBSERVABILITY EXTENSIONS
QuantumOptimizationAdapter  RegionalHealthSnapshot
QuantumSchedulingExperiment DeviceFleetHealth
QuantumPatternSearch        AIConsensusHealth
QuantumInferenceBoundary    FederatedAggregationHealth
                            SimulationQueueHealth
```

All anchored to:
- Phase F EventOutbox (durability)
- Phase I SecurityAuditEvent chain (tamper evidence)
- Phase J Region + EdgeNode (distributed runtime)
- Phase K Camera + VisionEventBatch (vision telemetry)

---

## 2. Claim surfaces

| # | Surface | Defensibility |
|---|---|---|
| L-1 | Federated tactical cognition | Multi-club gradient aggregation with privacy boundary + audit anchoring |
| L-2 | Autonomous coaching intelligence | Deterministic recommendation engine with confidence + impact + approval gate |
| L-3 | Biomech + biochem fusion | Sweat + neuromuscular + cortisol → StressIndex / TendonRisk derived signals |
| L-4 | Realtime cognitive game graphs | Graph snapshots updating at SSE cadence from Phase G spatial + Phase K events |
| L-5 | Deterministic sports simulation | Seed-pinned branching tree; replay-equal outputs |
| L-6 | Edge-to-cloud neuromorphic intelligence | HMAC-signed vision packets + federated aggregation |
| L-7 | Hardware-bound sports AI identity | DeviceTrustAnchor binds Device.id → cert + secure-boot hash |
| L-8 | AI recommendation audit anchoring | Every CoachRecommendation hashed into Phase I chain |

---

## 3. Determinism analysis

| Concern | Mitigation |
|---|---|
| Federated aggregation order | `aggregationSeed` (BigInt) + envelopes sorted by `clubId`. Replay reproduces `participantOrder` byte-for-byte. |
| Coach rec ordering | `monotonicMs` server-set + `detectorVersion = "l1"`. |
| Simulation branching | `TwinSimulationSession.seed` (BigInt) governs all branch generation. |
| Game graph snapshots | Persisted at write-time as JSON; replays read frozen content. |
| Biomech derived | Pure-function metrics with `version = "l1"`. |
| Sport plugin extensions | Append-only catalog; `isActive=false` doesn't delete history. |

A replay test would: take a frozen DB snapshot → re-run `aggregate(jobId, version)` → assert `payloadHash` is identical to the persisted checkpoint. Bonus: the SecurityAuditEvent chain proves the inputs weren't tampered with between the original and replay.

---

## 4. Security analysis

| Threat | Mitigation |
|---|---|
| Firmware impersonation | DeviceTrustAnchor + DeviceAttestation. On HMAC or secure-boot-hash mismatch, the device is auto-revoked. |
| Model poisoning | FederatedGradientEnvelope `normValue` capped by `clippingNormMax` on the job. PrivacyBoundary enforces DP ε + k-anonymity. |
| Cross-club leakage | ClubModelPartition + FederatedTrustBoundary. A club can only submit to families it's trusted for. |
| Coach hijack | High-risk CoachRecommendation kinds gate through Phase I AIApprovalRequest before they're actionable. |
| Replay attacks | Phase I device-nonce LRU on every signed surface (`attest:`, `fed-grad:`). |
| Post-quantum era | QuantumInferenceBoundary documents `kyber-768` + `dilithium-3` as the recommended forward rotation. |

---

## 5. Scalability analysis

- **Hardware**: bounded by fleet size; indexed `(clubId, status)` and `(serial)`.
- **Federated**: roundNumber × participants; expected hundreds of envelopes per round.
- **Coach recommendation**: bounded by approval-gate cadence; `<100/match` typical.
- **Simulation**: capped at 20 active sessions/club via service-level guard.
- **Game graph snapshots**: ≤2 Hz per active match.
- **Biomech derived**: piggy-backs on BiomechanicalPacket cardinality.
- **Observability**: roll-up tables, one row per (kind, snapshot window).

All `findMany` have `take` caps. No new external deps. Lazy adapters preserved (Phase J Kafka / Redis / NATS / Phase F outbox).

---

## 6. Files / services

```
src/hardware/hardware.service.ts
src/security-l/attestation.service.ts
src/federated/federated.service.ts
src/coaching/coach-agent.service.ts
src/simulation/twin-simulation.service.ts
src/cognitive/game-graph.service.ts
src/biochem/biomech-expansion.service.ts
src/sports-catalog/sport-catalog.service.ts
src/quantum/quantum-interfaces.ts          (no DB — TS contracts + stubs)
src/observability-l/health-aggregator.service.ts
src/controllers/phase-l.controller.ts
src/routes/phase-l.routes.ts               (mounted at /api/v1/phase-l)
docs/PHASE_L_FEDERATED_COGNITION.md
prisma/schema.prisma (+ root mirror)        (41 new models, 6 new enums)
```

---

## 7. Replay-safety validation

Every persisted Phase L row has:
- `monotonicMs` / `createdAt` server-set
- `version` / `detectorVersion` / `aggregationSeed` pinned at row creation
- No mutation post-write except documented status transitions
- All derivations are pure functions over already-persisted source rows

`scripts/boot-probe.js` (extended) hits the Phase L surface and asserts every endpoint returns `401` (auth gate) before any tenant data is touched. The Phase I audit chain `/security/audit/verify` continues to verify the full hash chain including newly anchored Phase L mutations.

---

## 8. Runbook (operator)

### Provision a real device
```
POST /api/v1/phase-l/hardware/sessions          { serial, batchId? }
POST /api/v1/phase-l/hardware/sessions/:id/steps { name: "CERT_INSTALL",      ok: true }
POST /api/v1/phase-l/hardware/sessions/:id/steps { name: "SECURE_BOOT_SEAL",  ok: true }
POST /api/v1/phase-l/hardware/trust-anchors      { deviceId, certFingerprint, secureBootHash }
```

### Bring device online (device-side)
```
POST /api/v1/phase-l/security/attestation        { deviceId, nonce, secureBootHash, sigB64 }
# Verified attestation activates the device; FAILED auto-revokes.
```

### Run a federated round
```
POST /api/v1/phase-l/federated/privacy-boundary  { modelFamily: "tactical_press_v1", dpEpsilon: 0.5 }
POST /api/v1/phase-l/federated/jobs              { modelFamily: "tactical_press_v1" }
# Each club:
POST /api/v1/phase-l/federated/jobs/:jobId/gradient
                                                 { payloadHash, nonce, normValue }
POST /api/v1/phase-l/federated/jobs/:jobId/aggregate
                                                 { version: "1.0.0" }
```

### Issue a coaching recommendation
```
POST /api/v1/phase-l/coaching/agents             { label, agentKind: "TACTICAL" }
POST /api/v1/phase-l/coaching/recommendations    { kind: "SUBSTITUTION", rationale, payload }
# High-risk kinds park behind Phase I AIApprovalRequest.
```

### Run a simulation
```
POST /api/v1/phase-l/simulation/sessions         { label, matchId, sourceFrameId }
POST /api/v1/phase-l/simulation/sessions/:id/branches
                                                 { label, divergencePayload }
POST /api/v1/phase-l/simulation/sessions/:id/state
                                                 { branchId, tickMs, state }
```

### Snapshot health
```
GET  /api/v1/phase-l/snapshot
```

---

## 9. What this does NOT change

- All Phase B–K endpoints behave exactly as before.
- Tactical OS (Phase H) frontend is untouched.
- No new external dependencies installed.
- No payment gateway wired (Phase J billing remains architecture-only).
- No actual quantum dependency (Phase L quantum stubs only).
- No actual ML training (federated aggregation is deterministic SHA-256 over sorted payload hashes; real training plugs in when ready).
- Render deployment continues to use the existing build pipeline.

Familista is now structurally ready for the next-generation autonomous sports cognition stack the user described.
