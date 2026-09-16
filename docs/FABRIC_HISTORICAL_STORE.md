# Familista Data Fabric — Historical Event Store

Durable, append-only, queryable history of everything the central Fabric
publisher accepts.

---

## Three things that are not each other

The single most important thing in this document. Confusing any two of these is
how a platform comes to believe it has a capability it does not have.

| | Historical Event Store | Cold Archive | Database Backup |
|---|---|---|---|
| **What it is** | `FabricEventHistory`, a table in PostgreSQL | Parquet objects in S3-compatible storage | The provider's image of the whole database |
| **Answers** | "What happened on 14 May 2030?" | "Keep a decade of history affordably" | "The database is gone — put it back" |
| **Granularity** | One row per event, indexed | Batched files, partitioned by date | The entire database at a point in time |
| **Read by** | A person, through the System API | An analytic reader (DuckDB, Spark, Athena) | A restore operation, never a query |
| **Scope** | This one table | This one table's older rows | Every table |
| **Status in this build** | **Live** | **Interface only — not configured** | **Neon's, not this platform's** |

**An archive is not a backup.** It holds one table's history in a format
designed for analysis. It cannot restore a club, a user or a match.

**A backup is not an archive.** It is a whole-database image restored to a point
in time. Nobody can run "every medical event in May" against it.

**Neither is the historical store.** It is the only one of the three that
answers a question about a particular day, and the only one a person reads.

---

## What existed before, and why a new table was needed

`EventOutbox` carries the Fabric envelope and looks like a historical store.
Three properties disqualify it:

1. **It is retention-governed.** `workers/retention.worker.ts` has an
   `EventOutbox` sweeper that deletes published rows the moment a
   `DataRetentionPolicy` names that entity type. No such policy exists today, so
   the rows survive — by the *absence of a policy*, not by any guarantee. A
   governance admin adding one tomorrow would destroy the platform's history
   without meaning to.
2. **It is not queryable by time or type.** The envelope lives inside
   `payload."__familista_event"` as JSON. There is no column for `eventType`,
   `occurredAt`, `entityType`, `entityId` or `correlationId`, and none of its
   indexes could serve a month-and-source query as anything but a full scan with
   JSON extraction on every row.
3. **It has mixed provenance.** It also holds legacy rows from
   `match-event.service` and `big-data/event-source` whose payloads have no
   schema and no classification — which is why the live board already renders
   such a row as `RESTRICTED`.

Also bounded, and also not history: `pulse-replay.replayWindow` (a capped
minutes-wide window, selected descending), the in-memory pulse buffer
(`BUFFER_LIMIT`), and `AnalyticsEvent` (UI telemetry with its own cutoff delete).

---

## The write path

```
producer
  → publishFabricEvent() / publishFabricEventDetached()
      → makeEvent()          envelope, validation, classification
      → transport.append()   EventOutbox — the transport
      → noteFabricPublishOutcome()
      → recordHistoryDetached()   ← the historical store
      → fanOut()             in-process subscribers
```

The historical write is **one call in `emit()`**. That is why none of the 131
producers was edited to gain history, and why the 132nd will not need to be:
everything that reaches the Fabric reaches it through `emit()`.

It is **detached**. The caller has already committed a business transaction by
the time it gets here, and a slow or unwell historical store must not make an
append slower — let alone fail one.

---

## Guarantees

**Append-only.** Nothing in the application updates or deletes a
`FabricEventHistory` row. There is no update path in the writer and no sweeper
in the retention worker.

**Idempotent.** `eventId` is `UNIQUE`. A duplicate key is treated as success,
not an error, so a retry of an event that already landed produces one row.

**Never loses an event silently.** A failed write goes onto a bounded retry
queue (`FABRIC_HISTORY_QUEUE_LIMIT`, default 500) and is retried on a timer
(`FABRIC_HISTORY_RETRY_MS`, default 30s) a fixed number of times
(`FABRIC_HISTORY_MAX_ATTEMPTS`, default 3). A record that exhausts its attempts,
or arrives at a full queue, is dropped **and counted**. `fabricHistoryHealth()`
reports `dropped`, `retryBacklog` and `lastError`, and
`GET /api/v1/system/fabric/history/health` serves them.

**No infinite retry.** Bounded queue, bounded attempts, unref'd timer.

---

## Privacy — historical does not mean raw

History is an **index of what happened**, not a second copy of what it happened
to. It is the longest-lived surface the platform has: a mistake on the live
board is visible for five minutes; a mistake here is a permanent record.

**The payload is not persisted.** Not a redacted copy, not a filtered subset,
not "just the safe keys". Every producer already writes safe payloads, but
*"safe to draw on an operator's screen for five minutes"* is not the same
judgement as *"safe to keep for a decade"*, and nobody has made the second one.

The one exception is `changedFields` — field **names** only — and only because
`project()` already reads exactly that key, caps it, and draws it. Reusing an
existing decision is not a new judgement.

Absent by construction, because the payload is never read: passwords, tokens,
API keys, connection strings, private messages, addresses, child personal
details, safeguarding notes, diagnoses, medical notes, prompts, model responses,
media bytes, storage URLs, salaries, contract clauses, negotiation text, and
private tactical or scouting notes.

**Entity ids.** Written only for subject kinds the platform already treats as
safe to name — `safeSubjectId()` in `pulse.service`, the same allow-list the
live board uses. `PLAYER` and `STAFF` are not on it, so a historical record
about a person says what kind of thing happened and never to whom.

Not a hash, either: a stable pseudonym in a permanent store still links every
event about one child across a decade.

The domain database remains the protected source of truth for sensitive content.

---

## Retention classes

A **classification, not a schedule**.

`OPERATIONAL` · `AUDIT` · `SECURITY` · `COMPLIANCE` · `ANALYTICS` · `RESTRICTED`

Assigned by `retentionClassFor()` in this order: an explicit governance override
→ `RESTRICTED` (from the envelope's own classification) → `SECURITY` (credential
and key domains) → `AUDIT` (the registry's `auditRelevant` flag, the same one
that routes an event to the Audit destination) → `ANALYTICS` → `OPERATIONAL`.
`COMPLIANCE` is never derived; governance assigns it.

Overrides come from `FABRIC_RETENTION_OVERRIDES`, a comma-separated list of
`eventTypeOrSource=CLASS` pairs, so a class can move without a code change.

**Nothing purges this table.** `retentionPolicyConfigured()` returns `false`, no
sweeper exists, and a duration is a legal judgement that varies by jurisdiction
and by the age of the person a record concerns — not a number to invent in code.
A record kept too long can be deleted later; one deleted too early cannot be
recovered.

---

## Query API

All routes sit behind `authenticate` + `assertPlatformOwner`. Historical
platform data is not club-readable and no club role reaches any of it.

```
GET /api/v1/system/fabric/history
  ?from=2028-05-01T00:00:00Z
  &to=2028-05-31T23:59:59Z
  &source=medical
  &eventType=injury.created
  &clubId=…&entityType=MATCH&entityId=…&correlationId=…
  &retentionClass=AUDIT
  &limit=50&cursor=<nextCursor>

GET /api/v1/system/fabric/history/count     same filters, no rows
GET /api/v1/system/fabric/history/replay    same filters, read-only
GET /api/v1/system/fabric/history/health    writer, window, retention, archive
```

A day, a month, a year and a custom range are the same query with different
bounds, so a future interface needs no endpoint per granularity.

**Always bounded.** `limit` is clamped to `HISTORY_MAX_PAGE` (200); further
pages are reached with the cursor. There is no request that returns the table.

**The cursor is a pair**, `(occurredAt, id)`, not a timestamp — two events
inside one millisecond are ordinary, and a cursor on time alone either replays
one for ever or skips one.

---

## Replay

`replayHistory()` is **read-only event reconstruction**. It retrieves what
happened, in the order it happened, and hands it back.

It does not re-run a business action, write to any table, publish an event, or
send an email, notification, transfer or AI request. That is not a promise the
comment makes — it is a property of the code: the module has no writer and no
transport, and a test reads the source to keep it that way.

The live board's existing Replay control is **unchanged**. This is the
foundation it can be pointed at later; that is a UI change and belongs in one.

---

## Cold archive — designed, not enabled

`archiveEnabled()` returns `false` unless **both** a bucket and credentials are
configured. Today neither is, so `archiveStatus()` reports `NOT_CONFIGURED` and
names what is missing.

```
FABRIC_ARCHIVE_BUCKET
FABRIC_ARCHIVE_S3_ENDPOINT      (optional for AWS)
FABRIC_ARCHIVE_S3_REGION
FABRIC_ARCHIVE_S3_ACCESS_KEY_ID
FABRIC_ARCHIVE_S3_SECRET_ACCESS_KEY
```

The repository already depends on `@aws-sdk/client-s3` and already builds an S3
client in `services/video-hls.service.ts` against `VIDEO_S3_*`, so the provider
abstraction exists — what does not exist is a configured archive bucket.
`exportArchiveBatch()` **throws** rather than silently succeeding: a no-op
export is how a platform comes to believe it has an archive it has never
written a byte to, and then deletes the hot rows.

**Format**: Parquet. **Partitioning**: Hive-style, date first because the
commonest archive question is a range and a reader that can skip whole
directories reads a thousandth of the bytes.

```
year=2030/month=05/day=14/source=matches/<batchId>.parquet
```

**Manifest** (`ArchiveManifest`): `batchId`, `recordCount`, `minOccurredAt`,
`maxOccurredAt`, `checksum` + `checksumAlgorithm`, `manifestVersion`,
`schemaVersions`, `sources`, `retentionClasses`, `objectKey`, `format`,
`createdAt`.

**`mayPurgeAfterArchive()` returns `false`,** and that is the more important
half of the design. An export *starting* is not an archive *existing*. A batch
is only safe to forget once its manifest has been read back and its checksum
verified against the bytes in the bucket, **and** a retention policy has said
that class of record may go. This build has neither.

---

## Snapshots — designed, not built

True "state at time X" needs:

```
snapshot taken before T  +  events between the snapshot and T  =  state at T
```

Familista has several domain snapshot models (`MatchTacticalSnapshot`,
`RegionalHealthSnapshot`, `ContractIntelligenceSnapshot`,
`FranchisePerformanceSnapshot`) but **no Fabric-wide snapshot infrastructure**,
and building one means snapshotting every table the events describe — a far
larger change than a historical store, with its own storage cost and its own
consistency problem.

So this PR builds none. The design it would follow:

1. A periodic job writes a versioned snapshot of a **named aggregate** (a club's
   squad, a competition's table), not of the whole database.
2. The snapshot records the `(occurredAt, id)` cursor of the last event included.
3. Reconstruction reads the newest snapshot at or before T, then replays
   `queryHistory` forward from that cursor to T.
4. `replayHistory` is already the second half. It needs no change.

The honest constraint: reconstruction is only as good as the events, and the
events carry no payload. State reconstruction will therefore need either
aggregate snapshots dense enough to stand alone, or a per-aggregate decision
about which payload fields may be retained — which is a privacy decision, not
an engineering one.

---

## Where reliable history begins

**The date this migration is deployed.** Nothing before it.

Events emitted before `FabricEventHistory` existed were never written to it, and
manufacturing them would be inventing the past. Some *may* be recoverable:
`EventOutbox` rows whose payload carries a `__familista_event` envelope are real
records of real events, and a backfill from them is legitimate **with
provenance** — each backfilled row marked as reconstructed rather than observed.

That backfill is not in this PR. Whether it is worth running depends on how much
outbox history the deployment still holds, which is a question about production
data that this session cannot see.

`GET /api/v1/system/fabric/history/health` reports the real window
(`earliest`, `latest`, `total`) from the data itself, so the answer is never a
configured intention.

---

## Performance

- Every query is indexed and every page is clamped.
- No historical query runs in a normal user request path. The only thing on the
  hot path is one detached insert.
- The cursor is a range scan on `(occurredAt, id)`, not an offset walk.
- `historyWindow()` is two `findFirst` reads on an index plus a count.
- Six indexes, deliberately. A partial index per high-volume source is the next
  step when one source's volume justifies it; adding more now would slow every
  write for queries nobody has run.
