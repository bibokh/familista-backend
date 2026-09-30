# Backup and restore (Cyber Defense, Step 10)

The whole platform's data lives in one PostgreSQL database. This page covers
how it is backed up off-site, how a backup is proven restorable, and how to
recover. Code: `src/security/backup/`, command line `src/scripts/backup.ts`
(`dist/scripts/backup.js` once built).

## What protects what

| Threat | Control |
|---|---|
| Stolen backup file or bucket | Encrypted to an **offline** X25519 public key (chunked AES-256-GCM, format FBK1). The machine that takes backups cannot read them. |
| Backup host compromised | The backup runs inside `familista-backend`. The runner refuses to start if `BACKUP_ENCRYPTION_PRIVATE_KEY` is in its environment; the service holds only the public key, the manifest signing key and an upload-only bucket key. Someone who takes over the service can add files to the bucket but cannot read, list or delete a backup. |
| Tampered, truncated or substituted backup | Every 64 KiB chunk is authenticated; the header is bound to every chunk; a dropped, reordered, appended or flipped chunk fails. An Ed25519-signed manifest pins the ciphertext hash, size, key ids and schema head, and is verified before a byte reaches the database. |
| Restore into the wrong database | A restore refuses `NODE_ENV=production`, requires `DRILL_CONFIRM_ISOLATED=yes`, refuses any target equal to `DATABASE_URL` / `DIRECT_URL` / `BACKUP_DATABASE_URL`, and refuses a target that already has tables. It runs in a single transaction. |
| Credentials leaking | Passwords reach pg tools only through `PGPASSWORD`, never argv; tool output is scrubbed of URLs, user, host and password before it is logged or recorded. No command is built from configuration (the old `eval` is gone). |
| A backup that silently fails | A failed run is recorded as a failed `BackupRecord`, and the GitHub Actions run that triggered it fails, so GitHub emails the owner. |
| Abuse of the trigger | `POST /internal/backups/run` takes no input and runs only the fixed runner. HMAC-SHA256 over method, path and timestamp (5-minute window, constant-time), closed without a secret, rate-limited, one run at a time (advisory lock) and none within 20 hours of a success — a leaked or replayed request can cause at most one extra backup a day. |
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
  `BACKUP_S3_SECRET_ACCESS_KEY` on `familista-backend`) and nowhere else. It is
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

Environment on the `familista-backend` web service (Render dashboard →
Environment), where the backup runs:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | The application database; the `BackupRecord` is written here. Backed up unless `BACKUP_DATABASE_URL` is set. |
| `BACKUP_DATABASE_URL` | no | A different database (e.g. a replica) for pg_dump to read. |
| `BACKUP_ENCRYPTION_PUBLIC_KEY` | yes | From `runner.env`. |
| `BACKUP_SIGNING_PRIVATE_KEY` | yes | From `runner.env`. |
| `BACKUP_S3_BUCKET` | yes | |
| `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` | yes | Write-only key. |
| `BACKUP_S3_ENDPOINT` | for B2 | `https://s3.eu-central-003.backblazeb2.com`. Must be `https://` in production. |
| `BACKUP_S3_REGION` | yes for B2 | `eu-central-003`; must match the endpoint. |
| `BACKUP_S3_PREFIX` | no | Default `familista/postgres/`. |
| `BACKUP_S3_FORCE_PATH_STYLE` | no | `true` for some S3-compatible stores. |
| `BACKUP_PG_DUMP` | no | pg_dump binary. It must be version 16 or newer; the run refuses otherwise, and the boot log reports what it found. |
| `BACKUP_TRIGGER_SECRET` | yes | At least 32 characters (`openssl rand -hex 32`). The same value is the GitHub Actions secret of the same name. Unset or short: the trigger answers 503 to everything. |
| `BACKUP_PSQL` | no | psql binary, used to read the schema head and write the record. |

pg_dump runs at the lowest scheduling priority with compression level 1, so a
backup yields the CPU to requests; it takes only light read locks (a schema
migration waits for it, nothing else does).

`BACKUP_STORE=file` with `BACKUP_FILE_DIR` exists for drills and tests and is
refused when `NODE_ENV=production`.

No migration is needed: the existing `BackupRecord` table is reused.

## Scheduling (€0/month)

There is no Render cron job: a Render cron job is a paid service, so
`render.yaml` declares none. GitHub Actions provides the schedule and the
running service does the work.

`.github/workflows/backup.yml` runs daily at **03:17 UTC** and on demand
(Actions → backup → Run workflow). It holds one secret, `BACKUP_TRIGGER_SECRET`,
and one repository variable, `BACKUP_SERVICE_URL` (the service's public https
address). It never has the database URL, a bucket key, the signing key, the
restore key or the decryption key. `scripts/backup-trigger.js`:

1. **wakes** the service — `GET /healthz` every 15 s for up to 8 minutes (a
   free instance sleeps after 15 minutes idle; waking also runs the startup
   migration gate);
2. **triggers** — `POST /internal/backups/run`, signed;
3. **waits** — `GET /internal/backups/runs/:id`, signed, every 20 s for up to
   60 minutes, which also keeps the instance awake.

It exits 0 when the backup succeeded, or when one already succeeded within the
last 20 hours; otherwise 1, so a failed backup is a failed workflow run and
GitHub emails the owner.

### The trigger

| | |
|---|---|
| `POST /internal/backups/run` | 202 `{id, state:"running"}` — started. 409 `{id, state:"running"}` — one is already running. 429 `{state:"recent", lastSuccessAt}` — one succeeded less than 20 hours ago. 401 `{error:"unauthorized"}`. 400 — a body or query string was sent. 503 — no trigger secret, or the backup is not configured. |
| `GET /internal/backups/runs/:id` | 200 `{id, state, startedAt, finishedAt, ok}` with `state` = `running`, `succeeded` or `failed` (a run unfinished after 90 minutes reads `failed`). 404 for an unknown or malformed id. |

Both need `X-Backup-Timestamp` (Unix seconds, within 5 minutes of the server)
and `X-Backup-Signature` = hex HMAC-SHA256 with `BACKUP_TRIGGER_SECRET` over
`METHOD\nPATH\nTIMESTAMP`. Neither accepts anything that could change what is
backed up or where: the runner uses only the service's own environment.

### Setup (the owner, once)

1. Render → `familista-backend` → Environment: the variables in the table
   above, including `BACKUP_TRIGGER_SECRET`. Never `BACKUP_ENCRYPTION_PRIVATE_KEY`
   and never the restore key.
2. GitHub → Settings → Secrets and variables → Actions: secret
   `BACKUP_TRIGGER_SECRET` (same value), variable `BACKUP_SERVICE_URL`.
3. After the deploy, check the boot log for
   `[boot] backup tooling {"pgDump":"16.x","meetsMinimum":true}`. `unavailable`
   or `meetsMinimum:false` means this runtime cannot take backups yet.
4. Run the workflow once by hand, then run the restore drill below against
   the object it produced.

**Keep the schedule alive.** This repository is public: GitHub disables a
scheduled workflow after 60 days without repository activity. It also may
start a scheduled run late, or skip one under load; the 20-hour rule makes a
late or repeated run harmless.

Whatever backups the Render database plan provides are unaffected; these are
an independent, off-site, encrypted copy.

## Restore drill (monthly, and after any schema-heavy release)

**Versions.** Production backups are written by pg_dump 18 (the version on the
Render service). Only pg_restore 18 or newer reads them, and pg_restore 18
sets `transaction_timeout`, which a PostgreSQL 16 server rejects — so a
backup restores into **PostgreSQL 17 or newer**. The drill therefore uses a
PostgreSQL 18 target.

### Windows (one command)

Prerequisites: Docker Desktop running, the repository built (`npm run build`),
and `offline-restore.env` in `%USERPROFILE%\familista-backup-keys\`.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-drill.ps1 -Latest
```

`-Latest` lists the prefix with the same Read Only key and restores the newest
**complete** backup: a `.fbk` whose signed `.fbk.manifest.json` is beside it.
A manifest is never chosen, a `.fbk` without its manifest (an interrupted
upload) is skipped, and an empty prefix stops the drill before anything
starts. The listing container gets the B2 settings only — not the offline key,
not a database URL. Choosing is not trusting: the drill still verifies the
signature, hash, size and key of what was chosen. To restore a particular
backup instead, name it (give one option or the other, not both):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\restore-drill.ps1 -Object 2026/09/30/familista-20260930T031700Z-0a1b2c3d.fbk
```

The same choice is available without PowerShell as
`node dist/scripts/backup.js latest` (B2 settings in the environment; prints
one JSON line with `objectKey`).

Run it as one command — do not paste its steps into the console. It asks for
the Backblaze **Read Only** key id and key at hidden prompts (a value that is
not a single token is refused and nothing is stored), then:

1. builds `familista-restore-drill-runner:pg18` once (`scripts/restore-drill/Dockerfile`:
   the official `postgres:18` image plus Node 20; nothing installed from a
   package repository);
2. starts a throwaway `postgres:18` target — new, empty, no published port, a
   random password nobody sees;
3. writes the B2 key and the target URL to a temporary env file only you can
   read, and passes it and `offline-restore.env` with `--env-file` — never on a
   command line, never through a shared environment variable; the file is
   deleted whatever happens;
4. runs `node dist/scripts/backup.js drill <key>` (the key named, or found by
   `-Latest`) in the runner, on the
   target's network, with no production URL;
5. queries the restored database directly, compares it with the drill's
   report, removes the target (`-KeepDatabase` keeps it) and prints:

```
STEP 10 RESTORE DRILL: PASS
Backup object: familista/postgres/…
Public tables restored: <n>
Core row counts: User=…, Club=…, Team=…, Player=…, Membership=…
Migration head: <head>
```

PASS requires the drill's own `"ok":true` (signature, hash, key, authenticated
decryption, single-transaction restore) and that the database agrees with it:
the same table count, schema head and core row counts.

### Linux / macOS

With pg_restore and psql 18 on the PATH and an empty PostgreSQL 17+ database:

```
set -a; . ./offline-restore.env; set +a
export BACKUP_S3_BUCKET=familista-backups-2026-739261 BACKUP_S3_REGION=eu-central-003
export BACKUP_S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com
export BACKUP_S3_ACCESS_KEY_ID=… BACKUP_S3_SECRET_ACCESS_KEY=…   # the Read Only restore key
export DRILL_DATABASE_URL=postgresql://postgres@localhost:5432/familista_drill
export DRILL_CONFIRM_ISOLATED=yes
BACKUP_OBJECT=2026/09/29/familista-20260929T031700Z-0a1b2c3d.fbk bash scripts/restore.sh
```

The object key is relative to `familista/postgres/`. The output is one JSON
line: schema head, table count and row counts of the core tables. The drill
writes nothing to production.

## Recovery

Never restore over the live database (`scripts/rollback.sh` refuses to).
Instead:

1. Create a new, empty PostgreSQL database, **version 17 or newer** (Render:
   new database, same region — see *Versions* above).
2. Run the drill above with `DRILL_DATABASE_URL` pointing at it.
3. Check the report, then point the service's `DATABASE_URL` / `DIRECT_URL`
   at the new database and redeploy. `prisma migrate deploy` on start applies
   any migrations newer than the backup.
4. Keep the old database until the new one is confirmed, then retire it.
