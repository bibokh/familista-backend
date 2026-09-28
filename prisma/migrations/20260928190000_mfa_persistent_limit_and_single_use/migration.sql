-- Cyber Defense · Step 6 — MFA code protection that survives a restart
--
-- Additive only: three columns on "MFASetting", no data rewritten, nothing
-- dropped. Every existing row gets codeFailures = 0 and NULLs, which means
-- "no failures recorded, no code used yet" — the correct starting state.
--
--   codeFailures     wrong codes in the current window. Held in the database
--                    so a restart, a redeploy or a free-plan spin-down cannot
--                    reset the limit, and every instance shares one count.
--   codeWindowStart  when that window began.
--   lastTotpStep     the 30-second step of the last accepted app code; a code
--                    is accepted only for a strictly later step, so a code that
--                    worked once is never accepted again.

-- AlterTable
ALTER TABLE "MFASetting" ADD COLUMN     "codeFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeWindowStart" TIMESTAMP(3),
ADD COLUMN     "lastTotpStep" INTEGER;
