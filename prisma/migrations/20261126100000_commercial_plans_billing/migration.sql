-- Premium plans (P5) and the provider-independent billing foundation (P6).
--
-- A plan is configuration the Platform Owner writes: which Design Studio features it includes, its limits, and — when
-- it has one — the price it will be offered at. Nothing here invents a price, charges anyone or talks to a payment
-- provider. A tenant (one club or one creator) holds at most one live subscription; the subscription says which plan its
-- features come from. A paid plan's subscription stays PENDING with an OPEN invoice until a payment provider reports the
-- payment; the Owner can also grant a plan outright (no invoice).
--
-- The database holds the money rules, not only the application:
--   · an invoice's amounts and lines never change once it exists, and PAID and VOID are final;
--   · an invoice becomes PAID only when a SUCCEEDED payment event for exactly its total and currency is recorded first —
--     so a successful payment cannot be invented by writing a status;
--   · a payment event is never changed or removed, and one provider event is recorded once (its provider id is unique);
--   · every subscription, invoice and payment event belongs to exactly one owner, under row-level security by either.
--
-- Separate from the platform's older club billing tables (BillingAccount, InvoiceDraft; Phase J, architecture only, one
-- club per account, seeded placeholder tiers): those stay as they are and are not read here.

CREATE TYPE "PlanAudience" AS ENUM ('CREATOR', 'CLUB');
CREATE TYPE "PlanInterval" AS ENUM ('MONTH', 'YEAR');
CREATE TYPE "CommercialSubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'CANCELED', 'EXPIRED');
CREATE TYPE "CommercialSubscriptionSource" AS ENUM ('SELF', 'OWNER_GRANT');
CREATE TYPE "CommercialInvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');
CREATE TYPE "PaymentEventStatus" AS ENUM ('SUCCEEDED', 'FAILED');

CREATE TABLE "CommercialPlan" (
  "id"             TEXT NOT NULL,
  "key"            TEXT NOT NULL,
  "audience"       "PlanAudience" NOT NULL,
  "name"           TEXT NOT NULL,
  "description"    TEXT,
  "features"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "maxProjects"    INTEGER,
  "maxCollections" INTEGER,
  "maxShares"      INTEGER,
  "priceMinor"     INTEGER,
  "currency"       TEXT,
  "interval"       "PlanInterval",
  "isDefault"      BOOLEAN NOT NULL DEFAULT false,
  "active"         BOOLEAN NOT NULL DEFAULT true,
  "sortOrder"      INTEGER NOT NULL DEFAULT 0,
  "createdById"    TEXT NOT NULL,
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialPlan_shape" CHECK (
    "key" ~ '^[a-z0-9][a-z0-9-]{1,39}$' AND char_length("name") BETWEEN 1 AND 60
    AND ("maxProjects" IS NULL OR "maxProjects" BETWEEN 1 AND 100000)
    AND ("maxCollections" IS NULL OR "maxCollections" BETWEEN 1 AND 100000)
    AND ("maxShares" IS NULL OR "maxShares" BETWEEN 0 AND 1000)
    AND (("priceMinor" IS NULL AND "currency" IS NULL AND "interval" IS NULL)
      OR ("priceMinor" BETWEEN 0 AND 100000000 AND "currency" ~ '^[A-Z]{3}$' AND "interval" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "CommercialPlan_key_key" ON "CommercialPlan"("key");
-- At most one default plan per audience among the active ones: what a tenant without a subscription has.
CREATE UNIQUE INDEX "CommercialPlan_default_key" ON "CommercialPlan"("audience") WHERE "isDefault" AND "active";
CREATE INDEX "CommercialPlan_audience_active_idx" ON "CommercialPlan"("audience", "active", "sortOrder");

CREATE TABLE "CommercialSubscription" (
  "id"                 TEXT NOT NULL,
  "clubId"             TEXT,
  "creatorId"          TEXT,
  "planId"             TEXT NOT NULL,
  "status"             "CommercialSubscriptionStatus" NOT NULL,
  "source"             "CommercialSubscriptionSource" NOT NULL,
  "currentPeriodStart" TIMESTAMPTZ(3),
  "currentPeriodEnd"   TIMESTAMPTZ(3),
  "cancelAtPeriodEnd"  BOOLEAN NOT NULL DEFAULT false,
  "canceledAt"         TIMESTAMPTZ(3),
  "providerRef"        TEXT,
  "note"               TEXT,
  "createdById"        TEXT NOT NULL,
  "createdAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialSubscription_one_owner" CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL)),
  CONSTRAINT "CommercialSubscription_shape" CHECK (
    ("status" <> 'ACTIVE' OR "currentPeriodStart" IS NOT NULL)
    AND ("currentPeriodEnd" IS NULL OR "currentPeriodStart" IS NULL OR "currentPeriodEnd" > "currentPeriodStart")
    AND ("status" <> 'CANCELED' OR "canceledAt" IS NOT NULL)
  )
);
-- One live subscription per tenant.
CREATE UNIQUE INDEX "CommercialSubscription_live_club_key" ON "CommercialSubscription"("clubId") WHERE "status" IN ('PENDING', 'ACTIVE') AND "clubId" IS NOT NULL;
CREATE UNIQUE INDEX "CommercialSubscription_live_creator_key" ON "CommercialSubscription"("creatorId") WHERE "status" IN ('PENDING', 'ACTIVE') AND "creatorId" IS NOT NULL;
CREATE UNIQUE INDEX "CommercialSubscription_id_clubId_key" ON "CommercialSubscription"("id", "clubId");
CREATE UNIQUE INDEX "CommercialSubscription_id_creatorId_key" ON "CommercialSubscription"("id", "creatorId");
CREATE INDEX "CommercialSubscription_status_idx" ON "CommercialSubscription"("status", "currentPeriodEnd");
ALTER TABLE "CommercialSubscription" ADD CONSTRAINT "CommercialSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CommercialPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommercialSubscription" ADD CONSTRAINT "CommercialSubscription_clubId_fkey" FOREIGN KEY ("clubId") REFERENCES "Club"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialSubscription" ADD CONSTRAINT "CommercialSubscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE SEQUENCE "CommercialInvoice_number_seq" START 1;
CREATE TABLE "CommercialInvoice" (
  "id"             TEXT NOT NULL,
  "number"         TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "clubId"         TEXT,
  "creatorId"      TEXT,
  "status"         "CommercialInvoiceStatus" NOT NULL DEFAULT 'OPEN',
  "currency"       TEXT NOT NULL,
  "subtotalMinor"  INTEGER NOT NULL,
  "taxMinor"       INTEGER,
  "totalMinor"     INTEGER NOT NULL,
  "lines"          JSONB NOT NULL,
  "periodStart"    TIMESTAMPTZ(3) NOT NULL,
  "periodEnd"      TIMESTAMPTZ(3) NOT NULL,
  "issuedAt"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt"         TIMESTAMPTZ(3),
  "voidedAt"       TIMESTAMPTZ(3),
  "createdAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommercialInvoice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommercialInvoice_one_owner" CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL)),
  CONSTRAINT "CommercialInvoice_shape" CHECK (
    "currency" ~ '^[A-Z]{3}$' AND "subtotalMinor" >= 0 AND ("taxMinor" IS NULL OR "taxMinor" >= 0)
    AND "totalMinor" = "subtotalMinor" + COALESCE("taxMinor", 0) AND "periodEnd" > "periodStart"
    AND ("status" = 'PAID') = ("paidAt" IS NOT NULL) AND ("status" = 'VOID') = ("voidedAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "CommercialInvoice_number_key" ON "CommercialInvoice"("number");
CREATE UNIQUE INDEX "CommercialInvoice_id_clubId_key" ON "CommercialInvoice"("id", "clubId");
CREATE UNIQUE INDEX "CommercialInvoice_id_creatorId_key" ON "CommercialInvoice"("id", "creatorId");
CREATE INDEX "CommercialInvoice_subscriptionId_idx" ON "CommercialInvoice"("subscriptionId");
CREATE INDEX "CommercialInvoice_status_idx" ON "CommercialInvoice"("status", "issuedAt");
ALTER TABLE "CommercialInvoice" ADD CONSTRAINT "CommercialInvoice_sub_club_fkey" FOREIGN KEY ("subscriptionId", "clubId") REFERENCES "CommercialSubscription"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CommercialInvoice" ADD CONSTRAINT "CommercialInvoice_sub_creator_fkey" FOREIGN KEY ("subscriptionId", "creatorId") REFERENCES "CommercialSubscription"("id", "creatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PaymentEvent" (
  "id"              TEXT NOT NULL,
  "invoiceId"       TEXT NOT NULL,
  "clubId"          TEXT,
  "creatorId"       TEXT,
  "provider"        TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "status"          "PaymentEventStatus" NOT NULL,
  "amountMinor"     INTEGER NOT NULL,
  "currency"        TEXT NOT NULL,
  "occurredAt"      TIMESTAMPTZ(3) NOT NULL,
  "receivedAt"      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentEvent_one_owner" CHECK (("clubId" IS NULL) <> ("creatorId" IS NULL)),
  CONSTRAINT "PaymentEvent_shape" CHECK ("amountMinor" >= 0 AND "currency" ~ '^[A-Z]{3}$' AND char_length("provider") BETWEEN 1 AND 40 AND char_length("providerEventId") BETWEEN 1 AND 200)
);
CREATE UNIQUE INDEX "PaymentEvent_provider_event_key" ON "PaymentEvent"("provider", "providerEventId");
CREATE INDEX "PaymentEvent_invoiceId_idx" ON "PaymentEvent"("invoiceId");
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_inv_club_fkey" FOREIGN KEY ("invoiceId", "clubId") REFERENCES "CommercialInvoice"("id", "clubId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_inv_creator_fkey" FOREIGN KEY ("invoiceId", "creatorId") REFERENCES "CommercialInvoice"("id", "creatorId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An invoice's amounts never change; PAID needs a recorded successful payment of exactly its total; PAID and VOID are final.
CREATE FUNCTION public.familista_commercial_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'OPEN' THEN RAISE EXCEPTION 'CommercialInvoice_open_first: an invoice is issued open' USING ERRCODE = '23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW."number" <> OLD."number" OR NEW."subscriptionId" <> OLD."subscriptionId" OR NEW."clubId" IS DISTINCT FROM OLD."clubId" OR NEW."creatorId" IS DISTINCT FROM OLD."creatorId"
     OR NEW."currency" <> OLD."currency" OR NEW."subtotalMinor" <> OLD."subtotalMinor" OR NEW."taxMinor" IS DISTINCT FROM OLD."taxMinor" OR NEW."totalMinor" <> OLD."totalMinor"
     OR NEW."lines" IS DISTINCT FROM OLD."lines" OR NEW."periodStart" <> OLD."periodStart" OR NEW."periodEnd" <> OLD."periodEnd" OR NEW."issuedAt" <> OLD."issuedAt" THEN
    RAISE EXCEPTION 'CommercialInvoice_frozen: an issued invoice never changes' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'OPEN' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'CommercialInvoice_final: a paid or void invoice is final' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'PAID' AND OLD."status" = 'OPEN' AND NOT EXISTS (
    SELECT 1 FROM "PaymentEvent" e WHERE e."invoiceId" = NEW."id" AND e."status" = 'SUCCEEDED' AND e."amountMinor" = NEW."totalMinor" AND e."currency" = NEW."currency"
  ) THEN
    RAISE EXCEPTION 'CommercialInvoice_unpaid: an invoice is paid only by a recorded successful payment of its total' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "CommercialInvoice_guard" BEFORE INSERT OR UPDATE ON "CommercialInvoice" FOR EACH ROW EXECUTE FUNCTION public.familista_commercial_invoice_guard();

CREATE FUNCTION public.familista_payment_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM "CommercialInvoice" i WHERE i."id" = OLD."invoiceId") THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'PaymentEvent_immutable: a payment event is never changed or removed' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "PaymentEvent_immutable" BEFORE UPDATE OR DELETE ON "PaymentEvent" FOR EACH ROW EXECUTE FUNCTION public.familista_payment_event_guard();
CREATE TRIGGER "PaymentEvent_no_truncate" BEFORE TRUNCATE ON "PaymentEvent" FOR EACH STATEMENT EXECUTE FUNCTION public.familista_payment_event_guard();

-- Row-level security: a tenant's subscription, invoices and payments are its own; the Owner reads them on the system path.
ALTER TABLE "CommercialSubscription" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommercialSubscription" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CommercialSubscription_tenant_isolation" ON "CommercialSubscription" FOR ALL
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER TABLE "CommercialInvoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommercialInvoice" FORCE ROW LEVEL SECURITY;
CREATE POLICY "CommercialInvoice_tenant_isolation" ON "CommercialInvoice" FOR ALL
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
ALTER TABLE "PaymentEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PaymentEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY "PaymentEvent_tenant_isolation" ON "PaymentEvent" FOR ALL
  USING (public.familista_rls_owner_ok("clubId", "creatorId")) WITH CHECK (public.familista_rls_owner_ok("clubId", "creatorId"));
