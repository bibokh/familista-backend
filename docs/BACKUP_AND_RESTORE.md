# Backup and restore (Cyber Defense, Step 10)

The whole platform's data lives in one PostgreSQL database. This page covers
how it is backed up off-site, how a backup is proven restorable, and how to
recover. Code: `src/security/backup/`, command line `src/scripts/backup.ts`
(`dist/scripts/backup.js` once built).

## What protects what

| Threat | Control |
|---|---|
| Stolen backup file or bucket | Encrypted to an **offline** X25519 public key (chunked AES-256-GCM, format FBK1). The machine that takes backups cannot read them. |
| Backup host compromised | The runner refuses to start if `BACKUP_ENCRYPTION_PRIVATE_KEY` is in its environment. It holds only the public key and a signing key. |
| Tampered, truncated or substituted backup | Every 64 KiB chunk is authenticated; the header is bound to every chunk; a dropped, reordered, appended or flipped chunk fails. An Ed25519-signed manifest pins the ciphertext hash, size, key ids and schema head, and is verified before a byte reaches the database. |
| Restore into the wrong database | A restore refuses `NODE_ENV=production`, requires `DRILL_CONFIRM_ISOLATED=yes`, refuses any target equal to `DATABASE_URL` / `DIRECT_URL` / `BACKUP_DATABASE_URL`, and refuses a target that already has tables. It runs in a single transaction. |
| Credentials leaking | Passwords reach pg tools only through `PGPASSWORD`, never argv; tool output is scrubbed of URLs, user, host and password before it is logged or recorded. No command is built from configuration (the old `eval` is gone). |
| A backup that silently fails | The run exits non-zero and records a failed `BackupRecord`. |
| A backup that cannot be restored | CI takes a real backup and restores it into an empty PostgreSQL on every pull request. |
| Forged or leaked backup records | `/api/v1/phase-o/monitoring/backups` (GET and POST) is platform authority only — the owner or `SUPER_ADMIN`; no club role. |

Nothing here makes the platform unbreakable. It narrows what a single
compromise can do and makes a broken backup visible before it is needed.

## Keys (once, offline)

On a trusted machine, not the server:

```
npm run build
node dist/scripts/backup.js keygen ./familista-backup-keys
```

This writes two files, mode 0600, and prints no key:

- `runner.env` — `BACKUP_ENCRYPTION_PUBLIC_KEY`, `BACKUP_SIGNING_PRIVATE_KEY`.
  Goes into the backup job's environment.
- `offline-restore.env` — `BACKUP_ENCRYPTION_PRIVATE_KEY`,
  `BACKUP_SIGNING_PUBLIC_KEY`. **Never** on the server. Keep it in a password
  manager and one offline copy. Losing it makes every backup unreadable.

Rotating: generate a new pair, switch the runner to the new `runner.env`, and
keep the old `offline-restore.env` for as long as backups made with it are
retained. The manifest records which key each backup used.

## Where backups go

Any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3), **separate from
the application's media storage**, with its own credentials:

- The runner's key may `PutObject` only — no `GetObject`, `DeleteObject` or
  `ListBucket`. A compromised runner then cannot read, delete or enumerate.
- Enable object lock / versioning and a lifecycle rule for retention
  (e.g. 35 daily copies) on the bucket itself.
- A separate read-only key is used only for restores.

Environment for the backup job:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | The application database; the `BackupRecord` is written here. Backed up unless `BACKUP_DATABASE_URL` is set. |
| `BACKUP_DATABASE_URL` | no | A different database (e.g. a replica) for pg_dump to read. |
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | yes | From `runner.env`. |
| `BACKUP_SIGNING_PRIVATE_KEY` | yes | From `runner.env`. |
| `BACKUP_S3_BUCKET` | yes | |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | yes | Write-only key. |
| `BACKUP_S3_ENDPOINT` | for non-AWS | Must be `https://` in production. |
| `BACKUP_S3_REGION` | no | Default `auto`. |
| `BACKUP_S3_PREFIX` | no | Default `familista/postgres/`. |
| `BACKUP_S3_FORCE_PATH_STYLE` | no | `true` for some S3-compatible stores. |
| `BACKUP_PG_DUMP` | no | pg_dump binary; must be at least the server's major version. |
| `BACKUP_PSQL` | no | psql binary, used to read the schema head and write the record. |

The job reaches the database only through the PostgreSQL client tools. It needs
none of the application's secrets (JWT, Stripe, storage) — do not give it them.

`BACKUP_STORE=file` with `BACKUP_FILE_DIR` exists for drills and tests and is
refused when `NODE_ENV=production`.

No migration is needed: the existing `BackupRecord` table is reused.

## Scheduling

Not in `render.yaml` on purpose: adding a cron service to the blueprint creates
a billable service on the next sync. The owner creates it once in the Render
dashboard (New → Cron Job, same repository), in the same region as the
database so it reaches it on the private network:

```
Build command:  npm install && npx prisma generate && npm run build   (as the web service)
Start command:  bash scripts/backup.sh
Schedule:       17 3 * * *        (daily, 03:17 UTC)
Environment:    the table above — never BACKUP_ENCRYPTION_PRIVATE_KEY
```

The posture manifest reports `backup-scheduled` as a known gap until a
schedule exists. Whatever backups the Render database plan provides are
unaffected; these are an independent, off-site, encrypted copy.

## Restore drill (monthly, and after any schema-heavy release)

On a trusted machine with PostgreSQL client tools of the server's major
version, against a **new, empty** database (a local Docker Postgres is fine):

```
set -a; . ./offline-restore.env; set +a
export BACKUP_S3_BUCKET=… BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=… BACKUP_S3_ENDPOINT=…   # read-only key
export DRILL_DATABASE_URL=postgresql://postgres@localhost:5432/familista_drill
export DRILL_CONFIRM_ISOLATED=yes
BACKUP_OBJECT=2026/09/29/familista-20260929T031700Z-0a1b2c3d.fbk bash scripts/restore.sh
```

The output is one JSON line: schema head, table count and row counts of the
core tables. Compare them with production's. The drill writes nothing to
production.

## Recovery

Never restore over the live database (`scripts/rollback.sh` refuses to).
Instead:

1. Create a new, empty PostgreSQL database (Render: new database, same region).
2. Run the drill above with `DRILL_DATABASE_URL` pointing at it.
3. Check the report, then point the service's `DATABASE_URL` / `DIRECT_URL`
   at the new database and redeploy. `prisma migrate deploy` on start applies
   any migrations newer than the backup.
4. Keep the old database until the new one is confirmed, then retire it.
