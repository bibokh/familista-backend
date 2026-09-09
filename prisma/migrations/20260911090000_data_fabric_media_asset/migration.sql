-- Familista Data Fabric — MediaAsset
--
-- PURELY ADDITIVE. One new table and six new enums. No existing table is
-- altered, no column is dropped or renamed, no row is read, written, moved or
-- deleted. Existing club crests and player photographs stay exactly where they
-- are, in the columns they are in, and keep working — this migration creates a
-- place for new media to go and nothing else.
--
-- The separate migration that would eventually move those existing images out
-- of Postgres is DESIGNED but NOT WRITTEN HERE, deliberately. See
-- src/fabric/media/legacy-media.ts, which documents it and reads both shapes
-- meanwhile.
--
-- Guarded throughout so it is safe to replay against a database bootstrapped
-- with `db push`.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MediaType') THEN
    CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MediaPurpose') THEN
    CREATE TYPE "MediaPurpose" AS ENUM ('CREST', 'PHOTO', 'AVATAR', 'MATCH_FOOTAGE', 'TRAINING_FOOTAGE', 'CLIP', 'THUMBNAIL', 'DOCUMENT', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MediaSubjectType') THEN
    CREATE TYPE "MediaSubjectType" AS ENUM ('CLUB', 'TEAM', 'PLAYER', 'STAFF', 'USER', 'MATCH', 'TRAINING_SESSION', 'COMPETITION', 'DEVICE', 'CAMERA', 'OTHER');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MediaProcessingStatus') THEN
    CREATE TYPE "MediaProcessingStatus" AS ENUM ('PENDING', 'STORED', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'MediaRetentionClass') THEN
    CREATE TYPE "MediaRetentionClass" AS ENUM ('HOT', 'WARM', 'COLD', 'ARCHIVED', 'DELETION_ELIGIBLE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DataClassificationLevel') THEN
    CREATE TYPE "DataClassificationLevel" AS ENUM ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "MediaAsset" (
  "id"                 TEXT NOT NULL,
  "clubId"             TEXT NOT NULL,
  "teamId"             TEXT,
  "subjectType"        "MediaSubjectType" NOT NULL,
  "subjectId"          TEXT,
  "mediaType"          "MediaType" NOT NULL,
  "purpose"            "MediaPurpose" NOT NULL DEFAULT 'OTHER',
  "mimeType"           TEXT NOT NULL,
  "originalFilename"   TEXT,
  "storageProvider"    TEXT NOT NULL,
  "storageKey"         TEXT NOT NULL,
  "sizeBytes"          INTEGER NOT NULL,
  "checksum"           TEXT NOT NULL,
  "captureTime"        TIMESTAMP(3),
  "venueId"            TEXT,
  "sessionType"        TEXT,
  "sessionId"          TEXT,
  "processingStatus"   "MediaProcessingStatus" NOT NULL DEFAULT 'PENDING',
  "retentionClass"     "MediaRetentionClass" NOT NULL DEFAULT 'HOT',
  "dataClassification" "DataClassificationLevel" NOT NULL DEFAULT 'INTERNAL',
  "consentRecordId"    TEXT,
  "aiEligible"         BOOLEAN NOT NULL DEFAULT false,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy"          TEXT,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  "deletedAt"          TIMESTAMP(3),
  "metadata"           JSONB,

  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- One row per stored object: the duplicate-upload guard, enforced by the
-- database rather than by a check-then-write in application code.
CREATE UNIQUE INDEX IF NOT EXISTS "MediaAsset_storageProvider_storageKey_key"
  ON "MediaAsset"("storageProvider", "storageKey");

-- Every read is tenant-first. These indexes exist so that a query which forgets
-- to lead with clubId is also the slow one.
CREATE INDEX IF NOT EXISTS "MediaAsset_clubId_subjectType_subjectId_idx" ON "MediaAsset"("clubId", "subjectType", "subjectId");
CREATE INDEX IF NOT EXISTS "MediaAsset_clubId_createdAt_idx"             ON "MediaAsset"("clubId", "createdAt");
CREATE INDEX IF NOT EXISTS "MediaAsset_clubId_purpose_idx"               ON "MediaAsset"("clubId", "purpose");
CREATE INDEX IF NOT EXISTS "MediaAsset_checksum_idx"                     ON "MediaAsset"("checksum");
CREATE INDEX IF NOT EXISTS "MediaAsset_processingStatus_idx"             ON "MediaAsset"("processingStatus");
CREATE INDEX IF NOT EXISTS "MediaAsset_retentionClass_idx"               ON "MediaAsset"("retentionClass");
