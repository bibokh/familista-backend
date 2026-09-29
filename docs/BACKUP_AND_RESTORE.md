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

AWS S3, bucket in `eu-central-1` (Frankfurt, the region of the Render
services), **separate from the application's media storage**, with its own
credentials. Set up once by the owner:

1. Create the bucket. Keep **Block all public access** on. Enable **Bucket
   Versioning** and **Object Lock**, default retention **Governance, 35 days**
   (Compliance cannot be shortened by anyone, including the owner). Default
   encryption SSE-S3 — a second layer, not the protection.
2. Lifecycle rule on prefix `familista/postgres/`: expire current versions
   after 36 days, permanently delete noncurrent versions 1 day after they
   become noncurrent, remove expired delete markers. Object Lock still holds
   every object for its 35 days.
3. Bucket policy refusing anything but TLS:

   ```json
   {"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*","Action":"s3:*",
     "Resource":["arn:aws:s3:::BUCKET","arn:aws:s3:::BUCKET/*"],"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
   ```

4. IAM user `familista-backup-writer` — **upload only**, the one permission
   the runner uses. Its access key goes into Render and nowhere else:

   ```json
   {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject",
     "Resource":"arn:aws:s3:::BUCKET/familista/postgres/*"}]}
   ```

5. IAM user `familista-backup-reader` — restores only. Its key is kept
   offline with `offline-restore.env`, never on Render:

   ```json
   {"Version":"2012-10-17","Statement":[
     {"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::BUCKET/familista/postgres/*"},
     {"Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::BUCKET",
      "Condition":{"StringLike":{"s3:prefix":"familista/postgres/*"}}}]}
   ```

A compromised runner can then add objects and nothing else: it cannot read,
list, overwrite or delete a backup. Another S3-compatible store works with
`BACKUP_S3_ENDPOINT`, but check that it offers an upload-only key before
choosing it.

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
| `BACKUP_S3_REGION` | no | Default `auto`; `eu-central-1` in production (set in `render.yaml`). |
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

`render.yaml` declares the job: service `familista-backup`, a Render cron job
in `frankfurt` (the database's region, so it uses the private network), daily
at 03:17 UTC, running `pg_dump --version && bash scripts/backup.sh`.

- `DATABASE_URL` is linked from `familista-postgres`; nobody copies it.
- `NODE_ENV=production` and `BACKUP_S3_REGION=eu-central-1` are the only
  values in the file.
- `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`,
  `BACKUP_S3_SECRET_ACCESS_KEY` (the writer key), `BACKUP_ENCRYPTION_PUBLIC_KEY`
  and `BACKUP_SIGNING_PRIVATE_KEY` (both from `runner.env`) are `sync: false`:
  the owner enters them in the Render dashboard on the `familista-backup`
  service. Until they are set, a run stops at configuration and does nothing.
- `BACKUP_ENCRYPTION_PRIVATE_KEY` is never declared; the job refuses to start
  if it is present. `tests/backup-schedule.unit.test.ts` and the posture
  control `backup-scheduled` both fail if the blueprint drifts from this.

After the values are set, run it once by hand (Render → `familista-backup` →
Trigger Run). The log shows the pg_dump version (it must be 16 or newer —
if it is missing or older the run fails on that line) and one JSON line,
`{"ok":true,"objectKey":…}`. The object and its `.manifest.json` appear in
the bucket, and the record in `GET /api/v1/phase-o/monitoring/backups`.
Then run the restore drill below against that object.

Whatever backups the Render database plan provides are unaffected; these are
an independent, off-site, encrypted copy.

## Restore drill (monthly, and after any schema-heavy release)

On a trusted machine with PostgreSQL client tools of the server's major
version, against a **new, empty** database (a local Docker Postgres is fine):

```
set -a; . ./offline-restore.env; set +a
export BACKUP_S3_BUCKET=… BACKUP_S3_REGION=eu-central-1 BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=…   # the reader key
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
