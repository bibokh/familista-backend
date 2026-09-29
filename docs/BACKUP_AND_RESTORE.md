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

Backblaze B2, through its S3-compatible API, bucket
`familista-backups-2026-739261` in region `eu-central-003`
(endpoint `https://s3.eu-central-003.backblazeb2.com`). The bucket is separate
from the application's media storage and has its own credentials:

- **Private**, with **default encryption** on — a second layer, not the
  protection.
- **Object Lock** on, with default retention (35 days is a sensible start;
  Governance-style retention can be shortened by the owner, Compliance cannot
  be shortened by anyone). A lifecycle rule handles expiry after that; Object
  Lock still holds every file for its retention period.
- **Writer key** — bucket-scoped, **Write Only**, restricted to the prefix
  `familista/postgres/`. It goes into Render (`BACKUP_S3_ACCESS_KEY_ID` /
  `BACKUP_S3_SECRET_ACCESS_KEY` on `familista-backup`) and nowhere else. It is
  the only permission the runner uses: one `PutObject` per file.
- **Restore key** — **Read Only**. Kept offline with `offline-restore.env`,
  never on Render.

A compromised runner can then add files and nothing else: it cannot read,
list or delete a backup, and Object Lock stops even the owner's keys from
deleting one early.

How the client talks to B2 (`src/security/backup/backup-store.ts`), all
covered by `tests/backup-config.unit.test.ts`:

- **Addressing:** virtual-hosted —
  `familista-backups-2026-739261.s3.eu-central-003.backblazeb2.com/familista/postgres/…`.
  B2 supports it for a bucket name without dots, so no path-style override is
  set. For a bucket whose name contains a dot, set
  `BACKUP_S3_FORCE_PATH_STYLE=true` (the wildcard TLS certificate cannot cover
  an extra label).
- **Signing:** SigV4 with region `eu-central-003`, which must match the
  endpoint's region.
- **Checksums:** the AWS SDK's default flexible checksums (an aws-chunked
  upload with an `x-amz-checksum-crc32` trailer, and `x-amz-checksum-mode` on
  download) are switched off with `WHEN_REQUIRED`; S3-compatible stores,
  B2 among them, have rejected those headers.
- **Content-MD5** is sent on every upload. B2 requires it on uploads to a
  bucket with default Object Lock retention, and it checks the transfer. The
  backup's own integrity is still the authenticated encryption and the signed
  SHA-256 manifest.

Environment for the backup job:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | The application database; the `BackupRecord` is written here. Backed up unless `BACKUP_DATABASE_URL` is set. |
| `BACKUP_DATABASE_URL` | no | A different database (e.g. a replica) for pg_dump to read. |
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | yes | From `runner.env`. |
| `BACKUP_SIGNING_PRIVATE_KEY` | yes | From `runner.env`. |
| `BACKUP_S3_BUCKET` | yes | |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | yes | Write-only key. |
| `BACKUP_S3_ENDPOINT` | for B2 | `https://s3.eu-central-003.backblazeb2.com` (set in `render.yaml`). Must be `https://` in production. |
| `BACKUP_S3_REGION` | yes for B2 | `eu-central-003` (set in `render.yaml`); must match the endpoint. |
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
- `NODE_ENV=production`, `BACKUP_S3_REGION=eu-central-003` and
  `BACKUP_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com` are the only
  values in the file; none is a secret.
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
export BACKUP_S3_BUCKET=familista-backups-2026-739261 BACKUP_S3_REGION=eu-central-003
export BACKUP_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
export BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=…   # the Read Only restore key
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
