-- Interface language for a user, as an IETF tag (en-GB, de-DE, ar, ...).
-- Nullable: NULL means the user has never chosen one, which the client
-- resolves from the browser and finally en-GB. Additive and idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "locale" TEXT;
