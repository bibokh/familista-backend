-- P7: manufacturing quotations are non-binding offers with the supplier's own conditions.
--
-- A quotation now carries the conditions its supplier attached (what the price includes or excludes, samples, artwork
-- approval), recorded by the Platform Owner with the quotation and shown to the club or creator. Like every other term of
-- a published quotation, they are never edited once published: the guard below is the original one with "terms" added.

ALTER TABLE "ManufacturingQuote" ADD COLUMN "terms" TEXT;
ALTER TABLE "ManufacturingQuote" ADD CONSTRAINT "ManufacturingQuote_terms_length" CHECK ("terms" IS NULL OR char_length("terms") BETWEEN 1 AND 1000);

CREATE OR REPLACE FUNCTION public.familista_manufacturing_quote_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
       OR NEW."supplierReference" IS DISTINCT FROM OLD."supplierReference" OR NEW."evidence" IS DISTINCT FROM OLD."evidence"
       OR NEW."terms" IS DISTINCT FROM OLD."terms") THEN
    RAISE EXCEPTION 'ManufacturingQuote_frozen: a published quotation is never edited' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
