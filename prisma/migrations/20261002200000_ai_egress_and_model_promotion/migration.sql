-- Cyber Defense · Batch 5 (R3 + R8) — the AI layer
--
-- Three new tables. No existing table, column or row is changed.
--
--   ClubAiDataPolicy   a club's two switches, both off by default:
--                      restrictedEgress (may RESTRICTED data reach an AI
--                      provider) and trainingUse (may the club's data be used
--                      for training, e.g. federated learning).
--   AiEgressRecord     one row per AI Gateway call: caller, purpose, data
--                      classes, model, tokens, outcome. Never the prompt.
--   AIModelPromotion   request → approval by a different person → Ed25519
--                      signature over the model artifact's SHA-256.

-- CreateTable
CREATE TABLE "ClubAiDataPolicy" (
    "clubId" TEXT NOT NULL,
    "restrictedEgress" BOOLEAN NOT NULL DEFAULT false,
    "trainingUse" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubAiDataPolicy_pkey" PRIMARY KEY ("clubId")
);

-- CreateTable
CREATE TABLE "AiEgressRecord" (
    "id" TEXT NOT NULL,
    "caller" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "clubId" TEXT,
    "model" TEXT,
    "provider" TEXT,
    "dataClasses" TEXT[],
    "pseudonymised" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiEgressRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIModelPromotion" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "artifactSha256" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "keyId" TEXT,
    "signature" TEXT,
    "notes" TEXT,

    CONSTRAINT "AIModelPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiEgressRecord_clubId_createdAt_idx" ON "AiEgressRecord"("clubId", "createdAt");

-- CreateIndex
CREATE INDEX "AiEgressRecord_createdAt_idx" ON "AiEgressRecord"("createdAt");

-- CreateIndex
CREATE INDEX "AIModelPromotion_modelId_status_idx" ON "AIModelPromotion"("modelId", "status");

-- AddForeignKey
ALTER TABLE "AIModelPromotion" ADD CONSTRAINT "AIModelPromotion_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AIModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
