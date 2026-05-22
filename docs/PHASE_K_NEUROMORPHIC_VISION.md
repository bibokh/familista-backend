# Phase K — Autonomous Cognitive Vision & Neuromorphic Sports Intelligence

This document describes the architecture, data contracts, patent strategy,
security model, hardware implications, and implementation roadmap of the
neuromorphic vision layer added to Familista in Phase K.

It composes on top of Phases B–J and does NOT replace any existing system.

---

## 1. Architecture

```
PHYSICAL FLEET (future hardware)
  ─ Event cameras (Prophesee, iniVation) — async microsecond events
  ─ Corner / fence / overhead RGB cameras
  ─ Wearable POV cameras (future)
  ─ 360° stadium rigs (future)

EDGE VISION RUNTIME            (Phase K, runs on Phase J EdgeNode)
  ─ EdgeVisionRuntime  : per-camera-box AI runtime metadata
  ─ EdgeModelManifest  : the catalog of models that can run on the box
  ─ EdgeModelVersion   : per-model semver + sha256
  ─ EdgeVisionInference: per-packet result row
  ─ EdgeVisionHealth   : rolling latency + confidence
  Edge processes events at μs cadence, ships pre-aggregated batches to
  the cloud at <2 Hz.

CLOUD NEUROMORPHIC SURFACE     (Phase K, this phase)
  ─ EventCameraStream   : long-lived stream identifier (camera, match)
  ─ VisionEventBatch    : append-only, N events per row (cap 5_000)
  ─ EventPoseEstimate   : derived pose
  ─ EventMotionCluster  : spatial event cluster (player/ball bursts)
  ─ VisionTimestampSync : per-camera clock-skew anchor
  ─ CameraRig + Members + SyncSession
  ─ MultiCameraObservation + SpatialTriangulationResult
  ─ Visual tactical signals (formation / pressing / overload / …)
  ─ BiomechanicalPacket (biochem patch payloads)

INTEGRATION
  Phase D-IP fusion-protocol.md       — BLI / TAI math
  Phase E TacticalState               — fast Live tab read
  Phase F EventOutbox + adapters      — durable replication
  Phase G Camera + CameraCalibration  — physical camera identity
  Phase G Spatial / Twin              — cognitive engine consumes Phase K outputs
  Phase H Tactical OS                 — frontend surface
  Phase I SecurityAuditEvent chain    — every Phase K mutation hashed
```

---

## 2. Data contracts

### EventCameraStream

```
{
  id, clubId, cameraId, matchId?, sessionRef,
  status: ACTIVE | PAUSED | CLOSED,
  openedAt, closedAt?,
  packetsTotal, eventsTotal, syncVersion,
  metadata?: Json
}
```

`(cameraId, sessionRef)` is unique — one stream per (camera, session).

### VisionEventBatch (high-rate append-only)

```
{
  id, streamId, clubId, matchId?,
  monotonicMs,      // server frame
  cameraTsUs,       // device frame, μs
  kind: 'RAW' | 'AGGREGATED' | 'DOWNSAMPLED',
  events: VisionEvent[],     // tuple form: [tMicros, x, y, polarity, extra?]
  eventCount, sigB64, nonce
}
```

**No row per individual event.** A batch holds up to 5_000 events.
Storage cost: O(1 row / batch).

### VisionEvent (TS-only tuple)

```ts
type VisionEvent = [
  tMicros: number,
  x:       number,
  y:       number,
  polarity: 0 | 1,
  extra?:  Record<string, unknown>,
];
```

### VisionTimestampSync

```
{
  cameraId, sessionRef,
  deviceUs, serverRxMs,
  skewMs, jitterMs?,
  version,         // bumped on every re-anchor
  isActive
}
```

`globalMsFor(cameraId, sessionRef, deviceUs)` returns the server-frame
millisecond for any device-frame microsecond.

### CameraRig + MultiCameraObservation + SpatialTriangulationResult

Multi-camera fusion. The triangulator is a pure function exposed by
`src/vision/triangulation.ts` (Phase G) and reused here. Each fused
observation persists:

- `MultiCameraObservation` — references the contributing cameras
- `SpatialTriangulationResult` — the 3D consensus point with votes + residual

### Visual tactical signals

8 detectors emit `VisualTacticalSignal` rows:

| Kind | What it captures |
|---|---|
| FORMATION | Closest template match + similarity |
| PRESSING | pressureMass + synchronyIndex |
| DEFENSIVE_LINE | lineX + spreadY + stability |
| OVERLOAD_ZONE | Per-cell home/away delta |
| SPACE_CREATION | Largest opp-to-opp gap |
| TRANSITION_MOMENT | HOME sprint density |
| COUNTERATTACK | HOME sprints in opp half |
| POSITIONAL_COLLAPSE | Stretched Y-spread |

Each row carries `detectorVersion = "v1"` for replay safety.

### BiomechanicalPacket

```
{
  id, clubId, matchId?, playerId?, deviceId?,
  monotonicMs, deviceTsMs,
  lactateMmol?, glucoseMg?, hydrationPct?, cortisolProxy?,
  payload? : Json,
  sigB64?, nonce?
}
```

Anchored to a Phase F `Device` via `deviceId`. HMAC verified when
`sigB64 + nonce` are present.

### Neuromorphic metrics (pure functions)

`src/vision/neuro-metrics.ts` exports 8 versioned pure-function metrics:

| Metric | Range | Inputs |
|---|---|---|
| eventMotionLoad | 0..1 | events count + density + sprint count |
| visionReactionDelay | 0..1 | burst onset μs + player motion onset μs |
| tacticalVisualDelay | 0..1 | cue ms + centroid shift ms |
| ballPressureGradient | -1..1 | samples of (tMs, oppNear) |
| spatialCollapseIndex | 0..1 | samples of (tMs, spreadX, spreadY) |
| transitionSharpnessScore | 0..1 | velocity vectors before/after |
| defensiveLineStability | 0..1 | samples of (tMs, lineX, spreadY) |
| pressingSynchronyIndex | 0..1 | sprinter ratio + start-time stddev |

`NEURO_METRICS_VERSION = "k1"` — any logic change bumps this constant.

---

## 3. Patent strategy

The defensible boundaries (claim surfaces):

1. **Event-camera + wearable fusion** — combining asynchronous μs events
   (Prophesee class) with seconds-scale biochemical patch packets and
   wearable IMU/HR into a deterministic per-player tactical state vector.
2. **Microsecond event alignment** — `VisionTimestampSync` mapping
   `(cameraId, sessionRef, deviceUs) → server ms`, with append-only
   versioned anchors so any historical packet can be reprojected.
3. **Digital twin replay from event streams** — reconstructing a
   SpatialFrame at arbitrary t by replaying VisionEventBatch +
   SpatialFrame + AIAgentDecision rows through the deterministic
   interpolator.
4. **Edge AI vision + secure device identity** — `EdgeVisionRuntime` +
   `EdgeModelVersion` + HMAC-signed inference packets + audit-chain
   anchoring of every result.
5. **HMAC-signed vision packets** — packet envelope of
   `(cameraTsUs, nonce, sha256(payload-json))` HMAC-SHA256-signed with
   `Camera.hmacSecret`, anti-replay LRU.
6. **Camera calibration trust chain** — versioned `CameraCalibration`
   (Phase G) referenced by `MultiCameraObservation` so any reprojection
   pins the exact intrinsics in force at capture.
7. **AI-generated annotations anchored into audit chain** — every
   `VisualTacticalSignal` / `TacticalPatternDetection` write also calls
   `appendAuditEventAsync` so a tampered detector output is detectable.

---

## 4. Security model

| Mechanism | Phase | Scope |
|---|---|---|
| HMAC-signed vision packets | K | `/neuro/streams/:id/event-batch` HMACs against `Camera.hmacSecret` |
| Anti-replay nonce | I + K | LRU (50_000 / 1h) on (camera, nonce) |
| TS skew gate | C + K | ±5 min on `cameraTsUs ↔ Date.now()` |
| Tenant gate | A + I | `tenantGuard` on all `/neuro` routes |
| Audit chain anchoring | I | Every detector + stream lifecycle row appends to `SecurityAuditEvent` |
| Sensitive field policy | I | Biomech payloads marked BIOMETRIC; never logged in plaintext |

No raw secrets in logs: `Camera.hmacSecret` and `Device.hmacSecret` are
returned ONCE at registration and never re-emitted from any service.

---

## 5. Future hardware implications

The schema was designed to drop into:

| Hardware | Integration point |
|---|---|
| Prophesee event camera | `CameraKind.EVENT`, `VisionEventBatch` |
| Standard RGB camera | `CameraKind.RGB`, existing Phase G `VisionFrame` |
| Depth camera | `CameraKind.DEPTH`, `worldZ` in detections |
| Panoramic / 360° rig | `CameraKind.PANORAMIC` + `CameraRig` grouping |
| Wearable POV camera | `CameraKind.WEARABLE` + bound to Phase F `Device` |
| NVIDIA Jetson edge box | `EdgeVisionRuntime.hwClass = "JETSON_ORIN"` |
| Biochemical patch | Phase F `Device` + `BiomechanicalPacket` |

None of these require code changes when the hardware ships — only
registration via the existing provisioning surface.

---

## 6. Implementation roadmap

**Today (delivered in Phase K):**
- ✅ Schema: 22 models + 6 enums (additive)
- ✅ TS contracts (`src/vision/neuromorphic-types.ts`)
- ✅ Services: event streams, camera rigs, edge vision runtime,
  biomech ingest, visual tactical engine, neuromorphic metrics
- ✅ REST surface under `/api/v1/neuro/*`
- ✅ Audit-chain anchoring on every detector mutation
- ✅ HMAC verification + anti-replay on event ingest

**Next (Phase L candidates, not in this phase):**
- Vision-event subscriber that feeds the Phase G `CognitiveSpatialEngine`
  with `INTERPOLATED` rows when wearable/sensor data is sparse.
- WebSocket / SSE channel for `VisualTacticalSignal` so the Tactical OS
  Brain tab can light up in realtime.
- A pre-built EdgeModelManifest seed for the first vision pipeline
  (`PLAYER_DETECT_V1`, `BALL_TRACK_V1`, `POSE_LITE_V1`).
- Long-running edge replay-from-archive endpoint (`POST /streams/:id/replay`)
  that re-derives all downstream signals deterministically.

**Hardware milestone (M1):**
- Two RGB cameras on a CameraRig in EU region
- HMAC-signed packets at 25 Hz aggregation
- Player detection inference at the edge
- Spatial fusion in the cognitive engine
- Tactical OS visualisation

**Hardware milestone (M2):**
- One Prophesee event camera per rig (corner mount)
- VisionEventBatch ingest at 100k events/s aggregated
- Visual tactical engine running per second
- Audit chain replay verification weekly

---

## 7. Runbook

### Smoke check (local)

```bash
node scripts/boot-probe.js
# expects [200] /api/v1/health + 401s on all /neuro/* surfaces
```

### Open + close a stream (operator)

```
POST   /api/v1/neuro/streams        { cameraId, sessionRef, matchId? }
POST   /api/v1/neuro/streams/:id/close
```

### Ingest an event batch (edge node, HMAC)

```
POST   /api/v1/neuro/streams/:id/event-batch
       { cameraTsUs, kind, payload, sigB64, nonce }
       sigB64 = HMAC-SHA256(cameraHmacSecret, `${cameraTsUs}.${nonce}.${sha256(payload-json)}`)
```

### Run a tactical detector

```
POST   /api/v1/neuro/matches/:matchId/detect/PRESSING
       (or FORMATION, DEFENSIVE_LINE, OVERLOAD_ZONE, SPACE_CREATION,
        TRANSITION_MOMENT, COUNTERATTACK, POSITIONAL_COLLAPSE, PATTERN)
```

### Pure-function metric snapshot

```
POST   /api/v1/neuro/metrics/snapshot
       { motion, reaction, visual, pressure, collapse, transition, defense, synchrony }
       → { version: "k1", metrics: { … } }
```

---

## 8. Determinism invariants

- `VisionEventBatch.monotonicMs` is server-set on receipt and never mutated.
- `VisionTimestampSync.version` is monotonically increasing per
  `(cameraId, sessionRef)`. Old versions remain queryable.
- `detectorVersion = "v1"` is pinned on every row. Bump on logic change.
- `NEURO_METRICS_VERSION = "k1"`. Bump on metric formula change.
- All tables are append-only; soft-delete is the only "delete" semantics
  used anywhere in Phase K.

A replay of any historical match against the current detector code will
produce IDENTICAL outputs as long as detectorVersion / NEURO_METRICS_VERSION
have not changed.
