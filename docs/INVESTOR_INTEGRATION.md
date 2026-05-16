# Familista — Investor Capital Engine · Integration Guide

This is the integration runbook for the Investor Capital Engine delta shipped to `Downloads/familista-backend/`. Apply in order — every step is idempotent except the migration.

---

## 0. Static verification summary

Cross-checked surfaces before delivery:

| Check | Result |
|---|---|
| Files present | 19 / 19 |
| Prisma models in schema fragment | 14 |
| Prisma enums in schema fragment | 21 |
| Controller handlers | 67 |
| Routes wired to controller handlers | 67 / 67 |
| Validator schemas imported by controller | 26 / 26 |
| Middleware exports used by controller / routes | 6 / 6 |
| Service exports referenced by controller | 100 % |
| Cross-engine deps satisfied | `dispatchPayout` ← franchise-payout · `getDescendantUnitIds` ← franchise-unit · `getPdfBranding` ← pdf-branding · `PdfBranding` ← admin.types |
| `Prisma.` namespace imports | 10 service files, all consistent |
| Unused symbols | 0 |
| Missing imports | 0 |
| Broken `ctrl.*` references in routes | 0 |

TypeScript build will succeed once the schema fragments are migrated (Prisma client must be regenerated to expose the new models).

---

## 1. Prerequisites

### NPM packages

All runtime deps are already in the project (`pdfkit`, `express`, `zod`, `@prisma/client`). For the optional Stripe Connect payout backend:

```bash
npm i stripe
```

For dimension-probed asset uploads on the admin panel side (optional, already documented in that engine):

```bash
npm i sharp
```

### Schema fragment order

Append schema fragments to `prisma/schema.prisma` **in this order** (each depends on the previous):

1. `whitelabel.schema.prisma`
2. `admin-whitelabel.schema.prisma`
3. `franchise.schema.prisma`
4. `investor.schema.prisma`   ← **this engine**

---

## 2. Schema edits to existing models

Open the merged `prisma/schema.prisma` and add the following fields to existing models. The investor engine will not compile without them.

```prisma
model User {
  // ...existing fields...
  investorProfile InvestorProfile?
}

model FranchiseUnit {
  // ...existing fields, including the franchise-engine edits...
  investmentEntity InvestmentEntity?
}

model Club {
  // ...existing fields, including the franchise-engine edit `franchiseUnitId`...
  investmentEntity InvestmentEntity?
}
```

Then run the migration:

```bash
npx prisma migrate dev --name investor_engine
npx prisma generate
```

---

## 3. Source tree placement

Move the delta files into the existing layout (paths are documented in each file's header comment, repeated here for convenience):

| File | Target path |
|---|---|
| `investor.types.ts` | `src/types/investor.types.ts` |
| `investor.validators.ts` | `src/utils/investor.validators.ts` |
| `investor-audit.service.ts` | `src/services/investor-audit.service.ts` |
| `investor-profile.service.ts` | `src/services/investor-profile.service.ts` |
| `investor-entity.service.ts` | `src/services/investor-entity.service.ts` |
| `investor-round.service.ts` | `src/services/investor-round.service.ts` |
| `investor-investment.service.ts` | `src/services/investor-investment.service.ts` |
| `investor-captable.service.ts` | `src/services/investor-captable.service.ts` |
| `investor-governance.service.ts` | `src/services/investor-governance.service.ts` |
| `investor-agreement.service.ts` | `src/services/investor-agreement.service.ts` |
| `investor-exit.service.ts` | `src/services/investor-exit.service.ts` |
| `investor-distribution.service.ts` | `src/services/investor-distribution.service.ts` |
| `investor-performance.service.ts` | `src/services/investor-performance.service.ts` |
| `investor-pdf.service.ts` | `src/services/investor-pdf.service.ts` |
| `investor-access.middleware.ts` | `src/middleware/investor-access.middleware.ts` |
| `investor.controller.ts` | `src/controllers/investor.controller.ts` |
| `investor.routes.ts` | `src/routes/investor.routes.ts` |
| `investor.schema.prisma` | merged into `prisma/schema.prisma` |
| `investor-routes.patch.ts` | reference doc — do not deploy |

Cross-engine deps (already in the project from previous deltas):
- `src/services/franchise-payout.adapter.ts` — `dispatchPayout`
- `src/services/franchise-unit.service.ts` — `getDescendantUnitIds`
- `src/services/pdf-branding.service.ts` — `getPdfBranding`
- `src/types/admin.types.ts` — `PdfBranding`

---

## 4. Mount the router

In `src/routes/index.ts`:

```ts
import investorRoutes from './investor.routes';
// ...
router.use('/investor', investorRoutes);
```

That registers ~67 endpoints under `/api/v1/investor`.

---

## 5. Stripe webhook fan-out

After your existing Stripe webhook records a `Financial` row, fan out to **both** the franchise revenue engine **and** the investor revenue-share engine. Use `paymentIntent.id` as the idempotency key on both sides.

```ts
// src/webhooks/stripe.webhook.ts
import { computeAndRecordDistribution } from '../services/franchise-revenue.service';
import { computeRevenueShareAccruals } from '../services/investor-distribution.service';
import {
  getEntityByClub,
  getEntityByFranchiseUnit,
} from '../services/investor-entity.service';

// inside handler for payment_intent.succeeded
const club = await prisma.club.findUnique({
  where: { id: clubId },
  select: { franchiseUnitId: true },
});

// (a) franchise-side
if (club?.franchiseUnitId) {
  await computeAndRecordDistribution(null, {
    unitId: club.franchiseUnitId,
    clubId,
    category: 'SUBSCRIPTION',
    sourceAmount: amount / 100,
    sourceCurrency: currency.toUpperCase(),
    sourceFinancialId: financial.id,
    sourceRef: paymentIntent.id,
    trigger: 'PAYMENT_RECEIVED',
  }).catch((e) => console.error('franchise distribution failed', e));
}

// (b) investor-side
const entity =
  (await getEntityByClub(clubId)) ??
  (club?.franchiseUnitId ? await getEntityByFranchiseUnit(club.franchiseUnitId) : null);
if (entity) {
  await computeRevenueShareAccruals(null, {
    entityId: entity.id,
    sourceAmount: amount / 100,
    currency: currency.toUpperCase(),
    category: 'SUBSCRIPTION',
    sourceRef: paymentIntent.id,
  }).catch((e) => console.error('investor accrual failed', e));
}
```

Both calls are no-ops if there's no franchise unit / no active investments — safe to invoke unconditionally.

---

## 6. Bootstrap (one-time)

Replace `<PLATFORM-OWNER-JWT>` with a token for a user who has a PLATFORM_OWNER row in `PlatformAdmin`.

```bash
# 6.1 — Create the Familista platform InvestmentEntity
curl -X POST https://<host>/api/v1/investor/bootstrap/platform-entity \
  -H "Authorization: Bearer <PLATFORM-OWNER-JWT>"
# → returns { id: "<platform-id>", ... }

# 6.2 — Create the Common share class
curl -X POST https://<host>/api/v1/investor/entities/<platform-id>/share-classes \
  -H "Authorization: Bearer <PLATFORM-OWNER-JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Common", "code": "COMMON", "category": "COMMON",
        "votingMultiple": 1.0, "totalAuthorized": 10000000 }'
# → returns { id: "<common-id>", ... }

# 6.3 — Create the founder InvestorProfile
curl -X POST https://<host>/api/v1/investor/profiles \
  -H "Authorization: Bearer <PLATFORM-OWNER-JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "type": "PRIVATE", "entityType": "PERSON",
        "displayName": "Founder", "userId": "<your-user-id>" }'
# → returns { id: "<founder-id>", ... }

# 6.4 — Commit + fund the founder's equity
curl -X POST https://<host>/api/v1/investor/investments \
  -H "Authorization: Bearer <PLATFORM-OWNER-JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "investorId": "<founder-id>", "entityId": "<platform-id>",
        "instrumentType": "EQUITY", "shareClassId": "<common-id>",
        "sharesIssued": 8000000, "pricePerShare": 0.0001,
        "committedAmount": 800 }'
# → returns { id: "<investment-id>", ... }

curl -X POST https://<host>/api/v1/investor/investments/<investment-id>/fund \
  -H "Authorization: Bearer <PLATFORM-OWNER-JWT>" \
  -H "Content-Type: application/json" \
  -d '{ "amount": 800 }'
# → InvestmentStatus moves to FUNDED, CapTableEntry is written,
#   InvestmentEntity.totalSharesIssued += 8_000_000.
```

Repeat 6.2 (`PREFERRED_A`, etc.) and 6.3–6.4 for each subsequent investor / round.

For a priced round:
```bash
POST /api/v1/investor/entities/<platform-id>/rounds        # create
POST /api/v1/investor/rounds/<round-id>/open               # open
POST /api/v1/investor/investments  ...                     # take commitments
POST /api/v1/investor/investments/<id>/fund  ...           # fund each
POST /api/v1/investor/rounds/<round-id>/close              # close
POST /api/v1/investor/rounds/<round-id>/convert-safes      # convert outstanding SAFEs
```

---

## 7. Cron jobs (5–60 min cadence)

Add to your existing scheduler:

```ts
import { expireStaleKyc } from './services/investor-profile.service';
// existing imports from franchise / whitelabel / admin engines stay

setInterval(async () => {
  // existing maintenance from previous engines
  await expireStaleKyc();               // VERIFIED → EXPIRED past kycExpiresAt
}, 60 * 60 * 1000);  // hourly
```

---

## 8. Access model

Every `/api/v1/investor/*` route is `authenticate` + `attachInvestorContext` + `requireInvestorContext`. Per-endpoint enforcement happens inside the controller via:

| Helper | Effect |
|---|---|
| `assertEntityAccess(actor, entityId, mode)` | Platform admin bypass · investor must hold a position in `entityId` |
| `assertInvestorAccess(actor, investorId, mode)` | Platform admin bypass · investor may only read their own profile |
| `effectiveEntityScope(actor)` | Returns `undefined` for platform admins (unrestricted) or the investor's owned-entity set |
| `effectiveInvestorScope(actor)` | Returns `undefined` / null / the investor's own id |

All mutation endpoints (create entity, run round, issue equity, sign agreement, execute exit, record distribution, KYC) require `scope.isPlatformAdmin === true`. Investors get read-only access to their own profile, portfolio, dashboard, statements, and the cap tables of entities they're invested in.

---

## 9. Verification commands

After Step 2 and Step 3, run:

```bash
# 9.1 — Prisma client regen succeeded
npx prisma validate
npx prisma format

# 9.2 — TypeScript build clean
npx tsc --noEmit

# 9.3 — Smoke test the surface (against your dev DB)
curl -H "Authorization: Bearer <JWT>" https://<dev-host>/api/v1/investor/dashboard/me
curl -H "Authorization: Bearer <JWT>" https://<dev-host>/api/v1/investor/profiles/me
curl -H "Authorization: Bearer <JWT>" https://<dev-host>/api/v1/investor/audit?limit=10
```

If `tsc --noEmit` reports errors, the most likely cause is the schema back-relations from Step 2 not being applied — Prisma's generated types won't include `User.investorProfile`, `FranchiseUnit.investmentEntity`, or `Club.investmentEntity` and `prisma.investmentEntity.findUnique({ where: { franchiseUnitId } })` will fail to type-check.

---

## 10. Cross-engine integration map

```
Stripe payment_intent.succeeded
   │
   ├──▶ Financial row (existing)
   │
   ├──▶ computeAndRecordDistribution()        (franchise-revenue.service)
   │       │
   │       └──▶ RevenueDistribution + allocations
   │              │
   │              └──▶ dispatchPayout()       (franchise-payout.adapter)
   │
   └──▶ computeRevenueShareAccruals()         (investor-distribution.service)
           │
           └──▶ InvestorDistribution rows per active REVENUE_SHARE investment
                   │
                   └──▶ payDistribution() → dispatchPayout()  (same adapter)


Cap-table reads / PDF statements
   │
   ├──▶ getPdfBranding(clubId)                (pdf-branding.service)
   │       └──▶ resolves WhiteLabelConfig + active assets
   │
   └──▶ getInvestorDashboard / getCapTable
           └──▶ PDFKit document with tenant branding
```

---

## 11. Surface summary

**14 Prisma models · 21 enums · ~67 endpoints across 13 sections · 19 delta files**

Capability map vs. the original request:

| Requested capability | Where it lives |
|---|---|
| 7 investor types | `InvestorType` enum + `InvestorProfile.type` |
| 6 investment instruments | `InstrumentType` enum + `Investment.instrumentType` + per-type fields |
| Cap table — ownership, dilution, exits, transfers, rights, voting | `investor-captable.service`, `investor-exit.service`, `investor-governance.service` |
| Investor dashboard — ROI, growth, cash flow, PDF reports | `investor-performance.service`, `investor-pdf.service` |
| Legal — SAFE, shareholder agreement, exit, profit distribution, board governance | `investor-agreement.service`, `investor-governance.service`, `investor-distribution.service`, `investor-exit.service` (waterfall) |
| Strategic expansion country → region → franchise → investor → academy → club | `InvestmentEntity` bridges Club + FranchiseUnit; rolls up via `getEntityRollUp` and `getDescendantUnitIds` |
