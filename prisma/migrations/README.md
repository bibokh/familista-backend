# Prisma migrations

The repo ships with a **baseline migration** (`00000000000000_baseline/`) that
encodes the current state of `prisma/schema.prisma` as a single CREATE script.

## Existing production database (one-time bootstrap)

Production was created via `prisma db push` and has no migration history.
After deploying this commit, run **once** against the live database:

```bash
npx prisma migrate resolve --applied 00000000000000_baseline --schema=prisma/schema.prisma
```

This records the baseline as "already applied" without re-running it. Every
subsequent `npx prisma migrate deploy` then works normally.

## New environments (staging / preview / local)

For a brand-new database the deploy command applies the baseline cleanly:

```bash
npx prisma migrate deploy --schema=prisma/schema.prisma
```

## Adding new migrations (going forward)

1. Edit `prisma/schema.prisma`.
2. `npx prisma migrate dev --name <change_summary>` (local dev DB).
3. Commit the new `prisma/migrations/<timestamp>_<change_summary>/` directory
   plus `migration_lock.toml`.
4. Render's deploy command (`npx prisma migrate deploy`) applies it on push.

## Why this matters

- Reproducible schema rebuilds (staging, DR drills, GDPR audits).
- Forward-only migration history → safe rollback paths.
- `prisma migrate diff` against `main` becomes the change review surface.
