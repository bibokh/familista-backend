-- AI cost control — the execution gate's reservations and the owner's switch
--
-- Additive only: seven nullable columns on the existing AiEgressRecord, two
-- indexes and one new table. No existing row, column or constraint changes,
-- and no data is moved.
--
-- AiEgressRecord already holds one row per AI call, written before the call
-- (src/platform/intelligence/gateway.ts). It now also holds the call's budget
-- reservation (reservedTokens, reservedCostMicros), the estimated cost of what
-- the provider reported (costMicros), and the workflow and agent job the call
-- belongs to. Counts and costs can never be negative.
--
-- AiExecutionControl is the Platform Owner's AI EXECUTION switch: one row, id
-- 'global', and no row means OFF. Deploying this migration therefore leaves
-- paid AI execution switched off until the owner switches it on.
--
-- Not a club-private table: no row belongs to a club, so row-level security
-- (R14) does not apply and none is enabled.

-- AlterTable
ALTER TABLE "AiEgressRecord" ADD COLUMN     "agent" TEXT,
ADD COLUMN     "agentRunId" TEXT,
ADD COLUMN     "costMicros" INTEGER,
ADD COLUMN     "origin" TEXT,
ADD COLUMN     "reservedCostMicros" INTEGER,
ADD COLUMN     "reservedTokens" INTEGER,
ADD COLUMN     "workflowId" TEXT;

ALTER TABLE "AiEgressRecord" ADD CONSTRAINT "AiEgressRecord_amounts_not_negative" CHECK (
  ("reservedTokens" IS NULL OR "reservedTokens" >= 0)
  AND ("reservedCostMicros" IS NULL OR "reservedCostMicros" >= 0)
  AND ("costMicros" IS NULL OR "costMicros" >= 0)
  AND ("tokensIn" IS NULL OR "tokensIn" >= 0)
  AND ("tokensOut" IS NULL OR "tokensOut" >= 0)
);

-- CreateTable
CREATE TABLE "AiExecutionControl" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiExecutionControl_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AiExecutionControl_single_row" CHECK ("id" = 'global')
);

-- CreateIndex
CREATE INDEX "AiEgressRecord_workflowId_idx" ON "AiEgressRecord"("workflowId");

-- CreateIndex
CREATE INDEX "AiEgressRecord_agentRunId_idx" ON "AiEgressRecord"("agentRunId");

-- The append-only guard (20261003100000_audit_append_only) allows one change to
-- a record: STARTED to its outcome, leaving who, what and when as they were.
-- It now also leaves the reservation and the attribution as they were, so a
-- settlement can record what the provider reported but can never shrink what
-- was reserved, or move the call to another workflow or agent run.
CREATE OR REPLACE FUNCTION familista_ai_egress_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."outcome" = 'STARTED'
     AND NEW."outcome" <> 'STARTED'
     AND NEW."id" = OLD."id"
     AND NEW."caller" = OLD."caller"
     AND NEW."purpose" = OLD."purpose"
     AND NEW."clubId" IS NOT DISTINCT FROM OLD."clubId"
     AND NEW."model" IS NOT DISTINCT FROM OLD."model"
     AND NEW."provider" IS NOT DISTINCT FROM OLD."provider"
     AND NEW."dataClasses" = OLD."dataClasses"
     AND NEW."pseudonymised" = OLD."pseudonymised"
     AND NEW."createdAt" = OLD."createdAt"
     AND NEW."reservedTokens" IS NOT DISTINCT FROM OLD."reservedTokens"
     AND NEW."reservedCostMicros" IS NOT DISTINCT FROM OLD."reservedCostMicros"
     AND NEW."workflowId" IS NOT DISTINCT FROM OLD."workflowId"
     AND NEW."agentRunId" IS NOT DISTINCT FROM OLD."agentRunId"
     AND NEW."agent" IS NOT DISTINCT FROM OLD."agent"
     AND NEW."origin" IS NOT DISTINCT FROM OLD."origin" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'familista: % on "AiEgressRecord" is refused — a record is completed once and never changed or deleted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
