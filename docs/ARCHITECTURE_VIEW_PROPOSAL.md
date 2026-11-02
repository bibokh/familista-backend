# Familista Architecture View — Proposal

Status: **DIRECTION APPROVED WITH REVISIONS (owner review, 2026-11-02). Nothing implemented.**
Phase 0 waits for the owner's explicit authorisation. No code, route, migration or UI
in the platform is changed by this document, and PR #146 is untouched.

Every count and path below was read from the repository at commit `83bb52e` (main) on
2026-11-02. Where a figure comes from a generated manifest, the generator and its
`generatedAt` are named. The interactive concept and its real-browser validation are
recorded in §9.

---

## 0. Decision record — owner review of 2026-11-02

| # | Decision | Effect on this proposal |
|---|---|---|
| 1 | Architecture separation **approved**. An independent, Platform-Owner-only system that composes Owner Control, Infrastructure City and the AI Agents Operations Room and replaces none of them. | §1, §4 unchanged in intent; the view links into the rooms and duplicates none of their responsibilities. |
| 2 | Visualisation **conditionally approved**. 2D and interactive 2.5D are the initial foundation. 3D is not excluded: the architecture must allow a future optional 3D mode (Babylon.js is already in the repository) without replacing the graph model. The initial implementation must not depend on 3D. | §3.6 rewritten around a renderer contract; 3D becomes an optional later phase (Phase 7) behind its own approval. |
| 3 | Status model **revised** into three independent dimensions: implementation maturity (Implemented, Partial, Planned, Unverified), runtime health (Healthy, Degraded, Unavailable, Not monitored), evidence (verified source, source reference, last verification, unknown or missing). Maturity is never proof of live operation; nothing unmeasured is ever healthy. | §3.3 rewritten. |
| 4 | Architecture graph **approved in principle**. One authoritative evidence pipeline, no competing source of truth, build-time graph and runtime health kept separate, nothing sensitive or tenant-specific exposed, server-side Platform Owner authorisation on the read API. | §3.1, §3.2 and §5 rewritten. |
| 5 | Infrastructure corrections **approved as a separate phase**: verify each against authoritative repository evidence, change no deployment behaviour, change no RLS enforcement, update generated evidence and tests, isolate in a dedicated PR. | §7 Phase 0 specified. **Not started; waits for authorisation.** |
| 6 | Approved roadmap categories, subject to repository verification: Digital University, Global E-Commerce Marketplace, Club Merchandise Design and Manufacturing, Global Multi-Agent Expansion, Field Intelligence, AI Camera and Video Intelligence Expansion. Media Network is a candidate needing separate approval. Smart Ball is **not** an approved implementation objective. Roadmap concepts, research prototypes, partial implementations and production components must be distinguished. | §2.5 verifies each category against the repository; §3.3 adds stage and approval attributes; new discrepancy D9. |
| 7 | Visual identity: a professional interactive engineering environment, not a dashboard and not a second Owner Control mind map; layers, real dependencies and flows, expandable systems, search and filtering, node inspection, zoom and pan, security and tenant boundaries, architectural history, modular expansion; aligned with Familista's identity. | §3.4 and §3.5 rewritten; §9 lists what the concept shows and what it does not yet. |
| 8 | Next action: update this document, validate the concept in a real browser (desktop, mobile, Arabic RTL), provide screenshots and limitations. No production implementation, no change to PR #146, no merge, no deploy, no Phase 0 without authorisation. | Done in this revision; §9. |

---

## 1. What it is, and what it is not

| | Owner Control (PR #146) | Infrastructure City | AI Agents Operations Room | **Architecture View** |
|---|---|---|---|---|
| Question | Where do I go? | What is the platform built from, and is it healthy? | What may each agent do, and who answers for it? | How does the whole platform fit together, and how sure are we? |
| Unit | a room | a component | an agent manifest | a system, its boundaries, its flows, its evidence |
| Form | landing mind map | city / map / topology / table of one manifest | registry room | layered engineering workspace across every registry |
| Changes | nothing | acknowledges incidents | nothing (kill switch lives in SYSTEM) | **nothing — read-only** |

The Architecture View is the cross-room layer that none of the existing rooms provides.
It follows the rule Source Core already set (`src/sources/source-registry.service.ts`):
**it discovers nothing, it composes.** Each fact keeps the single authority it already
has (§3.1), and every node links **into** the room that owns its detail.

---

## 2. Inventory — what the repository proves today

### 2.1 Evidence sources that already exist (the composer's inputs)

| Input | Generator / authority | What it gives the view |
|---|---|---|
| `src/infra/generated/infrastructure-manifest.json` | `scripts/infrastructure-discover.js` (generatedAt 2026-10-30) | 19 districts, 54 components (53 `ACTIVE`, 1 `NOT_CONFIGURED`), 17 relationships plus per-component `dependencies`, 7 `future` items, 55 route mounts, 30 technologies, 41 dependencies, 3 Render services, 4 CI workflows; surface: 65 route modules, 102 service modules, 24 middleware, 52 fabric modules, 619 TS files, 224 test suites, 49 migrations, 344 Prisma models, 209 enums |
| `src/cyber-defense/generated/security-manifest.json` | `scripts/security-discover.js` (generatedAt 2026-10-29) | 56 mounted routers, 764 handlers (public 21, member 350, scoped 60, roles 236, platform-owner 97), 8 dormant route modules, 7 realtime endpoints, 5 outbound call sites, tenancy (350 id parameters: 136 guarded, 214 exempt, 0 unguarded), 81 controls (79 present, 1 partial, 1 absent) |
| `src/cyber-defense/coverage-map.json` | reviewed, pinned by the posture test | 40 trust-boundary rows (34 covered; 6 partial: rows 1, 2, 5, 8, 17, 18) with flow, trust boundary, data class, controls and reason; every discovered component mapped to its rows |
| `src/cyber-defense/posture-policy.json` → `ownerRooms` | reviewed | the 10 owner-only routers and their mounts |
| `src/platform/system-modules.ts` | code registry | 24 SYSTEM modules (12 `LIVE`, 9 `PARTIAL`, 3 `NOT_INSTRUMENTED`); 25 `CLUB_MODULES` keys |
| `src/platform/capabilities.ts` | code registry | SYSTEM controls as `LIVE` / `PARTIAL` / `NOT_AVAILABLE` with risk level |
| `src/platform/agents/catalog.ts` + registry | code registry | 10 manifests, all `scope: CLUB`, `lifecycle: RUNNING`, ceiling `APPROVE`; no PLATFORM-scope agent |
| `src/platform/agents/generated/orchestration-evidence.json`, `published/` | lab generators | LAB orchestration evidence (not production runtime) |
| `src/fabric/registry/source-registry.ts` + Source Core `/flow`, `/:id/lineage` | code registry + owner API | data origins, intake, validation, consumers, lineage |
| `src/algorithms/generated/algorithm-manifest.json` | `scripts/algorithms-discover.js` | algorithms under change control |
| `src/design-system/generated/*.json` | `scripts/design-system-*.js` | token architecture, 60 components |
| `/system/infrastructure/stream` (SSE) | `src/infra/infrastructure-health.service.ts` | live health signals: `HEALTHY`, `WARNING`, `CRITICAL`, `NOT_CONFIGURED`, `NOT_INSTRUMENTED`, `UNVERIFIED`, `UNKNOWN` |

### 2.2 Real systems by area

| Area | Exists in the repository | State |
|---|---|---|
| Governance | SYSTEM (24 modules), Approval Center, Global Governance, Feature Flags, Experiments, Release Management, kill switch (`POST /system/agents/kill-switch`) | readiness per module |
| Infrastructure, APIs, databases | Express app, 56 mounted routers / 764 handlers, PostgreSQL via Prisma, Redis (private), object store, 8 worker files, WebSocket + SSE, Render ×3, GitHub Actions ×4 | Render deploy state not observable from the process |
| Security | JWT, RBAC, rate limiting, tenant guard, PostgreSQL RLS on 18 club tables, audit chain, 81 controls, 40 trust boundaries | 6 boundaries partial |
| Data | Data Fabric (event bus, durable outbox), Data Vault (historical store, history API), Source Core | cold archive `NOT_CONFIGURED`; snapshots and archive exporter are `future` |
| Agents | Agent Registry (10 RUNNING club agents), AI Gateway → Anthropic, runtime monitor, LAB orchestrator (`lab/orchestrator`) | the runtime refuses non-RUNNING agents |
| Vision | `/familista-vision/*` (status, models, sources, sessions, tracks, ball), `src/vision-platform/`, `python/familista_fusion/`, recorded sessions in `vision-sessions/`, video-transcode worker, HMAC-signed worker callbacks | external worker endpoints depend on environment |
| Club workspaces | 25 declared `CLUB_MODULES`; pages `club-home`, `squad`, `training`, `academy`, `video-intelligence`, `transfers`, `coach-market`, `familista-league`, … | see D6 |
| Design and commerce | Design System Control (owner API), Design Studio (browser-only UI-frame editor), Stripe billing for subscriptions, Phase M marketplace listings | see §2.5 |

Also present and easy to overstate: 8 dormant route modules (`admin`, `admin-dashboard`,
`ai-engine`, `executive`, `franchise`, `investor`, `vision-engine`, `whitelabel`), and
many `src/` domains from earlier speculative phases. Code existing is not a system
running; §3.3 keeps the two apart.

### 2.3 Discrepancies in the existing evidence (verified)

| # | Finding | Evidence |
|---|---|---|
| D1 | Every CI workflow gets a `DEPLOYS → render-familista-backend` edge, unconditionally, citing "render.yaml autoDeploy". `render.yaml` sets `autoDeploy: false`; only `deploy.yml` deploys, through `RENDER_DEPLOY_HOOK_URL`. `ci.yml`, `backup.yml` and `restore-drill.yml` contain no Render reference outside comments. | `scripts/infrastructure-discover.js:924-928`, `render.yaml:17`, `.github/workflows/deploy.yml` |
| D2 | Row-Level Security is listed under `future` while its own reason, and coverage-map row 5, record it enforced on 18 club tables. | `scripts/infrastructure-discover.js:943`, coverage-map row 5 |
| D3 | Every district's status is the default `ACTIVE`, not derived from evidence. | `scripts/infrastructure-discover.js:114` |
| D4 | Component `ACTIVE` means "a file exists", not "it runs". Only components with a `healthKey` have runtime state. | infra manifest; `src/routes/infrastructure.routes.ts:143` |
| D5 | The two manifests count routes differently (55 mounts vs 56 mounted routers) and were generated 13 h apart. | both manifests |
| D6 | `CLUB_MODULES` keys (`first-team`, `training-centre`, `match-center`) do not match the page slugs (`squad`, `training`); nothing maps one to the other. | `src/platform/system-modules.ts`, `public/app.js` |
| D7 | The owner-room list lives in three places not tied together: `_ALLOWED_PAGES`, `posture-policy.json` `ownerRooms`, and the `navTo` loaders. | as named |
| D8 | Source Core's header says the Fabric has eleven source domains; `source-registry.ts` declares ten statically. | as named |
| D9 | The infrastructure manifest lists Smart Ball under `future` as "On the product roadmap"; the owner decided on 2026-11-02 that it is not an approved implementation objective. The Prisma schema and `edge-node.service.ts` also name a smart-ball device type (data model only). | `scripts/infrastructure-discover.js` future list; `prisma/schema.prisma`; owner decision |

D1–D3 are Phase 0. D9 is **not** in Phase 0's approved scope; whether the manifest's
wording changes is a separate owner decision (§10). Until then the view shows both claims.

### 2.4 Missing architectural information (gaps)

| # | Gap | How to fill it without inventing |
|---|---|---|
| G1 | No domain-level dependency graph. | Extend `infrastructure-discover.js` with an import pass using TypeScript's own `ts.preProcessFile` (already a dependency). |
| G2 | No route → service → Prisma model map. | Same generator: record `prisma.<model>.<op>` call sites per file. |
| G3 | Prisma sections are named by delivery phase, not by domain. | A reviewed mapping file pinned by a test that fails on an unmapped section. |
| G4 | No registry of roadmap systems beyond 7 `future` items. | `planned-systems.json`, owner-approved (§2.5 is its first content). |
| G5 | Which connections carry real traffic. | `src/infra/api-traffic.ts` exists; not yet evaluated. No claim until it is. |
| G6 | Declared club modules → pages and routers. | Reviewed mapping, test-pinned (closes D6). |
| G7 | Deployment state. | Stays Not monitored; the process cannot see Render. |

### 2.5 Approved roadmap categories, verified against the repository

Searched on 2026-11-02 at `83bb52e`. "No code" means the named searches found nothing;
it is a claim about the repository, not about intent.

| Category | Owner status | Repository evidence | Classification in the view |
|---|---|---|---|
| Familista Digital University | Approved category | No module for university, course, curriculum or certification in `src/`. | **Planned** · roadmap concept |
| Global E-Commerce Marketplace | Approved category | `src/marketplace/marketplace.service.ts` ("Digital Marketplace Foundation (Phase M)"): `MarketplaceItem` with kinds `TRANSFER_LISTING`, `DEVICE_LISTING`, `SERVICE_LISTING`, `ACADEMY_PROGRAM`, `GENERIC`; listings only, no payment integration; mounted at `/phase-m/marketplace/listings`. Stripe handles subscriptions only. No cart, order, logistics or multi-currency code. | **Planned** · roadmap concept, built on a **Partial** foundation (marketplace listings) |
| Club Merchandise Design and Manufacturing | Approved category | No merchandise or manufacturing code. Design Studio (`public/design-studio/studio.js`) is a browser-only UI-frame editor; it is not evidence of merchandise design. | **Planned** · roadmap concept |
| Global Multi-Agent Expansion | Approved category | Agent Registry (10 RUNNING club manifests); `src/platform/agents/catalog.ts:14-15` defines the path: new agents join as DRAFT or LAB manifests in a reviewed PR. LAB orchestrator (AI-0.2 to AI-0.5). | **Planned** expansion on an **Implemented** registry; the orchestrator is a **research prototype** |
| Familista Field Intelligence | Approved category | Mounted `/spatial`, `/edge`, `/devices`, `/device-infra`; spatial fusion of vision and GPS (`src/spatial/cognitive-engine.ts`), edge nodes (`src/edge/edge-node.service.ts`), hardware lifecycle (`src/hardware/hardware.service.ts`), GPS fleet status (`src/gps/gps-status.service.ts`), turf-node packets in sensor ingest; match weather is an integration boundary with no provider configured (`src/competition/match-weather.service.ts`). No real device data verified. | **Partial** · partial implementation (software only) |
| AI Camera and Video Intelligence Expansion | Approved category | Vision routes (status, models, sources, sessions, tracks, ball), engine contract and session store (`src/vision-platform/`), `python/familista_fusion/`, recorded sessions, camera ingest, video-transcode worker. The expansion itself has no code. | **Planned** expansion on an **Implemented** foundation |
| Media Network | Candidate, needs separate approval | No media-network code. The HLS pipeline (`src/services/video-hls.service.ts`) serves club video; it is not a media network. | **Planned** · candidate concept |
| Smart Ball | Not an approved objective | Infrastructure manifest `future` entry; a smart-ball device type in the data model; no firmware, ingest or model. | **Planned** · "not an approved objective"; D9 |

---

## 3. Proposed technical architecture

### 3.1 One authoritative evidence pipeline

Every fact has exactly one authority, and the composer is not one of them:

| Fact | Single authority |
|---|---|
| Components, technologies, Render services, workflows, route mounts | `scripts/infrastructure-discover.js` |
| Handlers, authorisation kinds, tenancy, controls, dormant routes | `scripts/security-discover.js` |
| Trust boundaries and component → boundary mapping | `coverage-map.json` (reviewed) |
| Owner rooms | `posture-policy.json` `ownerRooms` (D7 later ties the front-end list to it) |
| SYSTEM modules and readiness, club modules | `src/platform/system-modules.ts` |
| Agents | `src/platform/agents/catalog.ts` |
| Data sources and lineage | the Fabric source registry |
| Roadmap systems, their stage and approval | `planned-systems.json`, owner-approved (new; the only new authority, and only for facts no generator can discover) |
| Runtime health | `infrastructure-health.service.ts` signals, at request time only |

```
generators & registries (authorities, unchanged)
        │  read-only, one direction
        ▼
Architecture Composer  ── derives, joins, maps; discovers nothing ──►  architecture-graph.json
 src/platform/architecture/ (adapters)                                 generated, committed,
        ▲                                                              `architecture:check` in CI
        │ never read back by any generator                                     │
                                                                               ▼
                                                     GET /system/architecture        (owner-only, build-time graph)
                                                     GET /system/architecture/nodes/:id
/system/infrastructure/stream (existing SSE) ──── runtime health only, joined in the browser by healthKey
```

- The pipeline runs inside the existing build (`npm run build` already runs the
  infrastructure and algorithms generators); the composer runs after them, and CI's
  `architecture:check` fails if the committed graph differs from a fresh composition.
- No generator reads the graph, so there is no loop and no second opinion.
- A conflict between authorities is recorded in `discrepancies[]`, shown with both
  claims, and never resolved by the composer.
- The build-time graph carries **no runtime field**. Runtime health arrives only from the
  existing stream and is joined in the browser by `healthKey`; the graph cannot claim
  that anything is healthy.
- Any PR that changes the platform's architecture shows the change as a diff of
  `architecture-graph.json`, so architectural change is reviewed by a person.

### 3.2 Graph contract (`schemaVersion: 1`) and exposure rules

- **Node**: `id` (namespaced from the authority's stable key: `infra:postgres`, `sys:approvals`, `club:training-centre`, `agent:club.tactical`, `boundary:5`, `source:matches`, `room:agents-room`, `plan:digital-university`), `kind`, `band`, `parent` (expandable systems), `label` (English catalogue key), `maturity`, `stage`, `approval?`, `evidence` (`state`, `refs[] {authority, path, line?}`, `lastVerified {commit, at, by}`), `room` (deep-link target), `healthKey?`, `dataClass?`, `position` (world coordinates, with band index as the third axis for any later 3D mode).
- **Edge**: `from`, `to`, `kind` (`CALLS`, `READS`, `WRITES_TO`, `PUBLISHES_TO`, `GUARDED_BY`, `DEPLOYS`, `GOVERNS`, `OPERATES_IN`, `EXTENDS`, `BUILDS_ON`, …), `maturity`, `evidence`.
- **Provenance**: per authority `{generator, generatedAt, sha256}`.
- **Discrepancies**: `[{id, subject, authorityA, claimA, authorityB, claimB}]`.

**Exposure rules.** The composer writes only allow-listed fields. A test scans the
generated graph and the API response and fails on any of: URLs or hostnames (`http`,
`https`, `wss`, `*.onrender.com`), IP addresses, ports, regions, service plans, deploy
hook names, environment variable names (the security manifest's 58), secret-shaped values,
e-mail addresses, club, team, user or membership identifiers or names, and request or
record content. Repository paths and line numbers are kept: they are already in the
repository and are what makes a node checkable.

Invariants, each a test with a negative control: every node and edge has an evidence
state; `IMPLEMENTED` requires a verified source; missing evidence forces `UNVERIFIED`; a
`PLANNED` node carries no code evidence for itself; no edge points at a missing node;
composition is byte-identical across runs; a new cross-authority conflict fails CI until
fixed or recorded.

### 3.3 Status model — three dimensions, never merged

**A. Implementation maturity** (build-time, from the authorities)

| Maturity | Means | Derived from |
|---|---|---|
| Implemented | code exists and is wired into the production build: mounted, registered, RUNNING | infra `ACTIVE` with a resolving path; SYSTEM `LIVE`; agent `RUNNING`; capability `LIVE` |
| Partial | some of it is built or wired, not all | SYSTEM `PARTIAL` / `NOT_INSTRUMENTED`; capability `PARTIAL`; dormant route modules (code, not mounted); infra `NOT_CONFIGURED`; LAB agents and lab tooling |
| Planned | declared, not built | infra `future[]`; `planned-systems.json` |
| Unverified | claimed, but the authorities conflict or the evidence is missing | discrepancies; evidence state `missing` |

Each node also carries a **stage**: production component (in the production build; live
operation is shown only by runtime health), partial implementation, research prototype,
roadmap concept or candidate concept. Planned nodes carry an **approval**: approved
roadmap category, needs separate approval, not an approved objective, or engineering item.
SYSTEM readiness and boundary coverage (`C` / `P` / `U`) stay visible as qualifiers.

**B. Runtime health** (request time, never from the graph)

| Runtime health | From `HealthState` |
|---|---|
| Healthy | `HEALTHY` |
| Degraded | `WARNING`; and `CRITICAL` where the signal does not report the component unreachable (see §10) |
| Unavailable | `CRITICAL` where the signal's own probe reports no answer (e.g. the database connectivity probe) |
| Not monitored | `NOT_CONFIGURED`, `NOT_INSTRUMENTED`, `UNVERIFIED`, `UNKNOWN`, or no `healthKey`; the original reason is kept and shown |

Rules: a node is Healthy only with a measurement from the current stream; maturity never
sets health; a stale or closed stream turns every node Not monitored, never "last known
good".

**C. Evidence**

| Evidence | Means |
|---|---|
| Verified source | the cited path resolves at the composed commit and the fact came from a generator or code registry that CI checks |
| Source reference | cited, not machine-verifiable: an owner decision, a design document, a reviewed hand mapping, or a system outside this repository |
| Last verification | commit, time and verifier (generator name or "owner decision") — shown on every node |
| Unknown or missing | no evidence; forces maturity Unverified |

Encoding never relies on colour alone: maturity is the outline (solid, dash-dot, dashed,
violet double) plus a drawn glyph (filled, half, hollow, "?"); runtime is a dot with its
word; evidence is a tag (VERIFIED, REFERENCE, MISSING). Outside two lenses the canvas uses no
status colour at all: in the Security lens amber marks a partially covered boundary, and in
the Runtime lens green, amber and red are measured health. Each lens explains its colours in
its own legend.

### 3.4 Bands, lenses, systems

Six fixed **bands**: Experience · Governance & Control · Application · Intelligence ·
Data · Platform & Delivery.

**Expandable systems.** Nodes nest by `parent`: platform → system → subsystem →
component. At overview zoom a band shows systems; expanding one reveals its subsystems in
place without moving its neighbours (reserved slots). This is the L0–L2 semantic zoom
(C4's levels without its tooling); L3 is the inspector's evidence.

**Lenses** overlay the same positions and never move a node: Structure · Security
boundaries (coverage-map rows drawn as **containers** with C/P/U) · Tenant isolation
(tenant guard, RLS, the club-workspace template as one node) · Data flow · Agents ·
Delivery · Runtime health · Evidence · Discrepancies.

**History.** Because the graph is committed, two commits or releases can be compared:
added, removed and changed nodes and edges, and maturity changes, on a timeline.

### 3.5 Frontend — an engineering workspace

A vanilla-JS owner room, `public/architecture-view/`, lazy-loaded like the Operations
Room (after `/system/whoami`), page key `architecture`, root `data-no-i18n`, its own
catalogue. Layout, deliberately unlike a dashboard or the Owner Control mind map:

- **Explorer** (inline-start): system tree with expand/collapse, search (Ctrl/Cmd-K) and
  filters by maturity, stage, approval, evidence and band.
- **Canvas** (centre): one SVG world; pan and zoom are a single transform; positions come
  precomputed from the composer.
- **Inspector** (floating, `position: fixed`, opacity/transform only): the three status
  dimensions, last verification, sources, connections, trust boundaries, discrepancies,
  **Open in <room>**.
- **Lens bar and history timeline**.
- **Outline view**: the accessible equivalent of the canvas and the escape hatch at
  `max-width: 980px` / `max-height: 620px`.

Surfaces follow the owner rooms (dark canvas, glass panels, hairline borders, 16px
radius). Status colour is lens-scoped (§3.3 C): maturity is carried by shape and glyph
only, so no colour means two things on the same screen.

### 3.6 Rendering — 2D and 2.5D now, optional 3D later

The graph is renderer-agnostic. Renderers implement one contract:

```
mount(host) · setGraph(graph) · setLens(lens) · setFilter(f) · select(id) · focus(id) · setHealth(map) · dispose()
```

| Renderer | Phase | Notes |
|---|---|---|
| 2D SVG (default) | 2 | crisp text, DOM focus and ARIA, CSP-clean, testable in jsdom and the browser proof |
| 2.5D layer stack | 2 | the six bands as tilted planes (CSS 3D transforms, no WebGL); orientation and band selection, with a flat band list as the real control (§9) |
| Canvas/WebGL 2D | only if a level exceeds a few thousand elements | same contract |
| **Optional 3D (Babylon.js)** | 7, separate approval | lazy-loaded only when chosen, as the drill engine already does (`public/app.js` injects `/vendor/babylon.js` on demand); never the default; positions use `(x, y, band)`; the outline view and inspector stay the accessible path. Cost: the vendored 6.8 MB `babylon.js` is fetched only by an owner who opens 3D. |

The initial implementation has no dependency on 3D, and nothing in the graph or API
assumes a renderer.

### 3.7 Open source evaluated

Backstage (Apache-2.0) is a second application with its own database, built for
multi-repo catalogues: too heavy for a solo-operated modular monolith. Structurizr / C4
needs a hand-maintained DSL, which drifts: rejected as a tool, its level model adopted.
Cytoscape.js (MIT) is the fallback renderer if SVG hits its limits. d3-force re-settles
when the graph changes, breaking the reader's mental map. ELK (`elkjs`, EPL-2.0) is the
candidate build-time layout engine at the Phase 4 decision point, never shipped to the
browser.

---

## 4. Integration with Owner Control navigation

- Owner Control stays the landing; PR #146's map is not changed.
- Entry points: `#architecture`, and an "Architecture View" entry in SYSTEM beside
  "AI Agent Control". A place on the Owner Control map is proposed separately after
  PR #146 merges.
- Back: "← Owner Control" returns to `owner-home`.
- Drill-through, not duplication: component → Infrastructure City, boundary →
  Cybersecurity, source → Source Core, history → Data Vault, agent → AI Agents Operations
  Room (focused through PR #146's `opts.open` hint once that PR is merged).
- The Operations Room stays independent: the view reads the registry through the
  composer and offers no agent control.

---

## 5. Security, tenancy and compliance

- `src/routes/architecture.routes.ts` at `/system/architecture`: `authenticate` and
  `assertPlatformOwner` router-wide, **enforced on the server**; GETs only;
  `Cache-Control: no-store`. The front-end gate is convenience only.
- Pinned in `posture-policy.json` `ownerRooms` (`security:check` fails if any handler is
  not owner-only) and mapped in `coverage-map.json` rows 4, 5, 6, 7.
- Exposure rules and the scanning test of §3.2. Club workspaces appear as one template
  node with their isolation mechanisms; no tenant data, identifier or name.
- The graph describes partial boundaries, so it is effectively an attack map: owner-only,
  uncached, no export until separately approved with an audit event.
- Client: no inline script or style, all text escaped, no third-party code, no new
  `connect-src`.
- No personal data processed; WCAG 2.2 AA verified with axe in the browser proof.

---

## 6. Localisation

The room's catalogue `public/architecture-view/i18n/{en,de,ar}.json`, keyed by English,
with a parity test, as for the other owner rooms. Product and system names, file paths and
identifiers are never translated. The concept surfaced two RTL rules the room must keep
(§9): SVG text inherits the page's `direction`, so English names in an Arabic page need
`direction: ltr` and Arabic tags must anchor at `start`; and mixed-direction inspector
lines need `<bdi>` isolation. Both get browser-proof checks.

---

## 7. Roadmap — independently testable phases

Every phase ends at a PR the owner approves. Nothing merges or deploys without it.

### Phase 0 · Evidence corrections — dedicated PR, **awaiting authorisation**

Scope: D1, D2, D3 in `scripts/infrastructure-discover.js` only.

| Correction | Authoritative evidence to verify first | Change |
|---|---|---|
| D1 deploy edges | `render.yaml` (`autoDeploy: false`), the four workflow files | Emit `DEPLOYS` only from a workflow that references the Render deploy hook; cite that evidence instead of `autoDeploy`. Expected result: one edge, from `deploy.yml`. |
| D2 RLS metadata | coverage-map row 5, `docs/security/row-level-security.md`, the RLS migrations and `scripts/rls/` | Remove RLS from `future[]`; represent it as present on the 18 recorded tables, with its evidence. |
| D3 district status | each district's components | Derive district status from its components instead of a default. |

Constraints: no change to `render.yaml`, any workflow, deploy hooks or deployment
behaviour; no change to any RLS policy, migration or enforcement; regenerate
`src/infra/generated/infrastructure-manifest.json`; update the tests that pin it
(including Infrastructure City's). Independent evidence: generator tests with negative
controls (a workflow without the hook gets no edge; RLS reappearing in `future` fails),
`infra:check`, `security:check` unchanged, Infrastructure City suite. Size: S.

### Later phases

| Phase | Delivers | Independent evidence | Size |
|---|---|---|---|
| 1 · Composer + owner API | adapters, `architecture-graph.json`, `architecture:check`, `/system/architecture`, `/nodes/:id`, posture pin, exposure scan | invariant tests with negative controls; determinism; `security:check`; anonymous 401, club account 403, owner 200; exposure scan fails on an injected URL and an injected env name | M |
| 2 · Room, 2D canvas and 2.5D stack | explorer with expandable systems, search and filters, canvas, inspector with the three dimensions, outline view, en/de/ar + RTL, `#architecture`, SYSTEM entry | unit tests on a fixture graph; browser proof: zero layout shift, axe 0 violations en/de/ar, keyboard, reduced motion, label containment in RTL, 0 CSP violations, club account never loads assets or calls the endpoint, listeners and heap released | M–L |
| 3 · Lenses | boundaries as containers, tenant isolation, data flow, agents, delivery, evidence, discrepancies | adapters tested against the real manifests; lens switch moves no node | M |
| 4 · Deeper evidence | G1–G3, G6, `planned-systems.json` (contents signed off), layout-engine decision | hand-verified samples; injected fake import fails | M |
| 5 · Runtime health + drill-through | runtime lens on the existing SSE, mapping of §3.3 B, deep links with focus, path tracing | Not monitored never Healthy; stale stream turns all Not monitored; SSE closed on teardown | M |
| 6 · History | commit/release comparison, timeline | diff tested on fixture commits | M |
| 7 · Optional 3D | Babylon renderer on the same contract | separate approval; accessibility path unchanged; lazy load measured | M |

Cost: EUR 0. No new runtime dependency; `elkjs` (build-time only) would come for approval
at Phase 4.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| The view becomes another opinion that drifts | single-authority table; composes only; conflicts recorded; `architecture:check` |
| Maturity read as live operation | three separate dimensions; runtime only from measurements |
| The posture map leaks | owner-only on the server, no-store, no export, exposure scan |
| Overview unreadable as the platform grows | expandable systems, lenses, filters, outline; renderer swappable (§9 measured the limit) |
| Reviewed mappings decay | tests fail on any unmapped item |
| Conflicts with PRs #146 / #143 in `app.js` and `index.html` | loader and allow-list only; land after #146 |
| RTL regressions in SVG | containment checks in the browser proof (§9) |

---

## 9. Concept validation — real browser, 2026-11-02

**What was tested.** The interactive concept
(<https://claude.ai/artifact/FxpEJXaT5wkmczapiWFAWR>), rebuilt on the three-dimension
model and the verified roadmap categories: 46 nodes and 35 edges, 9 lenses, search,
maturity filter, inspector, 2D map, 2.5D stack, EN/DE/AR. Headless Chromium (Playwright
1.63) with the page wrapped in the artifact host's skeleton; Inter and JetBrains Mono
served from local copies of the Google Fonts files; every other external request blocked;
axe-core 4.10.2 with the WCAG 2.0/2.1/2.2 A and AA tags.

**Scenarios.** Desktop 1440×900 EN (plus reduced motion), 1920×1080 EN, 1366×768 DE,
1440×900 AR; mobile 390×844 EN and AR at 2× with touch.

**Result: 69 of 69 checks pass** on the final page. These include: no horizontal page
scroll; fonts loaded; no clipped chrome text; every node label, meta line and tag inside
its box in all languages (including RTL runtime and evidence lenses); no console or page
errors; inspector, lens switch and close leave the stage, rail, top bar and nodes
pixel-identical; Tab → node, Enter opens, Escape closes and returns focus; wheel zoom;
drag pans without selecting; search and Enter; maturity filter; flow animation on, and off
under reduced motion; stack → band; RTL mirroring (first slot and band titles right, rail
right, inspector left); mobile outline with a bottom-sheet inspector inside the viewport;
axe 0 violations in EN, DE and AR on desktop and mobile.

**Defects found and fixed during validation**, each confirmed by a re-run:

| Defect | How it was found | Fix |
|---|---|---|
| Arabic: 97 node labels, meta lines, tags and band titles drawn outside their boxes | screenshot review, then a new containment check that failed (97) before the fix and passes after | `direction: ltr` on English names; Arabic tags anchored at `start` |
| Tertiary text `#66708b` at 3.45–4.01:1 (below 4.5:1) | axe on mobile; measured on every surface | `#8590a8`, ≥ 5.31:1 on every surface |
| Hidden 2.5D stack kept focusable planes (`aria-hidden-focus`) | axe | `inert` on whichever view is hidden |
| `<html>` without `lang` | axe | `lang` set on the document as the language changes |
| Three meta lines overflowed their boxes | containment check | shorter, still accurate meta |
| Half-circle glyph rendered as a stray tick | screenshot review | glyphs drawn in SVG, not typed |
| Amber meant both "owner" and "partial", and would also have meant "degraded" in the Runtime lens | screenshot review, then the legend | owner outline removed; maturity carried by shape and glyph only; amber appears only inside the Security and Runtime lenses |
| Inspector lines out of order in Arabic | screenshot review | `<bdi>` isolation; English notes marked `lang="en" dir="ltr"` |
| Stack: two plane labels under the note, one plane not hit-testable | probe of `elementFromPoint` per plane | a flat band list as the control; note hidden in stack view |
| Inspector faded out as an empty box | screenshot review | content kept during the fade; `visibility` removes it from the accessibility tree |
| Reading-order tab sequence broken by one node | review | nodes sorted by band and slot |

**Limitations that remain** (concept, not production):

1. **Overview text size.** Fitting all 46 nodes renders 12px labels at 9.6px at 1440×900
   (11.6px with the rail collapsed) and 9.0px at 1366×768; 13.7px at 1920×1080. Meta lines
   hide below 85% zoom. Production needs the expandable-systems overview (§3.4); the concept
   does not implement it.
2. **Inspector covers the two inline-end columns** at 1440 when open (by design nothing
   moves underneath); the reader pans or closes it.
3. **Edge routing is simple curves**: some edges cross unrelated nodes (e.g. Backend
   services → PostgreSQL across AI Infrastructure Assistant) and fan into API gateway.
   Routing is a Phase 4 layout decision.
4. **Not in the concept:** expandable systems, boundaries as containers (the security lens
   tints outlines only), history, path tracing, minimap, deep links into rooms, live runtime
   health (every node shows Not monitored).
5. **Security rows** for some nodes are mapped by name in the concept; the room reads
   `coverage-map.json`.
6. **Text:** node names stay English by rule; the evidence notes and discrepancy texts are
   English only in the concept. The German and Arabic strings are mine and have not been
   reviewed by a native speaker.
7. **Coverage of the test:** Chromium only (no Safari or Firefox), no physical touch
   device, no screen-reader session (axe is automated), no frame-time or memory budget
   measured, and the host skeleton was emulated rather than captured.

**Pre-existing observation, outside this work:** Infrastructure City's tertiary text token
`--ic-tx-3` is the same `#66708b`; it measures 3.72:1 on that room's panel and 4.01:1 on
its background, and is used in 41 rules of its stylesheet. Which of those are small text
has not been checked.

---

## 10. Open decisions

1. **`CRITICAL` → Unavailable or Degraded.** Recommended: Unavailable only where the
   signal's own probe reports no answer, Degraded otherwise, with the original state shown.
   This needs an explicit `reachable` measurement on the signals that probe.
2. **D9 wording.** Whether the infrastructure manifest's Smart Ball entry should stop
   saying "On the product roadmap". Outside Phase 0's approved scope.
3. **Phase 0 start.** Waiting for explicit authorisation.
4. **Owner Control map entry** after PR #146 merges, as a separate proposal.
