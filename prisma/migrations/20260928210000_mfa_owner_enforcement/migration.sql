-- Cyber Defense · Step 7 — the owner's choice to require a code at sign-in
--
-- Additive only: one nullable column on "MFASetting", no data rewritten,
-- nothing dropped. Every existing row gets NULL, which means "not required at
-- sign-in" — exactly today's behaviour, so applying this changes no sign-in.
--
--   enforcedAt  when the owner switched enforcement on. It is honoured only
--               while two-step sign-in is enrolled and only when it is not
--               older than the current enrolment (enforcedAt >= enabledAt), so
--               turning MFA off and on again never re-arms it silently.

-- AlterTable
ALTER TABLE "MFASetting" ADD COLUMN     "enforcedAt" TIMESTAMP(3);
