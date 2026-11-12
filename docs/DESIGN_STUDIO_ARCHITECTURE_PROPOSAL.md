# Familista Design Studio — Architecture and Product Design Proposal (DS-0)

Status: **DIRECTION PROVISIONALLY ACCEPTED (owner, 2026-11-10). D1, D5, D6 and L1 approved. DS-1a merged
and deployed (`4a9ca3c`, 2026-11-11). DS-1b — and only DS-1b — authorised (2026-11-11) and implemented for
review (§15); not merged, not deployed, no production migration run.** The original DS-0 text below is kept
as proposed; three statements in it were inaccurate and are corrected in place, each marked *Corrected
(final DS-0 review)*. Where DS-1b was built differently from what DS-0 proposed, §15 says how and why.

Read from the repository at `20df5fd` on 2026-11-10. `HEAD` equals the approved baseline: zero commits
after it, so there are no subsequent changes to report. Every claim about existing code cites the file
it was read from. Anything not read is marked **Unverified**.

Approved visual reference: [`docs/design-studio/approved-reference-2026-11-10.webp`](design-studio/approved-reference-2026-11-10.webp)
(1672 × 941, SHA-256 `5d0c5672…cc07bed4`). It is committed so that implementation can be compared
against one fixed file (§3.7).

---

## 0. Decision record

| # | Decision (owner) | Effect |
|---|---|---|
| — | Overall direction **provisionally accepted for further review**: one shared design engine, three independently authorised contexts, integration with existing infrastructure and governance, incremental delivery, the approved visual reference preserved. Not an authorisation to implement beyond DS-1a. | — |
| D1 | **Naming.** The new product is **Familista Design Studio**. The existing Owner-only interface design tool *may* be displayed as Interface Studio; every existing technical identifier, route, storage key, document format, export, test and compatibility is preserved. | DS-1a uses its own identifiers (`#product-design`, `public/product-design/`, `familista.product-design`, its own storage key). The optional relabel was **not** made in DS-1a: it would change the existing tool's code, its five catalogues and three pinned test assertions, which the preservation rule forbids; it remains available as a separate, isolated change. |
| D5 | **Visual design.** The approved image is the visual authority: dark navy, purple/blue accents, professional editing panels, central product visualisation; module accent colours kept technically separate from status colours; no redesign. | A module accent of its own (`--fam-module-accent` = violet-500, `-2` = blue-500) bound to `[data-fam-module="product-design"]`, distinct from `--fam-status-unverified` (violet-400). "Continue to order" is an unavailable control in DS-1a and is drawn in the room's neutral disabled style, not green. |
| D6 | **Arabic layout.** Proper RTL; navigation, panels and controls mirror where appropriate; the garment and the physical meaning of its surfaces are never mirrored. | Chrome follows the reading direction; the canvas is `dir="ltr"`; sleeves are named for the wearer's side; the workflow (a pipeline) reads left to right with unmirrored arrows, as the approved image shows. |
| L1 | **Official languages** confirmed: English, German, Arabic, French, Spanish, through the existing localisation infrastructure. | The room ships a catalogue for each (checked by `npm run i18n:check`); its navigation label is in every platform locale. |
| — | **DS-1a authorised** (2026-11-10), within §13 and the final DS-0 review's boundaries; no backend, database, authentication, authorisation, tenant-isolation, CSP, production-configuration, AI-governance, Neural Digital Twin, Interface Studio, manufacturer, payment or dependency change. | Implemented on `claude/kind-bell-inkoyy` for review; not merged, not deployed. DS-1b, DS-1c and later phases are not started. |
| — | **DS-1a merged and deployed** (owner approval, 2026-11-11): `main` `4a9ca3c`, live on Render after CI and the gated deploy. | — |
| — | **DS-1b authorised** (2026-11-11): secure server persistence, immutable revisions with restore, revision-based conflict prevention, Platform Owner-only on the server, audit, migration of browser drafts, Save / Projects / Versions in the editor; the ownership model for Club and Creator designs designed but not activated. Schema and migrations on the development branch only; no production migration without separate approval; no artwork upload until protected storage and recovery exist. | Implemented for review (§15). DS-1c, DS-ID, DS-2, DS-3 and manufacturing are not started. |
| D9 | Seller of record, liability, tax and payment architecture: **pending business and legal approval; not authorised.** | Nothing in DS-1a or DS-1b names a seller or shows a price. |

---

## 1. Executive architecture summary

**One engine, three contexts, one platform.** The Design Studio is a new domain module inside the
existing Express + Prisma + PostgreSQL monolith, not a service beside it. It consists of:

1. **A canonical product-design document** (`familista.product-design`, versioned JSON, geometry in
   millimetres on a garment's pattern panels). Everything else — the 2D editor, the shaded preview,
   the 3D preview, customer proofs, production files, supplier payloads — is *derived* from it. A
   rendered image is never the source.
2. **A pure, deterministic core** (no DOM, clock, network) that validates, edits (reversible
   operations, undo/redo) and checks manufacturability. This is the pattern the existing owner
   UI-frame studio already proves (`public/design-studio/studio-core.js`), applied to a different
   document.
3. **Thin renderers**: an SVG 2D editor with no third-party dependency, and a 3D preview on the
   Babylon.js 7.54.3 build the repository already vendors.
4. **Three application contexts** — Design Studio Control (Platform Owner, in SYSTEM), Club Design
   Studio (Club Workspace), Creator Studio (personal) — that differ only in *who owns the document*
   and *which permissions apply*, both decided server-side by the authorization model Familista
   already has.
5. **Commerce and manufacturing as later, gated layers**: a supplier-neutral adapter port, a
   quotation and order state machine, Stripe (already a dependency) through hosted Checkout, and
   suppliers shown with their *true* integration status.

**What the repository review changed about the plan** (detail in §2.2):

- The name "Design Studio" is already taken by an owner-only UI-frame editor that has nothing to do
  with garments. A naming decision is needed (D1).
- **Familista has no club-less accounts.** `User.clubId` is required and self-registration is closed.
  The Creator Studio for ordinary individuals therefore depends on an identity change that is
  security-sensitive and must be its own approved phase (**DS-ID**, inserted before DS-4).
- **There is no commerce transaction layer.** The marketplace is listings-only, billing is
  architecture-only, and Stripe is wired for club subscriptions only. Cart, order, tax, shipping,
  refund and seller-of-record do not exist.
- **Production storage is a 10 GB local disk.** An S3-compatible port exists but is not selected.
  Object storage must be decided before any non-owner artwork is accepted (DS-S).
- The governance Familista already has — four access levels, team access, data classification, the
  tenant-param guard, row-level security, the per-club audit chain, the approval gate, agent
  manifests with a `COMMERCE` domain and a kill switch, the algorithm fingerprint registry, the
  capabilities registry, the Fabric object store and secret store, and the Neural Digital Twin's
  automatic discovery — covers most of what this feature needs. The proposal reuses all of it and
  adds no second copy of any.

**Recommended first increment (§13):** DS-1a — the canonical document, its core, the approved
editor layout and a working 2D jersey editor, for the Platform Owner only, with no
migration, no route and no new dependency. Every control the image shows that cannot yet work is
present, disabled and says why.

---

## 2. Existing repository findings (Deliverable A)

### 2.1 Inventory

Status vocabulary: **Implemented** (verified in source and covered by tests), **Partial**,
**Prototype**, **Planned**, **Missing**, **Unverified**.

| # | Area | Status | Evidence | Reusable for Design Studio | Missing / limitation | Treatment |
|---|---|---|---|---|---|---|
| 1 | Backend framework | Implemented | `package.json` (Express 4, Prisma 5, zod 4, ioredis, ws); `src/app.ts` | Everything | The working profile says NestJS; the repository is Express. | Build on Express. No framework change. |
| 2 | Frontend | Implemented | `public/app.js` (69,706 lines, vanilla SPA); owner rooms lazy-loaded behind `/system/whoami` (`public/app.js:2841-2960`); React client at `/app` (`src/app.ts:317-325`, `client/`) | Room pattern: separate files, own CSS, own i18n, lazy load, teardown | React client has no design or commerce pages | New module under `public/product-design/`, loaded like the rooms (D2). |
| 3 | Existing "Design Studio" | Implemented (Slice 1a) | `public/design-studio/studio-core.js:1-30` (format `familista.studio.document` v1: frames, rects, text bound to UI tokens); `studio.js:1-35` (owner-only, localStorage, asks the server for nothing); `tests/design-studio.unit.test.ts` | Proven patterns: pure UMD core, closed-shape validation, reversible ops, history, camera and hit-test geometry, CSP-safe DOM rendering | It is a UI-layout tool. It cannot represent a garment, a print area, a unit, an asset, a supplier. | Do not extend its document, and do not touch it. *Corrected (final DS-0 review):* its geometry rounds every coordinate to whole pixels (`studio-core.js:122` `round`, `:468` `worldDelta`), while a garment needs 0.1 mm, so its functions cannot be shared without changing them. DS-1a reuses the pattern, not the code (D3). |
| 4 | Design System | Implemented | `public/design-system/*`, `src/design-system/*` (generated manifest, graph, components), `public/tokens/familista-tokens.css` | Tokens, components, module accent mechanism (`familista-tokens.css:355-395`) | No product/commerce components | Reuse tokens; add one module accent block (D5). |
| 5 | Authentication | Implemented | `src/middleware/auth.middleware.ts` (JWT, token version, cross-process identity invalidation); `src/auth-prod/*` (MFA, sessions) | All | **Self-registration closed** (`src/controllers/auth.controller.ts:77-95`); invited accounts only (`src/services/auth.service.ts:100-125`) | Unchanged until DS-ID. |
| 6 | Access levels | Implemented | `src/platform/access-levels.ts:1-30` (PLATFORM_OWNER, CLUB_OWNER, CLUB_STAFF, VIEWER) | Context resolution | No PERSONAL principal | DS-ID adds one, deliberately narrow. |
| 7 | Team / club authorization | Implemented | `src/identity/team-access.service.ts:1-25` ("the ONE place"); `MembershipRole` (`prisma/schema.prisma:628`) | Pattern: one decision file asked by every route | No design, publish, purchase or manufacturing permissions; no commerce role | New `design-access` decision file in the same style (§10.2). No new MembershipRole in DS-3. |
| 8 | Platform authority | Implemented | `src/middleware/platform-authority.middleware.ts`; `tests/platform-owner-boundary.unit.test.ts` | Guards Design Studio Control | — | Reuse as is. |
| 9 | Tenant guard | Implemented | `src/middleware/tenant-guard.middleware.ts` (`tenantParam('model')`, `:174`, `:220`); `tests/tenant-param-guard.unit.test.ts` | Club-scoped params for design and order ids | Club scope only | Register new resolvers; personal ownership checked in service (§10.3). |
| 10 | Row-level security | Implemented (pilot, enforced) | `prisma/migrations/20261004100000_rls_pilot`, `…_rls_club_private_tables`, `…_rls_enforce`; `src/security/rls-client.ts`; context `familista.club_id`; CI job "Row-level security pilot (real PostgreSQL)" | Club-owned design tables join the same policy | No user-scoped policy | Club tables: same policy. Personal tables: new policy in DS-ID with the same CI proof. |
| 11 | Data classification | Implemented | `src/platform/data-classification.ts` (PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED; unknown resource → INTERNAL) | Classify designs, rosters, orders | No entries for these resources | Add entries (§10.5). |
| 12 | Policy engine | Partial | `src/platform/governance/policy.ts` (jurisdiction packs; no pack → NOT_VALIDATED) | Sell-to-country gating, minors | No commerce packs | Commerce refuses a jurisdiction without a validated pack. |
| 13 | Audit | Implemented | Per-club hash chain `src/security/audit-chain.service.ts` (`AuditActor.clubId: string`, required); `PlatformAuditLog` (`schema.prisma:5961`, nullable club) | Club design and order actions | **No chain for actions without a club** | Club → chain; platform and personal → PlatformAuditLog (D17). |
| 14 | Approval gate | Implemented (AI) | `src/security/ai-approval.service.ts` (different-person rule, TTL, audit) | The *pattern* for brand and manufacturing approvals | Bound to AI jobs | New `DesignApproval` following the same rules (§10.4). |
| 15 | Object storage port | Implemented | `src/fabric/media/object-store.ts` (four operations, signed reads, wraps `lib/storage`); `src/fabric/media/media-asset.service.ts`; `MediaAsset` (`schema.prisma:10599`: club tenant, checksum, classification, `aiEligible` default false, consent ref) | Club artwork storage and records | `MediaAsset.clubId` required — no personal or platform owner | Club artwork → `MediaAsset`. Personal → decided in DS-ID. Templates → repository (DS-1/2). |
| 16 | Storage keys | Implemented | `src/security/storage-keys.ts` (roots `club/`, `clubs/`, `whitelabel/`, `year=`; `assertStorageKey` `:52`) | `clubs/<clubId>/design/…` already fits | No `users/` or `platform/` root | Add roots only with DS-ID / DS-2. |
| 17 | Production storage backend | Partial | `render.yaml`: `WL_ASSETS_BACKEND=LOCAL`, disk `familista-uploads` 10 GB at `/var/data`; S3 adapter `src/lib/storage/storage-s3.adapter.ts` (`@ts-nocheck`) | Port is ready | Single-instance disk; S3 not selected (**Unverified** in production) | DS-S before public uploads (D8). |
| 18 | Asset upload pipeline | Partial / Unverified | `src/services/admin-asset.service.ts` (`@ts-nocheck`, needs `multer`, which is **not** in `package.json`; accepts `image/svg+xml` with no sanitizer found) | MIME/size/checksum ideas | No SVG sanitization; no raster re-encoding (`sharp` optional, not installed) | Do not reuse for user artwork. New guarded upload path (§5.6). |
| 19 | Club crest | Implemented | `Club.crestUrl` (`schema.prisma:144`); `src/controllers/club.controller.ts:30-63` (https URL or inline PNG/JPEG/WebP ≤ 400,000 chars) | Default crest for a new club design (raster preview) | Raster only, data URL in a DB column, no vector | Brand assets with vector files are new (DS-3). |
| 20 | Commerce: marketplace | Prototype | `src/marketplace/marketplace.service.ts` ("NO payment integration… listings only"); `MarketplaceItemKind` has no physical product (`schema.prisma:3669`) | Approval-on-activate idea | No product, cart, order, payment | Not the foundation for orders. |
| 21 | Commerce: billing | Prototype | `src/billing/plans.service.ts` ("ARCHITECTURE-ONLY. No payment gateway") | — | — | Unrelated to product orders. |
| 22 | Payments: Stripe | Partial | `src/services/stripe.service.ts` (subscription Checkout + portal, env-gated `isStripeEnabled`); `src/middleware/raw-body-paths.ts` (signed webhook body); `render.yaml` `STRIPE_SECRET_KEY` | Client, webhook verification pattern, raw-body path mechanism | Subscriptions only; no PaymentIntent for goods; Connect is `LEDGER_ONLY` (`render.yaml`, `src/services/franchise-payout.adapter.ts`) | Extend in DS-6 with hosted Checkout (no CSP change). |
| 23 | Shopify | Missing | No reference in `src/` or `public/app.js` | — | — | None assumed. |
| 24 | Secrets | Implemented | `src/fabric/secrets/secret-store.ts` (`db` provider: AES-256-GCM envelope under env KEK; keyring rotation) | Supplier API keys and webhook secrets | — | Reuse (§10.7). |
| 25 | Event bus and outbox | Implemented | `src/platform/events/bus.ts`, `contracts.ts` (analytics vs audit streams, versioned); `EventOutbox` (`schema.prisma:1474`, unique `idempotencyKey`, retries) | Supplier submission outbox; order events | No design/commerce event names | Add contracts. |
| 26 | Background work | Implemented | `src/workers/*` (DB-polling workers: transcode, automation, retention, notifications) | Print-file rendering, supplier submission, reconciliation | — | Same pattern. No Kafka or BullMQ. |
| 27 | Algorithms registry | Implemented | `src/algorithms/registry.ts`; `scripts/algorithms-discover.js` (SHA-256 fingerprints; a change without recorded owner approval fails `tests/algorithms.unit.test.ts`) | Pricing, quotation, manufacturability, supplier matching | No domain algorithms | Register them; owner approval governs every pricing change. |
| 28 | Feature flags | Implemented | `src/platform/innovation/flags.ts` (`isEnabled` `:68`) | Gate every DS phase | — | Reuse. |
| 29 | Capabilities registry | Implemented | `src/platform/capabilities.ts` (LIVE/PARTIAL/NOT_AVAILABLE + risk) | Truthful state of every Studio control | — | Declare Studio capabilities. |
| 30 | SYSTEM modules | Implemented | `src/platform/system-modules.ts` (LIVE/PARTIAL/NOT_INSTRUMENTED) | Owner Control entry | No commerce group | Add `design-studio-control` as NOT_INSTRUMENTED until real. |
| 31 | Agents | Implemented (registry); runtime for 10 club agents | `src/platform/agents/manifest.ts` (`AGENT_DOMAINS` includes `COMMERCE` `:40-42`; scope CLUB or PLATFORM; ceiling ≤ APPROVE); `catalog.ts`; `operations-room.service.ts`; kill switch `src/platform/intelligence/agents.ts:106` | Every proposed agent | No PERSONAL scope; no commerce agent | Manifests as DRAFT/LAB only, DS-8. |
| 32 | n8n | Missing | No reference in `src/`, `scripts/`, `render.yaml`, `docker-compose.yml` | — | — | Not proposed. |
| 33 | Neural Digital Twin | Implemented (Phase 1–2) | `src/platform/neural-twin/compose.ts:1-25` (reads infra manifest, security manifest, Prisma sections, agent catalog, SYSTEM modules, coverage-map boundaries, TS imports) | Automatic discovery of the Studio | — | No Twin change; Studio supplies evidence through those authorities (§6.4). |
| 34 | 3D | Implemented | `public/vendor/babylon.js` (7.54.3, 6.8 MB) + glTF loaders; used by `public/app.js:13380` and `public/neural-twin/neural-twin.js` | 3D preview | No garment model (only `player.glb`) | Reuse; garment model is a sourcing task (D4). |
| 35 | CSP | Implemented | `src/app.ts:84-100`: `script-src 'self'`; `connect-src 'self'` + Render host; `img-src 'self' data: blob: https:`; `font-src 'self' data: fonts.gstatic.com`; `frame-src 'none'` | Vendored libraries, data/blob previews | Browser → bucket PUT, Stripe.js, WASM in browser would each need a change | Design avoids all three (§10.8). |
| 36 | i18n | Implemented | `src/i18n/locales.ts` (registry; five marked official); catalogue + bundle (`CLAUDE.md`); owner rooms keep official-language catalogues (`studio.js:31-35`) | All strings | — | Club/Creator contexts use the catalogue (every registry locale); the owner room uses a room catalogue. |
| 37 | Consent | Partial | `UserConsentRecord` (`schema.prisma:5221`), `ConsentScope` incl. `IMAGE_USE`; `src/governance/governance.service.ts` | Consent for player names on kits where required | No data-subject export or erasure flow found | Roster retention designed in (§10.6); DSAR flow is a gap (§N). |
| 38 | Retention | Implemented | `src/workers/retention.worker.ts` (DataRetentionPolicy enforcement) | Roster and proof retention | — | Add policies. |
| 39 | Players (minors) | Implemented | `Player.dateOfBirth` (required) | Detect minors on rosters | — | Roster entries for minors are RESTRICTED. |
| 40 | Prior architecture decision | Recorded | `docs/ARCHITECTURE_VIEW_PROPOSAL.md:23,129` — "Club Merchandise Design and Manufacturing" is an approved roadmap category, status Planned; the existing studio "is not evidence of merchandise design" | Confirms this document's starting point | — | — |

### 2.2 Findings that change the plan

| ID | Finding | Consequence |
|---|---|---|
| F1 | "Design Studio" already names an owner UI-frame editor (`public/design-studio/`, page `pg-design-studio`, label at `public/app.js:3495`). The image's "Design System Control" is also close to the existing "Design System" room (UI tokens). | Naming decision before any code (D1). Technical module name proposed: `product-design` in both `src/` and `public/`. |
| F2 | No club-less account can exist: `User.clubId String` (`schema.prisma:291`) is required; `register` refuses with `SELF_REGISTRATION_CLOSED`. | Creator Studio needs DS-ID. A personal account reaching club routes would be a tenant-isolation hazard (a missing club filter can drop to `undefined`), so DS-ID must be an allow-list gate, not a column change. |
| F3 | No commerce transaction foundation. | DS-6 builds it; nothing in DS-1..DS-5 takes money. |
| F4 | Assets live on one 10 GB local disk; the S3 port exists, unselected. | DS-S (object storage) precedes club uploads at scale and all public uploads. |
| F5 | CSP allows scripts only from self and connections only to self. | All editor code vendored; uploads proxied through the API; Stripe via redirect. No CSP widening proposed. |
| F6 | Colour semantics: the image's purple primary collides with `--fam-status-unverified` (violet-400); its green "Continue to order" collides with the rule that green means a result or availability. | Smallest adjustment proposed (D5); not changed silently. |
| F7 | The image is Arabic text laid out left-to-right (navigation on the left). Repository rule: Arabic mirrors. | Mirror chrome in RTL, never the garment (D6). |
| F8 | Governance coverage is unusually complete. | The Studio adds rules to existing authorities, never a parallel authority. |

---

## 3. Visual design alignment (Deliverable D)

### 3.1 What the approved image contains, region by region

Coordinates are approximate, measured on the 1672 × 941 reference.

| Region | Reference area | Contents | Behaviour specified |
|---|---|---|---|
| R1 Top bar | full width, y 0–62 | Wordmark "Familista Design Studio"; primary navigation (Home, Design Studio active, Clubs, Store, Orders, Factories, AI agents); notifications with badge; language switch; account chip | Items rendered from the caller's permissions (§4.4). Language switch reuses the platform switch. |
| R2 Sidebar | x 0–200 | Dashboard, Digital Twin, AI agents, Clubs, Design Studio (active), Global store, Orders, Factories & suppliers, Payments, Reports, Settings | Owner sidebar only for the Platform Owner. Club and Creator sidebars differ (§4.4). |
| R3 Header | x 205–1660, y 70–150 | Title and subtitle; three-way context switch (Club Design Studio active; Creator Studio; Design System Control); club selector card (crest, name, "official club designs") | Segments shown only for contexts the caller holds; a held-but-unavailable context is disabled with a reason. |
| R4 Library | x 215–495, y 160–695 | Tabs Products / Templates / Elements; accordion "Match kits" open with a 3 × 3 grid (match shirt selected, goalkeeper shirt, shorts, socks, training top, jacket, hoodie, T-shirt, polo); "Everyday wear", "Accessories", "Other" collapsed | Cards come from the template catalogue; an unavailable product shows a status chip, never a fake card. |
| R5 Tool strip | x 505–548 | Select, Text, Image, Shape, Pattern, Layers, Components | Each tool = one core operation family; keyboard shortcut on each; tooltip names it. |
| R6 Canvas toolbar | y 165–197 | Undo, Redo; grid, safe-zone, snapshot, capture; 2D / 3D toggle (3D active); fullscreen | Grid and safe-zone toggle overlays; 3D enabled only when the template has a model (§5.4). |
| R7 Canvas | x 555–940 | The jersey | Dominant region; never resized by panels opening (CLAUDE.md stable-layout rule). |
| R8 View rail | x 948–1020 | Front (active), Back, Right, Left, 360° | Front/Back/Left/Right switch the panel being edited; 360° is a 3D-only orbit. |
| R9 Pattern strip | y 640–690 | Scrollable pattern swatches with arrows | Procedural patterns from the template's allowed set. |
| R10 Inspector | x 1035–1325 | Tabs Design / Colour / Material / Sizes; "Elements (layers)": crest, sponsor, number, name, pattern, base colour, each with visibility, lock, drag handle, thumbnail; "Element properties": name, duplicate, delete, alignment, scale slider + field, rotation slider + field, X and Y | Properties shown are the selected layer's; numeric fields in mm and degrees; sliders always paired with an input. |
| R11 Product column | x 1338–1660 | "Kit preview" carousel (Away / Home / GK); "Available sizes" (Women / Youth / Men / Kids; XS–5XL, L selected); "Colours" swatches + add; "Production info": method (sublimation all-over), fabric (polyester 140 gsm), compatibility check | Sizes and methods come from template and supplier capability data; the check line is the manufacturability result, never a constant. |
| R12 Action bar | y 705–770 | Save design (primary), Versions, editable design name with season, estimated cost "€24.90 / per piece", Production preview, Continue to order | Price is a quotation or `—` with the reason. "Continue to order" disabled until DS-6. |
| R13 Workflow card | x 10–858, y 790–930 | Eight steps: design → sizes and quantity → price → secure payment → send to factory → manufacturing → shipping and tracking → delivery | Each step carries its real state (Available / Planned / Not connected). |
| R14 Integration card | x 872–1235 | Four ticked statements (integrated with platform systems; supervised by AI agents; appears in the Digital Twin; full club/user separation) | Each line bound to evidence; an untrue line renders as planned, not ticked. |
| R15 Suppliers card | x 1248–1660 | "Factories and suppliers (example)": Printful, Printify, Gelato, specialised sportswear factories | Names with the seven-state status (§8.5). The image itself labels them "example". |

### 3.2 Visual language mapped to existing tokens

| Image property | Token / mechanism | Note |
|---|---|---|
| Dark navy background | `--fam-surface-canvas` (midnight-950) | Exists. |
| Panels with hairline borders and glow | `--fam-surface-panel`, `--fam-surface-glass`, Training surface rules (CLAUDE.md) | Exists; reuse the shared panel, do not create a second. |
| Purple/blue accent, active pills, primary button | New module block `[data-fam-module="product-design"]` setting `--fam-module-accent` / `-2` | Mechanism exists (`familista-tokens.css:355-395`). Hue must not equal `--fam-status-unverified` (D5). |
| Gold trim on the jersey | Design data, not UI tokens | User content. |
| Green "Continue to order", green checks | `--fam-status-success` | Collides with the colour-meaning rule (D5). |
| Typography | `--fam-font-family-sans` (Inter, Noto Sans Arabic) | Matches the reference closely. |
| Radii 12–16 px | `--fam-radius-lg` and up | Exists. |

### 3.3 Parts that cannot be reproduced exactly, and why

| Element | Why not exactly | What is built instead |
|---|---|---|
| Photoreal jersey | Concept-art render; a real-time renderer of an editable design cannot match it frame-for-frame. | 2.5D shaded mockup in DS-1 (design composited into a garment silhouette with a fold/shade overlay), real-time 3D with a PBR fabric material when a garment model exists. Judged against the reference by side-by-side review, not pixel equality. |
| Printful / Printify / Gelato logos | Third-party trademarks; brand-use terms not reviewed. | Names and status chips; logos only after their brand guidelines are checked (D15). |
| "€24.90 / per piece" | No quotation exists. | `—` with "No quotation: no supplier connected" until DS-5/6. |
| Size grid XS–5XL with four fits | Real availability differs per product and supplier. | Rendered from the template's size chart; marked "reference sizes, not purchasable" until a supplier capability confirms them. |
| "Suitable for manufacturing at approved factories" ✓ | No approved factory exists. | The manufacturability result against the template's own rules, labelled as such; supplier compatibility appears in DS-5. |
| Integration ticks (R14) | Two of four are not yet true for this feature (AI supervision; Twin visibility of a module that does not exist). | Each line shows its real state. |
| Owner navigation for everyone | Security. | Navigation built from permissions (§4.4). |
| "FC Familista" selected while the reader is Platform Owner | Platform authority never grants club access (`tests/platform-owner-boundary.unit.test.ts`). | The club context appears only if the owner account also holds a membership in that club, and then acts under club authority, labelled. |
| Arabic text in a left-to-right arrangement | Repository rule: RTL mirrors. | D6. |

### 3.4 Interactions

- **Selection**: click/tap on canvas or on a layer row; Shift adds; rubber band on canvas (core `band`
  geometry exists). Selection shows handles; locked layers are selectable from the list only.
- **Transform**: drag moves in whole 0.1 mm steps at any zoom (core resolves screen → world as the
  existing studio does); handles resize with aspect lock for images; rotation handle and field;
  snapping to panel centre lines, print-area edges, other layers, grid; `Alt` suppresses snapping.
- **Layers**: reorder by drag or keyboard (`Ctrl/Cmd+[ ]`), visibility, lock, rename, group,
  duplicate, delete; roster layers (name, number) show a person icon and sample text.
- **History**: every change is one reversible operation; undo/redo up to the core limit; a drag is
  one step (pattern already in `studio.js`).
- **Autosave**: draft saved after 2 s of inactivity (local in DS-1a, server from DS-1b); "Save
  design" creates a named immutable version; "Versions" opens a floating panel listing versions
  with restore-as-new.
- **Views**: Front/Back/Left/Right switch the edited panel; in 3D the same buttons move the camera;
  360° orbits (respects `prefers-reduced-motion`).
- **Validation**: findings stream into "Production info" as Blocker / Warning / Info, each linked to
  the layer it concerns; selecting a finding selects the layer.

### 3.5 Responsive specification

The 1672-wide desktop layout is primary. Breakpoints follow the repository's escape hatches.

| Width | Layout | Changes from the reference |
|---|---|---|
| ≥ 1600 | Five columns exactly as R2–R11 | None. |
| 1280–1599 | Sidebar collapses to a 64 px icon rail; R11 folds into the inspector's existing tabs (Colour, Material, Sizes already exist there in the image) | The bottom row (R13–R15) becomes one collapsible strip. |
| 981–1279 | Library becomes a floating drawer opened from the tool strip; inspector stays docked | Canvas keeps ≥ 55 % width. |
| ≤ 980 (`max-width:980px`) | Page returns to normal scrolling (repository rule). Canvas full width with a contextual toolbar above the selection; bottom tab bar: Library · Layers · Properties · Product; each opens a bottom sheet (`position: fixed`, opacity/transform only); sticky action bar with one primary action; workflow becomes a vertical stepper | 3D off by default on touch devices (opt-in, lazy-loaded). |
| `max-height:620px` | Normal scrolling | — |

Touch: 44 px targets; pinch zoom; two-finger pan; long-press opens the layer context menu. No
panel opening, tab switch or section load moves the canvas (fixed-height flex workspace,
`scrollbar-gutter: stable`, skeletons the size of their content) — the same rules
`tests/league-premium.unit.test.ts` pins.

### 3.6 Accessibility and language

- The layer list is the full non-pointer editing surface: every canvas action is reachable by
  keyboard (arrows move 1 mm, Shift 10 mm; `R` rotates 1°, Shift 15°; Delete; Ctrl/Cmd+Z/Y; Tab
  cycles layers). An `aria-live` region announces each change ("Club crest moved to 12 mm, 40 mm").
- Visible focus on every control; contrast ≥ 4.5:1 for text (the accent chosen in D5 is checked
  against `--fam-surface-panel`); colour swatches carry names; findings use icon + text, never
  colour alone.
- Strings: Club and Creator contexts through the catalogue for every locale in the registry; the
  owner room through a room catalogue for the official languages (existing practice). Design names,
  garment text, player names and club names are `data-user-content` and never translated.
- Garment text supports Arabic (shaping and direction per text layer, `dir: auto|rtl|ltr`); the
  canvas itself is never mirrored. Back/forward arrows use `_dirArrow()` / `window.famDirArrow`.

### 3.7 Visual acceptance and screenshot comparison

A pixel diff against concept art is meaningless (the jersey is a render). Proposed, from DS-1a:

1. **Region geometry**: every region carries `data-ds-region="R1…R15"`. A Playwright script at
   1672 × 941 (DPR 1) records bounding boxes and compares them with
   `docs/design-studio/reference-regions.json` (to be authored in DS-1a from §3.1); tolerance
   ±16 px or ±2 %.
2. **Palette**: sample background, panel, border, accent and text pixels; compare with the tokens
   (ΔE2000 ≤ 3).
3. **Review sheet**: side-by-side and 50 % overlay composites generated for human review at 1672,
   1280, 1024, 768 and 390 widths, in `en-GB` and `ar` (mirrored).
4. **Functional evidence** alongside (§12): persistent data, permissions, versions, constraints,
   performance measured against the budgets in §12.3.

The script runs in a session and at the approval gate; it is not proposed for CI until it is
stable (no browser is installed in CI today).

---

## 4. Three-context architecture (Deliverable C)

### 4.1 Contexts

| | Design Studio Control | Club Design Studio | Creator Studio |
|---|---|---|---|
| Who | Platform Owner (PlatformAdmin or SUPER_ADMIN) | Members of one club, by permission | An individual with a personal account |
| Where | SYSTEM — Owner Control room `#design-studio-control`, never inside a Club Workspace | Club Workspace page `#club-design-studio` | Personal area `#creator-studio`, outside any club |
| Owner of documents | `PLATFORM` (templates, patterns, catalogue) | `CLUB` (`clubId`) | `PERSONAL` (`userId`) |
| Server guard | `requirePlatformAuthority` | `authenticate` + club context + `design-access` decision + `tenantParam` | DS-ID personal-principal guard + ownership check |
| RLS | Platform tables (no club rows) | `familista.club_id` policy (existing) | New user policy (DS-ID) |
| Audit | `PlatformAuditLog` | Club audit chain | `PlatformAuditLog` with `userId` (D17) |
| Earliest phase | DS-1a (editor), DS-2 (catalogue) | DS-3 | DS-4 (after DS-ID) |

Shared: the document format, the core, the renderers, the template catalogue, the validation and
pricing algorithms. Not shared: storage roots, rows, permissions, navigation, audit trails.

### 4.2 The owner's own editing

The owner uses the same editor to author **platform templates** (PLATFORM-owned). The header's
three-way switch for the owner reads: *Design Studio Control* (governance), *Template authoring*
(PLATFORM documents) and, only where the owner account holds a real membership, *Club Design
Studio* for that club under club authority. Viewing another club's private designs is not an owner
capability; support access, if ever needed, goes through the existing impersonation service with
its audit (`src/services/admin-impersonation.service.ts`) and is out of scope.

### 4.3 Design Studio Control responsibilities (by phase)

Template and catalogue management (DS-2); manufacturing standards and output profiles (DS-2/5);
supplier records, credentials and status (DS-5); pricing policy and commission (DS-6, registered
algorithms); order oversight and production monitoring (DS-6); quality-control policy (DS-6);
approval policies (DS-3); agent governance links into the AI Agents Operations Room (DS-8);
audit visibility via the existing Audit Center. It is distinct from the **Design System** room (UI
tokens and components), which it does not touch.

### 4.4 Navigation

| Item | Owner | Club (by permission) | Creator |
|---|---|---|---|
| Design Studio Control | ✓ | — | — |
| Design Studio (editor) | Template authoring | Club designs | My designs |
| Store | Global catalogue admin | Club Store (DS-7) | Shop (DS-6) |
| Orders | All orders (oversight) | Club orders | My orders |
| Factories & suppliers | ✓ | — | — |
| Payments | ✓ | Club purchases (finance permission) | Payment history |
| Digital Twin, AI agents, Clubs | Existing owner rooms | — | — |

Navigation is drawn from a server response describing the caller's capabilities, never from a
client-side role check; the server refuses regardless of what the screen shows.

---

## 5. Shared design engine (Deliverable E)

### 5.1 Canonical document — `familista.product-design` v1

| Part | Content | Rules |
|---|---|---|
| Header | `format`, `version`, `name`, `template: { key, version, digest }` | Template version is pinned by digest; a template change never alters an existing design. |
| Units | `mm` | All geometry in millimetres on the template's reference size; whole 0.1 mm. |
| Configuration | `fit`, `fabric`, `method`, `colourway` | Keys from the pinned template's option lists only (closed lists, as in the existing core). |
| Palette | `{ id, srgb, label, ref?: { system, code } }` | `srgb` drives preview; `ref` carries a supplier or licensed colour reference when one exists. |
| Assets | `{ id, ref: "media:<uuid>", sha256, kind: svg\|raster, box }` | A reference only; bytes never inline; hash pins the exact file. |
| Panels | `[{ panel: front\|back\|sleeve-l\|sleeve-r\|collar\|…, base, layers[] }]` | Panel ids from the template. |
| Layers | `fill`, `pattern` (procedural id + params + palette refs), `text` (content, font id, size mm, tracking, curve, colour, outline, `dir`, `lang`), `image` (asset, transform), `vector` (asset, transform, recolour map), `roster` (`field: name\|number`, style), `group` | Each: `id`, `name`, `visible`, `locked`, transform `{ anchor, x, y, w, h, rotate }`. Anchors (e.g. `centre-chest`, `left-chest`, `back-number`) let placements grade across sizes. |
| Limits | bytes, layers, text length, asset count | Enforced on import and save, as in the existing core. |

**Rosters are not in the document.** A `roster` layer is a binding; names, numbers and sizes live
in separate roster rows (§6.2) joined only when production files are generated. The design can be
shared, versioned and previewed without carrying any person's data.

Migration: every stored version keeps its `version`; pure upgraders `vN → vN+1` run on read and are
unit-tested on fixtures; stored rows are never rewritten in place.

### 5.2 Derivations

| Output | From | Where | Phase |
|---|---|---|---|
| 2D editing view | document → SVG per panel, with print-area / safe-zone overlays | Browser | DS-1a |
| Shaded preview (Front/Back/Sides) | panel SVGs clipped into the template silhouette + shade overlay | Browser | DS-1a |
| 3D preview | panel SVGs rasterised into the template's UV atlas → Babylon `DynamicTexture` on the garment glTF | Browser, lazy | DS-1c |
| Customer preview | server render of the shaded preview with sample roster text | Server | DS-2 |
| Production proof | server render of the exact print files the supplier will receive | Server | DS-5 |
| Supplier print files | document + template version + configuration + roster + supplier output profile | Server worker | DS-5 |
| Tech pack | sizes × quantities, roster, colours with references, fabric, method, placements | Server worker | DS-5 |

The customer approves the **production proof**, not the editor view: what is approved is byte-for-byte
what is submitted (§8.4).

### 5.3 2D editor — library comparison

| Option | Licence | Fit | Verdict |
|---|---|---|---|
| Own SVG renderer driven by the document (+ existing core geometry) | — | Vector-exact; no second object model; CSP-safe; accessible DOM; Arabic shaping by the browser; same serializer feeds export | **Recommended** |
| Fabric.js | MIT | Mature canvas editor | Brings its own object model and serialisation → two sources of truth; canvas output must be re-vectorised for production |
| Konva | MIT | Fast canvas scene graph | No native SVG export; same two-model problem |
| Polotno SDK | Commercial | Full editor, has a Gelato integration | Paid, external model, licence lock-in |
| Supplier-embedded editors (e.g. Printful's embedded designer) | Vendor terms | Fast POD start | Iframe (`frame-src 'none'` change), ties the design to one supplier — contradicts supplier neutrality |

Reuse from the existing studio core: the *pattern* — a pure UMD core, closed-shape validation,
reversible operations with an undo history, camera and hit-test geometry. *Corrected (final DS-0
review):* this section first proposed extracting the existing core's functions into a shared kernel.
They round to whole pixels and the product document needs 0.1 mm, so sharing them would mean
changing the Interface Studio. DS-1a writes its own millimetre core and leaves the Interface Studio
byte-for-byte unchanged; a shared kernel is reconsidered only if measured duplication justifies it (D3).

### 5.4 3D preview

Reuse the vendored Babylon.js 7.54.3 (Apache-2.0); adding three.js would put two 3D engines in one
product. Loaded only when the 3D toggle is used (6.8 MB). Requirements on each garment template:
glTF 2.0, one UV island per pattern panel, a panel → UV transform table, a fabric normal map, and
level-of-detail for mobile. **No such model exists in the repository** (only `player.glb`). Sourcing
options: commission (cost), license a garment library (licence review), or supplier-provided
templates (Printful/Printify publish flat print templates, not 3D — **Unverified** for 3D). Until a
model exists, the 3D toggle is disabled with that reason; the shaded 2.5D preview carries the visual.

### 5.5 Templates

A **product template version** declares: panels and their outlines (mm, per size), print areas and
safe zones per panel and method, anchors, allowed methods, fabrics, fits, size chart reference,
fonts and patterns allowed, preview silhouette and shade art, optional glTF and UV table. In DS-1/2
templates are **reviewed repository data** (like agent manifests), validated by a test and
fingerprinted; runtime template management moves to the database only when the owner needs to edit
templates without a release (DS-2 decision).

### 5.6 Assets

- Upload through the API (no browser → bucket PUT, so no `connect-src` change), size-capped,
  type decided by magic bytes, never by extension.
- SVG: server-side allow-list sanitizer (elements, attributes, no script, no `foreignObject`, no
  event attributes, no external `href`/`url()`), re-serialised; the design-system lab already keeps
  an allow-list sanitizer (`public/design-system/lab-sanitize.js`) whose approach is reused.
- Raster: dimension and effective-DPI read from headers in DS-1b; re-encoding and metadata stripping
  with `sharp` (Apache-2.0) proposed for DS-4 when the public can upload (D13).
- Stored through the Fabric object store; club artwork recorded as `MediaAsset` with
  `aiEligible = false`, content-addressed by SHA-256; read through short-lived signed URLs.
- Rights: every upload records the uploader's attestation of rights; official club brand assets are
  a separate, approved state (§10.4).

### 5.7 Autosave and versions

Working draft: one mutable head per project with an integer revision; saves are optimistic
(`If-Match` revision → 409 on conflict, never a silent overwrite). Versions: immutable snapshots
with SHA-256, author, label; orders and approvals reference versions, never the draft. Retention:
versions kept while the project exists; drafts of deleted projects removed by the retention worker.

### 5.8 Manufacturing-safe export

No universal format. Each supplier adapter declares an **output profile**: placement names,
canvas size in px or mm, DPI, colour space, bleed and safe zone, file type (PNG / PDF / SVG),
whether text must be outlined, maximum file size. Typical lanes: print-on-demand expects raster
print files per placement; cut-and-sew sublimation partners expect per-panel 1:1 vector artwork with
bleed plus a tech pack; embroidery needs a digitised stitch file produced by the manufacturer from
vector art. Server-side rendering: `@resvg/resvg-js` (MPL-2.0) for raster, `pdfkit` (MIT) for PDF
and tech packs, `harfbuzzjs` (MIT, WASM, server only) to outline text with correct Arabic shaping —
each a DS-5 dependency decision (D13). Colour: sRGB preview; CMYK/ICC only when a supplier's
profile requires it; the interface states that screen colour is not a physical colour guarantee.

---

## 6. Data and algorithm integration (Deliverable F)

### 6.1 Sources of truth

| Data | Authority | Store | Classification | Phase |
|---|---|---|---|---|
| Product categories, templates, print areas, size charts, materials | Repository (reviewed) → later `ProductTemplate*` tables | Git → PostgreSQL | PUBLIC | DS-1/2 |
| Design project, draft, versions | `DesignProject`, `DesignDraft`, `DesignVersion` | PostgreSQL (JSONB ≤ 1 MB, justified: small, transactional, RLS-protected) | INTERNAL (club) / personal | DS-1b |
| Artwork, logos, vectors | `MediaAsset` (club); personal model decided in DS-ID | Object store via Fabric port | INTERNAL | DS-1b/3 |
| 3D models, preview art | Repository (templates) | Static files | PUBLIC | DS-1c |
| Rosters (names, numbers, sizes) | `DesignRoster`, `DesignRosterEntry` | PostgreSQL | CONFIDENTIAL; RESTRICTED when any entry is a minor | DS-3 |
| Brand approvals, publish approvals | `DesignApproval` | PostgreSQL | INTERNAL | DS-3 |
| Supplier records, capabilities, product mappings | `Supplier`, `SupplierCapability`, `SupplierProductMapping` | PostgreSQL | INTERNAL (platform) | DS-5 |
| Supplier credentials, webhook secrets | Fabric secret store | Envelope-encrypted rows | RESTRICTED | DS-5 |
| Quotes | `Quote` (immutable, `expiresAt`, breakdown, algorithm fingerprint) | PostgreSQL | CONFIDENTIAL | DS-5 |
| Orders, items, status history | `Order`, `OrderItem`, `OrderEvent` (append-only) | PostgreSQL | CONFIDENTIAL | DS-6 |
| Payments | `PaymentRecord` (Stripe ids and amounts only; never card data) | PostgreSQL | CONFIDENTIAL | DS-6 |
| Supplier submissions, webhooks | `SupplierSubmission` (idempotency key), `SupplierWebhookEvent` (dedupe by event id) via `EventOutbox` | PostgreSQL | INTERNAL | DS-5/6 |
| Shipments | `Shipment` | PostgreSQL | CONFIDENTIAL (address) | DS-6 |
| Production files | Object store, `orders/…` under the owner's root | Object store | CONFIDENTIAL | DS-5 |
| Support | `SupportCase` (minimal) | PostgreSQL | CONFIDENTIAL | DS-6 |
| Audit | Club chain / `PlatformAuditLog` | PostgreSQL | — | all |
| Permissions | `design-access` decision file (role-derived), optional `DesignGrant` rows later | Code / PostgreSQL | — | DS-3 |

Ownership columns on every owned row: `ownerKind (CLUB|PERSONAL|PLATFORM)`, `clubId?`, `ownerUserId?`,
with a database CHECK that exactly the right one is set. All new models go in one Prisma section
headed "Design Studio" so the Twin's composer files them correctly.

### 6.2 Relationships (summary)

`ProductTemplateVersion 1—* DesignProject 1—1 DesignDraft`, `DesignProject 1—* DesignVersion`,
`DesignVersion *—* MediaAsset` (through the document's asset refs, validated on save),
`DesignProject 1—* DesignRoster 1—* DesignRosterEntry (→ Player? optional)`,
`DesignVersion 1—* DesignApproval`, `DesignVersion 1—* Quote 1—0..1 Order 1—* OrderItem`,
`Order 1—* OrderEvent`, `Order 1—* PaymentRecord`, `Order 1—* SupplierSubmission 1—* Shipment`.

### 6.3 Algorithms

| Algorithm | Kind | Registered in `src/algorithms/registry.ts` | Phase |
|---|---|---|---|
| Document validation (shape, limits, closed lists) | Deterministic | No (validator) | DS-1a |
| Print-area containment: transformed layer bounds within print area minus safe zone, per panel and per graded size | Deterministic geometry | Yes | DS-1a |
| Effective resolution: px ÷ (size mm ÷ 25.4) ≥ profile minimum | Deterministic | Yes | DS-1b |
| Method constraints: minimum text height, minimum stroke, colour count, gradients allowed — values from supplier capability data, never invented | Deterministic, data-driven | Yes | DS-5 |
| Material–method compatibility | Lookup | Yes | DS-2 |
| Size availability = template sizes ∩ supplier sizes for the configuration | Set | Yes | DS-5 |
| Roster rules: unique numbers per kit set, number range, name fits the area at the chosen size | Deterministic | Yes | DS-3 |
| Supplier matching: capable suppliers ranked by cost, lead time, region | Deterministic scoring with declared weights | Yes | DS-5 |
| Price: supplier cost + shipping + platform margin policy + VAT by destination, integer minor units, declared rounding | Deterministic | Yes | DS-6 |
| Order status transitions | State machine table | No (tested table) | DS-6 |

Registering pricing and matching means a change to a price rule is a fingerprint change that fails
the build until the owner approves it — the existing governance, applied unchanged.

### 6.4 Neural Digital Twin evidence (no Twin change)

The Studio becomes visible through the authorities the composer already reads: its module directory
under `src/` (files and TypeScript imports), its mounted routers (security manifest), its Prisma
section, its agent manifests (DRAFT/LAB), a `SYSTEM_MODULES` entry, and coverage-map trust-boundary
rows for the supplier webhook and payment boundaries. Supplier relationships appear as *declared*
(static) edges; nothing claims runtime observation of a supplier.

*Corrected (final DS-0 review):* the composer reads `src/`, never `public/`
(`src/platform/neural-twin/compose.ts:1-25`). DS-1a is frontend-only, so it is **not** visible in the
Twin — exactly like the existing owner rooms (Interface Studio, Design System Control, the Twin's own
room). Visibility begins with DS-1b, when the Studio has server code, routes and a Prisma section.

---

## 7. AI and multi-agent integration (Deliverable H)

All agents below are **future proposals**. None exists. Each joins only as a manifest in
`src/platform/agents/catalog.ts`, domain `COMMERCE` (already in `AGENT_DOMAINS`), lifecycle DRAFT or
LAB, autonomy ceiling ≤ SUGGEST unless stated, through a reviewed pull request; the runtime refuses
jobs for non-RUNNING manifests and honours the kill switch.

| Agent | Scope | Reads | Tools | Output | Human approval | Cost control |
|---|---|---|---|---|---|---|
| Design Assistant | CLUB (PERSONAL scope missing — gap) | The open document, template | none that write; returns proposed operations | Proposed ops shown as a preview the user accepts | Every proposal applied by the user | Per-owner daily quota; model and token caps from `AI_LLM_*` |
| Logo & Branding Assistant | CLUB | Club palette, crest raster | vector suggestions | Draft asset (not official) | Official status only via `DesignApproval` by a brand approver | Same |
| Product Configuration Assistant | CLUB/PLATFORM | Templates, capabilities | read-only catalogue | Recommended configuration | User selects | Deterministic first; LLM only for explanation |
| Manufacturing Preparation Assistant | PLATFORM | Validation findings | read-only | Explanations and fix suggestions | User applies | — |
| Supplier Matching Assistant | PLATFORM | Capabilities, quotes | read-only | Narrative over the deterministic ranking | Owner policy decides; agent never selects | — |
| Order Support Assistant | CLUB/PLATFORM | One order's status and events | read-only | Draft replies | Staff sends | — |
| Quality Review Assistant | PLATFORM | Production proofs, supplier QC photos | read-only | Flags for human QC | QC person decides | Image analysis cost per order, capped |

Never, under any manifest: approve branding, submit or pay for orders, read another tenant's
designs, see supplier credentials, or use customer artwork for training (`MediaAsset.aiEligible`
stays false; no training pipeline consumes design assets). Logging through the existing
execution-evidence and trace-chain modules. Nothing in this table is proposed before DS-8.

---

## 8. Product and manufacturing architecture (Deliverables G, I)

### 8.1 Two manufacturing lanes

| | Lane A — print-on-demand | Lane B — full-custom cut-and-sew |
|---|---|---|
| Products | T-shirts, hoodies, sweatshirts, polos, caps, bags, some all-over-print sportswear (availability per supplier **Unverified**) | Match kits, goalkeeper kits, shorts, socks, training wear, tracksuits, vests — sublimated panels sewn to pattern |
| Files | Raster print files per placement | Per-panel vector artwork with bleed, tech pack, roster |
| Quantity | One unit | Partner-specific; market examples show no minimum (owayo, Spized) to small minimums |
| Integration | Public REST APIs (Printful, Printify, Gelato) | Usually no public API: email/portal/SFTP; a **manual-assisted adapter** where an operator transmits a generated package and records status |
| Phase | DS-5 sandbox first | Partner search in parallel; DS-5 manual adapter |

Professional club kits (the image's centre) are Lane B. Lane A suppliers are not assumed able to
make them.

### 8.2 Catalogue and variants

Category tree: Sportswear (jersey, home/away/third, goalkeeper, shorts, socks, training shirt,
tracksuit, jacket, training vest), Casual (T-shirt, polo, hoodie, sweatshirt, casual jacket),
Accessories (cap, bag, scarf, flag, other). A product = template + configuration (fit, fabric,
method, colourway) + size. Sizes: per template, a size chart with fit groups (children, youth,
women, men, extended) and measurements in millimetres (chest, length, sleeve, waist, inseam as
relevant); purchasable sizes = capability intersection. MOQ and bulk price breaks come from supplier
capability rows. Nothing is purchasable without a supplier mapping.

### 8.3 Supplier adapter port

One TypeScript interface, one implementation per supplier, no supplier vocabulary outside its adapter
(the Fabric object-store discipline). Each adapter declares: identity and status; auth method
(secret-store reference); catalogue sync; capability mapping (sizes, colours, materials, methods,
placements, MOQ, lead time, regions); output profiles; `quote`; `submit` (idempotent, our order id as
the supplier's external id where supported — **verify per supplier**); `getStatus`; webhook
verification and normalisation; tracking; cancel; refund/reprint request; error taxonomy (retryable /
terminal / needs-human); rate-limit budget; audit fields.

### 8.4 Order lifecycle

| Step | Sync / async | Notes |
|---|---|---|
| Design → configuration → sizes/roster | Sync | Club team orders add COLLECTING (roster) and APPROVAL_PENDING |
| Validation | Sync | Blockers stop the flow |
| Production proof | Async job, awaited by UI | Files generated once, hashed |
| Quotation | Sync with timeout (cached supplier prices allowed, never older than the quote TTL) | Immutable; `expiresAt`; re-quote on expiry or supplier change |
| Customer approval of proof and quote | Sync | Binds proof hash + quote id |
| Payment authorisation | Hosted Stripe Checkout redirect; confirmation by signed webhook (async) | Order becomes PAID only from the webhook |
| Manufacturing submission | Async: outbox row in the payment transaction → worker | Idempotency key = order id; duplicate submission impossible by unique key |
| Production, QC, shipping, delivery | Async: supplier webhook + scheduled reconciliation poll | A webhook triggers a re-fetch; its body is never trusted alone |
| Support, returns, reprints | Mixed | Personalised goods exception to withdrawal is a legal-review item (§9.3) |

Failure handling: supplier outage → submission stays queued with backoff and an owner alert;
availability change after payment → ON_HOLD with customer choice (wait / alternative / refund);
quote expired at payment → refused before redirect; delivery exception → support case; repeated
terminal error → human queue. States: DRAFT, QUOTED, AWAITING_PAYMENT, PAID, SUBMITTED, IN_PRODUCTION,
SHIPPED, DELIVERED, CLOSED; side states CANCELLED, PAYMENT_FAILED, SUBMISSION_RETRYING, ON_HOLD,
REFUNDED, PARTIALLY_REFUNDED, RETURN_REQUESTED.

### 8.5 Supplier status — current truth

| Supplier | Status | Evidence |
|---|---|---|
| Printful | Under evaluation | Official docs read: v1 REST with a 120 req/min general limit and a lower mockup-generator limit; v2 published as **2.0.0-beta** with leaky-bucket rate-limit headers; private-token auth. Webhook signature scheme and all-over-print sportswear availability **unverified**. |
| Printify | Under evaluation | Official docs: personal access tokens per merchant account, OAuth for apps, per-account rate limits, catalogue capped at 100 req/min. Webhook details **unverified**. |
| Gelato | Under evaluation | Official docs: API key in `X-API-KEY`, quote endpoint, order webhooks; sandbox mentioned on its features page. Version of the quote endpoint (v2 vs v4) **unverified**. |
| Specialised sportswear manufacturers | Not researched | No partner identified. owayo and Spized run their own 3D configurators (no minimum order; Spized states sublimation) — they are competitors, not known API suppliers. |

Statuses shown in the product: Not researched · Under evaluation · Integration planned · Sandbox
connected · Production connected · Operational · Unavailable. A state is set only with evidence
(a passing sandbox order for "Sandbox connected", a reconciled live order for "Operational").

### 8.6 Competitive notes

owayo and Spized: 3D configurators, per-unit ordering, reorders, sublimation included in price.
What Familista can do that a stand-alone configurator cannot: roster from the club's own squad with
consent and minimisation; official-brand approval inside the club; team-order collection from players
and parents; season collections linked to competitions; one identity across club and personal use;
supplier neutrality; Arabic and multilingual garment text with shaping verified in production files.
Patentability is honestly low for the editor itself (heavy prior art); defensibility comes from the
integration with club data and governance. A narrower candidate worth a patent-attorney opinion:
privacy-separated roster binding compiled into supplier-specific production packages.

---

## 9. Commerce architecture (Deliverable J)

### 9.1 Who sells

| Model | Seller of record | Buyer | Payments | Phase |
|---|---|---|---|---|
| Individual order | Familista (legal entity) | Consumer | Stripe Checkout, platform account | DS-6 |
| Club team order | Familista | The club (B2B) | Stripe Checkout or invoice | DS-6 |
| Club Store | The club (merchant) on a Familista marketplace | Fans | Stripe Connect (adapter exists as `LEDGER_ONLY`) | DS-7 |
| Creator Store | Creator (trader or not — legal question) | Public | Stripe Connect | DS-7+ |

Recommended MVP: the first two only — one seller, no marketplace obligations, no payouts.

### 9.2 Capabilities by phase

Listings, variants and design references (DS-6 shop for own designs; DS-7 stores); cart (DS-6,
server-side, priced only from quotes); checkout (hosted Stripe Checkout — PCI scope stays with Stripe,
no CSP change); taxes (VAT by destination through policy packs; OSS registration question); invoices
(`pdfkit`, numbered, retained for the statutory period); commissions (DS-7, a registered algorithm);
fulfilment, shipping, tracking, refunds, returns, support, bulk orders, order history, reporting (DS-6).

### 9.3 German / EU items for professional review before live sales

Legal notice under the DDG (formerly TMG); pre-contract information and the order button wording
(§ 312j BGB); the withdrawal right and its exception for goods made to the consumer's specification
(§ 312g (2) no. 1 BGB) and how mixed baskets are handled; statutory warranty for defects; price
indication (PAngV); General Product Safety Regulation (EU) 2023/988 (responsible economic operator,
online product information); textile fibre labelling (EU) 1007/2011; packaging registration
(VerpackG / LUCID) and who is the obliged party with drop-shipping; VAT and OSS; invoice retention
versus GDPR deletion; GDPR Art. 28 processing agreements and international transfers for each
supplier; minors' capacity to contract and GDPR Art. 8 age for personal accounts; trademark and
copyright in uploaded artwork, notice-and-action for hosted content (DSA), and trader traceability
if a marketplace is opened (DSA Art. 30). None of this is resolved by software.

---

## 10. Security and privacy (Deliverable K)

### 10.1 Separate permissions

Design · Approve official branding · Publish · Purchase · Submit for manufacturing · Manage team
orders · Administer suppliers. None implies another.

### 10.2 Club defaults (role-derived, one decision file)

| Permission | CLUB_OWNER | CLUB_ADMIN | FINANCE_MANAGER | Coaching roles | ANALYST, others | PLAYER, PARENT |
|---|---|---|---|---|---|---|
| Design | ✓ | ✓ | — | ✓ (own team's kits) | — | — |
| Approve official branding | ✓ | ✓ | — | — | — | — |
| Publish to Club Store | ✓ | ✓ | — | — | — | — |
| Purchase | ✓ | ✓ | ✓ | — | — | — |
| Submit for manufacturing | ✓ | ✓ | ✓ | — | — | — |
| Manage team orders | ✓ | ✓ | ✓ | ✓ (own team) | — | own size/number entry only (DS-3) |
| Administer suppliers | Platform Owner only | | | | | |

Separation of duties: an approval is decided by a different person from the requester (as in the AI
approval gate). Team-pinned memberships stay team-pinned (`team-access.service.ts`).

### 10.3 Isolation, in layers

Service check of `ownerKind`/owner id on every read and write; `tenantParam` resolvers for
`designProject`, `designVersion`, `designRoster`, `order`; RLS on every club-owned table under the
existing policy; storage keys under `clubs/<clubId>/design/…` checked by `assertClubKey`; signed
reads with short expiry; tests that drive the real routers with a foreign id (the pattern of
`tests/tenant-param-guard.unit.test.ts`) and the RLS CI job extended to the new tables.

Personal accounts (DS-ID): a personal principal is refused by every router except an explicit
allow-list (auth, account, Creator Studio, shop, orders). This is safer than auditing every
`req.user.clubId` use: an absent club id must never reach a query as `undefined`.

### 10.4 Brand and publication controls

Official club brand assets: uploaded by Design permission, made official only by a `DesignApproval`
of kind `OFFICIAL_BRANDING` decided by a brand approver of that club. Official assets cannot be
imported into a personal context or another club. Publishing a design to a store requires a
`PUBLISH` approval of the exact version. A personal user cannot claim official identity; public
listings (DS-7) carry a report button and a review queue. Trademark misuse cannot be fully
prevented by software; attestation, review and takedown are the controls.

Public templates derived from private work: "publish as template" creates a new PLATFORM-owned
template from a copy of the document after review; assets are re-copied into the platform root after
review, roster bindings and private metadata are removed, raster metadata stripped. The private
original is never referenced.

### 10.5 Classification entries

`design-project` INTERNAL, `design-roster` CONFIDENTIAL (RESTRICTED when a minor is present),
`order` CONFIDENTIAL, `payment-record` CONFIDENTIAL, `supplier-credential` RESTRICTED, published
template PUBLIC.

### 10.6 Youth and personal data

Rosters may hold minors' names and numbers for an authorised kit order only; never public, never in
the design document, never in previews (sample text instead). Suppliers receive only what is printed
plus sizes; no date of birth, no player id. Shipping goes to the club, not to children's homes, for
team orders. Roster entries are deleted after delivery plus the return window (retention policy;
aggregated sizes kept). Consent requirements for printing a minor's name are a legal-review item.

### 10.7 Supplier credentials and webhooks

Credentials in the Fabric secret store (`db` provider, AES-256-GCM under `FAMILISTA_SECRET_KEK`,
keyring rotation); owner-only administration; never returned to any client; rotation added to
`docs/security/secrets-rotation.md`. Webhooks: each supplier path added to
`src/middleware/raw-body-paths.ts` with its verifier on the route, deduplicated by event id, followed
by a status re-fetch. Payments: Stripe webhook already verified the same way.

### 10.8 CSP — no widening

Libraries vendored; uploads proxied; Stripe hosted Checkout by redirect; WASM only on the server;
fonts self-hosted (OFL licences, permitting embedding in production files). If the owner later wants
direct-to-bucket uploads or an embedded payment element, each is a named, narrow CSP change for
separate approval.

---

## 11. Technology recommendations (Deliverable M)

Free and already-present first. Prices are not quoted: none were verified for this document.

| Need | Recommendation | Already in repo | Licence | Cost driver |
|---|---|---|---|---|
| 2D editor | Own SVG renderer and millimetre core (the existing studio's pattern, not its code) | Pattern yes | — | Engineering time |
| 3D preview | Babylon.js 7.54.3 | Yes | Apache-2.0 | Garment models (commission/licence); 6.8 MB bandwidth per 3D session (cache) |
| Storage | Fabric object store → S3-compatible bucket (e.g. Cloudflare R2, EU jurisdiction option) | Port + `@aws-sdk/client-s3` yes | — | Storage GB-month, operations; egress (R2 advertises none — verify) |
| DB | PostgreSQL (existing) | Yes | — | Plan size as rows grow |
| Jobs | DB-polling workers + `EventOutbox` | Yes | — | None new |
| Payments | Stripe hosted Checkout; Connect at DS-7 | `stripe` yes | — | Per-transaction fees |
| Raster processing | `sharp` (DS-4) | No | Apache-2.0 | Native build on Render |
| Print rendering | `@resvg/resvg-js` (DS-5) | No | MPL-2.0 | CPU per order |
| PDF | `pdfkit` (DS-5/6) | No | MIT | — |
| Text shaping for production | `harfbuzzjs` server-side (DS-5) | No | MIT | — |
| Fonts | OFL families (Inter, Noto Sans Arabic in use; add sport display faces under OFL) | Partly | OFL | — |
| Visual checks | Playwright script (session/gate) | Not a dependency | Apache-2.0 | — |
| AI | Existing `@anthropic-ai/sdk` through the agent runtime (DS-8) | Yes | — | Inference per call, capped |
| Manufacturing | Lane A per-item supplier cost; Lane B partner price lists | — | — | Per order, plus samples |

Rejected: microservices, Kafka/BullMQ for this feature, n8n (not present; nothing here needs it),
Shopify (not present; would duplicate catalogue and orders), Fabric.js/Konva (two models), a second 3D
engine.

---

## 12. Implementation roadmap (Deliverable L)

Each phase with a server part is behind a feature flag (*corrected:* the flag service is server-side,
`src/platform/innovation/flags.ts`; DS-1a has no server part and is reached only through the owner
check every owner room uses, which is convenience and not a security boundary), merged only with owner approval, deployed only by the existing
gated workflow.

| Phase | Objective | Depends on | Scope | Visible result | Tests / acceptance | Main risks | Cost drivers |
|---|---|---|---|---|---|---|---|
| DS-0 | This document | — | Research, design | — | Owner review | — | Time |
| **DS-1a** | Engine foundation | D1–D3, D5, D6 | Document v1, millimetre core (no change to the existing studio), SVG 2D editor, one jersey template (repo data), shaded preview, approved layout shell with truthful disabled controls, local draft + JSON export, i18n | Owner edits a jersey for real | Core unit tests incl. negative controls; existing studio tests unchanged; layout-stability tests; i18n check; region/palette script; keyboard path | Template art quality | Silhouette/shade art |
| DS-1b | Persistence | DS-1a, migration approval | `DesignProject/Draft/Version`, owner-guarded routes, autosave with revisions, versions panel, owner asset upload (sanitised SVG, PNG) on current storage, audit | Designs survive devices | Route tests, conflict (409) tests, sanitizer corpus, contract check | Disk capacity (F4) | None new |
| DS-1c | 3D preview | DS-1a, garment model (D4) | Babylon loader, UV atlas, 360° | 3D toggle live | FPS/time budgets measured | Model sourcing | Model commission/licence |
| DS-S | Object storage | Provider decision (D8) | Configure port, migrate assets, signed reads, backup coverage | — | Restore drill includes media | Provider lock-in | Storage/ops fees |
| DS-2 | Catalogue | DS-1b | Categories, templates (repo or DB), size charts, materials, compatibility | Library shows the real catalogue | Template validation, fingerprint | Scope creep | Template art per product |
| DS-3 | Club Design Studio | DS-1b, DS-2, DS-S | Club ownership, `design-access`, RLS, brand assets via `MediaAsset`, approvals, rosters, team-order collection (no payment) | Clubs design and approve kits | Cross-tenant negative tests on real routers, RLS CI, separation-of-duties tests | Permission mistakes | — |
| DS-ID | Personal accounts | Security review | Personal principal, allow-list gate, registration with verification and abuse controls, user RLS policy, personal asset model | Individuals can sign up | Full security suite + new gate tests | Highest-risk identity change | Email, abuse controls |
| DS-4 | Creator Studio | DS-ID, DS-S | Personal projects, libraries, `sharp` re-encoding | Individuals design | Isolation tests personal↔club | Abuse, IP misuse | Moderation time |
| DS-5 | Manufacturing sandbox | DS-2, supplier sandbox accounts (owner) | Adapter port, Lane A sandbox adapters, Lane B manual adapter, output profiles, proofs, quotes (labelled non-production) | Sandbox quotes and test orders | Contract tests per adapter, webhook signature tests, idempotency tests | API changes, beta APIs | Sample orders |
| DS-6 | Commerce & fulfilment | DS-5, legal review, owner approval of live keys | Orders, Stripe Checkout, tax policy packs, invoices, shipping, support, returns | Real orders | End-to-end with Stripe test mode, reconciliation tests | Legal, refunds | Transaction fees, samples |
| DS-7 | Stores & marketplace | DS-6, marketplace legal review | Club Stores, Connect payouts, commissions, later Creator Stores | Stores live | Payout ledger tests | Marketplace obligations | Connect fees |
| DS-8 | AI capabilities | Agent governance approvals | Manifests DRAFT→LAB→RUNNING per agent | Assistants | Agent registry tests, evals | Cost, hallucinated specs | Inference |

### 12.3 Performance budgets (targets to measure, not claims)

Editor shell interactive ≤ 2.5 s on a mid laptop excluding 3D; drag repaint at display rate for 200
layers; 3D first frame ≤ 3 s after its bundle loads on desktop; autosave payload ≤ 1 MB; proof
generation ≤ 30 s per order in DS-5.

---

## 13. Recommended first increment — DS-1a

**Objective**: make the canonical document and the shared engine real, inside the approved layout,
for the Platform Owner, without touching the database, the API, authorization, the CSP or any
dependency.

**Functional in DS-1a**

- `familista.product-design` v1: validation (closed shape, limits), reversible operations,
  undo/redo, mm geometry, print-area containment check with findings.
- One template: football jersey (front, back, sleeves) with print areas, safe zones, anchors and a
  size chart as reviewed repository data.
- 2D editor: select, move, resize, rotate, align, snap, grid and safe-zone overlays; layers with
  visibility, lock, reorder, rename, duplicate, delete; base colours, palette, procedural patterns
  (stripes, gradients, geometric); text and number/name placeholder layers with OFL fonts and Arabic
  text. *As authorised:* the DS-1a scope did not include artwork import, so SVG import was not built;
  the Image tool is present, unavailable, and says it needs secure server storage (DS-1b).
- Views: Front, Back, Left, Right; shaded 2.5D preview.
- Draft autosaved in the browser; export/import of the validated JSON file.
- Approved layout R1–R15, responsive rules, RTL mirroring, keyboard path, catalogue/room strings in
  every required locale.

**Present and disabled, each with its reason**

3D and 360° ("needs a garment model"); Templates/Elements tabs beyond the jersey ("catalogue in
DS-2"); Club Design Studio and Creator Studio segments ("planned"); Versions ("server versions in
DS-1b"); estimated cost (`—`, "no supplier connected"); Production preview ("proofs in DS-5");
Continue to order ("ordering not available"); sizes ("reference sizes, not purchasable"); production
method/fabric (template options only, "no supplier capability yet"); suppliers card (true statuses
from §8.5); integration card (true state per line).

**Not in DS-1a**: migrations, routes, uploads, server storage, payments, suppliers, AI, 3D.

**Acceptance**: core tests with negative controls (invalid documents refused, out-of-area layers
flagged, undo restores byte-identical documents); the existing studio byte-for-byte unchanged and its
tests passing (*corrected:* no kernel extraction in DS-1a); layout-stability and RTL navigation tests; `npm run i18n:check`; typecheck; build;
the region/palette comparison report and the review sheet at five widths in `en-GB` and `ar`;
manual keyboard-only walkthrough recorded.

---

## 14. Decisions requiring owner approval

| # | Decision | Recommendation |
|---|---|---|
| D1 | Naming. The existing owner tool is "Design Studio"; the image's owner context is "Design System Control", close to the existing "Design System" room. | Keep "Design Studio" for this product (as approved). Rename the existing UI-frame tool to "Interface Studio" (UI label only). Name the owner context "Design Studio Control". Technical module `product-design`. |
| D2 | Frontend stack | Vanilla lazy-loaded module following the owner-room pattern; not React (`client/` has no design or commerce surface and would split the design system). |
| D3 | 2D engine and kernel | Own SVG renderer. *Corrected:* no shared kernel in DS-1a — the existing studio's geometry is whole-pixel and stays untouched; reconsider only on measured duplication. |
| D4 | 3D garment models | Babylon reuse confirmed; approve sourcing route (commission vs licensed library) and budget before DS-1c. |
| D5 | Colour conflicts | Module accent in an indigo-violet distinct from `status-unverified`, with unverified chips always labelled; "Continue to order" in the module accent rather than green (green kept for validation results). Alternative: approve green as a documented commerce exception. |
| D6 | Arabic layout | Mirror the chrome (sidebar, library, inspector) in RTL; never mirror the garment or its views. |
| D7 | Personal accounts | Separate security phase DS-ID with an allow-list gate; Creator Studio waits for it. |
| D8 | Object storage | S3-compatible bucket in an EU region via the existing port, before DS-3 at scale and before DS-4. |
| D9 | Seller of record (MVP) | Familista sells individual and club team orders; marketplace models only in DS-7. |
| D10 | Manufacturing lanes | Lane A sandbox first; start Lane B partner search now; no supplier shown beyond "Under evaluation" until evidence exists. |
| D11 | Club permission defaults | Matrix §10.2 with separation of duties. |
| D12 | Roster privacy | Rosters outside the design; deleted after delivery + return window; suppliers receive printed fields and sizes only. |
| D13 | Future dependencies | None in DS-1; `sharp` (DS-4), `@resvg/resvg-js`, `pdfkit`, `harfbuzzjs` (DS-5) each approved at their phase. |
| D14 | Pricing governance | Pricing, quote and matching rules as registered, fingerprinted algorithms requiring owner approval to change. |
| D15 | Supplier logos | Names and statuses only until brand terms are reviewed. |
| D16 | AI | No agent before DS-8; manifests DRAFT/LAB; decide whether a PERSONAL agent scope is wanted. |
| D17 | Audit without a club | `PlatformAuditLog` for platform and personal actions; revisit a per-user hash chain if required. |
| D18 | CSP | No change through DS-6 (redirect Checkout, proxied uploads, server-only WASM). |
| D19 | Reference image | Keep `docs/design-studio/approved-reference-2026-11-10.webp` as the fixed visual baseline. |

---

## 15. DS-1b — secure server persistence, as built

**What it is.** The Platform Owner's designs are saved in PostgreSQL as projects with immutable revisions. The draft in
the editor is still kept in the browser after every change, exactly as in DS-1a; *Save design* keeps it on the server as
the next revision of its project (the first save creates the project). Everything is behind the server's own platform
owner check; the browser's room check remains a convenience.

| Part | Where | What it does |
|---|---|---|
| Data | `prisma/schema.prisma` section "Design Studio"; migration `20261111100000_design_studio_persistence` | `DesignProject` (ownership, template, `headRevision`, origin, archive) and `DesignRevision` (number, kind, `restoredFrom`, canonical document as JSONB, SHA-256 of its canonical text, size, format version, author). |
| Validation | `src/platform/product-design/core.ts` | The server validates with the editor's own `pd-core.js` and template: one validator, so the server stores nothing the editor cannot open. |
| Service | `src/platform/product-design/service.ts` | Create, open, list, save, list revisions, read a revision, restore, archive / return. Every query is scoped to `ownerKind = PLATFORM`; every change writes its `PlatformAuditLog` entry in the same transaction. |
| Routes | `src/routes/product-design.routes.ts`, mounted at `/system/product-design` | `authenticate` + `assertPlatformOwner` before any handler, `no-store`, zod for the envelope, 409 with the head on a stale save, 400 with the core's codes on an invalid document. |
| Editor | `public/product-design/pd-server.js`, `product-design.js` | Save, Projects and Versions are functional: saving, loading, error and conflict states; the DS-1a draft becomes a project on its first save; JSON export / import unchanged. |

**Ownership, designed for later contexts and not activated.** Every project carries `ownerKind` (`PLATFORM`, `CLUB`,
`PERSONAL`), `clubId?` and `ownerUserId?`, with a CHECK that exactly the right owner is set (§6.1). A second CHECK,
`DesignProject_context_active`, admits `PLATFORM` rows only: the database itself refuses a Club or Creator design
until the phase that activates that context drops it in the same migration that adds the context's foreign key and its
row-level security policy (§10.3). The service's own scope is a second, independent wall: with the CHECK removed by
hand, a `CLUB` row is still invisible to every route (proven on real PostgreSQL).

**Immutability, in the database.** A trigger refuses `UPDATE`, `TRUNCATE` and any `DELETE` of a revision except the
cascade of a deleted project (the one way a whole design can still be erased, for data-subject requests later). A
second trigger refuses any update of a project that changes its owner, origin, creator or creation time, or moves the
head anywhere but forward by one. A restore copies an old revision into a new one; the head never moves back.

**Conflicts.** A save names the revision it was based on; one conditional update moves the head from that number to the
next, so of any number of saves racing from one base exactly one lands (eight racing in the integration test). A stale
save is refused with the head it lost to and writes nothing; the editor says so and offers *Save mine as version N+1*
(which adds a revision and overwrites nothing), *Open version N*, or *Export mine*. A retried save whose document is
already the next revision is answered as saved instead of as a conflict.

**Where DS-1b departs from DS-0, and why.**

- *No `DesignDraft` table.* DS-0 proposed a mutable server draft beside immutable versions. The editor already keeps
  the working draft in the browser after every change; a second, mutable copy on the server would be the only mutable
  design state and would need its own concurrency and retention rules. Every server save is therefore an immutable
  revision, and the revision number is the concurrency token.
- *`DesignRevision`, not `DesignVersion`.* The authorisation speaks of revisions; the screen still calls them versions.
- *Audit category `ASSET`, not a new one.* A new `PlatformAuditCategory` value would change the Audit Center's filter
  list and its validators (unrelated modules). Entries are `design.*` actions on resource type `DesignProject`, with
  numbers and a hash, never the document.
- *No foreign keys to `Club` or `User` yet.* They belong to the phases that activate those owners, with their deletion
  semantics and row-level security; until then the activation CHECK makes them unnecessary.

**Backups and recovery — what is and is not covered.**

- *Design documents and revisions: covered.* They are ordinary rows in the one PostgreSQL database the backup dumps
  whole (`src/security/backup/backup-runner.ts`: `pg_dump --format=custom`, no table filter; encrypted, signed,
  off-site per `docs/BACKUP_AND_RESTORE.md`). The integration test runs the backup's own `pg_dump` arguments and
  `pg_restore` into an empty database and finds every project and revision with the same SHA-256, and the
  immutability triggers restored with them.
- *Binary artwork: not stored, and not covered.* DS-1b stores no files. The only media storage the platform has is
  the 10 GB disk mounted at `/var/data` (`render.yaml`, `familista-uploads`); this review found no verified backup of
  it, so none is claimed. Artwork upload therefore stays unavailable and says it waits for protected media storage
  with verified backups (§5.6, decision D8).

**Migration and deployment.** The migration only adds three enums, two tables, their indexes, CHECKs, two functions
and three triggers; it alters no existing table. It is applied by `prisma migrate deploy`, which the production start
script runs (`scripts/render-start.sh`): **merging DS-1b and letting the gated deploy run applies this migration to
production.** Rolling the application back is safe (older code never reads these tables); there is no automatic down
migration, and removing the tables would delete saved designs, so a database rollback is a deliberate manual step.

**Not in DS-1b.** Artwork upload, server-rendered previews, 3D (DS-1c), personal accounts (DS-ID), the catalogue
(DS-2), Club Design Studio (DS-3), manufacturing, quotations and payments.

---

## 16. DS-1c — the 3D garment view, as built

**What it is.** The Design Studio's 3D mode: the design on a three-dimensional jersey that turns, zooms and can be
edited by pointer, in the same room and from the same document as the 2D and 2.5D views. It is a **visual simulation
of a procedural prototype**. The form is built from the template's own flat panels, not from a measured garment or a
production pattern. Fabric, light and colour are simulated on a screen; the view is not a colour proof and not
manufacturing approval. The room says so on the canvas ("Visual simulation"), in the canvas's description, and in
every light and fabric announcement.

| Part | Where | What it does |
|---|---|---|
| Garment geometry | `public/product-design/pd-garment.js` (pure, no DOM, no WebGL) | Builds the jersey from the template's surfaces. Every vertex's texture coordinate is its flat position (u = x / width, v = 1 − y / height). Below the shoulders each body row wraps a half-ellipse by arc length, so millimetres across the panel are millimetres around the body. Front and back meet at the side seams and along the shoulders (the top of each panel's convex hull). Each sleeve is a cone whose circumference is its flat width, closed on its underarm seam. Also builds collar and cuff lines, seam lines, camera presets and outward normals. |
| 3D view | `public/product-design/pd-3d.js` | Babylon.js 7.54.3, the build the platform already vendors (`public/vendor/babylon.js`, Apache-2.0, loaded only when 3D is chosen). PBR fabric with sheen; a smooth or mesh knit (a normal map, one hole every 3.2 mm); studio, daylight or stadium lighting; collar and cuff tubes; a contact shadow. Draws only when something changed, and lowers its resolution while the garment moves on a slow GPU, never at rest. Disposes everything on close. |
| Editor | `public/product-design/product-design.js` (§ "the 3D view (DS-1c)") | Paints each surface from the same `layerNode` drawing the 2D canvas uses, as SVG, into a texture. A pick on the garment selects the element under it (`C.hitTest` on the surface's millimetres). A drag moves it with the same `C.moveBox`, snapping and grid as the flat panel, and is recorded as one undo step. Also: view presets, the 360° turntable, keyboard camera, close-up on the selection, print check, light, fabric and quality, and comparison with a saved version. |
| Server client | `public/product-design/pd-server.js` | One read-only addition: `getRevision` (the existing `GET /projects/:id/revisions/:number`), for the comparison. No route, schema or migration changed. |

**One document drives every view.** The 3D garment holds no design of its own. Its textures are the 2D drawing, so an
edit made in either view is the same operation on the same document, and undo, the local draft, saving and
versions are unchanged. A drag of 60 mm across the 3D garment moves the element 60 mm on the flat panel (proven in a
browser, ± 3 mm). Comparing with a saved version reads it with one `GET`, validates it with the core, and draws it
beside the design; it is never put into the editor and nothing is written.

**Where DS-1c departs from DS-0, and why.**

- *No garment model file.* DS-0 (§5.4) planned a licensed glTF garment model and disabled 3D until one existed. No
  licensed garment model is in the repository; `player.glb` is a humanoid. Buying one needs the Owner's approval.
  DS-1c instead builds a procedural prototype from the template's own panels. This makes the texture coordinates
  exactly the panels' millimetres, which a sourced model would have to be re-mapped to achieve. It is labelled a
  prototype everywhere it is shown. A measured garment model remains a sourcing task (§14).
- *3D on touch devices* is opt-in, as planned. A touch device starts at the low quality level, and the reader can change it.
- *Light, fabric and quality are cycle buttons*, not menus. The canvas at the approved reference size is about 370 px
  wide, and three menus plus the other controls did not fit in one row. The full name of each option is spoken and
  shown as a tooltip.
- *Comparison starts from the Versions panel* (a compare button on each version), so the canvas needs no version list of its own.

**Verified.**

| Evidence | Result |
|---|---|
| `tests/product-design-garment.unit.test.ts` | 39 tests on the real template. Exact UV equals flat position. Row isometry (≤ 0.2 % error) and sleeve circumference. Closed side, shoulder and underarm seams (< 1e-9 m). No flare at the hem or cuffs. Not mirrored under any preset. Outward normals and close-ups. Deterministic. Negative controls for the arc-length wrap and for mirroring. |
| `tests/product-design-3d.unit.test.ts` | 13 tests. Loads only the vendored script; no network, no `eval`, no inline style; no words of its own; every blob URL revoked; every listener, frame and object released on dispose; reduced motion honoured; the comparison only reads. |
| DS-1a/DS-1b suites, full Jest suite, typecheck, `i18n:check`, build | Pass (232 suites; 7 821 tests; 8 database-gated suites skipped without a database). |
| DS-1b persistence on real PostgreSQL | 24 / 24. |
| Browser proof, real application on real PostgreSQL, production CSP (`tools/components/product-design-browser-proof.cjs`, P16 in `product-design-3d-proof.cjs`) | 139 / 139, of which 33 are P16. 3D is loaded only when chosen; no CSP violation and no page error from the room. Hiding the crest on the 3D garment changes the pixels where the geometry puts it, and not at its mirror image (negative control). The drag matches in millimetres, with exact undo. Presets, keyboard and close-up work. Print check, light, fabric and quality work. Comparison writes nothing. The engine is disposed on leaving 3D and on leaving the room. Without WebGL, or without the engine, the room says why and stays on 2.5D. Nothing around the canvas moves when 3D opens. Arabic mirrors the controls and not the garment. axe finds no WCAG 2.2 A/AA violation in 3D (English, Arabic). |

**Performance, measured on this machine, not claimed.** Headless Chromium renders WebGL and composites the page in
software (SwiftShader), so these figures are a slow baseline, not a real graphics card. A control measures this
machine's own floor: a plain 2D canvas of the same size, redrawn every frame, in the same page.

| | Desktop 1672 × 941, balanced | Phone 390 × 844, CPU slowed 4×, low |
|---|---|---|
| 3D ready after it is chosen | ≈ 1.2 s | ≈ 2.5 s |
| Turntable, median frame interval | ≈ 53–63 ms | ≈ 30 ms |
| Plain-canvas floor (control) | 33.3 ms | 16.7 ms |
| Scene CPU time per frame (median) | ≈ 1 ms | ≈ 4 ms |
| Repainting one surface's artwork (median) | ≈ 100–180 ms | ≈ 260–410 ms |

The first frame budget (≤ 50 ms turntable on desktop) was not met under software rendering. The budget in the proof is
≤ 66.7 ms and no more than two 60 Hz frames over the measured floor. Real devices with graphics hardware have not been
measured. Repainting a surface's artwork (SVG rasterised into a texture) is the slowest step, so a 3D drag updates at
roughly 5–10 frames a second here.

**Implemented and deferred.**

| Asked for | DS-1c |
|---|---|
| True 3D jersey; 360° orbit; front, back, left, right; zoom, rotate, reset | Implemented (procedural prototype) |
| Front, back and sleeve mapping; synchronised 2D/3D editing; real-time updates | Implemented. Updates are as fast as the artwork can be repainted (above). |
| PBR fabric; lighting environments; seams, collar, sleeves; text orientation | Implemented |
| Desktop and mobile; 2D/2.5D fallback without WebGL | Implemented |
| Precision placement and inspection in 3D | Drag in millimetres with the flat panel's snapping and grid; 10 mm grid on the garment; close-up. Resizing and rotating stay on the flat panel. |
| Material preview (smooth, mesh), labelled as simulation | Implemented |
| Animated camera presets and close-ups | Implemented (instant under reduced motion) |
| Studio, daylight, stadium; no claim of exact colour | Implemented |
| Revision comparison without changing saved versions | Implemented: side by side, read only |
| Deterministic risk visualisation (safe zones, seams) | Implemented: printable area, safe zone, seam lines and every design-check finding on the garment; "not manufacturing approval" |
| Performance: texture updates, quality levels, cleanup, loading and error states, measured | Implemented and measured (above) |
| Measured garment model, graded sizes, fabric physics, production files | **Deferred.** A licensed or measured model needs sourcing and approval; production files are DS-5. |
| Artwork flowing across seams; resizing or rotating on the 3D garment | Deferred |

**Confidential research.** The Owner's brief also asked for research into manufacturing-related innovation candidates
and a prior-art review. That work was delivered to the Owner privately. It is not in this repository, and nothing in
DS-1c implements it.

## N. Risks and gaps (Deliverable N)

| Risk / gap | Severity | Mitigation |
|---|---|---|
| Personal accounts change the identity model | Critical | DS-ID as its own reviewed phase; allow-list gate; RLS user policy proven in CI |
| No data-subject export/erasure flow found | High | Design data included in a platform DSAR flow before DS-4 |
| Single 10 GB disk for assets | High | DS-S before scale |
| Garment 3D models absent | Medium | 2.5D preview carries DS-1; budgeted sourcing |
| Beta or changing supplier APIs (Printful v2 beta) | Medium | Adapter isolation, contract tests, v1 fallback where needed |
| Lane B partners without APIs | Medium | Manual-assisted adapter with full audit |
| Colour expectation vs physical print | Medium | Disclaimers, physical swatch/sample flow for clubs |
| Arabic shaping differences preview vs production | Medium | Server-rendered proof is what is approved |
| Trademark misuse in uploads | Medium | Attestation, official-brand approval, review, takedown |
| Legal obligations for live sales | High | §9.3 review before DS-6 |
| Scope creep toward marketplace | Medium | Phases gated; DS-7 last |
| Document format churn | Low | Versioned format, pure upgraders, immutable versions |

---

## Sources (external, read 2026-11-10)

- Printful API v1 documentation — https://developers.printful.com/docs/
- Printful API v2 (2.0.0-beta) — https://developers.printful.com/docs/v2-beta/
- Printify developer documentation — https://developers.printify.com/
- Printify API terms — https://printify.com/api-terms/
- Gelato webhooks — https://developers.gelato.com/docs/webhooks
- Gelato quote — https://developers.gelato.com/docs/orders/v2/quote
- Gelato features (sandbox) — https://www.gelato.com/au/features
- owayo FAQ / 3D Designer — https://www.owayo.com/soccer/faq.htm
- Spized club jerseys and ordering — https://www.spized.com/en/football-jerseys-for-clubs , https://www.spized.com/en/ordering-process

Where a statement in §8.5 is marked **Unverified**, the official reference must be read again before
any adapter is written.
