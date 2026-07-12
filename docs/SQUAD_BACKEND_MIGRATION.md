# Squad → Backend Migration (Training real-backend integration)

Status of the pieces in this change set:

| Piece | State | Where |
|---|---|---|
| Additive `Player` fields (`legacyId`, `roles`, `morale`, `isCaptain`, `isViceCaptain`, `trainedPositions`) | **Ready** (schema valid, client regenerates, typechecks) | `prisma/schema.prisma` |
| Additive migration (`ADD COLUMN` only — cannot fail on existing rows) | **Ready** | `prisma/migrations/20260712000000_squad_player_fields/migration.sql` |
| Idempotent Squad import (dry-run, validation, mapping, rollback) | **Ready + tested** (14/14 mock-DB tests pass) | `prisma/seeds/import-squad.ts` |
| Frontend Squad adapter (Squad/Lineup/Formation/Tactics/Training load the same real backend players by UUID; safe demo fallback) | **Deployed** (verified: demo unchanged) | `public/app.js` |
| **Stage 2** — additive Training-persistence schema (`TrainingSession.{startTime,sessionType,objective,tacticalFocus,formation,status,sessionRating,bestPlayerId,coachNote,completedAt}`, `PlayerTrainingStat.participation`, `AttendanceMark.INJURED`) | **Ready** (schema valid, `tsc` clean) | `prisma/schema.prisma`, `prisma/migrations/20260712010000_training_persistence/migration.sql` |
| **Stage 2** — backend endpoints: `PUT /training/:id/performance`, `POST /training/:id/complete`, `GET /training/reports?range=daily\|weekly\|monthly\|season` (reads **only** from PostgreSQL) | **Ready** (`tsc` clean) | `src/services/training.service.ts`, `src/controllers/training.controller.ts`, `src/routes/training.routes.ts` |
| **Stage 2** — verification report script + end-to-end harness | **Ready + tested** (harness: 16 imported / 0 dup / 4 sessions / 32 attendance / 56 stats / 0 orphans / all-same-UUID) | `prisma/seeds/verify-migration.ts`, `prisma/seeds/verify-migration.test.ts` |
| **Stage 2** — frontend backend-sync Training layer (every write persisted to PostgreSQL by real Player UUID; backend-first read; inert on demo/logged-out) | **Deployed** (verified inert) | `public/app.js` |

I do **not** have production database access or an authenticated login, so I could **not** run the migration/import against production or verify the authenticated flow. Everything above is complete and tested locally; the production database steps below must be run by someone with `DATABASE_URL` for the production DB. They are additive and reversible.

**Deploy order:** (A) merge the backend commit to `main` so Render applies **both** additive migrations and ships the new endpoints; (B) run the import; (C) run the verification report. The frontend is already deployed and activates automatically once real players exist.

---

## Production steps (run in order, with a backup)

> Run from the repo root with `DATABASE_URL` pointing at the **production** database.

### 0. Back up first (rollback point)
```bash
pg_dump "$DATABASE_URL" -Fc -f squad_migration_backup_$(date +%Y%m%d).dump
```

### 1. Apply the additive migration
Two options — pick one:
- **Deliberate (recommended):** `npx prisma migrate deploy --schema=prisma/schema.prisma`
- **Automatic:** merging the backend commit to `main` runs `prisma migrate deploy` in Render's `preDeployCommand` on the next deploy.

The migration only adds nullable/defaulted columns to `Player`, so it applies with no data backfill and cannot fail on existing rows.

### 2. Import the Squad (dry-run first)
```bash
# Preview — writes nothing, prints the old-id -> new-UUID mapping:
npx ts-node prisma/seeds/import-squad.ts --club "FC Familista" --dry-run

# Real import (idempotent — safe to re-run, never duplicates):
npx ts-node prisma/seeds/import-squad.ts --club "FC Familista"
```
(Use `--club-id <uuid>` instead of `--club "<name>"` if you prefer.)

### 3. Verify (prints the exact migration verification report)
```bash
npx ts-node prisma/seeds/verify-migration.ts --club "FC Familista"
#   --json for machine-readable; exit code 0 = PASS, 1 = FAIL
```
Prints: imported players, duplicated players (must be 0), migrated sessions, attendance records, PlayerTrainingStat records, and "all modules share Player UUIDs YES/NO".

Also:
- The import command prints `legacyId -> Player UUID` for all 16 players.
- `GET /api/v1/players` (authenticated as that club) now returns the 16 real players.
- Log in to the club → Squad / Lineup / Formation / Tactics / Training / Match Center / Medical all read the **same** `State.players` UUIDs (the deployed frontend adapter loads them automatically; no further deploy needed).
- Training writes (sessions/attendance/ratings/completion) now persist to PostgreSQL by real Player UUID; `GET /api/v1/training/reports?range=weekly` returns reports computed only from PostgreSQL.

### Rollback
```bash
npx ts-node prisma/seeds/import-squad.ts --rollback          # deletes only the imported players (by legacyId)
# schema rollback (only if you must reverse the columns):
#   ALTER TABLE "Player" DROP COLUMN "legacyId","roles","morale","isCaptain","isViceCaptain","trainedPositions";
# or restore the pg_dump from step 0.
```

---

## Field mapping (client Squad → backend `Player`)

| Squad | Player | Notes |
|---|---|---|
| `id` (`sq-8`) | `legacyId` | stable idempotency key |
| `name` | `firstName` + `lastName` | split on first space |
| `pos` | `position` | GK→GK, CB→DC, LB→DL, RB→DR, DM→DMC, CM→MC, LW→AML, RW→AMR, ST→ST |
| `num` | `number` | |
| `natName` / `nat` | `nationality` / `flag` | |
| `age` | `dateOfBirth` | Jan 1 of (2026 − age) |
| `qual` | `overallRating` | |
| `cond` | `condition` | fitness |
| `value` (`€28.0M`) | `marketValue` | 28000000 |
| `foot` | `preferredFoot` | RIGHT/LEFT/BOTH |
| `height` (`1.78m`) | `height` | 178 (cm) |
| `roles`, `morale`, captain, vice, trained positions | `roles`, `morale`, `isCaptain`, `isViceCaptain`, `trainedPositions` | vice = highest-quality non-captain |

---

## Not in this change set (deferred, needs the same DB access to verify)

Persisting **Training sessions/attendance/ratings/completion** to Postgres reuses the existing `TrainingSession` / `TrainingAttendanceRecord` / `PlayerTrainingStat` models and the authenticated `/api/v1/training` endpoints (create/list/get/delete + attendance already exist). To store **ratings, participation and completion status** as well, add (additively): `PlayerTrainingStat.participation`, `TrainingSession.{status, sessionType, objective, tacticalFocus, formation, sessionRating, bestPlayerId, coachNote, completedAt}`, and `AttendanceMark.INJURED`; then wire the frontend Training layer (currently client-persistent) to those endpoints using the real Player UUIDs. This depends on the Squad import above (real Player rows) and requires an authenticated environment to verify end-to-end.
