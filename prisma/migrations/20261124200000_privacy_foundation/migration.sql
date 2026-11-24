-- Familista — privacy foundation (P1): people's names apart from frozen manufacturing records; minors.
--
-- A request's specification is frozen (ManufacturingRequest_guard): its designs, sizes and sets never change, so a
-- supplier and the club can rely on it. Until now it also held the roster's names, which could therefore never be
-- erased. From here the specification keeps each entry's position, number, sizes and sets, and the names live in
-- ManufacturingRequestPerson, one row per entry, where a name can only ever be erased (KEPT -> ERASED), never changed.
-- A name is not kept at all (WITHHELD) where the roster includes minors and no club administrator attested a
-- guardian's consent when the request was sent.

CREATE TYPE "ManufacturingPersonState" AS ENUM ('KEPT', 'WITHHELD', 'ERASED');

ALTER TABLE "DesignRoster" ADD COLUMN "includesMinors" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ManufacturingRequest" ADD COLUMN "minors" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ManufacturingRequest" ADD COLUMN "minorsConsentAt" TIMESTAMPTZ(3);
ALTER TABLE "ManufacturingRequest" ADD COLUMN "minorsConsentById" TEXT;
ALTER TABLE "ManufacturingRequest" ADD CONSTRAINT "ManufacturingRequest_minors_consent" CHECK (
  ("minorsConsentAt" IS NULL AND "minorsConsentById" IS NULL) OR ("minors" AND "minorsConsentAt" IS NOT NULL AND "minorsConsentById" IS NOT NULL)
);

CREATE TABLE "ManufacturingRequestPerson" (
  "id"        TEXT NOT NULL,
  "clubId"    TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "position"  INTEGER NOT NULL,
  "name"      TEXT,
  "state"     "ManufacturingPersonState" NOT NULL DEFAULT 'KEPT',
  "erasedAt"  TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManufacturingRequestPerson_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManufacturingRequestPerson_shape" CHECK (
    "position" >= 0 AND
    (("state" = 'KEPT' AND "name" IS NOT NULL AND char_length("name") BETWEEN 1 AND 40 AND "erasedAt" IS NULL)
     OR ("state" = 'WITHHELD' AND "name" IS NULL AND "erasedAt" IS NULL)
     OR ("state" = 'ERASED' AND "name" IS NULL AND "erasedAt" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "ManufacturingRequestPerson_requestId_position_key" ON "ManufacturingRequestPerson"("requestId", "position");
CREATE INDEX "ManufacturingRequestPerson_clubId_idx" ON "ManufacturingRequestPerson"("clubId");
ALTER TABLE "ManufacturingRequestPerson" ADD CONSTRAINT "ManufacturingRequestPerson_requestId_clubId_fkey"
  FOREIGN KEY ("requestId", "clubId") REFERENCES "ManufacturingRequest"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- A kept name may be erased, and that is the only change a row ever takes; rows go only with their request.
CREATE FUNCTION public.familista_manufacturing_person_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "ManufacturingRequest" r WHERE r."id" = OLD."requestId") THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'ManufacturingRequestPerson_erase_only: a name is erased, never removed with its row' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'ManufacturingRequestPerson_erase_only: a name is erased, never removed with its row' USING ERRCODE = '23514';
  END IF;
  IF OLD."state" = 'KEPT' AND NEW."state" = 'ERASED' AND NEW."name" IS NULL AND NEW."erasedAt" IS NOT NULL
     AND NEW."id" = OLD."id" AND NEW."clubId" = OLD."clubId" AND NEW."requestId" = OLD."requestId" AND NEW."position" = OLD."position"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ManufacturingRequestPerson_erase_only: a kept name can only be erased' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "ManufacturingRequestPerson_erase_only" BEFORE UPDATE OR DELETE ON "ManufacturingRequestPerson"
  FOR EACH ROW EXECUTE FUNCTION public.familista_manufacturing_person_guard();
CREATE TRIGGER "ManufacturingRequestPerson_no_truncate" BEFORE TRUNCATE ON "ManufacturingRequestPerson"
  FOR EACH STATEMENT EXECUTE FUNCTION public.familista_manufacturing_person_guard();

ALTER TABLE "ManufacturingRequestPerson" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManufacturingRequestPerson" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ManufacturingRequestPerson_club_isolation" ON "ManufacturingRequestPerson" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

-- Requests sent before this migration: their names move out of the frozen specification into the new table. The
-- freeze is lifted for this one statement and restored at once; nothing else in a specification changes.
INSERT INTO "ManufacturingRequestPerson" ("id", "clubId", "requestId", "position", "name", "state")
SELECT gen_random_uuid()::text, r."clubId", r."id", (e.ord - 1)::int, NULLIF(btrim(e.value->>'name'), ''),
       CASE WHEN NULLIF(btrim(e.value->>'name'), '') IS NULL THEN 'WITHHELD'::"ManufacturingPersonState" ELSE 'KEPT'::"ManufacturingPersonState" END
FROM "ManufacturingRequest" r, jsonb_array_elements(r."spec"->'entries') WITH ORDINALITY AS e(value, ord);

ALTER TABLE "ManufacturingRequest" DISABLE TRIGGER "ManufacturingRequest_guard";
UPDATE "ManufacturingRequest" r SET "spec" = jsonb_set(r."spec", '{entries}', COALESCE((
  SELECT jsonb_agg((e.value - 'name') || jsonb_build_object('position', (e.ord - 1)::int) ORDER BY e.ord)
  FROM jsonb_array_elements(r."spec"->'entries') WITH ORDINALITY AS e(value, ord)), '[]'::jsonb))
WHERE r."spec" ? 'entries';
ALTER TABLE "ManufacturingRequest" ENABLE TRIGGER "ManufacturingRequest_guard";
