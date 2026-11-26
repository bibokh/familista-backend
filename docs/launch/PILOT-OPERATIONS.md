# Invited pilot — minimum monitoring, controls and rollback

For a restricted pilot of the Design Studio (clubs released one by one; creators by invitation), after the Platform
Owner approves, reviews and merges PR #164. Every mechanism named here exists in the platform today. Nothing here
merges, deploys or enables anything.

## 1. Before the deploy

| Check | How | Must be |
|---|---|---|
| CI on the merge commit | GitHub `ci` workflow: validate, both browser proofs, secret scan | green |
| A fresh backup and a passing restore drill | `docs/BACKUP_AND_RESTORE.md` (scheduled backup; weekly drill) | green within the last 7 days |
| Row-level security context | Production environment `DB_RLS_CONTEXT` | `on`: enforcement is live since Stage 4 (`docs/security/row-level-security.md`), and the new billing tables are pilot tables |
| Online payment stays off | `PAYMENT_PROVIDER` | **unset**. No provider adapter exists, so no value can turn payment on; checkout answers `PAYMENTS_NOT_CONFIGURED` |
| Minimum creator age | `CREATOR_MINIMUM_AGE` | the value counsel approves (default 18) |
| Email | `EMAIL_PROVIDER` | known state; while unset, the Owner confirms creator addresses by hand (Creators tab) |

Deploys run `prisma migrate deploy` on start. The branch adds eleven migrations, all additive or relaxing (new tables,
nullable columns, new checks, triggers and policies; no `UPDATE`, `DELETE` or data rewrite). They were applied from
scratch on PostgreSQL 16 with enforcement on, by every PostgreSQL suite.

## 2. What stays disabled, and the control that keeps it so

| Capability | Control | Verified by |
|---|---|---|
| Payment collection | No payment provider adapter; `PAYMENT_PROVIDER` unset. A paid plan waits as PENDING with an OPEN invoice; the database refuses PAID without a recorded provider event | `tests/commercial.integration.test.ts`, P28 |
| Public enrolment | No public sign-up: creator accounts only with an Owner invitation (revocable); club sign-up refused (`SELF_REGISTRATION_CLOSED`); the sign-in page is `noindex` | `tests/creator-tenancy.integration.test.ts`, P26, P29 |
| Real supplier transactions | Verify no supplier until an agreement exists: no quotation can be recorded or published without one (service and database). For pilot clubs, keep `club_design_manufacturing` **Off** in Club releases; for creators, configure the default creator plan **without** `manufacturing` | `tests/manufacturing.integration.test.ts`, P20, P24 |

## 3. Monitoring (daily during the pilot)

1. **Availability**: `/healthz` and `/api/health` under the host's health check.
2. **Errors**: structured `http` log lines carry `requestId`, `path`, `status` and `latencyMs`. Review every 5xx on
   `/api/v1/creator/*`, `/api/v1/club-design/*`, `/api/v1/system/product-design/*` and `/api/v1/system/manufacturing/*`.
   Expected rate: zero. One is a ticket; a repeat is a stop (section 5).
3. **Isolation**: any log line from the RLS observer (a query on a pilot table without a database context) is a defect;
   with enforcement on, such a query returns nothing rather than another tenant's rows.
4. **Money invariants** (one read-only query, on the system path):
   ```sql
   SELECT (SELECT count(*) FROM "CommercialInvoice" WHERE "status" = 'PAID') AS paid_invoices,  -- must be 0
          (SELECT count(*) FROM "PaymentEvent") AS payment_events,                               -- must be 0
          (SELECT count(*) FROM "ManufacturingSupplier" WHERE "status" = 'VERIFIED') AS verified_suppliers; -- 0 until an agreement exists
   ```
5. **Audit trail**: `PlatformAuditLog` actions `commercial.*`, `design.share.*`, `creator.*`, `manufacturing.*`,
   `design.rollout.changed`: each should match something the Owner or a pilot user did.
6. **Readiness**: the Owner's Plans & billing → Readiness tab (email, payments, suppliers, plans, creators, released clubs).
7. **Security alerts**: the existing email alerts (`docs/DEPLOY_GATE_AND_SECURITY_ALERTS.md`, R6).

## 4. Rollback, from least to most invasive

| Level | Action | Effect |
|---|---|---|
| A club | Club releases → `club_design_studio` **Off** for the club | its studio routes answer `DESIGN_STUDIO_NOT_ENABLED` at once; its data stays |
| A creator | Creators → **Suspend** (with a note); revoke unused invitations | sessions refused; data stays |
| A plan | Plans & billing → edit the plan → not offered / not default; **End** a subscription with a note | entitlements fall back at once (default plan or what the studio ships with) |
| The code | `Actions → deploy → Run workflow` on the previous release | verified: the previous release's `prisma migrate deploy` accepts the new schema with nothing to apply; its queries meet the new checks (it writes club rows only) |
| The data | Never over the live database: restore into a new one (`docs/BACKUP_AND_RESTORE.md`, *Recovery*) | last resort |

There are no down-migrations. Rolling back the code leaves the new tables and columns in place, unused.

## 5. Stop conditions

Stop the pilot (every club's studio Off; creators suspended) and investigate on any of:

- one tenant sees another's data, by any path;
- a PAID invoice or a PaymentEvent row appears;
- a quotation is published for an unverified supplier, or a supplier is shown to a customer as a partner;
- repeated 5xx on the routes in section 3.

## 6. Known limits accepted for the pilot

- A concurrent second plan request from the same workspace is refused by the database (one live subscription per
  workspace) but answers 500 rather than 409; the UI does not send two.
- Creator data export (`/me/export`) does not yet include subscriptions and invoices; these exist only as Owner grants
  while payment is off.
- Sharing tells a creator whether an address has a creator account (needed to share); it is rate-limited and needs a
  signed-in account.
- Translations (de, fr, es, ar) are not reviewed by native speakers, and the Spanish catalogue mixes formal and informal
  address.
- Prisma's model cannot express the composite owner foreign keys the SQL migrations create. Never generate migrations
  with `prisma migrate dev` against this schema without reviewing the diff: it would propose dropping them.
