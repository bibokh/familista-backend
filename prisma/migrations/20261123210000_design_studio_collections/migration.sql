-- Design Studio M3b — a club's collections: its designs gathered as one kit
-- ─────────────────────────────────────────────────────────────────────────────
-- DesignCollection gathers a club's designs across garments and colourways (a
-- season's home kit: shirt, shorts and socks), and names by default the roster
-- it is made for. DesignCollectionItem is one design in its place. An item names
-- its collection and its project each together with the club (composite
-- foreign keys), so the database itself holds every item to one club: no
-- collection can gather another club's design, whatever the request says. A
-- roster a collection names is its own club's, held by a trigger (on the system
-- path too); deleting the roster clears it.
--
-- Both tables join row-level security with the pilot's own fail-closed policy
-- (familista_rls_club_ok("clubId"), both ways), enforced from this migration on
-- (Stage 4). Every path to them is an authenticated club request.
--
-- Forward-only and additive.

-- CreateEnum
CREATE TYPE "DesignCollectionRole" AS ENUM ('HOME', 'AWAY', 'THIRD', 'GOALKEEPER', 'TRAINING', 'OTHER');

-- CreateTable
CREATE TABLE "DesignCollection" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "season" TEXT,
    "rosterId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "archivedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignCollectionItem" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "role" "DesignCollectionRole" NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "DesignCollectionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignCollection_clubId_archivedAt_updatedAt_idx" ON "DesignCollection"("clubId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "DesignCollection_rosterId_idx" ON "DesignCollection"("rosterId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignCollection_id_clubId_key" ON "DesignCollection"("id", "clubId");

-- CreateIndex
CREATE INDEX "DesignCollectionItem_clubId_idx" ON "DesignCollectionItem"("clubId");

-- CreateIndex
CREATE INDEX "DesignCollectionItem_projectId_idx" ON "DesignCollectionItem"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignCollectionItem_collectionId_position_key" ON "DesignCollectionItem"("collectionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "DesignCollectionItem_collectionId_projectId_key" ON "DesignCollectionItem"("collectionId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignProject_id_clubId_key" ON "DesignProject"("id", "clubId");

-- AddForeignKey
ALTER TABLE "DesignCollection" ADD CONSTRAINT "DesignCollection_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignCollection" ADD CONSTRAINT "DesignCollection_rosterId_fkey" FOREIGN KEY ("rosterId") REFERENCES "DesignRoster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignCollectionItem" ADD CONSTRAINT "DesignCollectionItem_collectionId_clubId_fkey" FOREIGN KEY ("collectionId", "clubId") REFERENCES "DesignCollection"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignCollectionItem" ADD CONSTRAINT "DesignCollectionItem_projectId_clubId_fkey" FOREIGN KEY ("projectId", "clubId") REFERENCES "DesignProject"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- The shape of what is kept, in the database itself.
ALTER TABLE "DesignCollection" ADD CONSTRAINT "DesignCollection_shape" CHECK (
  char_length("name") BETWEEN 1 AND 80
  AND ("season" IS NULL OR char_length("season") BETWEEN 1 AND 20)
  AND "version" >= 1
);
ALTER TABLE "DesignCollectionItem" ADD CONSTRAINT "DesignCollectionItem_shape" CHECK ("position" BETWEEN 0 AND 11);

-- A roster a collection names is its own club's. Asked in the writer's own context: under a club's, row-level security
-- hides every other club's roster, so naming one is refused; on the system path, the clubs are compared.
CREATE FUNCTION public.familista_design_collection_roster_club() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."rosterId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "DesignRoster" r WHERE r."id" = NEW."rosterId" AND r."clubId" = NEW."clubId"
  ) THEN
    RAISE EXCEPTION 'DesignCollection_roster_club: a collection names a roster of its own club only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "DesignCollection_roster_club" BEFORE INSERT OR UPDATE OF "rosterId", "clubId" ON "DesignCollection"
  FOR EACH ROW EXECUTE FUNCTION public.familista_design_collection_roster_club();

-- Row-level security: a club's collections and their items are its club's alone.
ALTER TABLE "DesignCollection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignCollection" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignCollection_club_isolation" ON "DesignCollection" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

ALTER TABLE "DesignCollectionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DesignCollectionItem" FORCE ROW LEVEL SECURITY;
CREATE POLICY "DesignCollectionItem_club_isolation" ON "DesignCollectionItem" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
