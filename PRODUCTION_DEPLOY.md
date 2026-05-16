# Familista — Production Deployment Runbook

> All steps assume you've already merged this `Downloads/familista-backend/src/` tree + `prisma/schema.prisma` into your production GitHub repo, and that you've stripped the 9 `// LOCAL VALIDATION SHIM` files (your repo has the real ones).

Artefacts in this folder ready to use:

| File | Purpose |
|---|---|
| `render.yaml` | Render Blueprint with full env-var map |
| `.env.production.example` | Paste-ready env list |
| `scripts/preflight.sh` | **Run BEFORE `git push`** — local gate (schema + tsc + artefact + migration safety) |
| `scripts/seed-platform-admin.sql` | One-time SQL bootstrap of the first `PlatformAdmin` row |
| `scripts/bootstrap.sh` | Executes every seed/bootstrap endpoint in order |
| `scripts/verify-live.sh` | Smoke-tests one critical endpoint per engine (2xx only) |
| `scripts/post-deploy-check.sh` | Asserts bootstrap actually populated seed counts + idempotency |
| `scripts/stripe-webhook-integration.ts` | Code snippet to paste into your existing Stripe webhook |
| `public/familista-api-client.js` | Browser-side fetch client for all 7 engines |
| `public/whitelabel-bootstrap.client.js` | Tenant theme bootstrap (already present) |

---

## 0 — Pre-flight (5 min)

Use the bundled preflight gate — it runs schema + tsc + artefact + migration-safety checks in one shot:

```bash
chmod +x scripts/preflight.sh
./scripts/preflight.sh
```

Exits non-zero on any failure. **Do not `git push` until preflight passes.** A failed Render build burns ~5 minutes per attempt; this gate catches the common breakages locally.

For manual spot checks:

```bash
git status                              # confirm every src/* file is staged
git diff prisma/schema.prisma           # eyeball the schema delta
npx prisma format && npx prisma validate
npx tsc --noEmit                        # must exit 0
```

---

## 1 — Render production deployment

### Option A — Blueprint (recommended for new instances)

1. Copy `render.yaml` from this folder into your production repo root.
2. In Render dashboard → **New → Blueprint** → connect repo → select branch → Apply.
3. Render provisions:
   - Web service `familista-backend` (Node)
   - Postgres database `familista-postgres` (links `DATABASE_URL` automatically)
4. Set the **secret** env vars in Render dashboard (anything marked `sync: false` in `render.yaml`):
   - `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`
   - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   - `ANTHROPIC_API_KEY`
   - `VISION_WEBHOOK_TOKEN`, `VISION_CLIP_WEBHOOK_TOKEN`
   - any S3 credentials if `WL_ASSETS_BACKEND=S3`

### Option B — Existing service (manual)

1. Render dashboard → existing `familista-backend` service → **Settings**.
2. Update **Build Command**:
   ```
   npm install && npx prisma generate && npm run build
   ```
3. Update **Start Command**:
   ```
   node dist/server.js
   ```
   (Adjust to match your actual entry point — `dist/index.js` if that's how your `tsconfig` outputs.)
4. **Health Check Path**: `/api/v1/health`
5. **Environment → Add Environment Variable** — paste each row from `.env.production.example`. Secrets stay marked private.
6. **Manual Deploy → Deploy latest commit**.

### Option C — Push-to-deploy (already configured)

```bash
git add -A
git commit -m "go-live: 7-engine integration"
git push origin main          # or whatever your Render-connected branch is
```

Watch the deploy logs in Render. Wait for **Live** status.

---

## 2 — Database migration

The migration runs **from the build environment**, not your laptop. Recommended approach:

### 2a — Add to the build command

Update Render **Build Command** to include the migration:

```
npm install && npx prisma migrate deploy && npx prisma generate && npm run build
```

`prisma migrate deploy` applies any pending migrations to the live DB on every deploy. It's idempotent.

### 2b — One-time migration creation (run locally against a staging branch DB first)

```bash
# locally, with DATABASE_URL pointed at a STAGING / dev DB
npx prisma migrate dev --name go_live_full_stack
git add prisma/migrations
git commit -m "migration: go-live schema (88 models)"
git push
```

Once `prisma/migrations/<timestamp>_go_live_full_stack/` is committed, Render's build runs `prisma migrate deploy` and applies it to production.

### 2c — Sanity check after deploy

```sql
-- Run in your Render Postgres shell or via psql:
SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
-- Should show the new migration as applied.

SELECT count(*) FROM "AIModel";              -- empty until you run bootstrap
SELECT count(*) FROM "Territory";            -- empty until you run bootstrap
SELECT count(*) FROM "ColorPaletteTemplate"; -- empty until you run bootstrap
```

---

## 3 — Environment variables final map

See `.env.production.example` in this folder. Categories:

| Group | Required for | Notes |
|---|---|---|
| Core (`DATABASE_URL`, `NODE_ENV`, `JWT_*`) | always | secrets must be private |
| Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) | billing + revenue distribution | already in your existing deploy |
| AI (`ANTHROPIC_API_KEY`, `AI_LLM_MODEL`) | optional | engine degrades to deterministic-only without it |
| Vision (`VISION_*`) | optional | `STUB` defaults work without external workers |
| Asset upload (`WL_ASSETS_*`) | required if uploading logos | `LOCAL` works on Render single-instance |
| Franchise payout (`WL_PAYOUT_BACKEND`) | default `LEDGER_ONLY` | switch to `STRIPE_CONNECT` for external owner payouts |

---

## 4 — Bootstrap execution

After the service is **Live**, run from any machine that can reach the deployed URL:

```bash
chmod +x scripts/bootstrap.sh
BASE_URL="https://your-service.onrender.com" \
JWT="<your-platform-owner-JWT>" \
./scripts/bootstrap.sh
```

The script hits, in order:

1. `POST /api/v1/admin/whitelabel/palettes/seed-presets` — 10 system palettes
2. `POST /api/v1/admin/feature-flags/seed` — 7 default feature flags
3. `POST /api/v1/franchise/seed/territories` — 31 countries + 19 regions
4. `POST /api/v1/ai/bootstrap/seed-models` — 32 default AI models
5. `POST /api/v1/investor/bootstrap/platform-entity` — Familista platform InvestmentEntity

All endpoints are idempotent — re-running is safe.

### One-time bootstrap that needs SQL (no endpoint exists for this)

The very first `PlatformAdmin` row must exist before any platform-admin JWT can be used. Use the bundled SQL script:

```bash
# Either: open scripts/seed-platform-admin.sql, replace the placeholder User.id,
# then paste into Render Postgres → Shell.

# Or via psql with your live DATABASE_URL:
psql "$DATABASE_URL" -f scripts/seed-platform-admin.sql
```

`scripts/seed-platform-admin.sql` wraps the INSERT in a transaction, uses `ON CONFLICT ("userId") DO NOTHING` so it's idempotent, and selects the resulting row back for visual confirmation.

(`mfaEnforced=false` lets you bootstrap before MFA is wired. Flip to `true` after.)

---

## 5 — Stripe webhook production wiring

Open `scripts/stripe-webhook-integration.ts` — it contains the exact code to **paste into your existing Stripe webhook handler** (typically `src/webhooks/stripe.webhook.ts` or `src/services/stripe.service.ts`).

The snippet adds, on `payment_intent.succeeded`:
1. The existing `Financial` row write (unchanged — keep yours).
2. A call to `computeAndRecordDistribution()` (franchise revenue split).
3. A call to `computeRevenueShareAccruals()` (investor revenue-share).

Both calls use `paymentIntent.id` as the idempotency key — re-deliveries from Stripe are safe.

Also add a Stripe webhook guard to **respect the `Club.planSource = OVERRIDE`** flag before mutating `Club.plan` / `Club.subscriptionStatus` (preventing operator overrides from being clobbered by Stripe events). The snippet contains that guard too.

After patching, redeploy and verify in Render logs that webhooks process without errors.

In Stripe dashboard:
- **Developers → Webhooks → your endpoint** → confirm signing secret matches `STRIPE_WEBHOOK_SECRET`
- Trigger a test event from Stripe and check Render logs for `franchise distribution failed` / `investor accrual failed` (should not appear)

---

## 6 — Frontend endpoint integration

Two artefacts in `public/`:

| File | Role |
|---|---|
| `whitelabel-bootstrap.client.js` | Resolves tenant theme from current host on page load, applies CSS variables. Runs once before any rendering. |
| `familista-api-client.js` | Browser-side fetch wrapper exposing typed functions per engine: `FamilistaAPI.ai.injuryRisk(playerId)`, `FamilistaAPI.executive.dashboard()`, etc. |

Both are injected into `familista_v5.html` by step 8 below.

To consume from existing SPA code:

```html
<script src="/whitelabel-bootstrap.client.js"></script>
<script src="/familista-api-client.js"></script>
<script>
  // Anywhere in your existing JS:
  FamilistaAPI.setToken(localStorage.getItem('jwt'));
  const dashboard = await FamilistaAPI.executive.dashboard();
  const ai = await FamilistaAPI.ai.injuryRisk(playerId);
</script>
```

Surfacing the new endpoints in UI is your existing front-end team's incremental work — the API client gives them every entry point in one place.

---

## 7 — Live endpoint verification

After bootstrap completes:

```bash
chmod +x scripts/verify-live.sh
BASE_URL="https://your-service.onrender.com" \
JWT="<your-platform-owner-JWT>" \
./scripts/verify-live.sh
```

The script hits one critical endpoint per engine and reports PASS/FAIL per line:

```
✓ GET  /health                                           200
✓ GET  /api/v1/whitelabel/public/resolve?host=…          200
✓ GET  /api/v1/admin/whitelabel/palettes                 200
✓ GET  /api/v1/franchise/territories                     200
✓ POST /api/v1/investor/bootstrap/platform-entity        200
✓ GET  /api/v1/ai/models?activeOnly=true                 200
✓ GET  /api/v1/vision/audit?limit=1                      200
✓ GET  /api/v1/executive/dashboard                       200
```

Any non-2xx line is a real failure — open Render logs at the same timestamp.

---

## 8 — Post-deploy assertion check

`verify-live.sh` only proves endpoints respond. A 2xx with an empty body is **not** good enough — the engines must contain seed data. Run this after `bootstrap.sh` completes:

```bash
chmod +x scripts/post-deploy-check.sh
BASE_URL="https://your-service.onrender.com" \
JWT="<your-platform-owner-JWT>" \
./scripts/post-deploy-check.sh
```

Asserts:

- `>= 10` color palette presets seeded
- `>= 7` feature flags seeded
- `>= 30` franchise territories seeded
- `>= 32` AI models seeded
- `>= 1` investor entity present
- Re-running each bootstrap endpoint stays 2xx (idempotency)
- Executive OS cross-engine reads succeed

Exits non-zero if any assertion fails. **This is the real "platform is live" gate** — `verify-live.sh` is the liveness probe; `post-deploy-check.sh` is the readiness probe.

---

## Rollback

```bash
# In Render: Service → Manual Deploy → pick previous successful commit → Deploy
# In Postgres: every migration has a corresponding down migration in prisma/migrations
#              but Prisma's `migrate resolve --rolled-back <name>` is one-way.
# Safer rollback: redeploy previous container; the new tables stay but the app
# stops writing to them. Drop tables manually only if absolutely necessary.
```
