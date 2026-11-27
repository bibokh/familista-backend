-- Design Studio M3 — a club's team rosters: the names, numbers and sizes a kit is made for
-- ─────────────────────────────────────────────────────────────────────────────
-- A design keeps nobody's data (a roster layer is a placeholder). DesignRoster
-- keeps, for a club, only what printing its kit needs: per entry the name to
-- print, the number, a size per garment form and how many sets, as
-- public/product-design/pd-roster.js validates them on the server and in the
-- editor alike. `version` is the concurrency token every save names, so two
-- people editing one roster cannot overwrite each other unseen.
--
-- The table joins row-level security with the pilot's own fail-closed policy
-- (familista_rls_club_ok("clubId"), both ways), enforced from this migration on
-- (Stage 4). Every path to it is an authenticated club request.
--
-- Forward-only and additive.

-- CreateTable
CREATE TABLE "DesignRoster" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "entries" JSONB NOT NULL DEFAULT '[]',
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignRoster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesignRoster_id_clubId_key" ON "DesignRoster"("id", "clubId");

-- CreateIndex
CREATE INDEX "DesignRoster_clubId_archivedAt_updatedAt_idx" ON "DesignRoster"("clubId", "archivedAt", "updatedAt");

-- AddForeignKey
ALTER TABLE "DesignRoster" ADD CONSTRAINT "DesignRoster_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The shape of what is kept, in the database itself.
ALTER TABLE "DesignRoster" ADD CONSTRAINT "DesignRoster_shape" CHECK (
  jsonb_typeof("entries") = 'array' AND jsonb_array_length("entries") <= 150
  AND "entryCount" = jsonb_array_length("entries")
  AND "version" >= 1
  AND char_length("name") BETWEEN 1 AND 80
);

-- Row-level security: a club's rosters are its club's alone.
ALTER TABLE "DesignRoster" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignRoster" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignRoster_club_isolation" ON "DesignRoster" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
