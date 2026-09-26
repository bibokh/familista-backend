# Familista Vision — the sixth platform module

A native Familista capability, not a second product. It takes the existing
shell, authentication, club scoping, event transport and historical store, and
adds no login, no event bus, no monitoring surface and no database table.

---

## 1 · Architecture

```
Familista Platform  (shell · auth · RBAC · club scoping · i18n)
        ↓
Familista Vision Module      public/familista-vision/  ·  17 sections
        ↓
Vision Device/API Contract   /api/v1/familista-vision  ·  src/vision-platform/
        ↓
VisionEngine  ← the seam                      ProcessingTarget
        ├── LOCAL_SERVER  reads session artefacts      ← today
        └── VISION_HUB    refuses, and says why        ← future hardware
        ↓
Sources → VIDEO_FILE today; 12 further types named, none implemented
```

**The seam is the point.** The platform never calls the engine; it calls a
`VisionEngine`, and a processing target decides which adapter answers. Selecting
`VISION_HUB` today runs the whole platform against an adapter that returns
`NOT_IMPLEMENTED` to every call. Nothing about the device is simulated — no
invented temperature, no invented battery, no invented camera count. When the
hardware exists, `engine-contract.ts` is the only file that changes.

---

## 2 · File tree

```
src/vision-platform/
├── engine-contract.ts        286  the portable seam: VisionEngine, LocalServerEngine,
│                                  VisionHubEngine, ProcessingTarget, telemetry
├── session-model.ts          243  what a session IS once the platform holds it
├── session-normaliser.ts     418  engine artefact → platform session. Decides
│                                  nothing the engine declined to decide
├── session-store.service.ts  135  load, cache, club scope. No new tables
├── session-timeline.ts       193  the session as a strip of time, gaps drawn
├── source-types.ts           156  14 source types, 1 implemented, 9 rig slots
├── vision-events.ts          194  17 versioned event names + zod payload schema
├── vision-source.ts           47  Vision on the Fabric source registry
├── vision-producer.ts        243  publishing onto the platform transport
├── vision-health.service.ts  201  14 capability rows for Infrastructure City
├── vision-access.ts           73  three rules joining a session to platform roles
└── vision-intelligence.contract.ts  178  evidence out; no field for a rating

src/routes/familista-vision.routes.ts   372  the API
src/routes/index.ts                      +4  mounted at /api/v1/familista-vision
src/infra/infrastructure-health.service.ts  +75  visionSignal() into the City

public/familista-vision/
├── familista-vision.js      1285  the module, all 17 sections
└── familista-vision.css      327  the design system, Vision's own tokens

public/app.js      +60   sixth card, shell ownership, allow-list, mount, probe
public/app.css     +40   grid area and accent for the sixth room
public/index.html   +2   assets
public/i18n/catalogue/*.json  +5 strings × 31 locales

scripts/vision-import-session.js  128  artefact → session store, verifying
tests/familista-vision.unit.test.ts  424  36 tests
vision-sessions/                     3 real validated sessions + README
```

---

## 3 · Nervous-system integration — what is real

| Link | How | Evidence |
|---|---|---|
| **Source Core** | `registerFabricSource({ id: 'vision', … })` | Source Core composes from the Fabric registry, so Vision appears in its flow, lineage and consumer map with no entry of its own |
| **Data Fabric** | 17 event types via `registerFabricEvents` + one zod payload schema | Travel through `publishFabricEvent` → the same outbox as every other domain |
| **Data Vault** | Session facts persist as events in the platform history | No new table; original evidence never rewritten |
| **Infrastructure City** | `visionSignal()` added to `infrastructureSignals()` | Joined by `healthKey` like every other component |
| **Familista Intelligence** | `evidenceFor(session)` | Positions with error bars and confirmed findings; no field exists for a rating |

### Why there are no new database tables

A Vision session is two things wearing one name. The **artefact** is original
evidence — immutable, because when a better model disagrees next year both
answers must be readable and attributable — so it stays with the engine,
read-only. The **facts** are events, and the platform already has durable,
replayable storage for events.

A `vision_session` table would have been a second history beside the Vault and a
second original beside the engine's.

**The cost, stated:** "every session this club ran in March" is answered by event
history rather than a SQL index, and that will be slower at scale. When session
*volume* rather than session *content* becomes the bottleneck, the fix is a
projection table built **from** the events — a read model, not a second source of
truth.

---

## 4 · API

All under `/api/v1/familista-vision`, behind the platform's `authenticate`.
Mounted on its own prefix because `/api/v1/vision` is the live Phase-G camera
module and a second meaning on the same path would collide silently.

| Route | Returns |
|---|---|
| `GET /status` | service health, 14 capability rows, viewer role |
| `GET /models` | models and providers, composed from visible sessions |
| `GET /sources` | 14 type specs, 9 rig slots, connected sources |
| `POST /sources` | `501 NOT_IMPLEMENTED` — no live-source adapter exists |
| `GET /sessions` | summaries, filtered by club on the server |
| `POST /sessions` | `501 NOT_IMPLEMENTED` — this deployment reads, does not infer |
| `GET /sessions/:id` | the whole normalised session |
| `GET /sessions/:id/summary` · `/tracks` · `/ball` · `/calibration` · `/teams` · `/events` · `/timeline` | the evidence, by kind |
| `GET /sessions/:id/evidence` | the Intelligence bundle |
| `GET /sessions/:id/reports` · `/export?kind=` | 8 export kinds incl. CSV |
| `GET /device` | identity + host telemetry, absences explicit |
| `GET /integrations` | the nervous-system flow and the event catalogue |

A session the viewer may not see returns **404, not 403** — a reader without
access should not learn that a session with that id exists.

No filesystem path crosses the boundary: a source is reduced to its file name
and its SHA-256 before anything reaches a response, and a test asserts it.

---

## 5 · Capability matrix

### LIVE NOW
Vision Engine (LOCAL_SERVER) · VIDEO_FILE sources · player detection and
tracking · identity segmentation · team classification · goalkeeper/referee
roles · pitch calibration with its validity gate · ball OBSERVED/PROPAGATED ·
PROXIMITY and CONTROL events · possession state machine · timeline · heatmaps
from calibrated history · exports with provenance · Model Registry with licence
verdicts · Source Core registration · 17 Fabric events · Data Vault persistence ·
Infrastructure City health · Intelligence evidence interface · club isolation

### READY / WAITING FOR FUTURE CAMERA
USB · UVC · IP · RTSP · ONVIF · Sony body · Main and four Corner camera slots.
The vocabulary, the session model and the source contract accept them; no
adapter is written.

### READY / WAITING FOR FUTURE HARDWARE
Familista Vision Hub · HDMI capture · Drone · Field Nodes · Player Pods · Ball
Sensor. The processing-target abstraction addresses the Hub today and it
refuses.

### NOT YET VALIDATED
Tactical intelligence (no formation, shape, zone, pressing or space result
exists) · physical metrics (speed, acceleration, distance, HSR, sprints,
stamina) · multi-camera fusion · any player rating, Quality score or mental
attribute.

---

## 6 · One real session through the platform

`original-clip` — `test_match.mp4`, 1024×576 @ 30.013 fps, quality HIGH.

| | Engine reported | Platform shows |
|---|---|---|
| frames · observations · identities | 301 · 4484 · 38 | identical |
| calibration coverage | 0.7176 | 71.8% |
| accepted anchors | 41 (HIGH 9 / MEDIUM 29 / LOW 3) | identical |
| expected metric error | 0.398 – 4.154 m | identical |
| anchor disagreement | 1.086 m | identical |
| metric positions | 4204 of 4484 | identical, on-pitch 100.0% |
| calibration NONE frames | 84 | drawn as its own timeline band |
| ball | 132 OBSERVED · 11 PROPAGATED · 12 UNKNOWN · 146 NOT_AVAILABLE | never summed |
| events | 13 PROXIMITY CONFIRMED | no CONTROL invented |
| speed guard | 42 spans · 1 withheld · 5 frames | shown as a guard, not a speed |

---

## 7 · Tests

**36 new**, in `tests/familista-vision.unit.test.ts`: the processing-target seam
swaps the engine; the Hub refuses everything; no reading is invented; a session
reference cannot escape the store; the platform reports the engine's numbers
unchanged; a withheld coordinate stays withheld; OBSERVED never merges with
PROPAGATED; the evidence bundle has no field for a rating; one club cannot see
another's session; an unowned session defaults to the narrow answer; the
registries are idempotent; no filesystem path crosses the boundary.

**Full suite: 3892 passed**, 137 suites, 0 failures. TypeScript clean. i18n gate
passes — the 5 new strings are in all 31 locale catalogues, 29 recorded as
pending translation in `public/i18n/_pending-translation.json` rather than
silently passed off as translated.

**Four pre-existing tests were updated**, not weakened: they asserted the
landing had five cards and a particular grid track. A sixth room is the change,
so they now assert six cards and the new track.

---

## 8 · Remaining limitations

1. **Landmark evidence per anchor shows an em dash.** This engine schema records
   the landmark sentence on the calibration state, not on each frame's
   provenance. The platform does not hold it, so it draws `—`. A later engine
   that publishes it per frame needs no change here.
2. **Live Analysis draws the annotation layer, not the video.** Boxes, ids,
   teams, roles and the ball marker come from stored observations rendered over
   a neutral frame. Playing the source video beside them needs a media path that
   does not exist yet.
3. **Session listing scales by reading every session.** Acceptable at three;
   the projection-table fix is described in §3.
4. **Club scope is declared, not inferred.** Sessions carry a club only when
   `FAMILISTA_VISION_SESSION_SCOPES` says so. The three fixtures are
   platform-scoped, so a club account sees none of them — which is the correct
   default and is asserted by a test.
5. **The i18n placeholders are English.** No translation provider is configured
   in this environment; with `ANTHROPIC_API_KEY` set, `i18n:sync
   --provider=anthropic` fills them properly.
6. **No live source, no queue, no in-process inference.** This deployment reads
   completed sessions. Starting one belongs to the engine, and on the Hub target
   to the device.

---

## 9 · The Vision Hub can use this architecture unchanged

The frontend never names a model, a checkpoint or a processing location. It
calls `/api/v1/familista-vision/...`. Those routes call a `VisionEngine`. A Hub
adapter implements four methods — `identify`, `listSessions`, `readSession`,
`telemetry` — over HTTP to the device instead of over a directory, and:

* the UI does not change;
* the event names, schemas and Vault records do not change;
* Source Core lineage does not change;
* club scoping does not change, because the engine never knew what a club was.

`VisionHubEngine` already exists and is already addressable. It answers
`NOT_IMPLEMENTED` because the hardware is not built — which is the honest answer
and, incidentally, the proof that the seam holds.
