-- Cyber Defense · Batch 6 (R9) — the audit evidence is append-only
--
-- Until now the application's own database role could UPDATE or DELETE the
-- rows that are supposed to prove what happened. These triggers make the
-- database itself refuse it, whatever code — or whoever holding the
-- application's credentials — asks:
--
--   SecurityAuditEvent   the hash-chained audit trail. Never updated, never
--                        deleted, never truncated.
--   AIAudit              the decision engine's audit log. Same.
--   DeviceSecurityEvent  device security events. Same.
--   SecurityEvent        never updated. A row may be deleted only once it is
--                        older than 90 days — the retention worker's purge —
--                        so recent evidence cannot be erased.
--   AiEgressRecord       the AI Gateway's per-call record (Batch 5). Written
--                        STARTED before a call and completed once after it:
--                        only that one transition, changing only the outcome
--                        columns. Never deleted.
--
-- TRUNCATE is refused on all five. Tables whose rows cascade from a parent
-- (membership, player, match and club audit logs) are deliberately NOT here:
-- deleting a club or erasing a person must still work, and those logs are not
-- the security evidence trail.
--
-- A purge beyond these rules is an owner-only procedure (docs/security/
-- audit-trail.md): a migration or a superuser session that drops the trigger,
-- which is itself recorded in the migration history.

CREATE OR REPLACE FUNCTION familista_audit_refuse() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'familista: % on "%" is refused — audit evidence is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE OR REPLACE FUNCTION familista_security_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."createdAt" < (now() AT TIME ZONE 'UTC') - interval '90 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'familista: % on "SecurityEvent" is refused — only rows older than 90 days may be purged', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE OR REPLACE FUNCTION familista_ai_egress_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."outcome" = 'STARTED'
     AND NEW."outcome" <> 'STARTED'
     AND NEW."id" = OLD."id"
     AND NEW."caller" = OLD."caller"
     AND NEW."purpose" = OLD."purpose"
     AND NEW."clubId" IS NOT DISTINCT FROM OLD."clubId"
     AND NEW."model" IS NOT DISTINCT FROM OLD."model"
     AND NEW."provider" IS NOT DISTINCT FROM OLD."provider"
     AND NEW."dataClasses" = OLD."dataClasses"
     AND NEW."pseudonymised" = OLD."pseudonymised"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'familista: % on "AiEgressRecord" is refused — a record is completed once and never changed or deleted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- SecurityAuditEvent
CREATE TRIGGER "SecurityAuditEvent_append_only"
  BEFORE UPDATE OR DELETE ON "SecurityAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION familista_audit_refuse();
CREATE TRIGGER "SecurityAuditEvent_no_truncate"
  BEFORE TRUNCATE ON "SecurityAuditEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION familista_audit_refuse();

-- AIAudit
CREATE TRIGGER "AIAudit_append_only"
  BEFORE UPDATE OR DELETE ON "AIAudit"
  FOR EACH ROW EXECUTE FUNCTION familista_audit_refuse();
CREATE TRIGGER "AIAudit_no_truncate"
  BEFORE TRUNCATE ON "AIAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION familista_audit_refuse();

-- DeviceSecurityEvent
CREATE TRIGGER "DeviceSecurityEvent_append_only"
  BEFORE UPDATE OR DELETE ON "DeviceSecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION familista_audit_refuse();
CREATE TRIGGER "DeviceSecurityEvent_no_truncate"
  BEFORE TRUNCATE ON "DeviceSecurityEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION familista_audit_refuse();

-- SecurityEvent
CREATE TRIGGER "SecurityEvent_append_only"
  BEFORE UPDATE OR DELETE ON "SecurityEvent"
  FOR EACH ROW EXECUTE FUNCTION familista_security_event_guard();
CREATE TRIGGER "SecurityEvent_no_truncate"
  BEFORE TRUNCATE ON "SecurityEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION familista_audit_refuse();

-- AiEgressRecord
CREATE TRIGGER "AiEgressRecord_append_only"
  BEFORE UPDATE OR DELETE ON "AiEgressRecord"
  FOR EACH ROW EXECUTE FUNCTION familista_ai_egress_guard();
CREATE TRIGGER "AiEgressRecord_no_truncate"
  BEFORE TRUNCATE ON "AiEgressRecord"
  FOR EACH STATEMENT EXECUTE FUNCTION familista_audit_refuse();
