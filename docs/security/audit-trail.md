# Audit trail — append-only evidence (Cyber Defense R9)

The rows that prove what happened on the platform cannot be rewritten or erased
by the application. PostgreSQL itself refuses it, through the triggers in
`prisma/migrations/20261003100000_audit_append_only/migration.sql`.

| Table | What it holds | What the database allows |
|---|---|---|
| `SecurityAuditEvent` | the hash-chained audit trail (`src/security/audit-chain.service.ts`) | INSERT only |
| `AIAudit` | the decision engine's audit log | INSERT only |
| `DeviceSecurityEvent` | device and camera security events | INSERT only |
| `SecurityEvent` | the security event log (logins, lockouts, approvals…) | INSERT; DELETE only of rows older than 90 days |
| `AiEgressRecord` | one row per AI Gateway call (Batch 5, R3) | INSERT; one UPDATE from `STARTED` to a final outcome, changing only the outcome columns |

`TRUNCATE` is refused on all five. A refused statement fails with SQLSTATE
`42501` (insufficient privilege) and a message naming the table.

## Retention

The retention worker (`src/workers/retention.worker.ts`) purges `SecurityEvent`
rows by policy. The database refuses to delete one younger than 90 days, and
the worker clamps its cutoff to the same floor (`MIN_RETENTION_DAYS`), so a
shorter policy purges what it may instead of failing. `SecurityAuditEvent` is
never purged by the worker (`PROTECTED_ENTITIES`).

## What is deliberately not frozen

Logs whose rows cascade from a parent — `MembershipAuditLog` (club),
`PlayerAuditLog` (player), `MatchAuditLog` (match), `WhiteLabelAudit` (config),
and the `SET NULL` relations on `PlatformAuditLog` and `FranchiseAudit` — stay
mutable. Deleting a club and erasing a person's data must keep working; those
logs are operational history, and the security evidence above is what proves
it happened.

## A purge beyond these rules (owner-only)

There is no application path. It is a reviewed change, applied by the platform
owner, and the change itself is the record:

1. Write a migration that names the table, the rows (by an explicit `WHERE`)
   and the reason, wraps the deletion between `ALTER TABLE … DISABLE TRIGGER
   "<table>_append_only"` and `ENABLE TRIGGER`, in one transaction.
2. Open it as a pull request; it is reviewed and merged like any change, and
   runs through CI and the deploy gate.
3. Verify the chain afterwards: `verifyAuditChainComplete` for each club whose
   `SecurityAuditEvent` rows were touched (a chain purge needs a re-anchor and
   is not supported by this procedure).

Disabling a trigger needs the table owner's rights; the migration runs with the
same role that created the trigger, and the history in `_prisma_migrations`
keeps it.

## Evidence

- `tests/audit-append-only.integration.test.ts` — on real PostgreSQL (CI step
  "Audit evidence append-only"): updates, deletes and truncates refused, a
  90-day-old security event purgeable, an egress record completed once, the
  hash chain still verifying, and a club still deletable.
- Posture control `db-audit-append-only` (required).
