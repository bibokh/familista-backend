// Familista — Franchise Expansion Engine
// Wiring patch and operational notes. Treat as documentation, not runtime code.

/* ──────────────────────────────────────────────────────────────────────────── *
 *  1. routes/index.ts — mount the franchise router
 * ──────────────────────────────────────────────────────────────────────────── */
// import franchiseRoutes from './franchise.routes';
// router.use('/franchise', franchiseRoutes);

/* ──────────────────────────────────────────────────────────────────────────── *
 *  2. Required schema edits to existing models (see header of franchise.schema.prisma)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 * model Club {
 *   ...
 *   franchiseUnitId      String?
 *   franchiseUnit        FranchiseUnit? @relation(fields: [franchiseUnitId], references: [id], onDelete: SetNull)
 *   revenueDistributions RevenueDistribution[]
 *
 *   @@index([franchiseUnitId])
 * }
 *
 * model User {
 *   ...
 *   franchiseOwner FranchiseOwner?
 * }
 *
 * Then:  npx prisma migrate dev --name franchise_engine
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  3. Stripe webhook — call into revenue distribution on payment_intent.succeeded
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 * import { computeAndRecordDistribution } from './services/franchise-revenue.service';
 *
 * // inside your stripe webhook handler, after recording the Financial row:
 * const club = await prisma.club.findUnique({ where: { id: clubId }, select: { franchiseUnitId: true } });
 * if (club?.franchiseUnitId) {
 *   await computeAndRecordDistribution(null, {
 *     unitId: club.franchiseUnitId,
 *     clubId,
 *     category: 'SUBSCRIPTION',
 *     sourceAmount: amount / 100,            // Stripe is in minor units
 *     sourceCurrency: currency.toUpperCase(),
 *     sourceFinancialId: financial.id,
 *     sourceRef: paymentIntent.id,           // idempotency key
 *     trigger: 'PAYMENT_RECEIVED',
 *   }).catch((err) => console.error('franchise distribution failed', err));
 * }
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  4. Payout adapter selection (env)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *   WL_PAYOUT_BACKEND=LEDGER_ONLY        (default — internal accounting only)
 *   WL_PAYOUT_BACKEND=STRIPE_CONNECT     (requires `npm i stripe` and
 *                                         FranchiseOwner→Stripe-account mapping)
 *
 * The Stripe Connect adapter falls back to LEDGER if a recipient has no mapped
 * Stripe account, so partial rollout is safe.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  5. Background jobs (cron / scheduler)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *   import { expireDueContracts } from './services/franchise-contract.service';
 *
 *   setInterval(async () => {
 *     await expireDueContracts();           // moves ACTIVE → EXPIRED past effectiveTo
 *     await reapExpiredImpersonations();    // from the admin panel
 *     await expireStaleOverrides();         // from the admin panel
 *     await recheckStaleDomains(60);        // from the white-label engine
 *   }, 5 * 60 * 1000);
 *
 *   // Daily performance snapshots:
 *   import { generateSnapshot } from './services/franchise-performance.service';
 *   // Iterate all ACTIVE units and write a snapshot for the current period.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  6. PDF + email branding — already wired by the admin panel
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  No changes needed here. PDFKit + email branding read from Club → WhiteLabelConfig
 *  and remain orthogonal to franchise hierarchy. If you want PER-UNIT brand
 *  (e.g. master-franchise level), introduce a `franchiseUnitId` column on
 *  WhiteLabelConfig in a follow-up.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  7. Bootstrap order (one-time after migrate)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *  a) Seed system territories:
 *       POST /api/v1/franchise/seed/territories     (platform-admin only)
 *     or call `seedSystemTerritories()` from your seed script.
 *
 *  b) Create your headquarters MASTER unit (operator console):
 *       POST /api/v1/franchise/units
 *       { "code": "DE-MASTER", "name": "Familista Germany", "level": "MASTER",
 *         "territoryId": "<DE-country-id>", "ownershipModel": "INVESTOR_GROUP" }
 *
 *  c) Create the headquarters FranchiseOwner and grant primary ownership:
 *       POST /api/v1/franchise/owners        → returns ownerId
 *       POST /api/v1/franchise/units/<id>/ownerships
 *       { "ownerId": "<id>", "equityPercent": 100, "isPrimary": true,
 *         "acquiredVia": "INITIAL" }
 *
 *  d) Define HQ split rule (e.g. 70% local / 25% master / 5% HQ):
 *       POST /api/v1/franchise/units/<id>/split-rules
 *       { "name": "Default subscription split", "category": "SUBSCRIPTION",
 *         "recipients": [
 *           { "type": "HEADQUARTERS", "recipientUnitId": "<hq-unit-id>", "percent": 5 },
 *           { "type": "MASTER",       "recipientUnitId": "<master-id>",  "percent": 25 },
 *           { "type": "LOCAL",        "recipientUnitId": "<local-id>",   "percent": 70 }
 *         ] }
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  8. Access control summary
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Three concentric layers protect every endpoint:
 *    a) `authenticate`            — JWT (existing middleware).
 *    b) `attachFranchiseContext`  — loads scope (platform-admin OR derived from
 *                                   FranchiseOwner.ownerships expanded through
 *                                   the unit hierarchy). Cached 30s per user.
 *    c) `assertUnitAccess(actor, unitId, mode)` inside controllers — fails fast
 *                                   for cross-tenant writes / non-primary actions.
 *
 *  Access modes:
 *    read    — direct ownership OR descendant of an owned unit OR platform-admin
 *    write   — direct ownership only (no implicit descendant write) OR PLATFORM_OWNER/ADMIN
 *    primary — `isPrimary: true` on an active ownership at the unit OR PLATFORM_OWNER
 *
 *  Platform-billing role gets an explicit write allowance for category=REVENUE
 *  so it can manage split rules and distributions without granting full write.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  9. CORS — no special handling needed
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  /api/v1/franchise is authenticated; the existing `origin: true` setting on
 *  app.ts is fine. If you tighten CORS for /api/v1/admin separately, leave
 *  /api/v1/franchise on the broader allowlist used by tenant SPAs.
 */
