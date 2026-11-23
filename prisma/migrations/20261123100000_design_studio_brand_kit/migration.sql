-- Design Studio M2c — a club's brand kit: its colours and its logos
-- ─────────────────────────────────────────────────────────────────────────────
-- DesignBrandKit holds a club's named colours, one kit per club. DesignBrandAsset
-- holds its logos: never the uploaded bytes, but the PNG the server re-encoded
-- from them (src/platform/product-design/brand-image.ts), with its size and
-- SHA-256, kept here so it is backed up, restored and held by row-level security
-- with the rest of the club's data. An asset names its kit and its club together
-- (a composite foreign key), so the database holds an asset to its kit's club;
-- deleting the club deletes its kit and its assets.
--
-- Both tables join row-level security with the pilot's own fail-closed policy
-- (familista_rls_club_ok("clubId"), both ways), enforced from this migration on
-- (Stage 4). Every path to them is an authenticated club request.
--
-- Forward-only and additive.

-- CreateEnum
CREATE TYPE "DesignBrandAssetKind" AS ENUM ('CREST', 'SPONSOR', 'MARK');

-- CreateTable
CREATE TABLE "DesignBrandKit" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "colours" JSONB NOT NULL DEFAULT '[]',
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignBrandKit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignBrandAsset" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "kitId" TEXT NOT NULL,
    "kind" "DesignBrandAssetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "png" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignBrandAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesignBrandKit_clubId_key" ON "DesignBrandKit"("clubId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignBrandKit_id_clubId_key" ON "DesignBrandKit"("id", "clubId");

-- CreateIndex
CREATE INDEX "DesignBrandAsset_clubId_archivedAt_createdAt_idx" ON "DesignBrandAsset"("clubId", "archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "DesignBrandAsset_kitId_idx" ON "DesignBrandAsset"("kitId");

-- AddForeignKey
ALTER TABLE "DesignBrandKit" ADD CONSTRAINT "DesignBrandKit_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignBrandAsset" ADD CONSTRAINT "DesignBrandAsset_kitId_clubId_fkey" FOREIGN KEY ("kitId", "clubId") REFERENCES "DesignBrandKit"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The shape of what is kept, in the database itself.
ALTER TABLE "DesignBrandKit" ADD CONSTRAINT "DesignBrandKit_shape" CHECK (
  jsonb_typeof("colours") = 'array' AND jsonb_array_length("colours") <= 24
);
ALTER TABLE "DesignBrandAsset" ADD CONSTRAINT "DesignBrandAsset_shape" CHECK (
  "width" BETWEEN 1 AND 1024 AND "height" BETWEEN 1 AND 1024
  AND "bytes" = octet_length("png") AND "bytes" BETWEEN 8 AND 4194304
  AND "sha256" ~ '^[0-9a-f]{64}$'
  AND char_length("name") BETWEEN 1 AND 80
  AND substring("png" from 1 for 8) = '\x89504e470d0a1a0a'::bytea
);

-- Row-level security: a club's kit and logos are its club's alone.
ALTER TABLE "DesignBrandKit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignBrandKit" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignBrandKit_club_isolation" ON "DesignBrandKit" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

ALTER TABLE "DesignBrandAsset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignBrandAsset" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignBrandAsset_club_isolation" ON "DesignBrandAsset" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
