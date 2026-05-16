// Familista — Executive OS · Integration Layer
// Wiring patch + operational notes. Documentation, not runtime code.

/* ──────────────────────────────────────────────────────────────────────────── *
 *  1. routes/index.ts — mount the executive router
 * ──────────────────────────────────────────────────────────────────────────── */
// import executiveRoutes from './executive.routes';
// router.use('/executive', executiveRoutes);

/* ──────────────────────────────────────────────────────────────────────────── *
 *  2. Schema ordering
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Append fragments in this order:
 *    whitelabel → admin-whitelabel → franchise → investor → ai-engine → vision
 *      → executive
 *
 *  No edits to existing models are required.
 *
 *    npx prisma migrate dev --name executive_integration
 *    npx prisma generate
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  3. Required NPM packages
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  None — the executive layer only orchestrates existing services. No new
 *  runtime dependencies.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  4. What this engine does NOT add
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  By design this engine never duplicates operational data. It calls into:
 *
 *    • franchise-expansion.service           (expansion requests + acquisitions)
 *    • franchise-ownership.service           (transfers)
 *    • franchise-performance.service         (snapshots)
 *    • franchise-compliance.service          (compliance checks)
 *    • investor-investment.service           (commit + fund)
 *    • investor-round.service                (rounds open/close)
 *    • investor-entity.service               (valuation)
 *    • investor-exit.service                 (exits + waterfall)
 *    • investor-distribution.service         (record distributions)
 *    • admin-branding.service                (apply palette / brand)
 *    • admin-organization.service            (subscription overrides + limits)
 *    • ai-player-decisions.service           (injury / talent / etc.)
 *    • ai-club-decisions.service             (financial health / sponsorship / …)
 *    • ai-franchise-decisions.service        (territory risk / expansion / …)
 *    • ai-investor-decisions.service         (ROI / valuation / acquisition)
 *
 *  The step executor (executive-step-executor.service.ts) holds the single
 *  registry mapping (engine, action) tuples to the concrete service calls.
 *  All workflow logic flows through that one file.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  5. Bootstrap (one-time after migrate)
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Promote a user to an executive role:
 *
 *    curl -X PUT https://<host>/api/v1/executive/assignments \
 *      -H "Authorization: Bearer <PLATFORM-OWNER-JWT>" \
 *      -H "Content-Type: application/json" \
 *      -d '{"userId":"<user-uuid>","role":"CEO","voteWeight":2.0}'
 *
 *  Board members need vote weights configured here — those weights are used
 *  when tallying resolutions.
 *
 *  No additional seed step required. Workflow templates are declarative data
 *  in src/data/executive-workflow-templates.ts and are loaded directly by the
 *  workflow service.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  6. Background jobs (cron / scheduler)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *   import { sweep } from './services/executive-risk.service';
 *
 *   setInterval(async () => {
 *     await sweep(null);                          // refreshes RiskAlert rows
 *     // existing cron actions from prior engines stay
 *   }, 30 * 60 * 1000);                            // every 30 minutes
 *
 *  Quarterly forecast pre-warming (so the dashboard never waits):
 *
 *   import { generateForecast } from './services/executive-forecast.service';
 *   setInterval(async () => {
 *     await generateForecast(<systemActor>, {
 *       scope: 'PLATFORM',
 *       periodKey: '<next-quarter>',
 *       periodStartAt: '<iso>',
 *       periodEndAt: '<iso>',
 *       scenarios: ['BASE', 'OPTIMISTIC', 'PESSIMISTIC', 'STRESS'],
 *     });
 *   }, 24 * 60 * 60 * 1000);
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  7. Access matrix
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *    Endpoint                                  Required role(s)
 *    ----------------------------------------- ---------------------------------
 *    GET   /dashboard                           any executive OR platform admin
 *    GET   /actions                             any executive OR platform admin
 *    GET   /assignments                         platform admin
 *    PUT   /assignments                         platform admin
 *    DELETE/assignments/:userId                 platform admin
 *    *     /workflows*                          any executive OR platform admin
 *    POST  /resolutions                         CHAIR / BOARD_MEMBER / platform admin
 *    POST  /resolutions/:id/vote                CHAIR / BOARD_MEMBER / platform admin
 *    POST  /resolutions/:id/tally               CHAIR / BOARD_MEMBER / platform admin
 *    POST  /forecasts                           CEO / CFO / COO / platform admin
 *    POST  /sponsors*                           any executive OR platform admin
 *    POST  /risks/sweep                         any executive OR platform admin
 *    GET   /audit*                              any executive OR platform admin
 *
 *  Attestations on workflows are role-checked at the workflow service layer:
 *  the workflow template declares `requiredAttestations`, and `transitionWorkflow`
 *  refuses to move to APPROVED until each required role has an APPROVE
 *  WorkflowAttestation row from a user with that ExecutiveAssignment.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  8. Governance contract
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Every cross-engine action that flows through the executive layer carries:
 *    • A workflow row with a templateSlug pinning the exact step list used
 *    • Per-step engine + action + params (the dispatch signature)
 *    • Per-step result + error + completedBy
 *    • Attestations with role + decision + signatureRef
 *    • Cross-engine audit rows in ExecutiveAudit AND in the originating
 *      engine's own audit log — both records reference the same workflow id
 *
 *  Board resolutions carry the full vote ledger (BoardVote rows with weight,
 *  rationale, signatureRef) and the running tally, so a resolution can be
 *  forensically replayed years later.
 *
 *  Risk alerts are de-duplicated by fingerprint, and re-runs of the sweep
 *  reconcile severity to the latest evidence rather than spamming new rows.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  9. Adding a new workflow kind
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  1. Add a WORKFLOW_TEMPLATES entry in src/data/executive-workflow-templates.ts
 *     with: slug, kind, requiredAttestations, defaultPriority, steps[].
 *  2. If a step references a NEW engine action, add the StepActionId in
 *     src/types/executive.types.ts and a handler in the HANDLERS map in
 *     src/services/executive-step-executor.service.ts (call into the
 *     existing engine service — never duplicate logic).
 *  3. Add the new kind to ExecutiveWorkflowKind in the Prisma schema if it
 *     isn't one of the existing nine. Run a migration.
 *
 *  No controller / routes changes are needed — workflow CRUD is templated.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  10. CORS
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  /api/v1/executive is authenticated and consumed by the executive console
 *  (typically https://exec.familista.app). If you tighten CORS, allow that
 *  origin explicitly. Otherwise the default `origin: true` in app.ts is fine.
 */
