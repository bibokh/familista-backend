# Prisma Migrations

`prisma/schema.prisma` is the **single source of truth** for all Prisma commands.
The root `schema.prisma` is kept in sync with it — they are identical.

## Migration history

| # | Name | Contents |
|---|------|----------|
| 1 | `00000000000000_baseline` | Full schema snapshot at project start (294 tables) |
| 2 | `20250525000000_add_phase_q_and_password_reset` | Phase Q tables (Competition, Fixture, Standings, Player stats, Transfer intelligence) + PasswordResetToken + EventOutbox/VideoAsset/MatchEvent column additions |

---

## New environment (staging / preview / local)

Apply all migrations against a fresh database:

```bash
npx prisma migrate deploy --schema=prisma/schema.prisma
```

Or use the npm script:

```bash
npm run db:migrate
```

---

## Existing production database (one-time bootstrap)

Production was bootstrapped via `prisma db push` and has no `_prisma_migrations` table.
Run these **once** against the live database before the first `prisma migrate deploy`:

```bash
# Mark both migrations as already applied (no SQL is executed)
npm run db:resolve:all
```

Which expands to:

```bash
npx prisma migrate resolve --applied 00000000000000_baseline \
  --schema=prisma/schema.prisma

npx prisma migrate resolve --applied 20250525000000_add_phase_q_and_password_reset \
  --schema=prisma/schema.prisma
```

After this, every subsequent `npm run db:migrate` (or Render's build command) is
forward-only and safe.

---

## Adding new migrations (going forward)

1. Edit `schema.prisma` (root — authoritative source).
2. Copy it to `prisma/schema.prisma`:
   ```bash
   cp schema.prisma prisma/schema.prisma
   ```
3. Generate the migration on a local dev database:
   ```bash
   npm run db:migrate:dev -- --name <change_summary>
   ```
   This creates `prisma/migrations/<timestamp>_<change_summary>/migration.sql`.
4. Commit the new migration directory, `prisma/schema.prisma`, and `schema.prisma`.
5. Render's `npm run db:migrate` in the build command applies it automatically on push.

---

## Check migration status

```bash
npm run db:migrate:status
```

## Why this matters

- Reproducible schema rebuilds (staging, DR drills, GDPR wipe-and-restore).
- Forward-only migration history → clear audit trail.
- `prisma migrate diff` against any prior migration becomes the change review surface.
- `prisma migrate status` catches drift before it reaches production.
