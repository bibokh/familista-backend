-- Cyber Defense · Step 8 — refresh tokens hashed at rest, dual-read
--
-- Nothing is dropped and no signed-in user is logged out.
--
--   tokenHash  SHA-256 of 'familista:refresh-token:v1:' || token, hex — the
--              exact digest `src/security/refresh-token-hash.ts` computes. The
--              build that ships with this migration writes only this column and
--              looks tokens up by it.
--   token      becomes nullable. New rows leave it NULL.
--
-- Existing rows are backfilled with their hash here. Their raw value is KEPT
-- while the token is still valid, because during a deploy the previous build
-- keeps serving until the new one takes over, and it can only find a token by
-- its raw value: clearing it now would log those users out. Such a row loses
-- its raw value the moment it is used (a refresh rotates it away, a logout
-- deletes it) and is useless once it expires (7 days at most).
--
-- A raw value that has already expired can sign nobody in on any build, so it
-- is cleared now. (Prisma keeps timestamps as UTC without a zone, so the
-- comparison is made in UTC whatever the server's time zone is.)

-- AlterTable
ALTER TABLE "RefreshToken" ALTER COLUMN "token" DROP NOT NULL,
ADD COLUMN     "tokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- Backfill: every row gets its hash.
UPDATE "RefreshToken"
SET "tokenHash" = encode(sha256(convert_to('familista:refresh-token:v1:' || "token", 'UTF8')), 'hex')
WHERE "token" IS NOT NULL AND "tokenHash" IS NULL;

-- Scrub: an expired raw token is of no use to anybody, so it is not kept.
UPDATE "RefreshToken" SET "token" = NULL WHERE "token" IS NOT NULL AND "expiresAt" < (now() AT TIME ZONE 'UTC');
