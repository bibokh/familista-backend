# Disaster recovery — database, media, Redis, region loss (Cyber Defense R10)

What is lost when something fails, how it comes back, and who does it. The
database runbook itself is `docs/BACKUP_AND_RESTORE.md`; this page covers what
it does not, and the loss of the whole region.

## What exists today

| Data | Where | Backed up by | Recovery point |
|---|---|---|---|
| PostgreSQL | Render, Frankfurt (`familista-postgres`, private network only) | Render's own daily backups, and the encrypted, signed off-site backup to Backblaze B2 (`docs/BACKUP_AND_RESTORE.md`), at most once per 12 hours and daily by schedule | ≤ 1 day |
| Media (white-label logos, fabric media, video) | the configured object store (`WL_ASSETS_*`, video bucket when configured) | **nothing** — see the decision below | — |
| Redis | Render, Frankfurt (`familista-redis`, private network only) | **nothing, by design** | not needed |
| Secrets | Render environment (`sync: false`) and the owner's offline copies | the owner | — (`docs/security/secrets-rotation.md`) |

## Media: the decision

**Recovery path: re-upload.** Today no media object is the only copy of
anything a club cannot provide again: logos and crests are uploaded by the club,
video originals are recorded by the club, and the platform derives everything
else (HLS renditions, thumbnails) from them. After a media-store loss:

1. Point `WL_ASSETS_*` (and the video bucket, when configured) at a new bucket.
2. Database rows keep their `storageKey`s, so the screens show the asset as
   missing rather than as somebody else's (every key is under its owner's
   prefix — `src/security/storage-keys.ts`).
3. Ask each club to re-upload its crest and logo; re-run transcodes from any
   video originals the club still holds.

**When this stops being true** — the day media becomes evidence nobody else
holds (match video recorded only by Familista cameras, medical documents) — the
option already designed is a nightly encrypted copy of the media prefixes to the
existing B2 bucket under a new prefix. It costs nothing within B2's free 10 GB
and about $6 per TB per month beyond, and needs one production change by the
owner: a B2 application key permission for that prefix. It is not enabled.

## Redis: why there is no backup

Redis holds nothing that is the only copy of anything (`redis-private-only`
lists every key namespace): rate-limit buckets, short-lived single-use claims
(WebSocket tickets, device nonces), worker leases, and pub/sub channels. Losing
it resets rate limits and drops in-flight realtime fan-out; the platform keeps
running, single-instance, on its in-process fallbacks. Recovery: provision a new
Render Redis and let `REDIS_URL` (linked from the service) follow it. Nothing
is restored.

## Region loss (Frankfurt unavailable)

Everything Familista runs is in one Render region. If it is gone:

1. **Decide** — the owner declares the outage after Render's status page
   confirms a regional incident expected to last longer than the time below
   (about 2 hours of work). Shorter: wait.
2. **Database** — create a PostgreSQL 16 database in another Render region.
   Restore the newest B2 backup into it with the offline keys, following
   "Recovery" in `docs/BACKUP_AND_RESTORE.md`. Recovery point: the last
   successful backup (≤ 1 day; Render's own backups are in the lost region).
3. **Service** — create `familista-backend` in the new region from
   `render.yaml` (change `region:`), with a new Redis there. Copy every
   `sync: false` secret from the owner's offline record; the database URL is the
   new database's.
4. **Media** — the object store is a separate provider and not affected by a
   Render region; if it is, follow the media decision above.
5. **Traffic** — move the custom domain to the new service. Point
   `BACKUP_SERVICE_URL` (GitHub variable) at it.
6. **Verify** — the restore drill's checks against the new database, a
   sign-in, and the next scheduled backup succeeding.
7. **Afterwards** — tell clubs what window of data was lost, in writing. Data
   created between the last backup and the outage is not recoverable.

Recovery time objective: about 2 hours of the owner's work once started.
Recovery point objective: ≤ 1 day.
