-- Migration: add Announcement model for Club Home dashboard
-- Creates AnnouncementPriority enum and Announcement table (idempotent).

DO $$ BEGIN
  CREATE TYPE "AnnouncementPriority" AS ENUM ('HIGH', 'NORMAL', 'LOW');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "Announcement" (
    "id"        TEXT          NOT NULL,
    "clubId"    TEXT          NOT NULL,
    "title"     VARCHAR(200)  NOT NULL,
    "body"      TEXT          NOT NULL,
    "priority"  "AnnouncementPriority" NOT NULL DEFAULT 'NORMAL',
    "createdAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'Announcement_clubId_fkey'
    ) THEN
        ALTER TABLE "Announcement"
            ADD CONSTRAINT "Announcement_clubId_fkey"
            FOREIGN KEY ("clubId") REFERENCES "Club"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Announcement_clubId_createdAt_idx"
    ON "Announcement"("clubId", "createdAt" DESC);
