// Familista — AI Decision Engine
// Wiring patch + operational notes. Documentation, not runtime code.

/* ──────────────────────────────────────────────────────────────────────────── *
 *  1. routes/index.ts — mount the AI engine router
 * ──────────────────────────────────────────────────────────────────────────── */
// import aiEngineRoutes from './ai-engine.routes';
// router.use('/ai', aiEngineRoutes);

/* ──────────────────────────────────────────────────────────────────────────── *
 *  2. Required schema ordering
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Append the schema fragments in this order:
 *    whitelabel → admin-whitelabel → franchise → investor → ai-engine
 *
 *  No edits to existing models are required — AIDecision references subjects
 *  via plain string IDs so the audit trail is decoupled from any tenant
 *  schema. Run:
 *
 *    npx prisma migrate dev --name ai_engine
 *    npx prisma generate
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  3. Environment variables
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *    ANTHROPIC_API_KEY       — required for Claude-backed narratives
 *    AI_LLM_MODEL            — default `claude-sonnet-4-20250514`
 *    AI_LLM_MAX_TOKENS       — default 1024
 *    AI_LLM_TIMEOUT_MS       — default 20_000
 *
 *  When ANTHROPIC_API_KEY is unset, the engine runs in deterministic-only
 *  mode — every decision still produces a rationale, but it is built from
 *  the scored factors instead of LLM prose. Switching modes does not change
 *  scores, confidence, urgency, or recommended actions.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  4. Required NPM packages
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *    @anthropic-ai/sdk     — required for Claude narratives (optional;
 *                            engine degrades gracefully if absent)
 *
 *  All other deps (express, prisma, zod) are already in the project.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  5. Bootstrap (one-time after migrate)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *   POST /api/v1/ai/bootstrap/seed-models     (platform-admin)
 *
 *  Seeds 32 default RULE_BASED / HYBRID models — one per decision type — and
 *  activates the freshest version per (domain, decisionType). Idempotent.
 *
 *  Alternatively, from your seed script:
 *
 *    import { seedDefaultAIModels } from './data/ai-models.seed';
 *    await seedDefaultAIModels();
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  6. Background jobs (cron / scheduler)
 * ──────────────────────────────────────────────────────────────────────────── */
/*
 *   import { expireStaleDecisions } from './services/ai-decision-history.service';
 *
 *   setInterval(async () => {
 *     await expireStaleDecisions();   // GENERATED/REVIEWED → EXPIRED past expiresAt
 *     // existing cron actions from earlier engines stay
 *   }, 60 * 60 * 1000);
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  7. Access model summary
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Three layers per request:
 *    a) `authenticate`             — JWT (existing middleware).
 *    b) `attachAIContext`          — loads scope: platform admin OR derived
 *                                    from User.clubId + InvestorProfile +
 *                                    FranchiseOwner (with descendant expansion).
 *                                    Cached 30s per user.
 *    c) `assertSubjectAccess`      — called inside each controller before the
 *                                    decision runs. Enforces per-domain rules.
 *
 *  Quick reference for subject access:
 *    Player          → user must be CLUB_ADMIN/HEAD_COACH/.../SCOUT in the
 *                      player's club, or platform admin
 *    Match           → coaching roles in the match's club, or platform admin
 *    Club            → CLUB_ADMIN in that club, or platform admin
 *    TrainingSession → coaching roles in the session's club, or platform admin
 *    FranchiseUnit   → user is FranchiseOwner with ownership in the unit or
 *                      an ancestor, or platform admin
 *    InvestorProfile → user is the linked investor, or platform admin
 *    InvestmentEntity → user holds positions in the entity, or platform admin
 *    Platform        → platform admin only
 *
 *  Model registry, executive decisions, network audit and seeding require
 *  platform-admin access.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  8. Governance — board-safe explainability contract
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  Every persisted AIDecision row carries the full lineage required by the
 *  governance request:
 *
 *    • model.{slug, version}     — exactly which model produced it
 *    • features (frozen JSON)    — the inputs at decision time, replayable
 *    • inputHash                 — sha256 of canonicalised inputs, used to
 *                                  short-circuit identical re-runs
 *    • evidence                  — scored factors with weights + contributions
 *    • recommendation            — the deterministic action
 *    • rationale                 — human-readable narrative (LLM if available,
 *                                  otherwise deterministic fall-back)
 *    • alternatives              — explicit alternatives with score deltas
 *    • warnings                  — flagged caveats grounded in the data
 *    • confidence                — bounded [0,1], LLM may nudge ±0.3
 *    • urgency                   — INFO / LOW / MEDIUM / HIGH / CRITICAL
 *    • status, reviewedBy/At     — operator review trail
 *    • outcome, outcomeAt        — closed-loop feedback signal
 *    • generatedByUserId         — provenance
 *    • llmTokensIn/Out/DurationMs — cost accounting
 *
 *  The deterministic scoring library is pure: feeding the same features
 *  through the same model version always produces the same score, evidence
 *  and recommendation. The LLM only generates prose; it never alters the
 *  numerical decision.
 *
 *  When a model is updated, register a NEW version (e.g. `1.1.0`) and call
 *  /activate — never mutate an active version. Decisions written under the
 *  old version retain their lineage and remain explainable indefinitely.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  9. Cross-engine integration map
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  AI Engine reads from:
 *    • Existing Familista models (Player, Match, Club, Financial, …)
 *    • Franchise engine (FranchiseUnit, FranchiseViolation,
 *      FranchiseContract, FranchisePerformanceSnapshot, RevenueDistribution,
 *      TerritoryRight)
 *    • Investor engine (InvestorProfile, Investment, CapTableEntry,
 *      InvestmentEntity, InvestorDistribution)
 *
 *  AI Engine writes to:
 *    • AIDecision (immutable audit-grade rows)
 *    • AIDecisionFeedback (closed loop)
 *    • AIAudit (every model registration, decision, review)
 *
 *  AI Engine does NOT write back to operational tables (Player, Club, etc.).
 *  Acting on an AI recommendation is always an explicit operator step
 *  through the existing domain APIs.
 */

/* ──────────────────────────────────────────────────────────────────────────── *
 *  10. CORS — no special handling
 * ──────────────────────────────────────────────────────────────────────────── *
 *
 *  /api/v1/ai is authenticated; the existing `origin: true` setting in
 *  app.ts already covers tenant SPAs and the executive dashboard.
 */
