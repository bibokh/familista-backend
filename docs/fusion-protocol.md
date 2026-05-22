# Cognitive Sensor-to-Vision Spatial Fusion Protocol (CSVSFP)

> Familista — Phase D-IP technical specification.
> Status: **prototype + reference implementation shipped (read-only API + Python framework). Hardware integration is the next milestone.**

---

## 1 · Executive technical summary

Familista is consolidating its hardware + software stack around a single integration primitive: **the FusionPacket**. Every heterogeneous sensor in the ecosystem — wearable IMU/GPS/ECG, epidermal biochemical patch, neuromorphic event-based camera, smart-turf node, AI camera, smart ball, human match operator — produces packets that are projected onto **one monotonic global timestamp axis** and grouped by `(deviceSessionId, clubId, teamId, matchId)`.

The fusion protocol then derives two deterministic, named, reproducible metrics per player per time window:

- **Biomechanical Load Index (BLI)** — z-scored aggregate of accelerometric load, sprint load, HR stress, joint strain, and mechanical work.
- **Tactical Attrition Index (TAI)** — bounded [0,1] composite of BLI, biochemical fatigue gradient, tactical reaction delay, positional deviation from the formation template, sprint-velocity degradation, recovery lag, and external injury-risk probability.

The IP is **not any single sensor or score**. It is **the synchronisation + fusion + interpretation protocol** that ties asynchronous neuromorphic vision events to slow biochemical patch readings to high-rate IMU streams to low-rate human tactical events — all under one timestamp, one tenant model, one sport-pluggable interpretation layer, one cloud API contract.

Shipped this phase (production-safe, additive):
- `src/fusion/{types,timestamp,metrics,fusion.service,realtime-ingest}.ts`
- `src/controllers/fusion.controller.ts`
- `GET /api/v1/matches/:id/fusion` (auth + tenant gated)
- `SensorPacket` ingest now fans out to `MatchChannel` (live updates)
- `python/familista_fusion/` — full OOP reference framework + smoke tests
- This document

Untouched: login, dashboard, Players module, SaaS Phase A, Match Phase B, Realtime Phase C, Render deployment, existing schema.

---

## 2 · Patent-oriented system description

### 2.1 The claim, in plain words

> A unified sports intelligence protocol that synchronises heterogeneous sensor streams — including frameless neuromorphic event-based vision, epidermal biochemical electronics, wearable biomechanical telemetry, and tactical positioning — under a single per-session timestamp synchroniser, applies edge AI compression at the sensor PCB, transports packets through a tenant-isolated transport with HMAC integrity, and interprets the fused stream through a sport-pluggable tactical engine that emits a Tactical Attrition Index for real-time match-intelligence and automation.

### 2.2 Specific innovation surfaces

1. **Tenant inheritance through session, not packet.** The PCB never declares clubId/teamId/matchId. Packets carry only `deviceSessionId + sigB64`. The backend resolves tenancy from the session row, never from the packet — preventing spoofed cross-tenant ingestion.
2. **Per-session clock + drift estimator** with one EMA-smoothed offset + one ppm-bounded drift slope (O(1) memory per session). Allows microsecond-accurate neuromorphic events to align with second-precision biochemical readings.
3. **Compact FusionPacket envelope** universal across sport types — same shape for football, tennis, basketball, athletics. Plugins (`SportPluginBase`) handle interpretation; the engine itself is immutable.
4. **Tactical Attrition Index** — a bounded scalar combining biochemical, biomechanical, tactical, and injury-risk signals with explicit weights + clamps. Versioned (`FUSION_METRICS_VERSION='v1.0'`) for regulatory reproducibility.
5. **Edge AI compression hand-off**: when the wearable PCB pre-computes `edge.fatigue_score`, the cloud calculator uses it as a tie-breaker rather than recomputing. This makes the protocol economical at scale without changing the API.
6. **HMAC handshake → short-lived device JWT**: device proves possession of `sessionKey` via `HMAC-SHA256(sessionKey, ts + '.' + nonce)`, server issues a 4-hour scoped JWT. Patentable boundary: device never possesses tenant identifiers.

### 2.3 What is NOT being claimed

- Any single sensor (GPS modules, IMU chips, ECG AFE, event cameras — all prior art).
- Any single metric in isolation (BLI's components mirror sports-science literature).
- Generic football/tennis tactics.

The claim space is the **integration protocol + timing + tenant model + sport-pluggable interpretation** — the fabric, not the threads.

---

## 3 · Full sensor-to-vision fusion architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        FAMILISTA SPATIAL FUSION FABRIC                     │
└────────────────────────────────────────────────────────────────────────────┘

  EDGE                            INGEST                       FUSION + CLOUD
  ───────────────────             ─────────────                ────────────────────────

  Wearable PCB (ESP32-S3)         Device handshake            SensorPacket persistence
   ├ IMU 100 Hz                   /api/v1/devices/             prisma.sensorPacket.createMany
   ├ GPS 10 Hz                      auth/token                                │
   ├ ECG / HR 250→1 Hz             ↓ device JWT (4h)                         ▼
   ├ Edge AI (joint strain,      Packet ingest                ✦ realtime-ingest.ts ✦
   │   fatigue score)              /sessions/:id/                  publish() →
   ├ HMAC sign(sessionKey)         packets[/batch]              MatchChannel /ws/match/:id
   └ Compression (Δ-coded)            (acceptUserOrDevice)             │
                                                                       ▼
  Epidermal Biochem Patch                                       FusionFrame builder
   ├ Lactate, cortisol, glucose                                 GET /api/v1/matches/:id/fusion
   ├ IBC → wearable hub                                                 │
   └ Wear-time quality decay                                            ▼
                                                                BLI · TAI per player
  Neuromorphic Camera (DVS)                                            +
   ├ Asynchronous events                                        TacticalAnnotations (plugin)
   │   {x, y, p, t_us}                                                  │
   └ Hot-window filter (50 ms)                                          ▼
                                                              SPA · AI agent · automation
  Smart Turf Node                                                       │
   └ Pressure / contact                                                 ▼
                                                              Big-data lake (Phase E)
  Smart Ball (future)                                          Kafka topic fam.sensor.v1
   └ x, y, z, v                                                Flink features → ML registry

  Human Operator                                               Patent-protected
   └ MatchTimeline (Phase B)                                   integration boundary
```

Two flows merge into the FusionFrame:
- **Hot path (writes)**: every packet emits a tiny channel summary so the SPA tactical board updates in <1 s without polling.
- **Cold path (reads)**: `GET /matches/:id/fusion` runs `computeFusionFrameForMatch()`, integrates the persisted SensorPacket history with MatchTimeline + Lineup, and returns per-player BLI + TAI + spatial state with diagnostic notes.

---

## 4 · Timestamp synchronisation model

### 4.1 Notation

| Symbol | Meaning |
|---|---|
| `t_dev` | device-local monotonic counter (µs) |
| `t_srv` | server reception wall clock (ms since epoch) |
| `offset` | offset(ms) = t_srv − t_dev/1000 |
| `drift` | drift slope (ppm) of device clock vs server |
| `α` | EMA smoothing factor — `0.05` for stability |
| `Δt` | elapsed device time since last anchor |

### 4.2 Estimator

For every received packet:

```
offset(n) = (1 − α)·offset(n−1) + α·(t_srv − t_dev/1000)

sample_drift_ppm = ((Δ_dev − Δ_srv) / Δ_srv) · 1e6              # clamp to ±200
drift(n)         = (1 − α)·drift(n−1) + α·sample_drift_ppm
```

### 4.3 Projection

To project any device microsecond timestamp onto the global axis:

```
global_ms(t_dev) = t_dev/1000 + offset − drift_correction(Δt_ms)
drift_correction(Δt) = drift_ppm · Δt / 1e6
```

### 4.4 Properties

- **O(1) memory per session**: just two scalars (offset, drift) + last anchor.
- **No NTP dependency**: server is the authoritative clock; device clocks may free-run.
- **Robust to jitter**: EMA suppresses single-packet spikes.
- **Robust to disconnect**: when a device reconnects, the synchroniser re-bootstraps from the next packet.

Reference implementations:
- TS: `src/fusion/timestamp.ts` — used at runtime in the API.
- Python: `python/familista_fusion/core/timestamp.py` — used in research notebooks.

---

## 5 · Mathematical equations — BLI and TAI

### 5.1 Biomechanical Load Index (BLI)

Per player `p`, over window `W` ending at `t`:

```
BLI(p, t, W) = w_A·z(A) + w_S·z(S) + w_H·z(H) + w_J·z(J) + w_M·z(M)
```

Component definitions (continuous form; sampled in code):

| Symbol | Definition | Units |
|---|---|---|
| `A` | `∫_{t-W}^{t} \|a(τ)\|² dτ`, where `a` is accel vector with gravity removed | (m/s²)²·s |
| `S` | `∫_{t-W}^{t} 1{\|v(τ)\|>v_sprint} · \|v(τ)\|² dτ`, `v_sprint = 7 m/s` | m²/s²·s |
| `H` | `∫_{t-W}^{t} max(0, HR(τ) − HR_*)² dτ`, `HR_* = 160 bpm` | bpm²·s |
| `J` | `∫_{t-W}^{t} \|ω(τ)\|² · m_limb dτ` (IMU rotational velocity proxy) | kg·rad²/s |
| `M` | `½·m_player · Σ Δv²` (mechanical work proxy from GPS speed deltas) | J |

Z-score is taken against player baseline (last 7 days):

```
z(X) = clamp((X − μ_X)/σ_X, −3, +3)
```

Weights (sum = 1.0, version v1.0):

```
w_A = 0.30   w_S = 0.25   w_H = 0.20   w_J = 0.15   w_M = 0.10
```

Resulting `BLI ∈ approximately [−3, +5]` (mechanical work tail can mildly exceed because component clamps cap inputs but combined weights are 1.0).

### 5.2 Tactical Attrition Index (TAI)

```
TAI(p, t) = w_b · σ(BLI)
          + w_f · σ(z(dF/dt))
          + w_d · σ(z(δ_T))
          + w_p · σ(z(Δ_P))
          + w_r · σ(z(R))
          + w_s · (1 − r_sprint)
          + w_i · P_injury
```

| Symbol | Definition |
|---|---|
| `σ` | logistic sigmoid `1/(1+e^{-x})` |
| `dF/dt` | biochemical fatigue gradient (mmol·L⁻¹·min⁻¹ for lactate), substituted by `σ(BLI)` when patch absent |
| `δ_T` | mean reaction time (s) between opponent action and our tactical response |
| `Δ_P` | mean L2 distance (m) between expected and actual position |
| `R` | mean recovery lag between sprints (s) |
| `r_sprint` | ratio of recent peak v_max to first-15-min v_max; `1 − r_sprint` ∈ [0,1] is sprint degradation |
| `P_injury` | external probability ∈ [0,1]; fallback `σ(BLI − 1)` |

Weights (sum = 1.0):

```
w_b = 0.35   w_f = 0.15   w_d = 0.10   w_p = 0.10   w_r = 0.10   w_s = 0.10   w_i = 0.10
```

`TAI ∈ [0,1]`. Higher = closer to tactical breakdown / substitution / injury.

### 5.3 Reproducibility

Both `FUSION_METRICS_VERSION` and every weight + threshold are exported constants:

- `src/fusion/metrics.ts` — `BLI_WEIGHTS`, `TAI_WEIGHTS`, `SPRINT_THRESHOLD_MPS`, `HR_STRESS_THRESHOLD_BPM`
- `python/familista_fusion/metrics/{bli,tai}.py` — same identifiers

A regulator can reproduce any historical TAI value from the raw packet log + the version constant alone.

---

## 6 · Python OOP prototype framework

Package: `python/familista_fusion/`

| Module | Class / function |
|---|---|
| `core/timestamp.py` | `GlobalTimestampSynchronizer` |
| `core/packets.py` | `FusionPacket`, `PlayerStateVector`, `GPSReading`, `IMUReading`, `ECGReading`, `BiochemReading`, `PoseReading`, `NeuroVisionEvent`, `BallReading`, `TacticalEvent` |
| `core/fusion_engine.py` | **`SensorVisionFusionEngine`** — immutable core, sport-agnostic |
| `adapters/neuromorphic.py` | `NeuromorphicVisionAdapter` |
| `adapters/biochemical.py` | `BiochemicalPatchAdapter` |
| `adapters/biomechanical.py` | `WearableBiomechanicsAdapter` |
| `tactical/base.py` | `SportPluginBase` (abstract), `TacticalAnnotations`, `TacticalContextEngine` |
| `tactical/football.py` | `FootballTacticalPlugin` |
| `tactical/tennis.py` | `TennisTacticalPlugin` |
| `metrics/bli.py` | `biomechanical_load_index`, `BLIInputs`, `BLIResult`, `BLI_WEIGHTS` |
| `metrics/tai.py` | `tactical_attrition_index`, `TAIInputs`, `TAIResult`, `TAI_WEIGHTS`, `TacticalAttritionModel` |
| `tests/test_smoke.py` | 6 deterministic smoke tests |

**Public contract** (one example — Football end-to-end):

```python
import familista_fusion as ff
from familista_fusion.core.packets import FusionPacket, GPSReading

engine = ff.SensorVisionFusionEngine(plugin=ff.FootballTacticalPlugin())
engine.ingest(FusionPacket(
    kind='GPS', ts=1_700_000_000_000,
    deviceSessionId='session-uuid', clubId='club-uuid',
    matchId='match-uuid', playerId='player-uuid',
    payload=GPSReading(lat=52.5, lon=13.4, speed=8.0, x=50.0, y=30.0),
))
features = engine.features('match-uuid')
print(features['states'])          # PlayerStateVector list
print(features['annotations'])     # TacticalAnnotations (football plugin)
print(features['bli'])             # {playerId: BLIResult}
print(features['tai'])             # {playerId: TAIResult}
```

To switch sport: `engine.tactical.set_plugin(ff.TennisTacticalPlugin())` — fusion engine is unchanged.

---

## 7 · Familista OS integration plan

| Familista module | Today | After Phase D-IP |
|---|---|---|
| **Match Center** | shows matches, status, score | `+ Fusion` tab fetches `/matches/:id/fusion` and shows BLI/TAI per player |
| **Live Match Engine** | timeline + lineup + tactical snapshot via WS | Same WS now also fans out sensor packet summaries from `realtime-ingest.ts` |
| **Tactical Board** | read-only SVG pitch | Pitch reads `FusionFrameRow.state.x/y` for live positions (Phase E) |
| **Player Profile** | medical / payment / GPS history | `+ BLI/TAI history` chart from `/fusion` per-window calls (Phase E) |
| **Medical Center** | static injury list | Subscribes to `MEDICAL` AIAgent jobs whose input is `FusionFrame.diagnostics` |
| **AI Tactical Assistant** | LLM agent worker | Now receives `FusionFrame` as input; prompt asks for adjustments by reading `team_shape` + `pressing_index` |
| **AI Medical Assistant** | LLM agent worker | Now receives per-player BLI/TAI + biochem readings as input |
| **Device Management** | DeviceSession list | Diagnostics in `FusionFrame.diagnostics.sessions` show offset + packet count |
| **Big Data Engine** | placeholder | `realtime-ingest.ts` is the future Kafka producer — same publish call, different sink |
| **Automation System** | task → run → agent | `MATCH_RECAP` agent reads `/fusion` for stat-rich post-match generation |

**No existing module is broken.** The fusion layer is read-only against the persisted data; it sits *next to* every consumer rather than *between* them.

---

## 8 · PCB / wearable / camera architecture implications

### 8.1 Wearable PCB (ESP32-S3 reference)

- **MCU**: ESP32-S3 dual-core 240 MHz + 512 KB SRAM. Cost target < $8 BOM @ 10k volume.
- **Sensors**:
  - IMU: Bosch BMI270 (6-axis @ 100 Hz)
  - GPS/GNSS: u-blox MAX-M10 (10 Hz)
  - ECG/HR: Maxim MAX30003 (250 Hz AFE, 1 Hz HR exported)
- **Radio**: BLE 5.0 (mesh-capable) + Wi-Fi (uplink during sessions).
- **Edge AI**: TFLite-Micro model: 64-neuron MLP on top of `[acc_var, gyro_var, hr_delta]` → `fatigue_score ∈ [0,1]`. Exported as a `HEALTH_BUNDLE` packet every 5 s.
- **Crypto**: ESP32-S3 has hardware AES + SHA-256. The `sessionKey` (32 bytes) is stored in eFuse blocks (immutable post-provisioning). HMAC is computed in hardware on each packet — no plaintext key ever in RAM.
- **Storage**: 8 MB flash; circular log for offline buffering when the field has no Wi-Fi.

### 8.2 Smart turf node

- **MCU**: ESP32-C3 (single core, cheaper).
- **Sensors**: piezoelectric pad (foot contact), Hall sensor (ball pass), microphone (whistle / impact).
- **Mesh**: BLE mesh between nodes; one gateway uplinks via Wi-Fi.
- **Packet**: `TURF_NODE` kind with `{event, magnitude, duration_ms}`.

### 8.3 Neuromorphic camera

- Prophesee Gen4 or Inivation DVXplorer.
- Captured events are batched at the edge box, decoded to `{x, y, p, t_us}`, packed into 32-byte structs, transmitted as `NEURO_VISION_EVENT` packets (batch 500 / call).
- **Critical**: do NOT downconvert to frames at the edge — the patentable boundary requires the event stream to reach the cloud intact so the fusion engine retains microsecond precision.

### 8.4 Smart ball (future)

- IMU + GPS + LPS triangulation. Outputs `BALL` packets at 100 Hz with `{x, y, z, vx, vy, vz}`.

### 8.5 PCB provisioning flow

```
Factory → bake unique deviceSerial into eFuse
Operator opens DeviceSession via app → server returns sessionKey
sessionKey flashed to eFuse via secure provisioning tool (one-time)
First handshake: device computes HMAC(sessionKey, ts + nonce) → backend → JWT
Field use: device posts /devices/sessions/:id/packets/batch with JWT
```

---

## 9 · Big-data pipeline direction

```
                 ┌─────────────────────────────────────────────────────┐
                 │           Familista API (today)                     │
                 │   SensorPacket → Postgres → Channel → SPA           │
                 └────────────────────┬────────────────────────────────┘
                                      │ same publish() facade
                                      ▼
                 ┌──────────────────────────────────────────────────────┐
                 │         Phase E: Kafka topic  fam.sensor.v1         │
                 │                                                      │
                 │  Producer = MatchChannel publish() (no code change)  │
                 │  Consumers:                                          │
                 │   1. cold archive (S3 + parquet)                     │
                 │   2. Flink: tactical features (every 1s)             │
                 │   3. Feature store (Feast) → ML registry             │
                 │   4. Replay simulator (digital twin)                 │
                 └──────────────────────────────────────────────────────┘
                                      │
                                      ▼
                 ┌──────────────────────────────────────────────────────┐
                 │  Phase F: ML model registry                          │
                 │   - injury_risk_v2 (XGBoost on 30-day window)        │
                 │   - tactical_phase_classifier (LSTM)                 │
                 │   - pose_keypoint_smoother (transformer)             │
                 │  Served by /api/v1/ai/predict/<model> (Phase F)      │
                 └──────────────────────────────────────────────────────┘
```

**Today's compatibility guarantee**: every byte we write to `SensorPacket` and every event we `publish()` is already shaped as an append-only event with `(ts, kind, payload)`. The Phase E Kafka producer drops in as one additional subscriber on `MatchChannel` — zero schema rewrites needed.

---

## 10 · Step-by-step implementation roadmap

| Phase | What | Status |
|---|---|---|
| A | Multi-tenant SaaS (Team, Membership, Context) | ✅ shipped |
| B | Match Intelligence (Lineup, Timeline, Tactical, DeviceSession, AIAgentJob inbox) | ✅ shipped |
| C | Realtime WS + AI agent worker + Automation scheduler + Device auth | ✅ shipped |
| **D-IP** | **Fusion protocol — types, equations, fusion service, realtime ingest, Python framework** | ✅ **shipped (this turn)** |
| D-UI | Match Detail drawer "Fusion" tab — render BLI/TAI per player + low-confidence badges | next |
| E.1 | Kafka producer on MatchChannel (`BIG_DATA_KAFKA_URL` env) | future |
| E.2 | Flink job: tactical feature extractor (rolling window) | future |
| E.3 | Feature store + replay simulator | future |
| F | ML registry — first three models | future |
| G | PCB Rev-A board file + edge SDK (TS reference for ESP32-S3) | hardware track |
| H | Patent prosecution: PCT filing + claims drafted from `metrics.ts` weight table | legal track |

---

## 11 · What should be implemented NOW vs LATER

**NOW (already done in this turn, no further action needed):**
- ✅ FusionPacket types (TS + Python in lockstep)
- ✅ Global timestamp synchroniser (TS + Python)
- ✅ BLI + TAI math with versioned weights
- ✅ Fusion service that reads existing SensorPacket + MatchTimeline data
- ✅ `/api/v1/matches/:id/fusion` endpoint (auth + tenant gated)
- ✅ Realtime ingest bridge (SensorPacket → MatchChannel)
- ✅ Python `SensorVisionFusionEngine` + Football + Tennis plugins
- ✅ Documentation (this file)

**LATER (do not implement yet — risks):**

| Item | Risk if rushed |
|---|---|
| Live PCB ingestion at 100 Hz IMU × 22 players | DB will hit `INSERT` ceiling — needs partitioning + Kafka mirror |
| Drag-and-drop tactical board UI | UX still needs design review — Phase D-UI |
| `MatchTacticalSnapshot` auto-capture every 30 s | Will multiply snapshot rows × matches × season — needs archival policy |
| Real ML models (injury risk, tactical phase) | Need labelled data — collect first |
| Neuromorphic camera ingestion in production | Need event-camera firmware tested at venue first |
| Biochemical patch live integration | Need IRB/ethical sign-off per jurisdiction |

---

## 12 · Exact safe next development step inside current platform

**Single concrete next step:**

> Add a "Fusion" tab to the existing Match Detail drawer in `familista_v5.html`.

It is the smallest possible change that:
- Touches zero backend code (the endpoint is already live).
- Touches zero schema (read-only call).
- Touches zero auth (`/matches/:id/fusion` reuses existing JWT).
- Renders the response into per-player TAI bars + diagnostic notes.
- Confirms end-to-end that the patentable layer is reachable from the SPA.

Code shape (suggested, ~80 lines):

```js
// In renderMatchModalTab() add a new case:
if (tab === 'fusion') {
  const r = await FamilistaAPI.get('/matches/' + State.activeMatch.id + '/fusion');
  const f = r && r.data;
  if (!f) return c.innerHTML = '<div class="empty">No fusion data</div>';
  c.innerHTML =
    '<div style="padding:18px;">' +
      '<div style="font-size:11px;color:var(--tx-3);margin-bottom:10px;">' +
        f.diagnostics.notes.join(' · ') +
      '</div>' +
      f.rows.map(r => `<div class="card" style="padding:12px;margin-bottom:6px;display:grid;grid-template-columns:1fr auto auto;gap:10px;">
        <div><strong>#${r.player.number}</strong> ${r.player.firstName} ${r.player.lastName}</div>
        <div style="font-family:var(--mono);color:${r.tai && r.tai.value > 0.6 ? 'var(--red)' : 'var(--green-l)'};">
          TAI ${r.tai ? r.tai.value.toFixed(3) : '—'}
        </div>
        <div style="font-family:var(--mono);color:var(--tx-3);">BLI ${r.bli ? r.bli.value.toFixed(2) : '—'}</div>
      </div>`).join('') +
    '</div>';
}
```

Add the corresponding tab button in `#match-tabs-nav`:

```html
<button class="filter-btn" onclick="setMatchModalTab('fusion',this)">Fusion</button>
```

Everything else (PCB, neuromorphic, biochemical, big-data) waits for the relevant hardware / data-pipeline phase.

---

**Files in this phase:**

```
src/fusion/types.ts                              ─ universal envelope + derived state types
src/fusion/timestamp.ts                          ─ TS GlobalTimestampSynchronizer
src/fusion/metrics.ts                            ─ BLI + TAI math (versioned weights)
src/fusion/fusion.service.ts                     ─ FusionFrame builder (read-only)
src/fusion/realtime-ingest.ts                    ─ SensorPacket → MatchChannel bridge
src/controllers/fusion.controller.ts             ─ thin HTTP shim
src/routes/match.routes.ts                       ─ + GET /:id/fusion mount
src/services/device-session.service.ts           ─ ingest paths now call emitSensorPacket / Batch

python/familista_fusion/__init__.py
python/familista_fusion/core/{__init__,packets,timestamp,fusion_engine}.py
python/familista_fusion/adapters/{__init__,neuromorphic,biochemical,biomechanical}.py
python/familista_fusion/tactical/{__init__,base,football,tennis}.py
python/familista_fusion/metrics/{__init__,bli,tai}.py
python/familista_fusion/tests/{__init__,test_smoke}.py

docs/fusion-protocol.md                          ─ THIS FILE
```

End of CSVSFP v1.0 spec.
