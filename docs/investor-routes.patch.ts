// Familista — Global Investor Layer
// Wiring patch + operational notes. Documentation, not runtime code.

/* ──────────────────────────────────────────────────────────────────────────── *
 *  1. routes/index.ts — mount the investor router
 * ──────────────────────────────────────────────────────────────────────────── */
// import investorRoutes from './investor.routes';
// router.use('/investor', investorRoutes);

/* ──────────────────────────────────────────────────────────────────────────── *
 *  2. Required schema edits to existing models
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 * model User {
 *   ...
 *   investorProfile InvestorProfile?
 * }
 *
 * model FranchiseUnit {
 *   ...
 *   investmentEntity InvestmentEntity?
 * }
 *
 * model Club {
 *   ...
 *   investmentEntity InvestmentEntity?
 * }
 *
 * Then:  npx prisma migrate dev --name investor_engine
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  3. Required dependencies
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *   pdfkit is already in the project (Executive PDF Reports).
 *   No new runtime deps needed for the default LEDGER_ONLY payout backend.
 *   For STRIPE_CONNECT payouts (also covers franchise-side):
 *     npm i stripe
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  4. Stripe webhook integration
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  After recording a Financial row on payment_intent.succeeded, fan out to:
 *    a) Franchise revenue distribution  (handled in the franchise engine)
 *    b) Investor revenue-share accruals (new — this engine)
 *
 *  Example flow:
 *
 *    import { computeAndRecordDistribution } from './services/franchise-revenue.service';
 *    import { computeRevenueShareAccruals } from './services/investor-distribution.service';
 *    import { getEntityByClub, getEntityByFranchiseUnit } from './services/investor-entity.service';
 *
 *    const club = await prisma.club.findUnique({
 *      where: { id: clubId },
 *      select: { franchiseUnitId: true },
 *    });
 *
 *    // Franchise-side distribution
 *    if (club?.franchiseUnitId) {
 *      await computeAndRecordDistribution(null, {
 *        unitId: club.franchiseUnitId,
 *        clubId,
 *        category: 'SUBSCRIPTION',
 *        sourceAmount: amount / 100,
 *        sourceCurrency: currency.toUpperCase(),
 *        sourceFinancialId: financial.id,
 *        sourceRef: paymentIntent.id,
 *        trigger: 'PAYMENT_RECEIVED',
 *      }).catch((err) => console.error('franchise distribution failed', err));
 *    }
 *
 *    // Investor-side accruals — resolve the InvestmentEntity for the source
 *    // (club first; fall back to its franchise unit) and fan out to all
 *    // active REVENUE_SHARE investments on that entity.
 *    const entity =
 *      (await getEntityByClub(clubId)) ??
 *      (club?.franchiseUnitId ? await getEntityByFranchiseUnit(club.franchiseUnitId) : null);
 *    if (entity) {
 *      await computeRevenueShareAccruals(null, {
 *        entityId: entity.id,
 *        sourceAmount: amount / 100,
 *        currency: currency.toUpperCase(),
 *        category: 'SUBSCRIPTION',
 *        sourceRef: paymentIntent.id,        // idempotency
 *      }).catch((err) => console.error('investor accrual failed', err));
 *    }
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  5. Background jobs (cron / scheduler)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *   import { expireStaleKyc } from './services/investor-profile.service';
 *
 *   setInterval(async () => {
 *     await expireStaleKyc();   // VERIFIED → EXPIRED past kycExpiresAt
 *     // ...existing franchise / whitelabel / admin cron actions
 *   }, 60 * 60 * 1000);  // hourly is plenty
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  6. Bootstrap order (one-time after migrate)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *  a) Create the platform InvestmentEntity (Familista holding):
 *       POST /api/v1/investor/bootstrap/platform-entity
 *     or call `ensurePlatformEntity()` from your seed script.
 *
 *  b) Create founder share class + founder cap-table entry:
 *       POST /api/v1/investor/entities/<platform-id>/share-classes
 *       { "name": "Common", "code": "COMMON", "category": "COMMON",
 *         "votingMultiple": 1, "totalAuthorized": 10000000 }
 *
 *       POST /api/v1/investor/profiles
 *       { "type": "PRIVATE", "entityType": "PERSON", "displayName": "Founder",
 *         "userId": "<existing-user-id>" }
 *
 *       POST /api/v1/investor/investments
 *       { "investorId": "<founder-id>", "entityId": "<platform-id>",
 *         "instrumentType": "EQUITY", "shareClassId": "<common-id>",
 *         "sharesIssued": 8000000, "pricePerShare": 0.0001,
 *         "committedAmount": 800 }
 *
 *       POST /api/v1/investor/investments/<id>/fund
 *       { "amount": 800 }
 *
 *  c) First fundraising round:
 *       Create SEED round → open → take investments → close.
 *       SAFEs auto-convert when the next priced round closes via
 *       POST /api/v1/investor/rounds/<id>/convert-safes
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  7. Access model summary
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Two concentric layers per request:
 *    a) `authenticate`            — JWT (existing middleware).
 *    b) `attachInvestorContext`   — loads scope (platform-admin OR derived from
 *                                   InvestorProfile.userId → entities with active
 *                                   investments / cap-table positions). Cached 30s.
 *
 *  Mutation endpoints (create entities, run rounds, issue equity, sign agreements,
 *  execute exits, record distributions) require `scope.isPlatformAdmin = true`.
 *  Investors get read-only access to:
 *    - Their own profile, portfolio, dashboard, statements
 *    - Cap tables of entities they have positions in
 *    - Agreements / rights / board seats tied to those entities
 *    - Their distribution history
 *
 *  The waterfall preview endpoint requires entity scope (the investor sees what
 *  their stake would be worth at a hypothetical exit, but only for entities
 *  they actually have positions in).
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  8. Cross-system integration map
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Stripe webhook
 *    → Financial row
 *    → computeAndRecordDistribution()         (franchise engine)
 *    → computeRevenueShareAccruals()          (this engine)
 *
 *  Franchise FranchiseOwner ←→ InvestorProfile
 *    Link via InvestorProfile.linkedFranchiseOwnerId for unified identity.
 *    A FranchiseOwner who's also a platform-level investor gets two records,
 *    one bridge, and consistent revenue routing through the shared payout
 *    adapter.
 *
 *  Club / FranchiseUnit ←→ InvestmentEntity
 *    A single InvestmentEntity per Club (1:1) and per FranchiseUnit (1:1) via
 *    the unique `clubId` / `franchiseUnitId` fields. Investments target the
 *    InvestmentEntity, never the Club / FranchiseUnit directly, so the
 *    capital and operational graphs stay decoupled.
 *
 *  PDFKit reports
 *    Reuse the existing `getPdfBranding(clubId)` adapter for visual identity.
 *    Pass `clubId` query param to the PDF endpoints to brand statements for
 *    a specific tenant; pass `clubId=platform` (or omit) for the default
 *    Familista brand.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  9. CORS — no special handling needed
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  /api/v1/investor is authenticated; the existing `origin: true` setting in
 *  app.ts is fine. If you tighten CORS for /api/v1/admin separately, leave
 *  /api/v1/investor on the broader allowlist so tenant SPAs (and the investor
 *  dashboard hosted on a custom domain) can both reach it.
 */
