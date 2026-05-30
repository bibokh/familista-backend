-- Phase R — Club System
-- Additive, nullable-only columns on "Club". Backward-compatible: existing rows
-- remain valid (every column is nullable, no defaults, no data rewrite).
-- Logo + brand colors intentionally NOT duplicated here — they live in
-- "WhiteLabelConfig" (logoUrl / logoDarkUrl / faviconUrl / primaryColor / ...).

ALTER TABLE "Club"
  ADD COLUMN IF NOT EXISTS "description"  TEXT,
  ADD COLUMN IF NOT EXISTS "addressLine"  TEXT,
  ADD COLUMN IF NOT EXISTS "region"       TEXT,
  ADD COLUMN IF NOT EXISTS "postalCode"   TEXT,
  ADD COLUMN IF NOT EXISTS "contactEmail" TEXT,
  ADD COLUMN IF NOT EXISTS "contactPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "websiteUrl"   TEXT,
  ADD COLUMN IF NOT EXISTS "socialLinks"  JSONB;
