-- Invitation email delivery state
--
-- Additive only. One new enum and seven nullable/defaulted columns on
-- ClubInvitation; nothing is dropped, renamed or rewritten, and no existing
-- row changes meaning.
--
-- The default is CREATED, which is exactly what every invitation that predates
-- email delivery is: it exists, and nothing was ever emailed for it. That is
-- true, and it does not touch the invitation's own status — an invitation is
-- valid or not for its own reasons, and delivery is a different fact.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailDeliveryState') THEN
    CREATE TYPE "EmailDeliveryState" AS ENUM ('CREATED', 'QUEUED', 'SENT', 'FAILED');
  END IF;
END $$;

ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryState" "EmailDeliveryState" NOT NULL DEFAULT 'CREATED';
ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryProvider" TEXT;
ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryMessageId" TEXT;
ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryFailureCode" TEXT;
ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryFailureClass" TEXT;
ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryAttemptedAt" TIMESTAMP(3);
ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ClubInvitation" ADD COLUMN IF NOT EXISTS "deliveryLocale" TEXT;

-- SYSTEM lists invitations whose delivery failed, so that lookup is an index.
CREATE INDEX IF NOT EXISTS "ClubInvitation_deliveryState_idx" ON "ClubInvitation"("deliveryState");
