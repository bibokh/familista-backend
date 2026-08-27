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

## 3b · Sizing workers on a container

`WEB_CONCURRENCY=auto` means "one worker per CPU", and the obvious way to count
CPUs — `os.cpus().length` — is wrong on every managed platform. It reports the
cores of the HOST, not the share the container may use. A one-CPU instance
scheduled onto a sixteen-core machine reports sixteen, so `auto` would fork
sixteen workers onto one CPU: sixteen event loops timeslicing one core, sixteen
Prisma pools, sixteen sets of GC threads. That is considerably worse than not
clustering, and nothing in the logs would look wrong.

`effectiveCpus()` reads the cgroup quota first (v2 `cpu.max`, then v1
`cpu.cfs_quota_us`/`cpu.cfs_period_us`) and falls back to the host count only
when there is genuinely no quota. A fractional allowance — Render's 0.5-CPU
Starter — floors to one rather than falling through, which was a real bug caught
by the table test: `Math.floor(0.5)` is 0, the "is it at least 1" guard rejected
it, and it fell through to the host count. Exactly the instance size where
over-forking hurts most.

The cap applies to an explicit `WEB_CONCURRENCY=8` as well, not just `auto`.

**Consequence for this deployment:** `render.yaml` currently declares
`plan: standard`. If that plan is one CPU, `auto` correctly resolves to one
worker and the service runs single-process — safe, but none of the multi-core
gain below is realised. Multi-worker requires an instance type with 2+ CPUs.

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

---

## 6 · Measured capacity of one 4-core instance

All figures from this machine: 4 cores, 15 GB, 4 workers, Redis, load client on
the same box (it used 34–39% of one core — measured, not assumed, so it is not
the constraint).

### The ceiling is CPU, and it is now genuinely parallel

| | one process | four workers |
|---|---|---|
| peak server CPU (400% = all cores) | **398%** | **389%** |
| minimum system idle | 0% | 1% |

Both saturate the box at 250 users. The difference is what happens next: one
process starts refusing connections, four degrade into latency. With one event
loop, nothing accepts while it is busy; with four, one of them can.

### Steady-state navigation (sign-in excluded)

| concurrent | req/s | p50 | p95 | p99 |
|---|---|---|---|---|
| 25 | 408 | 79 ms | 453 ms | 631 ms |
| 50 | **453** | 172 ms | 784 ms | 1286 ms |
| 100 | 452 | 334 ms | 1894 ms | 5176 ms |

Throughput is flat from 50 users on: **~450 req/s is the ceiling of 4 cores**
(~112 req/s per core). Past that, more users buy only queueing.

### Sign-in is a separate, harder ceiling

~14 logins/s, and it does not improve with more processes because bcrypt at
cost 12 already uses every core through libuv. ~3.5 logins/s per core. The work
factor is not reduced to move this number.

### What broke at 250 users on one process

Not a resource limit — every candidate was measured and none was near its
ceiling:

| | peak | limit |
|---|---|---|
| accept queue depth | **0** | 511 |
| DB connections | 26 | 100 |
| TIME-WAIT sockets | 1175 | 28231 |
| open descriptors | 1193 | 20000 |

The failures were `UND_ERR_CONNECT_TIMEOUT` dying at **10214/10253 ms** — the
client's 10-second *connect* timeout — plus `ECONNRESET`, all of them on the
Transfers module, which the client fires as **9 parallel requests at once**.
With the CPU at 0% idle the single event loop could not accept that burst
within 10 s. It is CPU exhaustion surfacing as connection failures, and four
workers removed it (0 errors across every 250-user run).

### Safe supported concurrency

The honest unit is requests per second, because "concurrent users" depends
entirely on how fast each user clicks. The load client's user is deliberately
brutal: **~9 req/s each**, a request every 110 ms with no reading time. A real
person browsing is 0.2–1 req/s.

At 70% of the 450 req/s ceiling — 315 req/s sustained, leaving headroom for
sign-in bursts and the background timers:

| user model | req/s each | supported concurrent |
|---|---|---|
| load-test user (worst case) | 9.0 | **~35** |
| heavy real user | 1.0 | ~315 |
| normal active user | 0.5 | ~630 |
| reading/idle user | 0.2 | ~1575 |

Measured against the load client's own model, **100 of its users is the last
comfortable rung** (p95 474 ms, 0 errors); 150 and 250 complete without errors
but with multi-second p95.

### Scaling to 250 / 500 / 1000 load-test-grade users

CPU-bound and now parallel, so it scales close to linearly in cores. Using the
measured 450 req/s per 4 cores and the brutal 9 req/s user:

| target | req/s needed | cores | shape |
|---|---|---|---|
| 250 | ~2250 | ~20 | 5 × 4-core instances |
| 500 | ~4500 | ~40 | 10 × 4-core instances |
| 1000 | ~9000 | ~80 | 20 × 4-core instances |

Against a normal 0.5 req/s user those same targets need ~2, ~3 and ~5 cores
respectively — i.e. a single larger instance. The gap between those two columns
is why the user model has to be stated with any capacity number.

Two things scale with instance count and must move with it:

- **Database connections.** 25 per instance. Twenty instances is 500, far past
  a default `max_connections` of 100. Beyond ~4 instances this needs either a
  larger Postgres plan or a pooler (PgBouncer in transaction mode).
- **Redis.** One shared instance serves all of them; it is doing small atomic
  operations and is nowhere near a bottleneck at these rates, but it becomes a
  single point of failure for the whole fleet, so it wants its own HA plan.
