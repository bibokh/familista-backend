# Row-level security (Cyber Defense R14)

Club isolation is enforced by the application: tenant guards on every route id
(R2), and club filters in every service. This pilot adds a second, independent
check inside PostgreSQL, so a query that forgets its club filter cannot read or
change another club's rows on the protected tables.

**Stage 4 — enforced.** `20261006100000_rls_enforce` switches
`familista_rls_enforced()` on, after a guard that refuses (and stops the deploy)
unless every one of the 18 tables is forced under RLS with its policy.
PostgreSQL now refuses what the policies refuse. Stages 1–3 below are how it
got here; the rollback is at the end.

## What is protected

| Table | Reads | Writes | Why this shape |
|---|---|---|---|
| `PlayerInjury` (medical) | the player's club only | the player's club only | medical data belongs to one club |
| `VideoAsset` | the asset's club only; an asset with no club is system-only | the asset's club only | match and training video is private to a club |
| `Player` | open | own club only | the transfer market reads other clubs' players (public fields, `publicPlayerSelect`) |
| `Membership` | open | own club only | a user's own clubs and the staff market read across clubs |

Club-private tables (`20261005100000_rls_club_private_tables`): every row
belongs to exactly one club (`clubId NOT NULL`) and no legitimate path reads
them across clubs, so each is isolated both ways (`FOR ALL`, `USING` and
`WITH CHECK`), with the pilot's own policy function:

| Area | Tables |
|---|---|
| Health and biometrics (special category) | `BiochemicalSignal`, `HydrationEstimate`, `StressIndex`, `NeuromuscularLoad`, `TendonRiskEstimate` |
| Minors' safeguarding | `PlayerGuardianLink` |
| Player lifecycle | `PlayerContractRecord`, `PlayerEvaluationRecord`, `PlayerOnboardingStep` |
| Attendance | `TrainingAttendanceRecord`, `MatchAttendanceRecord` |
| Finance | `OperationsPayment` |
| Club operations | `ClubCalendarEntry` |
| Staff market (the club's private notes) | `StaffClubNote` |

The AI agent worker runs each job's deterministic handler in that job's own
club context (`runInClubContext(job.clubId, …)`), not on a system path: the
finance agent reads `OperationsPayment` as the club it works for.

`InjuryRecord`, `WorkloadRecord` and the other club tables are not covered
yet: some have no migration (the schema/migration drift tracked separately),
some are read across clubs by design (markets, competitions), and the list
grows table by table — `rlsPilotTables` in `posture-policy.json` is a ratchet
the security posture check holds against `RLS_PILOT_MODELS` and the
migrations.

## How it works

PostgreSQL reads two transaction-local settings:

| Setting | Values |
|---|---|
| `familista.rls_mode` | `club` — a request inside one club; `system` — an explicit, named path that acts across clubs |
| `familista.club_id` | the club, in `club` mode |

Anything else — no mode, an unknown mode, `club` without a club — sees nothing
and writes nothing. That is the fail-closed default.

The application sets them (`src/security/db-context.ts`, `src/security/rls-client.ts`):

- `authenticate` runs the rest of each request in the user's club context; a
  platform owner runs on the named `platform-owner` path.
- Every query on a pilot table runs in a transaction that first sets the two
  values (`set_config(..., true)`: they end with the transaction, so nothing
  leaks to the next user of a pooled connection). Inside `$transaction` they
  are set once, first.
- Paths that legitimately act across clubs call `runAsSystem('<reason>', …)`
  with a literal reason. Each reason is reviewed by name in
  `posture-policy.json` (`rlsSystemPaths`); an unreviewed one fails CI. Today:
  `platform-owner`, `transfer-settlement`, `staff-market-move`,
  `video-transcode`. An accepted invitation writes its membership in the
  inviting club's own context, not a system one.
- Backups, restores and their checks read under the system context
  (`PGOPTIONS` in `backup-config.ts`; `pg_dump --enable-row-security`).

A query runs when it is awaited, not when it is built, so it must be awaited
inside the context. Request handlers do so by construction.

## What it does not defend against

- **Arbitrary SQL.** Anyone who can run SQL as the application role can set
  `familista.rls_mode` themselves. The pilot defends against application bugs
  — a missing club filter — not against SQL injection (`no-unsafe-raw-sql`
  covers that). Closing it needs a separate, non-owner database role for the
  application: a production change.
- **A superuser connection.** PostgreSQL never applies policies to a
  superuser or a `BYPASSRLS` role. Render's database user is neither; the
  integration test runs as a role that is neither, deliberately.
- **Column-level exposure** of `Player` and `Membership`, whose reads stay
  open. Which columns other clubs see is the application's `publicPlayerSelect`.

## Rollout (owner decisions, in order)

Steps 1 and 2 are settings on the service, not made by this repository. Step 3
is the migration `20261006100000_rls_enforce`.

1. **Observe.** Set `DB_RLS_CONTEXT=observe` on the service. Behaviour does not
   change; every query on a pilot table that runs without a context logs
   `[rls] pilot table queried with no database context` once per model and
   operation. Run it through normal use, and give each reported path a club
   context or a named system path.
2. **Carry the context.** Set `DB_RLS_CONTEXT=on`. The application now sends
   its context on every pilot-table query; the database still does not
   enforce, so nothing is refused yet. Watch latency: each pilot-table query
   outside a transaction becomes a two-statement transaction.
3. **Enforce.** `20261006100000_rls_enforce`: a guard over the 18 tables, then
   ```sql
   CREATE OR REPLACE FUNCTION public.familista_rls_enforced() RETURNS boolean
     LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT true $$;
   ```

   `familista_rls_enforced()` is `IMMUTABLE`, so PostgreSQL folds its answer
   into the plan of every prepared statement. A pooled connection that planned
   a query before the switch keeps the old answer for that query until the
   connection is replaced. The switch — either way — therefore takes effect
   with fresh connections: the restart of the deploy that carries the
   migration does that. Running the migration by hand against a live service
   is not enough; restart the service after it. The integration test
   reconnects after every flip for the same reason.

### What changes in production at Stage 4

- **Behaviour.** A query on a protected table outside its club or a named
  system path reads no rows and cannot write; a cross-club insert is an error.
  Every path found by the Stage 4 audit already runs in a club context
  (`authenticate`), in its own row's club context (invitation acceptance, AI
  agent jobs, the staff demo fill across a session's authorised clubs) or on a
  named system path. Production reported no query without a context on the
  18 tables before the switch.
- **Latency.** None added by this step. The two-statement transaction per
  protected-table query outside a transaction has been paid since Stage 3
  (`DB_RLS_CONTEXT=on`). The policy itself is a comparison of `clubId` with a
  setting per row; on `PlayerInjury` it is a lookup of the player's club by
  primary key per row.
- **Backups** read under the system context (`PGOPTIONS`, `pg_dump
  --enable-row-security`) and keep every club's rows; the restore drill
  reads the same way.

### Rollback (Stage 4 → Stage 3)

Forward-only, through the same gates as any change; no manual database edit.

1. Copy `scripts/rls/rls-enforcement-off.sql` to
   `prisma/migrations/<timestamp>_rls_enforcement_off/migration.sql`.
2. In `src/cyber-defense/posture-policy.json`, move `db-row-level-security`
   from `requiredControls` back to `knownGaps` (CI refuses the rollback
   otherwise: a required control may not regress silently).
3. `node scripts/security-discover.js`, open the PR, let CI pass, merge.
4. The deploy starts a new instance, which runs the migration before it
   serves (`scripts/render-start.sh`); its fresh connections no longer
   enforce. Policies, FORCE and the application's context stay as they are,
   so this is Stage 3 exactly, and Stage 4 is re-entered by the same kind of
   migration with `true` (the guard included).

`tests/rls-pilot.integration.test.ts` runs that exact rollback file on real
PostgreSQL, checks Stage 3 behaviour, then re-applies the enforcement
migration and checks its guard refuses while any table is not forced.

### How the Cybersecurity control plane knows

Stage 4 is read from the database, not from the repository: one fixed
catalogue query returns `familista_rls_enforced()` and which of the declared
tables PostgreSQL does not hold to RLS right now (not forced, or no policy).
The RLS view is PROTECTED only when the switch is on, every table is held,
and the service's own `DB_RLS_CONTEXT` is `on`; a table not held makes it
PARTIAL and names the table, an unread answer is UNKNOWN. The build-time
control `db-row-level-security` is PRESENT when the guarded enforcement
migration and its rollback test are in the repository. Coverage rows 5 and 18
stay Partial for gaps RLS does not close: ids in request bodies are not
inventoried, and the application connects as the tables' owner.

## Evidence

- `tests/rls-pilot.integration.test.ts`, run in CI on real PostgreSQL as a
  role that is not a superuser and does not bypass RLS: every protected table
  is forced under RLS with its policy; for each club-private table, the same
  club reads and writes its own rows, another club's rows cannot be read,
  changed, deleted or moved into, a missing or invalid context (unknown mode,
  club mode with no or an unknown club, a club without a mode) reads and
  writes nothing, and the named system path sees every club; the migrations
  ship enforcement on; the rollback file returns Stage 3 and the enforcement
  migration re-applies, refusing while any table is not forced; enforced, no context and another club see and change nothing; a
  club sees its own; the system path sees all; reads stay open where intended;
  a club delete still cascades; the application client carries the context
  through single queries, interactive and batch transactions without leaking
  it; and the real `pg_dump`/`pg_restore` keep every club's rows.
- `tests/db-context.unit.test.ts`: the switch defaults off and leaves the
  client untouched; contexts are per async flow; system paths must be named.
- Posture controls `db-rls-pilot` and `db-rls-system-paths-reviewed` (required),
  `db-row-level-security` (PARTIAL until enforced).
