# Multi-process readiness

**Status: DONE. Clustering is safe when Redis is configured and answering, and
refuses to start when it is not.**

This file records what was process-local, what each piece would have done wrong
with a second process, where that state lives now, and what happens when the
shared store fails.

Measured on a 4-core instance: one Node process saturates the machine on
sign-ins (bcrypt is CPU-bound across all four cores via libuv). Ordinary reads
are not CPU-bound and were leaving three cores idle — that is what more
processes buy, and only once the state below is shared.

---

## The gate

`src/infra/cluster.ts` forks one worker per core when `WEB_CONCURRENCY > 1`, and
only after `verifyRedis()` — a PING that came back, not merely a `REDIS_URL`
that is set. There are three outcomes and the service serves traffic in all
three:

| Condition | Result |
|---|---|
| Redis verified | forks N workers |
| `REDIS_URL` unset | **refuses**, serves as one process, logs why |
| `REDIS_URL` set, Redis silent | **refuses**, serves as one process, logs why |

A misconfigured URL or a Redis still booting must never produce four processes
that believe they are sharing state. Refusing costs throughput; not refusing
costs the correctness of every item below.

---

## 1 · Was process-local, now shared

### Both rate limiters
`src/middleware/rate-limit-redis.store.ts` — the three-tier IP/user/tenant
bucket, a token bucket in a Lua script so refill-and-decrement is atomic.
`src/middleware/edge-rate-limit.store.ts` — the `express-rate-limit` edge guard,
which had no `store:` at all and so used the library's in-process `MemoryStore`.

Per-process buckets mean N × the configured ceiling with nothing anywhere
saying so: the config still reads 300 while 1200 get through. **Measured:** four
workers, anonymous flood — 302 allowed then 429, against ~1200 unshared.

The Redis store also gained `peek()`. Without it the credential bucket was
silently unenforced, because `rateLimitAuth` treats a store with no `peek` as
"always has room".

### Device replay protection
`src/security/device-nonce.service.ts` — `SET key NX PX`, which *is* the check:
either this request created the key or the nonce has been seen. No read-then-write
window.

This was the one item that was a security hole rather than a degradation. A
nonce remembered in process A's `Map` is not a replay when the load balancer
sends the retry to process B, so with four workers a captured signed request
replays successfully three times in four. **Measured:** a nonce accepted in one
process is rejected in another; scope still separates devices.

### Background worker ownership
`src/infra/leader.ts` + `src/infra/background-workers.ts`. A Redis lease with a
30 s TTL, renewed every 10 s, renewal being a compare-and-extend in Lua so a
process paused past its expiry cannot steal back a lease someone else now holds.

Six timers each written assuming they are alone: two settlement sweeps racing
one due auction, two dispatchers sending one notification, two transcoders
claiming one job. **Measured:** four workers, exactly one runs the timers; kill
the holder and one successor takes over within the TTL, never two at once.

### Realtime fan-out
`src/infra/channel-bridge.ts` bridges all three realtime channels over Redis
pub/sub: `market-channel`, `match-channel`, and the vision live feed in
`vision-realtime.service` — that last one is SSE rather than a websocket, but an
SSE connection is pinned to one process in exactly the same way, so a sideline
dashboard would otherwise miss an incident detected on another worker. A received event is delivered locally only — never re-published,
or two processes bounce it forever — and a process drops its own echo by
`origin`. Club scope is preserved exactly: a CLUB event still reaches only the
clubs named on it. **Measured:** 8 sockets across 4 workers, one real action on
one worker, 8/8 received; unbridged reached 2/8.

---

## 2 · Left process-local, deliberately

### The identity cache — `src/middleware/auth.middleware.ts`
5-second TTL. Fragmenting it means N cold caches instead of one, so the first
request per user per process does a database read. Correctness is unaffected:
`forgetIdentity` runs in the process that made the change and the other copies
expire within 5 seconds — the same bound the design already accepts.

### The authorisation scope caches — 30-second TTL each
`tenant-guard`, `ai-access`, `franchise-access`, `investor-access`,
`executive-access`, `vision-access`, plus the branding/theme caches.

Worth stating explicitly because these cache *permissions*, which sounds like it
should be on the shared list. It is not, and the reason is that fragmenting does
not lengthen the staleness window — it only multiplies the number of copies, each
independently bounded by the same 30 seconds. A revoked permission is honoured
late by at most the TTL whether there is one copy or four. That exposure is a
property of caching permissions at all, which the single-process design already
accepted; clustering does not widen it.

### The sensor-fusion clocks — `src/fusion/timestamp.ts`
A per-device-session EMA of clock offset and drift. Fragmenting gives N
independent estimates instead of one, each computed from real packets but from
fewer of them, so the drift correction is noisier. It never produces wrong data
and it is self-healing: `updateClock` bootstraps an unknown session, and
`toGlobalMs` already falls back to `Date.now()` for a session it has not seen —
the same fallback every session's first packet takes.

Deliberately **not** moved: this sits on the high-frequency sensor ingest path,
so sharing it would add a Redis read-modify-write per packet. That is a real
throughput cost on the hottest write path in the system, paid for an accuracy
improvement in a correction that is already clamped to ±200 ppm.

### `startRetentionWorker` / `startNotificationDispatchWorker`
Imported and stopped by `server.ts`, never started by it. That predates this
work. Starting them would be a behaviour change smuggled in under an
infrastructure task, so they stay off; their `stop` is wired for the day they
are turned on, and they are already in the leased set's shutdown path.

---

## 3 · What happens when Redis fails

The rule, stated once: **a Redis outage may cost availability or freshness. It
may never quietly cost a security property.**

| State | Behaviour |
|---|---|
| Replay protection | **fails CLOSED** — the request is refused. An unanswerable replay check is a failed one. |
| Worker ownership | **fails CLOSED** — the holder stands down rather than assume it still owns the lease. |
| Rate limits | fall back to the **local store** and log at error level. Still enforced, just per-process — a bounded degradation, never "off". |
| Websocket fan-out | degrades to local delivery. Clients elsewhere see stale prices until they re-read. Nothing stored is wrong. |

**Measured:** with Redis down, 520 requests still produced 99 × 429 — the old
code failed open and would have produced 0. Both limiters logged the
degradation. `GET /security/health` reports `redis.configured` and
`redis.healthy` separately, because "not configured" (a supported single-process
deployment) and "configured and down" (a deployment that believes it shares
state) mean opposite things.

One subtlety that cost a real bug: `enableOfflineQueue: false` makes a command
fail immediately when the socket is not writable — which is every command during
the first connect and every reconnect. A still-opening socket is not an outage,
so `whenReady()` gates the boot-time paths. Without it the service announced a
false outage on every start, refused device requests for the first seconds of
its life, and lost the first realtime event.

---

## 4 · Budgets are divided, not multiplied

Each worker builds its own Prisma pool and its own libuv thread pool. Left
alone, four workers would open 4 × 25 = 100 connections against a server
permitting 100. The primary divides both and passes each worker its share, so
the instance's totals are unchanged and only the number of processes splitting
them went up.

| Budget | Total | 4 workers |
|---|---|---|
| `DB_CONNECTION_LIMIT` | 25 | 6 each (24) |
| `UV_THREADPOOL_SIZE` | 8 | 2 each (8) |

Across instances the rule is unchanged: keep `DB_CONNECTION_LIMIT × instances`
under the database's `max_connections`.

---

## 5 · Redis configuration that matters

`maxmemoryPolicy: noeviction`, set in `render.yaml`. Under memory pressure a
default LRU policy would silently discard rate-limit buckets, device nonces and
the worker lease — turning a memory limit into a replay window and a
double-settlement race, with nothing in any log. Refusing writes is loud, and
the code treats a refusal as an outage and applies the fail-safe policy above.
