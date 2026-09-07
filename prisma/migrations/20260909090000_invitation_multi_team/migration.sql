-- Multi-team staff invitations.
--
-- One invitation, several teams. Additive and defaulted, so every existing row
-- is already correct and nothing that reads "teamId" changes meaning: this
-- holds the teams BEYOND the first, and is empty for every invitation that
-- predates it.
ALTER TABLE "ClubInvitation"
  ADD COLUMN IF NOT EXISTS "additionalTeamIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
