# Familista Architecture View — Proposal for owner approval

Status: **PROPOSAL, nothing implemented.** No code, route, migration or UI is
changed by this document. PR #146 is untouched. Every count and path below was
read from the repository at commit `83bb52e` (main) on 2026-11-02; where a figure
comes from a generated manifest, the generator and its `generatedAt` are named.

---

## 1. What it is, and what it is not

| | Owner Control (PR #146) | Infrastructure City | **Architecture View** |
|---|---|---|---|
| Question | Where do I go? | What is the platform built from, and is it healthy? | How does the whole platform fit together, and how sure are we? |
| Scope | the ten owner rooms as a landing map | the infrastructure manifest (54 components) | every room's registry, composed into one graph |
| Unit | a room | a component | a system, its boundaries, its flows, its evidence |
| Changes | nothing | acknowledges incidents | **nothing — read-only** |

The Architecture View is the cross-room layer that none of the existing rooms
provides: one navigable model spanning governance, infrastructure, security
boundaries, data, agents, Vision and club workspaces, where every node links
**into** the room that owns its detail. It never duplicates a room's content.

It follows the rule Source Core already set (`src/sources/source-registry.service.ts`):
**it discovers nothing, it composes.** A fourth discovery mechanism would be a
fourth opinion about the platform, and opinions drift.

---

## 2. Inventory — what the repository actually proves today

### 2.1 Evidence sources that already exist (the composer's inputs)

| Input | Generator / owner | What it gives the view |
|---|---|---|
| `src/infra/generated/infrastructure-manifest.json` | `scripts/infrastructure-discover.js` (generatedAt 2026-10-30) | 19 districts, 54 components (53 `ACTIVE`, 1 `NOT_CONFIGURED`), 17 relationships + per-component `dependencies`, 7 `future` items, 55 route mounts, 30 technologies, 41 dependencies, 3 Render services (frankfurt), 4 CI workflows; surface: 65 route modules, 102 service modules, 24 middleware, 52 fabric modules, 619 TS files, 224 test suites, 49 migrations, 344 Prisma models, 209 enums |
| `src/cyber-defense/generated/security-manifest.json` | `scripts/security-discover.js` (generatedAt 2026-10-29) | 56 mounted routers, 764 handlers (public 21, member 350, scoped 60, roles 236, platform-owner 97), 8 dormant route modules, 7 realtime endpoints, 5 outbound call sites, tenancy (350 id params: 136 guarded, 214 exempt, 0 unguarded), 81 controls (79 present, 1 partial, 1 absent), 2 private datastores |
| `src/cyber-defense/coverage-map.json` | reviewed by hand, pinned by the posture test | 40 trust-boundary rows (34 covered, 6 partial: rows 1, 2, 5, 8, 17, 18), each with flow, trust boundary, data class, controls, reason; every discovered component (routers, 78 src domains, 65 Prisma sections, workers, env, Render, workflows, infra components) mapped to its rows |
| `src/cyber-defense/posture-policy.json` → `ownerRooms` | reviewed | the 10 owner-only routers and their mounts (`/system`, `/system/trace`, `/system/data-pulse`, `/system/fabric`, `/system/infrastructure`, `/system/sources`, `/system/cybersecurity`, `/system/algorithms`, `/system/design-system`, `/system/agents`) |
| `src/platform/system-modules.ts` | code registry | 24 SYSTEM modules: 12 `LIVE`, 9 `PARTIAL`, 3 `NOT_INSTRUMENTED`; 25 `CLUB_MODULES` keys; test-asserted disjoint |
| `src/platform/capabilities.ts` | code registry | every SYSTEM control as `LIVE` / `PARTIAL` / `NOT_AVAILABLE` with risk level |
| `src/platform/agents/catalog.ts` + registry | code registry | 10 agent manifests, all `scope: CLUB`, `lifecycle: RUNNING`, autonomy ceiling `APPROVE`; no PLATFORM-scope agent exists |
| `src/platform/agents/generated/orchestration-evidence.json`, `published/` | lab generators | LAB orchestration evidence (not production runtime) |
| `src/fabric/registry/source-registry.ts` + Source Core `/flow`, `/:id/lineage` | code registry + owner API | data origins, intake, validation, consumers, lineage |
| `src/algorithms/generated/algorithm-manifest.json` | `scripts/algorithms-discover.js` | algorithms under change control |
| `src/design-system/generated/*.json` | `scripts/design-system-*.js` | token architecture, 60 components |
| `/system/infrastructure/stream` (SSE) | `src/routes/infrastructure.routes.ts` | live health with the four "no data" words: NOT INSTRUMENTED, NOT CONFIGURED, UNVERIFIED, UNKNOWN |

### 2.2 Real systems by the ten areas in the brief

| Area | Exists in the repository | State |
|---|---|---|
| 1 Governance | SYSTEM (24 modules), Approval Center, Global Governance, Feature Flags, Experiments, Release Management, kill switch (`POST /system/agents/kill-switch`) | implemented; readiness per module |
| 2 Infrastructure, APIs, DBs | Express app (`src/app.ts`), 56 mounted routers / 764 handlers, PostgreSQL via Prisma (344 models), Redis (private), object store, 8 worker files, WebSocket + SSE, Render ×3, GitHub Actions ×4 | implemented; Render deploy state **not observable** (manifest says UNVERIFIED) |
| 3 Security | JWT auth, RBAC, rate limiting, tenant guard, PostgreSQL RLS on 18 club tables, audit chain, 81 controls, 40 trust boundaries | implemented; 6 boundaries partial |
| 4 Data | Data Fabric (event bus, durable outbox), Data Vault (historical store, history API), Source Core | implemented; cold archive `NOT_CONFIGURED`; snapshots and archive exporter are `future` |
| 5 Agents | Agent Registry (10 RUNNING club agents), AI Gateway → Anthropic, runtime monitor, LAB orchestrator (`lab/orchestrator`) | registry implemented; orchestrator is LAB-only (the runtime refuses non-RUNNING agents) |
| 6 Vision | `/familista-vision/*` (status, models, sources, sessions, tracks, ball), vision-platform, video-transcode worker, HMAC-signed worker callbacks, outbound inference/clip adapters | implemented in code; external worker endpoints depend on environment |
| 7 Club workspaces | 25 declared `CLUB_MODULES`; front-end pages `club-home`, `squad`, `training`, `academy`, `video-intelligence`, `transfers`, `coach-market`, `familista-league`, … | implemented; see gap G6 |
| 8 Club modules | First Team/Squad, Academy, Training, Match Center, Video Intelligence, Transfers, Coach Market, Familista League | implemented (pages + routers) |
| 9 Design, commerce, extensions | Design System Control (owner API), Design Studio (browser-only, no endpoint), Stripe billing (`src/billing/plans.service.ts`, billing routes), marketplace service | implemented; **no Digital University, Media Network or commerce catalogue code exists** |
| 10 Dependencies and flows | 17 explicit relationships + component `dependencies` in the infra manifest; Source Core flow/lineage; coverage-map component→boundary mapping | thin — see gaps G1–G3 |

Also present and easy to overstate: 8 **dormant** route modules (`admin`, `admin-dashboard`, `ai-engine`, `executive`, `franchise`, `investor`, `vision-engine`, `whitelabel`) whose code exists but is not mounted, and many `src/` domains from earlier speculative phases (`quantum`, `biochem`, `cognitive`, `twins`, …). Code existing is not a system running. The view must say which is which.

### 2.3 Discrepancies found in the existing evidence (verified)

These matter because the view inherits whatever the generators claim.

| # | Finding | Evidence |
|---|---|---|
| D1 | Every CI workflow gets a `DEPLOYS → render-familista-backend` edge, unconditionally, citing "render.yaml autoDeploy". `render.yaml` sets `autoDeploy: false`; only `deploy.yml` deploys, through `RENDER_DEPLOY_HOOK_URL`. Three of four edges are unsupported and the fourth cites the wrong mechanism. | `scripts/infrastructure-discover.js:924-928`, `render.yaml:17`, `.github/workflows/deploy.yml` |
| D2 | Row-Level Security is listed under `future` while its own reason, and coverage-map row 5, record it enforced on 18 club tables. | `scripts/infrastructure-discover.js:943`, `src/cyber-defense/coverage-map.json` row 5 |
| D3 | Every district's status is the default `ACTIVE`; it is not derived from evidence. | `scripts/infrastructure-discover.js:114` |
| D4 | Component `ACTIVE` means "a file exists", not "it runs". Only components with a `healthKey` have runtime state; the rest report NOT_INSTRUMENTED. | infra manifest; `src/routes/infrastructure.routes.ts:143` |
| D5 | The two manifests count routes differently (55 mounts vs 56 mounted routers) and were generated 13 h apart. | both manifests |
| D6 | `CLUB_MODULES` keys (`first-team`, `training-centre`, `match-center`) do not match the page slugs the workspace uses (`squad`, `training`, …); nothing maps one to the other. | `src/platform/system-modules.ts`, `public/app.js` `CLUB_NAV_ITEMS` |
| D7 | The list of owner rooms lives in three places that are not tied together: `_ALLOWED_PAGES` (front end), `posture-policy.json` `ownerRooms` (routers), and the `navTo` loaders. | as named |
| D8 | Source Core's header says the Fabric has eleven source domains; `source-registry.ts` declares ten statically. One may be registered at load. | `src/sources/source-registry.service.ts`, `src/fabric/registry/source-registry.ts` |

### 2.4 Missing architectural information (gaps)

| # | Gap | How to fill it without inventing |
|---|---|---|
| G1 | No domain-level dependency graph (which `src/` domain imports which). | Extend `infrastructure-discover.js` with an import pass using TypeScript's own `ts.preProcessFile` (TypeScript is already a dependency; zero new packages). |
| G2 | No route → service → Prisma model map (who reads/writes which tables). | Same generator: record `prisma.<model>.<op>` call sites per file. |
| G3 | Prisma sections are named by delivery phase ("Phase K — …"), not by domain. | A reviewed mapping file pinned by a test that fails on an unmapped section — the coverage-map pattern. |
| G4 | No registry of planned systems (Digital University, commerce catalogue, Media Network, Smart Ball, Field Intelligence, wearables firmware). Only 7 `future` items exist. | An owner-approved `planned-systems.json`. Nothing appears as PLANNED unless the owner declared it there or an existing `future` list names it. |
| G5 | Which connections carry real traffic. | `src/infra/api-traffic.ts` exists; what it records has not yet been evaluated. No claim until it is. |
| G6 | Mapping from declared club modules to their pages and routers. | Reviewed mapping, test-pinned (closes D6). |
| G7 | Deployment state. | Stays UNVERIFIED; the process cannot see Render. Not invented. |

---

## 3. Proposed technical architecture

### 3.1 Shape

```
existing generators & registries ──► Architecture Composer ──► architecture-graph.json (generated, committed, --check in CI)
 (infra, security, coverage map,      src/platform/architecture/        │
  system modules, capabilities,       one adapter per source;           ▼
  agent registry, fabric sources,     pure, deterministic          GET /system/architecture        (owner-only, read-only)
  algorithms, design system,                                       GET /system/architecture/nodes/:id
  planned-systems.json)                                                 │
                                                                        ▼
                         /system/infrastructure/stream (existing SSE) ──► public/architecture-view/ (owner room, lazy-loaded)
                                                   runtime overlay only        SVG canvas · inspector · outline · lenses
```

**Build-time composition, not request-time.** Every input is either a generated
manifest or a code constant, so the graph is fully determined at build. It is
generated like the four existing manifests, committed, and checked in CI with
`architecture:check`. A useful side effect: any pull request that changes the
platform's architecture shows the change as a diff in `architecture-graph.json`,
so architecture drift is reviewed by a person rather than discovered later.

**Adapters.** One adapter per source: `read() → toNodes() / toEdges()`. A new
registry (a future Education service, a device fleet registry) joins by adding
one adapter; the UI needs no change. This is the expansion mechanism for the
coming years.

### 3.2 Graph contract (`schemaVersion: 1`)

- **Node**: `id` (namespaced, from the source's stable key: `infra:postgres`, `sys:approvals`, `club:training-centre`, `agent:club.tactical`, `boundary:5`, `source:matches`, `room:agents-room`), `kind`, `band`, `parent` (for semantic zoom), `label` (English, catalogue key), `status`, `evidence[]` (`{source, path, line?}`), `room` (deep-link target), `dataClass?`, `position` (world coordinates).
- **Edge**: `from`, `to`, `kind` (`CALLS`, `READS`, `WRITES_TO`, `PUBLISHES_TO`, `GUARDED_BY`, `DEPLOYS`, `ISOLATES`, `GOVERNS`, `OPERATES_IN`, …), `evidence[]`, `source`, `status`.
- **Provenance**: per input `{generator, generatedAt, sha256}`.
- **Discrepancies**: `[{subject, sourceA, claimA, sourceB, claimB}]` — conflicts are shown, never averaged.

Invariants, each a test: every node and edge has at least one evidence entry; every evidence path exists in the repository; no edge points at a missing node; composition is byte-identical across runs; a PLANNED node cannot carry code evidence; a new cross-source conflict fails CI until it is fixed or listed.

### 3.3 Status model — two axes, never merged

**Existence** (build-time, from the repository) — the four states the brief asks for:

| State | Means | Comes from |
|---|---|---|
| IMPLEMENTED | code exists **and** is wired: mounted, registered, RUNNING | infra `ACTIVE` with a resolving path; SYSTEM module present; agent `RUNNING`; capability `LIVE`/`PARTIAL` |
| UNAVAILABLE | code exists but cannot be used in this build | dormant route modules; `NOT_CONFIGURED`; capability `NOT_AVAILABLE`; agent `LAB`/`DRAFT`/`RETIRED` |
| PLANNED | declared, no code | infra `future[]`; owner-approved `planned-systems.json` |
| UNVERIFIED | claimed but not provable here: evidence missing, sources conflict, or invisible to the process | discrepancies D1–D8; Render deploy state |

Qualifiers kept as they are, not collapsed: SYSTEM readiness (`LIVE` / `PARTIAL` / `NOT_INSTRUMENTED`) and boundary coverage (`C` / `P` / `U`). "Backup & Recovery — Implemented · Not instrumented" is the honest sentence; "Implemented" alone is not.

**Runtime** (live, optional lens) — reuses Infrastructure City's vocabulary and its rule: NOT INSTRUMENTED, NOT CONFIGURED, UNVERIFIED and UNKNOWN are never green.

Encoding never relies on colour alone, and matches the agent badges in PR #146: solid outline = implemented, dashed = planned, dotted = unavailable, double outline with a "?" glyph = unverified; plus the word in the inspector.

### 3.4 Bands and lenses

Six fixed **bands** (horizontal planes, top to bottom): Experience (owner rooms, club workspace, React client) · Governance & Control · Application (routers, services, workers, realtime) · Intelligence (AI gateway, agents, algorithms, Vision) · Data (PostgreSQL, Fabric, Data Vault, Source Core, Redis, object store) · Platform & Delivery (runtime, Render, CI, external providers, devices).

**Lenses** overlay the same positions; switching one never moves a node:
Structure (default) · Security boundaries (40 coverage-map rows as hulls, C/P/U) · Tenancy (tenant guard, RLS, the club-workspace template) · Data flow (Fabric → outbox → history → Data Vault; Source Core lineage) · Agents (registry → domains → club modules) · Delivery (CI → Render) · Runtime (existing SSE) · Discrepancies.

**Semantic zoom**, borrowing the C4 model's levels without its tooling: L0 Context (the platform, its actors and external providers) → L1 Systems (~12) → L2 Components → L3 Evidence (inspector only: files, lines, controls, tests, generator).

### 3.5 Frontend

A vanilla-JS owner room, `public/architecture-view/`, exactly like the existing ten: lazy-loaded by a `_loadArchitectureView` loader after `/system/whoami` names the owner (the `_loadAgentsRoom` pattern), page key `architecture`, root `data-no-i18n`, its own en/de/ar catalogue. Not React: Owner Control and every owner room are vanilla JS in `public/`; a second UI runtime for one room is cost without benefit.

- Canvas: one SVG; pan/zoom is a single `transform` on the world group (mouse, trackpad, pinch, keyboard). No layout runs during interaction.
- Positions arrive precomputed in the graph (deterministic band layout in the composer), so the picture is identical every visit, which is what keeps a mental map stable, and nothing moves on load.
- Inspector: a `position: fixed` floating panel animating `opacity`/`transform` only; status chips, evidence list, neighbours, trust boundaries, provenance, and **Open in <room>**.
- Outline view: an accessible tree of the same graph. It is the screen-reader equivalent and the escape hatch at `max-width: 980px` / `max-height: 620px`.
- Path tracing between two selected nodes over evidenced edges only; search (Ctrl/Cmd-K); focus mode (n-hop neighbourhood).
- Surfaces: the owner rooms' dark canvas, glass panels, hairline borders, 16px radius. Each lens takes the accent of the room that owns it; green/amber/red appear only in the Runtime lens.

### 3.6 Rendering approach: 2D, 2.5D or 3D

| Option | For | Against |
|---|---|---|
| **2D SVG** (recommended base) | crisp text, real DOM focus and ARIA, CSS theming, CSP-clean, testable in Jest/jsdom; comfortably handles the expected few hundred nodes with semantic zoom | needs a canvas/WebGL renderer if a level ever exceeds a few thousand elements (the contract stays the same) |
| **2.5D layer stack** (recommended as the overview mode) | the six bands tilted as stacked planes via CSS 3D transforms show cross-layer dependencies at a glance; GPU-composited, no WebGL, no dependency | tilted text is hard to read, so the stack is for orientation; reading and interaction happen in flat 2D |
| 3D (Babylon.js, already vendored, 6.8 MB) | spatial wow | occlusion and perspective distort what is near what; labels are hard to read; keyboard and screen-reader access is much harder; GPU cost on laptops. Munzner's rule "no unjustified 3D" applies: no task in the brief needs depth as data. Infrastructure City already owns a spatial "city" metaphor. |

**Recommendation: 2D first, 2.5D layer-stack overview, no 3D.** Revisit 3D only for a task that is physically spatial (Field Intelligence positioning, sensor placement), where depth is the data.

Layout engine: a deterministic band layout in the composer (zero dependencies), with a decision point at Phase 4. If the import graph makes edges unreadable, adopt ELK (`elkjs`, EPL-2.0) as a **build-time devDependency only**, never shipped to the browser.

### 3.7 Open-source evaluated

Backstage (Apache-2.0) is a whole second application with its own database, built for multi-repo catalogues: too heavy for a solo-operated modular monolith. Structurizr / C4 needs a hand-maintained DSL, which drifts: rejected as a tool, its level model adopted. Cytoscape.js (MIT) is a strong canvas graph library, kept as the fallback renderer if SVG hits its limits, with weaker native accessibility. d3-force is rejected because a force layout re-settles when the graph changes, so adding one node moves unrelated ones and breaks the reader's mental map. Mermaid is static only.

---

## 4. Integration with Owner Control navigation

- **Owner Control stays the landing.** PR #146's map is not changed, and the Architecture View is not added to it in Phases 1–5.
- **Entry points:** (1) deep link `#architecture`; (2) an "Architecture View" entry in SYSTEM, beside "AI Agent Control" — the same way the Operations Room is reached today; (3) after PR #146 is merged, one small affordance on the map, proposed separately for your approval.
- **Back:** "← Owner Control" returns to `owner-home`.
- **Drill-through, not duplication:** a node opens its owning room: component → Infrastructure City, boundary → Cybersecurity, source → Source Core, history → Data Vault, agent → AI Agents Operations Room (focused on that agent through the `opts.open` hint PR #146 adds; without #146 merged it opens the room unfocused).
- **AI Agents Operations Room stays independent.** The view reads the Agent Registry through the composer, shows no agent controls (no kill switch, no lifecycle), and links into the room.

---

## 5. Security, tenancy and compliance

- New router `src/routes/architecture.routes.ts` at `/system/architecture`: `authenticate` + `assertPlatformOwner` router-wide, GETs only, `Cache-Control: no-store`.
- Pinned in `posture-policy.json` `ownerRooms`, so `security:check` fails if any handler is ever not owner-only; mapped in `coverage-map.json` (rows 4, 5, 6, 7, as `agents-room.routes` is), since an unmapped router fails the posture test.
- The graph carries **no** environment variable names or values, secrets, club names or ids, personal data, or request content. Club workspaces appear as one template node (the architecture of a workspace), with isolation mechanisms, never tenant data.
- The graph is effectively an attack map (it lists the partial boundaries). It stays owner-only, uncached, and has no export in Phases 1–5; export, if ever wanted, gets its own approval and an audit event.
- Client: no inline script or style (CSP `script-src 'self'`), all text escaped, no third-party code, no new `connect-src`.
- No personal data is processed, so no new GDPR processing. WCAG 2.2 AA, verified with axe in the browser proof.

---

## 6. Localisation

The room's own catalogue `public/architecture-view/i18n/{en,de,ar}.json`, keyed by English, with a parity test, as for SYSTEM, Data Vault, Infrastructure City and the Operations Room. Product names (PostgreSQL, Redis, Render, Stripe) and code identifiers are never translated. In Arabic the canvas mirrors on the x-axis and the inspector moves to the inline-start edge; floating panels are checked in RTL, where they usually break.

---

## 7. Roadmap — independently testable phases

Every phase ends at a PR you approve. Nothing merges or deploys without it.

| Phase | Delivers | Independent evidence it is right | Size |
|---|---|---|---|
| **0 · Evidence hygiene** | Fix D1 (derive `DEPLOYS` from the deploy-hook evidence), D2 (RLS out of `future`), D3 (district status from its components). Changes what Infrastructure City shows, so it is its own approval. | generator tests with negative controls (a workflow without a hook gets no edge); `infra:check`; Infrastructure City suite | S |
| **1 · Composer + owner API** | `src/platform/architecture/` adapters (infra, security + coverage map, system modules, capabilities, agents, fabric sources); `architecture-graph.json` + `architecture:check`; `/system/architecture`, `/nodes/:id`; posture pin. Backend only. | invariant tests from §3.2 with negative controls (a fabricated node fails, a missing path fails, a PLANNED node with code fails); determinism; `security:check` (owner-room violations 0); authorization tests: anonymous 401, club account 403, owner 200 | M |
| **2 · Room + 2D canvas** | Owner room, Structure lens, pan/zoom, L0–L2 semantic zoom, inspector, outline view, en/de/ar + RTL, `#architecture`, SYSTEM entry | unit tests on a fixture graph (status encoding, escaping hostile labels); browser proof: zero layout shift on open/inspect/lens switch, axe 0 violations in en/de/ar, keyboard traversal, reduced motion, 0 CSP violations, a club account never loads the assets or calls the endpoint, listeners and heap released on teardown (proof sections 13–16) | M–L |
| **3 · Lenses** | Security, Tenancy, Data flow, Agents, Delivery, Discrepancies | each adapter tested against the real manifests; a lens switch moves no node (positions pinned in a test) | M |
| **4 · Deeper evidence** | G1 import graph, G2 Prisma access map, G3/G6 reviewed mappings, G4 planned-systems registry (its contents need your sign-off); layout-engine decision | a hand-verified sample of imports and table accesses; an injected fake import must fail; unmapped sections fail | M |
| **5 · Runtime + drill-through** | Runtime lens on the existing SSE; deep links with focus; path tracing; search | overlay state mapping (NOT INSTRUMENTED is never green); SSE closed on teardown; deep-link tests per room | M |
| **6 · 2.5D overview + history** | layer-stack overview; architecture diff between two commits or releases | transform/opacity-only animation measured; reduced motion gives a flat view; diff tested on fixture commits | M |

Cost: EUR 0. No new runtime dependency. One possible build-time devDependency (`elkjs`) at the Phase 4 decision point, which would come to you for approval first.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| The view becomes another opinion that drifts | It only composes; conflicts are listed, not resolved by guessing; `architecture:check` in CI |
| "Implemented" read as "running" | Two status axes; readiness and coverage always shown beside existence |
| The posture map leaks | Owner-only, no-store, no export, security posture test |
| Visual overload as the platform grows | Semantic zoom, lenses, focus mode, outline; renderer swappable behind the same contract |
| Reviewed mapping files decay | Tests fail on any unmapped item (the coverage-map pattern) |
| Conflicts with PR #146 / #143 in `app.js` and `index.html` | Touch `app.js` only for the loader and allow-list; land after #146 |

---

## 9. Decisions requested

1. The two-axis status model (§3.3).
2. 2D with a 2.5D layer-stack overview; no 3D (§3.6).
3. Build-time composition with an owner-only read API at `/system/architecture` (§3.1, §5).
4. Entry points: `#architecture` and SYSTEM now; an Owner Control map affordance only after PR #146, as a separate proposal (§4).
5. Phase 0 as a separate PR, since it changes what Infrastructure City shows.
6. A `planned-systems.json` whose contents you declare (Digital University, commerce, Media, Smart Ball, Field Intelligence, …), so planned systems appear without being invented (G4).
