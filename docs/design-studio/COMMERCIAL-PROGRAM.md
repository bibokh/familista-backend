# Design Studio → commerce: gap analysis and execution program

Owner directive of 22 November 2026: turn the Design Studio into a working design, manufacturing-request and
commerce platform. This document is the one repository-wide gap analysis the directive asks for, and the order in
which the work is delivered. Each milestone ships as a verified pull request: tests, the browser proof, five languages,
and nothing labelled available that does not work. Production stays as it is until the Owner approves a release.

## 1. What exists (production baseline `ed243ee`)

| Capability | State | Evidence |
|---|---|---|
| Design editor, 2D, 2.5D and 3D | One garment: the match shirt | `public/product-design/templates/football-jersey.json`; the catalogue lists eight more as *Planned* |
| Template system | Data-driven and reusable | Templates are reviewed JSON (surfaces, outlines in mm, safe areas, views); the server validates against a registry (`TEMPLATE_FILES` in `src/platform/product-design/core.ts`) |
| 3D garment builder | Generic for tops | `pd-garment.js` builds body panels and sleeve cones from any template with front, back and two sleeves. Shorts, socks, hoods, zips and trousers need new topologies. |
| Saved designs and revisions | Platform Owner only | `DesignProject.ownerKind` already has CLUB and PERSONAL; the database admits PLATFORM rows only, by design (DS-1b) |
| Uploads | Club-scoped media, S3 | `MediaAsset` (tenant column, checksum, signed URLs); `video-hls.service.ts` S3 client |
| Notifications | Club-scoped, in-app | `UserNotification`, `UserNotificationChannel` |
| Plans and billing | Subscription plans; Stripe optional and unconfigured | `SubscriptionPlan` (BASIC, PRO, ACADEMY, ENTERPRISE), `SubscriptionOverride`, `stripe.service.ts`, `InvoiceDraft` |
| Accounts | Every user belongs to exactly one club | `User.clubId` is required |
| Suppliers, quotations, orders, shipping | Missing | No models, routes or screens; the room's supplier names are labelled examples |
| Creator (individual) and supplier accounts | Missing | Follows from `User.clubId` |

## 2. Architecture decisions

1. **Garments are data.** Every released product is a reviewed template file in the registry. A garment family that
   needs new 3D topology gets its own builder in `pd-garment.js` behind the same interface (panels, mappers,
   presets). Nothing renders a product that has no template.
2. **Workspaces, not a second tenancy.** Creators and suppliers get workspaces of their own kind on the existing
   tenant (an additive `kind` on the club record: CLUB, CREATOR, SUPPLIER), so authentication, roles, row-level
   security and audit apply unchanged. `User.clubId` stays required; no existing club changes.
3. **Designs follow their workspace.** CLUB and PERSONAL design projects are enabled by migration with row-level
   security keyed on the workspace, reusing DS-1b's service, revisions and audit.
4. **Uploads are re-encoded, never trusted.** Raster logos are decoded and re-encoded server-side (size, dimension
   and type limits); SVG is accepted only after sanitisation to a safe subset. Files are stored as `MediaAsset` in the
   owner's workspace and served by signed URL.
5. **The manufacturing workflow is a state machine with an audit trail:** design → technical specification → request
   for quotation → supplier quote → customer approval → order → production → shipped → delivered, with cancellation
   and refusal at each step. Every transition is one audited transaction and notifies the parties.
6. **Money is only real when it is.** Until a payment provider is configured and approved, an approved quote becomes a
   *manually confirmed order* with a payment request marked as not processed online. No payment is ever shown as
   successful unless the provider says so.
7. **Entitlements are configuration.** Premium features are switched on by plan or by override per workspace, and
   enforced on the server. No price is invented: plan prices come from the billing configuration or are shown as not
   set.

## 3. Milestones, in dependency order

| # | Milestone | Exit criteria |
|---|---|---|
| M1 | **Catalogue foundation.** Template registry and switching in the editor; released tops on the existing 3D builder (goalkeeper shirt, training top, T-shirt, polo shirt); then shorts and socks on a new leg/tube builder; then jackets, hoodies and tracksuits. | Each released garment designs, saves, restores, exports and previews in 2D, 2.5D and 3D, in five languages; unreleased ones stay *Planned* |
| M2 | **Workspaces and the Club Design Studio.** Workspace kinds; club-scoped designs with row-level security; brand kit (colours, logos, sponsor layouts); secure logo upload. | A club designs only its own kits; cross-tenant tests and RLS tests pass |
| M3 | **Team Kit Builder and collections.** Player names, numbers and sizes with CSV import and export; collections across garments and colourways. | A full squad's kit and a collection save, restore and export |
| M4 | **Manufacturing workflow and Supplier Portal.** Supplier workspace, application and Owner verification; capabilities; requests for quotation with specifications; quotes and comparison; approval; order and production milestones; notifications; production export. | End-to-end club → supplier → order journey passes; no unverified supplier receives a request |
| M5 | **Creator Studio.** Individual workspaces, personal projects, collections, requests for quotation. | Creator journey passes end to end |
| M6 | **Orders and money.** Internal order and payment-request state machine; refunds and cancellations; audit. Online payment only after the provider is configured and approved. | No payment state without a provider event |
| M7 | **Premium.** Entitlements and plan configuration; presentation exports; design reviews, comments and approvals; production intelligence from configured data; design assistance (deterministic variations; AI only with an approved provider). | Entitlements enforced server-side, with tests per plan |
| M8 | **Launch readiness.** Product and landing pages, onboarding for clubs, creators and suppliers, FAQ and support, invitation templates (not sent), terms and privacy drafts for qualified review, rollout controls. | Every public claim maps to a verified capability |

## Status

| Milestone | State |
|---|---|
| **M1a: catalogue foundation, tops** | Delivered on its branch, awaiting review. A template registry is read by both the editor and the server. Garments switch behind the unsaved-change guard, and saved or imported designs open on their own garment. Released: match shirt, **goalkeeper shirt** (V-neck, long sleeves), **training top** (crew neck, long sleeves), **T-shirt** (crew neck). Every geometry promise of the 3D builder is tested on each of them. |
| M1b: shorts and socks | Next: a leg/tube builder in `pd-garment.js` |
| M1c: jackets, hoodies, tracksuits, polo | After M1b. The polo stays Planned until its collar and placket can be modelled, rather than being shown as a crew-neck shirt. |
| M2–M8 | Not started |

## 4. Prerequisites only the Owner can provide

- **Suppliers:** real factories, their verification and their agreement. Until then the Supplier Portal works but no
  factory is shown as a partner.
- **Payments:** provider account, keys, and the compliance and tax decisions; until then orders are confirmed manually.
- **Shipping:** carrier contracts, if delivery is to be tracked through a carrier.
- **Legal:** terms, privacy notice, consent texts, and the qualified patent review before direct 3D editing is restored
  or the 3D view is used commercially.
- **Hardware:** the real-device performance validation (`docs/design-studio/DS-1c-real-device-performance.md`).
- **AI design assistance:** an approved provider and its terms, if generation beyond deterministic variations is wanted.

## 5. Public commercial launch

Public launch is **NO-GO** until M1–M8 are complete and verified and the prerequisites in section 4 that a launched
feature depends on are met. A milestone may be released earlier to the Platform Owner or to invited clubs, behind its
rollout control, when the Owner approves it.
