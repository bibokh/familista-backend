# Familista — Final src/ File-Drop Layout

Schema: `schema.prisma` → `prisma/schema.prisma` · **88 models · 110 enums · 4050 lines · merge integrity verified**

Original canonical preserved at: `schema.prisma.canonical-backup`

---

## Repository tree (target placement)

```
prisma/
└── schema.prisma                                   ← from ./schema.prisma

src/
├── app.ts                                          ← already exists
├── types/
│   ├── whitelabel.types.ts
│   ├── admin.types.ts
│   ├── franchise.types.ts
│   ├── investor.types.ts
│   ├── ai-engine.types.ts
│   ├── vision.types.ts
│   └── executive.types.ts
│
├── utils/
│   ├── whitelabel.validators.ts
│   ├── admin.validators.ts
│   ├── franchise.validators.ts
│   ├── investor.validators.ts
│   ├── ai-engine.validators.ts
│   ├── vision.validators.ts
│   └── executive.validators.ts
│
├── middleware/
│   ├── whitelabel.middleware.ts
│   ├── admin-rbac.middleware.ts
│   ├── franchise-access.middleware.ts
│   ├── investor-access.middleware.ts
│   ├── ai-access.middleware.ts
│   ├── vision-access.middleware.ts
│   └── executive-access.middleware.ts
│
├── controllers/
│   ├── whitelabel.controller.ts
│   ├── admin.controller.ts
│   ├── franchise.controller.ts
│   ├── investor.controller.ts
│   ├── ai-engine.controller.ts
│   ├── vision-engine.controller.ts
│   └── executive.controller.ts
│
├── routes/
│   ├── index.ts                                    ← edit to mount new routers (§ Routes patch)
│   ├── whitelabel.routes.ts
│   ├── admin.routes.ts
│   ├── franchise.routes.ts
│   ├── investor.routes.ts
│   ├── ai-engine.routes.ts
│   ├── vision-engine.routes.ts
│   └── executive.routes.ts
│
├── services/
│   ├── whitelabel.service.ts
│   │
│   ├── admin-rbac.service.ts
│   ├── admin-asset.service.ts
│   ├── admin-branding.service.ts
│   ├── admin-organization.service.ts
│   ├── admin-domain.service.ts
│   ├── admin-impersonation.service.ts
│   ├── admin-audit.service.ts
│   ├── admin-feature-flag.service.ts
│   ├── pdf-branding.service.ts
│   ├── email-branding.service.ts
│   │
│   ├── franchise-audit.service.ts
│   ├── franchise-territory.service.ts
│   ├── franchise-unit.service.ts
│   ├── franchise-ownership.service.ts
│   ├── franchise-expansion.service.ts
│   ├── franchise-revenue.service.ts
│   ├── franchise-payout.adapter.ts
│   ├── franchise-contract.service.ts
│   ├── franchise-compliance.service.ts
│   ├── franchise-performance.service.ts
│   │
│   ├── investor-audit.service.ts
│   ├── investor-profile.service.ts
│   ├── investor-entity.service.ts
│   ├── investor-round.service.ts
│   ├── investor-investment.service.ts
│   ├── investor-captable.service.ts
│   ├── investor-governance.service.ts
│   ├── investor-agreement.service.ts
│   ├── investor-exit.service.ts
│   ├── investor-distribution.service.ts
│   ├── investor-performance.service.ts
│   ├── investor-pdf.service.ts
│   │
│   ├── ai-audit.service.ts
│   ├── ai-model-registry.service.ts
│   ├── ai-llm.adapter.ts
│   ├── ai-feature-extraction.service.ts
│   ├── ai-explainability.service.ts
│   ├── ai-orchestrator.service.ts
│   ├── ai-player-decisions.service.ts
│   ├── ai-coach-decisions.service.ts
│   ├── ai-club-decisions.service.ts
│   ├── ai-franchise-decisions.service.ts
│   ├── ai-investor-decisions.service.ts
│   ├── ai-executive-decisions.service.ts
│   ├── ai-decision-history.service.ts
│   ├── ai-feedback.service.ts
│   │
│   ├── vision-audit.service.ts
│   ├── vision-inference.adapter.ts
│   ├── vision-clip.adapter.ts
│   ├── vision-ingest.service.ts
│   ├── vision-tracking.service.ts
│   ├── vision-events.service.ts
│   ├── vision-analytics.service.ts
│   ├── vision-fusion.service.ts
│   ├── vision-clip.service.ts
│   ├── vision-scouting.service.ts
│   ├── vision-realtime.service.ts
│   │
│   ├── executive-audit.service.ts
│   ├── executive-aggregator.service.ts
│   ├── executive-workflow.service.ts
│   ├── executive-step-executor.service.ts
│   ├── executive-sponsor.service.ts
│   ├── executive-board.service.ts
│   ├── executive-forecast.service.ts
│   ├── executive-risk.service.ts
│   └── executive-dashboard.service.ts
│
├── lib/
│   ├── ai-scoring.lib.ts
│   ├── vision-analytics.lib.ts
│   └── storage/
│       ├── storage.adapter.ts
│       ├── storage-local.adapter.ts
│       └── storage-s3.adapter.ts
│
└── data/
    ├── palette-presets.ts
    ├── franchise-seed.ts
    ├── ai-models.seed.ts
    └── executive-workflow-templates.ts

public/
├── familista_v5.html                               ← already exists
└── whitelabel-bootstrap.client.js                  ← new: SPA theme bootstrap
```

---

## Move commands (run from `Downloads/familista-backend/`)

```bash
# prisma
mkdir -p prisma
cp schema.prisma prisma/schema.prisma

# src/types
mkdir -p src/types
mv whitelabel.types.ts admin.types.ts franchise.types.ts investor.types.ts \
   ai-engine.types.ts vision.types.ts executive.types.ts src/types/

# src/utils
mkdir -p src/utils
mv whitelabel.validators.ts admin.validators.ts franchise.validators.ts \
   investor.validators.ts ai-engine.validators.ts vision.validators.ts \
   executive.validators.ts src/utils/

# src/middleware
mkdir -p src/middleware
mv whitelabel.middleware.ts admin-rbac.middleware.ts franchise-access.middleware.ts \
   investor-access.middleware.ts ai-access.middleware.ts vision-access.middleware.ts \
   executive-access.middleware.ts src/middleware/

# src/controllers
mkdir -p src/controllers
mv whitelabel.controller.ts admin.controller.ts franchise.controller.ts \
   investor.controller.ts ai-engine.controller.ts vision-engine.controller.ts \
   executive.controller.ts src/controllers/

# src/routes
mkdir -p src/routes
mv whitelabel.routes.ts admin.routes.ts franchise.routes.ts investor.routes.ts \
   ai-engine.routes.ts vision-engine.routes.ts executive.routes.ts src/routes/

# src/services
mkdir -p src/services
mv whitelabel.service.ts \
   admin-rbac.service.ts admin-asset.service.ts admin-branding.service.ts \
   admin-organization.service.ts admin-domain.service.ts admin-impersonation.service.ts \
   admin-audit.service.ts admin-feature-flag.service.ts \
   pdf-branding.service.ts email-branding.service.ts \
   franchise-audit.service.ts franchise-territory.service.ts franchise-unit.service.ts \
   franchise-ownership.service.ts franchise-expansion.service.ts franchise-revenue.service.ts \
   franchise-payout.adapter.ts franchise-contract.service.ts franchise-compliance.service.ts \
   franchise-performance.service.ts \
   investor-audit.service.ts investor-profile.service.ts investor-entity.service.ts \
   investor-round.service.ts investor-investment.service.ts investor-captable.service.ts \
   investor-governance.service.ts investor-agreement.service.ts investor-exit.service.ts \
   investor-distribution.service.ts investor-performance.service.ts investor-pdf.service.ts \
   ai-audit.service.ts ai-model-registry.service.ts ai-llm.adapter.ts \
   ai-feature-extraction.service.ts ai-explainability.service.ts ai-orchestrator.service.ts \
   ai-player-decisions.service.ts ai-coach-decisions.service.ts ai-club-decisions.service.ts \
   ai-franchise-decisions.service.ts ai-investor-decisions.service.ts \
   ai-executive-decisions.service.ts ai-decision-history.service.ts ai-feedback.service.ts \
   vision-audit.service.ts vision-inference.adapter.ts vision-clip.adapter.ts \
   vision-ingest.service.ts vision-tracking.service.ts vision-events.service.ts \
   vision-analytics.service.ts vision-fusion.service.ts vision-clip.service.ts \
   vision-scouting.service.ts vision-realtime.service.ts \
   executive-audit.service.ts executive-aggregator.service.ts executive-workflow.service.ts \
   executive-step-executor.service.ts executive-sponsor.service.ts executive-board.service.ts \
   executive-forecast.service.ts executive-risk.service.ts executive-dashboard.service.ts \
   src/services/

# src/lib + src/lib/storage
mkdir -p src/lib/storage
mv ai-scoring.lib.ts vision-analytics.lib.ts src/lib/
mv storage.adapter.ts storage-local.adapter.ts storage-s3.adapter.ts src/lib/storage/

# src/data
mkdir -p src/data
mv palette-presets.ts franchise-seed.ts ai-models.seed.ts \
   executive-workflow-templates.ts src/data/

# public
mkdir -p public
cp whitelabel-bootstrap.client.js public/
```

---

## Routes patch — `src/routes/index.ts`

Append these imports and mounts to your existing `src/routes/index.ts`:

```ts
import whitelabelRoutes  from './whitelabel.routes';
import adminRoutes       from './admin.routes';
import franchiseRoutes   from './franchise.routes';
import investorRoutes    from './investor.routes';
import aiEngineRoutes    from './ai-engine.routes';
import visionRoutes      from './vision-engine.routes';
import executiveRoutes   from './executive.routes';

router.use('/whitelabel', whitelabelRoutes);
router.use('/admin',      adminRoutes);
router.use('/franchise',  franchiseRoutes);
router.use('/investor',   investorRoutes);
router.use('/ai',         aiEngineRoutes);
router.use('/vision',     visionRoutes);
router.use('/executive',  executiveRoutes);
```

---

## app.ts patch — webhook body-limit + static uploads

Add **before** `app.use('/api/v1', routes)`:

```ts
import path from 'path';

// Large payloads from the Vision inference worker
app.use('/api/v1/vision/webhooks/inference', express.json({ limit: '32mb' }));

// LOCAL storage backend serves uploaded assets from disk
if ((process.env.WL_ASSETS_BACKEND ?? 'LOCAL') === 'LOCAL') {
  const uploadsDir = process.env.WL_ASSETS_DIR ?? path.resolve(process.cwd(), 'uploads');
  app.use('/uploads', express.static(uploadsDir, {
    maxAge: '1y',
    immutable: true,
    index: false,
    dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));
}
```

---

## NPM dependencies

```bash
npm i multer @aws-sdk/client-s3 @anthropic-ai/sdk pdfkit
npm i -D @types/multer @types/pdfkit
# optional / by-adapter
npm i sharp                         # image dimension probe for asset uploads
npm i stripe                        # only for STRIPE_CONNECT payout backend
```

---

## Environment variables

```bash
# Existing
DATABASE_URL=...
ANTHROPIC_API_KEY=...                 # optional — AI engine degrades to deterministic without it
AI_LLM_MODEL=claude-sonnet-4-20250514
MAIL_DEFAULT_FROM=no-reply@familista.app

# White-label assets
WL_ASSETS_BACKEND=LOCAL              # or S3
WL_ASSETS_DIR=./uploads              # LOCAL only
WL_ASSETS_PUBLIC_PREFIX=/uploads
WL_ASSETS_PUBLIC_BASE_URL=           # optional CDN base
WL_ASSETS_S3_BUCKET=                 # S3 only
WL_ASSETS_S3_REGION=us-east-1
WL_ASSETS_S3_ENDPOINT=               # R2/Spaces only
WL_ASSETS_S3_ACCESS_KEY_ID=
WL_ASSETS_S3_SECRET_ACCESS_KEY=
WL_ASSETS_S3_FORCE_PATH_STYLE=false

# Franchise revenue payouts
WL_PAYOUT_BACKEND=LEDGER_ONLY        # or STRIPE_CONNECT
STRIPE_SECRET_KEY=                   # STRIPE_CONNECT only

# Vision
VISION_INFERENCE_BACKEND=STUB        # or INTERNAL_WORKER | STATS_PERFORM | HUDL
VISION_WORKER_URL=
VISION_WORKER_CALLBACK_URL=
VISION_WORKER_TOKEN=
VISION_WEBHOOK_TOKEN=                # required to accept inference callbacks

VISION_CLIP_BACKEND=STUB             # or FFMPEG_WORKER | AWS_MEDIA_CONVERT | MUX
VISION_CLIP_WORKER_URL=
VISION_CLIP_WORKER_CALLBACK_URL=
VISION_CLIP_WORKER_TOKEN=
VISION_CLIP_WEBHOOK_TOKEN=

VISION_FUSION_DISTANCE_WEIGHT=0.5
VISION_FUSION_TOPSPEED_WEIGHT=0.3
```

---

## Files NOT to deploy (reference docs only)

```
schema.prisma.canonical-backup
routes_index.patch.ts
admin-routes.patch.ts
franchise-routes.patch.ts
investor-routes.patch.ts
ai-engine.patch.ts
vision-engine.patch.ts
executive.patch.ts
INVESTOR_INTEGRATION.md
SRC_LAYOUT.md
GO_LIVE.md
seed-bootstrap.sh
smoke-tests.sh

# Individual schema fragments (already merged into schema.prisma)
whitelabel.schema.prisma
admin-whitelabel.schema.prisma
franchise.schema.prisma
investor.schema.prisma
ai-engine.schema.prisma
vision.schema.prisma
executive.schema.prisma
```

---

## Post-move execution

```bash
# in your project root
npx prisma format
npx prisma validate
npx prisma migrate dev --name go_live_full_stack
npx prisma generate
npx tsc --noEmit

# bootstrap + smoke (after deploy / boot)
chmod +x seed-bootstrap.sh smoke-tests.sh
./seed-bootstrap.sh
./smoke-tests.sh
```
