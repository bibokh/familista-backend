# Familista Design Studio — release-readiness assessment (P8)

Assessed 26 November 2026, on branch `claude/kind-bell-inkoyy`. This is an engineering assessment, not a decision:
opening commercial access, activating payments, merging and deploying are the Platform Owner's, and none of them has
been done.

## Final acceptance (26 November 2026, PR #164)

Three different bars, kept apart. **Engineering complete**: built, and held by automated evidence. **Invited pilot**:
safe to put in front of invited clubs and creators under `PILOT-OPERATIONS.md`, with every external gap said on screen.
**Public launch**: open to anyone, for money; needs what only the Owner can provide.

| Feature | Engineering complete | Invited pilot | Public commercial launch |
|---|---|---|---|
| Design Studio (garments, 2D/2.5D/3D, versions) | Yes | Yes | Needs real-device performance validation |
| Club workspaces and isolation (row-level security) | Yes | Yes | Needs an independent security review |
| Brand kit, rosters, collections, order and presentation sheets | Yes | Yes | Yes, after legal review (rosters hold people's names) |
| Reviews and approvals | Yes | Yes | Yes |
| Colourways | Yes | Yes | Yes |
| Rollout control (club by club) | Yes | Yes (the pilot's main control) | — |
| Privacy controls (erasure, retention rules, minors' consent) | Yes | Yes | Needs retention periods and the legal review |
| Creator Studio accounts (invitation only), export, deletion | Yes | Yes | Needs public enrolment decided; export to include billing records |
| Sharing between creators | Yes | Yes | Yes |
| Plans and server-side entitlements | Yes | Yes (plans granted by the Owner) | Needs payment collection |
| Professional tools (print sheet, tech pack) | Yes | Yes | Yes |
| Billing (invoices, subscriptions, grants, voids, expiry) | Yes | Yes, **no collection**: invoices stay open | Needs a payment provider, keys and tax treatment |
| Manufacturing workflow (owner-brokered) | Yes | Only with `club_design_manufacturing` Off and no supplier verified, or after a supplier agreement | Needs supplier agreements and the contract structure of brokered orders |
| Non-binding quotations, administrator-only decisions | Yes | As above | As above |
| Getting started; sign-in page with honest service status; Owner readiness | Yes | Yes | Needs the services it reports on |
| Five room languages | Yes (complete, checked) | Yes | Needs native-speaker review |

**Defects fixed at acceptance**: none in the code paths. Wording that would have been untrue under pilot conditions was
corrected in five languages: the account panel and Getting started said a confirmation link was "in the email sent when
you opened the account" (no email is sent while email is not configured), and five sentences presented quotations as
coming "from verified suppliers" while none is verified. Three index names in the P6 migration were aligned with the
Prisma schema (no database change).

**Security review** (creator accounts, sharing, entitlements, billing, isolation): every new route is behind its guard
(creator authentication and ownership checks on every id, club roles and `tenantParam`, the Owner's
`assertPlatformOwner`); the security posture check is unchanged (79 controls present, every handler classified); the
public sign-in answer reads no account, club or person and sits behind the authentication rate limit; money paths
cannot be reached over HTTP (no webhook route exists); the database enforces one owner per row, row-level security,
one live subscription per workspace, PAID only from a recorded provider event, and immutable payment events. Accepted
limits are listed in `PILOT-OPERATIONS.md`, section 6. An independent review has not been done.

**Database integrity**: the migrations apply from scratch (every PostgreSQL suite, with enforcement on); the schema
differs from the migrations only where the database is stricter than Prisma can express (composite owner foreign keys,
the same as before this work); the eleven new migrations rewrite and delete no data; the previous release's
`prisma migrate deploy` accepts the new schema, so the code can be rolled back without a schema rollback.

## Verdict

| Release | Verdict | Why |
|---|---|---|
| **Public commercial launch** | **NO-GO** | No payment provider, no verified supplier, no email provider in production, legal texts are drafts awaiting qualified review, real-device performance is not validated, and the translations have not been reviewed by native speakers. Each is outside engineering; see *External dependencies*. |
| **Invited pilot** (clubs released one by one; creators by invitation; plans granted by the Owner; quotations brokered by hand) | **Engineering-ready, pending the Owner's approval, review and merge** | Every feature below marked *verified* passes its PostgreSQL suite and browser proof. What a pilot would lack is said on screen: email, online payment and quotations each show their real state. |

## Every feature, classified

*Verified* means: implemented, and held by automated evidence independent of whoever wrote it — PostgreSQL suites on a
real database with row-level security, browser proofs of the compiled application (axe WCAG 2.2 A/AA, CSP, English and
Arabic), and the launch-claims register (`claims.json`), which fails when a claim's evidence disappears.

### Fully implemented and verified

| Feature | Evidence |
|---|---|
| Design Studio: seven garments in 2D, 2.5D and 3D; versions; import/export | P16, P17; `product-design-persistence` |
| Club workspaces, isolation by the database (row-level security) | `product-design-persistence`, `rls-pilot` |
| Brand kit, team rosters, collections, order sheet, presentation sheet | P18, P19, P22; `product-design-persistence` |
| Reviews and approvals (administrator decides; decisions immutable) | P21; `product-design-persistence` |
| Colourways (deterministic, contrast-checked) | P23 |
| Rollout control: the studio and its parts released club by club | P24 |
| Privacy foundation: names apart from frozen specifications, erasure, retention rules, minors' consent | P25; `manufacturing` |
| Creator Studio: invitation-only accounts, own tenancy, account privacy (export, deletion) | P26; `creator-tenancy` |
| Sharing between creators (see / comment; revocable) | P27; `creator-tenancy` |
| Plans and server-side entitlements; the Plan & billing panel; the Owner's plans console | P28; `commercial` |
| Professional tools: print sheet (SVG, every view) and tech pack (CSV/JSON, mm placements) | P28; `commercial` |
| Billing that needs no particular provider: invoices, subscriptions, grants, voids, expiry; nothing charged | P28; `commercial` |
| Manufacturing workflow (owner-brokered): requests, quotations, orders, production sheet | P20; `manufacturing` |
| Quotations non-binding with the supplier's conditions; administrator-only decisions; supplier records complete before verification; tech packs for the order's supplier | P20; `manufacturing`, `creator-tenancy` |
| Getting started (first steps from each workspace's own records) | P29; `commercial` |
| Commercial sign-in page: plans on offer and honest service status; not indexed; sign-up by invitation | P29; `commercial` |
| Owner readiness view (email, payments, suppliers, plans, creators, released clubs) | P29; `commercial` |
| Five room languages (en, de, fr, es, ar), right to left in Arabic | every proof's Arabic section; `i18n:check` |

### Implemented, awaiting external activation

| Feature | Waits for | What happens meanwhile |
|---|---|---|
| Online payment of invoices | A payment provider (account, keys, webhook), and the compliance and tax decisions | Paid plans wait with an open invoice; checkout answers `PAYMENTS_NOT_CONFIGURED`; the Owner grants plans with a note. Adding a provider means implementing `PaymentProvider` (`src/platform/commercial/payment-provider.ts`). |
| Tax on invoices | The Owner's tax advisers | `taxMinor` is null and every invoice says "Tax not calculated"; no figure is invented. |
| Email (address confirmation, password reset, invitations) | An email provider configured in production | The Owner confirms creator addresses by hand, with a note; the page says email is not set up. |
| Quotations reaching customers | At least one real supplier, verified with a complete record | Requests are received; the console says no quotation can be recorded until a supplier is verified. |

### Blocked by legal, supplier, payment or hardware dependencies

| Item | Blocked by |
|---|---|
| Terms and privacy notice in force | Qualified legal review of `legal/TERMS-DRAFT.md` and `legal/PRIVACY-DRAFT.md`, including the contract structure of brokered orders and supplier data transfers |
| Retention periods | The Owner's and counsel's decision; none is set by default (the rules exist, empty) |
| Named partner factories | Supplier agreements (no supplier is presented as a partner) |
| Direct 3D garment manipulation | Qualified patent review (kept disabled) |
| Performance claims on real devices | Validation on real hardware (`docs/design-studio/DS-1c-real-device-performance.md`) |

### Not implemented

| Item | Status |
|---|---|
| Jackets, hoodies, tracksuits, polos (M1c) | Deferred; shown as Planned |
| Supplier Portal (suppliers quoting directly) | Not approved; manufacturing stays owner-brokered |
| AI-generated designs | Needs an approved provider and its terms; assistance is deterministic |
| Global Store | Planned |
| Public self-service sign-up | Deliberately absent: invitation only until the Owner decides otherwise |

## Verification that exists, and what does not

Exists: unit tests (≈8,100), PostgreSQL suites with row-level security and negative controls (the commercial,
creator-tenancy, manufacturing, persistence and RLS suites), browser proofs P16–P29 on the compiled application (axe,
CSP, English and Arabic, layout stability), the security posture check (79 controls present, unchanged by this work),
the i18n check, and the claims register.

Does not exist yet, and blocks a public launch:

- **Production observation**: nothing here has run in production; no monitoring baseline exists for these routes.
- **Independent security review** of the new routes (billing, sharing, creator accounts): automated controls only.
- **Native-speaker review** of the German, French, Spanish and Arabic texts, which were written with the software and
  checked for completeness and placeholders, not by qualified translators.
- **Human accessibility review** beyond axe's automated rules.
- **Real-device performance** (see the blocked table).

## Decisions only the Owner can take

1. Approve, review and merge this branch (nothing is merged or deployed).
2. Choose a payment provider and authorise its activation; settle the tax treatment.
3. Configure an email provider for production.
4. Verify real suppliers and sign agreements before any is named as a partner.
5. Commission the legal review; set retention periods.
6. Decide when, and to whom, commercial access opens.
