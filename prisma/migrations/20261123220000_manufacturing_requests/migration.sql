-- Manufacturing M4 — owner-brokered quotations and orders
-- ─────────────────────────────────────────────────────────────────────────────
-- Until real factories are signed (the Owner's decision of 23 November 2026), a
-- supplier is a record the Platform Owner creates and verifies, not an account.
-- A club requests a quotation for a collection and a roster; the request holds a
-- frozen specification (each design at its saved revision and hash, the roster's
-- names, numbers and sizes). The Owner records the quotations real suppliers
-- give, with the supplier's own reference and how each was received; the club
-- accepts one; the Owner tracks the order to delivery. Nothing here moves money.
--
-- What the database holds, whatever the application does:
--   · only a VERIFIED supplier's quotation is ever published or accepted;
--   · a request's specification never changes once submitted;
--   · its history (ManufacturingRequestEvent) is never changed or removed;
--   · a quotation and an event name their request and club together
--     (composite keys), so neither can be filed under another club;
--   · requests, quotations and events are under row-level security with the
--     pilot's fail-closed policy, enforced from this migration on (Stage 4).
--     ManufacturingSupplier is platform data with no club: it is reached only on
--     the Platform Owner's routes (the system path), and a club sees a verified
--     supplier's name and country on a quotation, never its row.
--
-- Forward-only and additive.

-- CreateEnum
CREATE TYPE "ManufacturingSupplierStatus" AS ENUM ('PROSPECT', 'VERIFIED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ManufacturingRequestStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'QUOTED', 'ACCEPTED', 'ORDERED', 'IN_PRODUCTION', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'DECLINED', 'REFUSED');

-- CreateEnum
CREATE TYPE "ManufacturingQuoteStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ACCEPTED', 'SUPERSEDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ManufacturingActorKind" AS ENUM ('CLUB', 'OWNER', 'SUPPLIER');

-- CreateTable
CREATE TABLE "ManufacturingSupplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "city" TEXT,
    "website" TEXT,
    "contactEmail" TEXT,
    "forms" TEXT[],
    "methods" TEXT[],
    "minOrderSets" INTEGER,
    "leadTimeDays" INTEGER,
    "status" "ManufacturingSupplierStatus" NOT NULL DEFAULT 'PROSPECT',
    "verificationNote" TEXT,
    "verifiedAt" TIMESTAMPTZ(3),
    "verifiedById" TEXT,
    "portalWorkspaceId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManufacturingSupplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingRequest" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "collectionId" TEXT,
    "status" "ManufacturingRequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "spec" JSONB NOT NULL,
    "setsTotal" INTEGER NOT NULL,
    "clubNote" TEXT,
    "neededBy" DATE,
    "acceptedQuoteId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManufacturingRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingRequestEvent" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" "ManufacturingRequestStatus",
    "toStatus" "ManufacturingRequestStatus" NOT NULL,
    "actorKind" "ManufacturingActorKind" NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManufacturingRequestEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManufacturingQuote" (
    "id" TEXT NOT NULL,
    "clubId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "ManufacturingQuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL,
    "totalMinor" INTEGER NOT NULL,
    "lines" JSONB NOT NULL DEFAULT '[]',
    "leadTimeDays" INTEGER NOT NULL,
    "validUntil" DATE NOT NULL,
    "supplierReference" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManufacturingQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ManufacturingSupplier_status_idx" ON "ManufacturingSupplier"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingRequest_acceptedQuoteId_key" ON "ManufacturingRequest"("acceptedQuoteId");

-- CreateIndex
CREATE INDEX "ManufacturingRequest_clubId_status_updatedAt_idx" ON "ManufacturingRequest"("clubId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "ManufacturingRequest_status_updatedAt_idx" ON "ManufacturingRequest"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ManufacturingRequest_collectionId_idx" ON "ManufacturingRequest"("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ManufacturingRequest_id_clubId_key" ON "ManufacturingRequest"("id", "clubId");

-- CreateIndex
CREATE INDEX "ManufacturingRequestEvent_requestId_createdAt_idx" ON "ManufacturingRequestEvent"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "ManufacturingRequestEvent_clubId_idx" ON "ManufacturingRequestEvent"("clubId");

-- CreateIndex
CREATE INDEX "ManufacturingQuote_requestId_idx" ON "ManufacturingQuote"("requestId");

-- CreateIndex
CREATE INDEX "ManufacturingQuote_supplierId_idx" ON "ManufacturingQuote"("supplierId");

-- CreateIndex
CREATE INDEX "ManufacturingQuote_clubId_idx" ON "ManufacturingQuote"("clubId");

-- AddForeignKey
ALTER TABLE "ManufacturingRequest" ADD CONSTRAINT "ManufacturingRequest_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingRequest" ADD CONSTRAINT "ManufacturingRequest_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "DesignCollection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingRequestEvent" ADD CONSTRAINT "ManufacturingRequestEvent_requestId_clubId_fkey" FOREIGN KEY ("requestId", "clubId") REFERENCES "ManufacturingRequest"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingQuote" ADD CONSTRAINT "ManufacturingQuote_requestId_clubId_fkey" FOREIGN KEY ("requestId", "clubId") REFERENCES "ManufacturingRequest"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManufacturingQuote" ADD CONSTRAINT "ManufacturingQuote_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "ManufacturingSupplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The shape of what is kept, in the database itself.
ALTER TABLE "ManufacturingSupplier" ADD CONSTRAINT "ManufacturingSupplier_shape" CHECK (
  char_length("name") BETWEEN 1 AND 120 AND "country" ~ '^[A-Z]{2}$'
  AND ("minOrderSets" IS NULL OR "minOrderSets" BETWEEN 1 AND 100000)
  AND ("leadTimeDays" IS NULL OR "leadTimeDays" BETWEEN 1 AND 365)
  AND "forms" <@ ARRAY['top', 'shorts', 'socks']::text[]
  AND "methods" <@ ARRAY['SUBLIMATION', 'SCREEN_PRINT', 'EMBROIDERY', 'HEAT_TRANSFER']::text[]
  AND ("status" <> 'VERIFIED' OR ("verificationNote" IS NOT NULL AND char_length("verificationNote") >= 10 AND "verifiedAt" IS NOT NULL AND "verifiedById" IS NOT NULL))
  AND "version" >= 1
);
ALTER TABLE "ManufacturingRequest" ADD CONSTRAINT "ManufacturingRequest_shape" CHECK (
  jsonb_typeof("spec") = 'object' AND "setsTotal" BETWEEN 1 AND 100000 AND "version" >= 1
  AND ("clubNote" IS NULL OR char_length("clubNote") <= 1000)
);
ALTER TABLE "ManufacturingQuote" ADD CONSTRAINT "ManufacturingQuote_shape" CHECK (
  "currency" ~ '^[A-Z]{3}$' AND "totalMinor" > 0 AND "leadTimeDays" BETWEEN 1 AND 365
  AND char_length("supplierReference") BETWEEN 1 AND 80 AND char_length("evidence") BETWEEN 10 AND 500
  AND jsonb_typeof("lines") = 'array'
  AND ("status" = 'DRAFT' OR "publishedAt" IS NOT NULL)
);

-- Only a verified supplier's quotation reaches a club. Asked of the supplier's row as it is when the quotation is
-- published or accepted, so suspending a supplier stops its next quotation, on every path.
CREATE FUNCTION public.familista_manufacturing_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('PUBLISHED', 'ACCEPTED')
     AND (TG_OP = 'INSERT' OR OLD."status" IS DISTINCT FROM NEW."status")
     AND NOT EXISTS (SELECT 1 FROM "ManufacturingSupplier" s WHERE s."id" = NEW."supplierId" AND s."status" = 'VERIFIED') THEN
    RAISE EXCEPTION 'ManufacturingQuote_verified_supplier: only a verified supplier''s quotation reaches a club' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" <> 'DRAFT' AND (
       NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."totalMinor" IS DISTINCT FROM OLD."totalMinor"
       OR NEW."lines" IS DISTINCT FROM OLD."lines" OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
       OR NEW."leadTimeDays" IS DISTINCT FROM OLD."leadTimeDays" OR NEW."validUntil" IS DISTINCT FROM OLD."validUntil"
       OR NEW."supplierReference" IS DISTINCT FROM OLD."supplierReference" OR NEW."evidence" IS DISTINCT FROM OLD."evidence") THEN
    RAISE EXCEPTION 'ManufacturingQuote_frozen: a published quotation is never edited' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ManufacturingQuote_guard" BEFORE INSERT OR UPDATE ON "ManufacturingQuote"
  FOR EACH ROW EXECUTE FUNCTION public.familista_manufacturing_quote_guard();

-- A request's specification and club never change once submitted.
CREATE FUNCTION public.familista_manufacturing_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."spec" IS DISTINCT FROM OLD."spec" OR NEW."clubId" IS DISTINCT FROM OLD."clubId" OR NEW."setsTotal" IS DISTINCT FROM OLD."setsTotal"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById" OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'ManufacturingRequest_frozen: a submitted specification is never changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ManufacturingRequest_guard" BEFORE UPDATE ON "ManufacturingRequest"
  FOR EACH ROW EXECUTE FUNCTION public.familista_manufacturing_request_guard();

-- A request's history is never changed or removed: no UPDATE, no DELETE unless its request is already gone (the cascade
-- of a deleted club), no TRUNCATE.
CREATE FUNCTION public.familista_manufacturing_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "ManufacturingRequest" r WHERE r."id" = OLD."requestId") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ManufacturingRequestEvent_immutable: a request''s history is never changed or removed' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "ManufacturingRequestEvent_immutable" BEFORE UPDATE OR DELETE ON "ManufacturingRequestEvent"
  FOR EACH ROW EXECUTE FUNCTION public.familista_manufacturing_event_guard();
CREATE TRIGGER "ManufacturingRequestEvent_no_truncate" BEFORE TRUNCATE ON "ManufacturingRequestEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION public.familista_manufacturing_event_guard();

-- Row-level security: a club's requests, quotations and their history are its club's alone.
ALTER TABLE "ManufacturingRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManufacturingRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ManufacturingRequest_club_isolation" ON "ManufacturingRequest" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

ALTER TABLE "ManufacturingRequestEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManufacturingRequestEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ManufacturingRequestEvent_club_isolation" ON "ManufacturingRequestEvent" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));

ALTER TABLE "ManufacturingQuote" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ManufacturingQuote" FORCE ROW LEVEL SECURITY;
CREATE POLICY "ManufacturingQuote_club_isolation" ON "ManufacturingQuote" FOR ALL
  USING (public.familista_rls_club_ok("clubId"))
  WITH CHECK (public.familista_rls_club_ok("clubId"));
