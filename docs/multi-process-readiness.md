# Multi-process readiness

**Status: clustering is NOT safe yet. Redis is required first, plus one worker
change.** This file records exactly what is process-local today and what each
piece would do wrong if a second process existed.

Measured on a 4-core instance: one Node process now saturates the machine on
sign-ins (bcrypt is CPU-bound across all four cores via libuv). Ordinary reads
are not CPU-bound and would benefit from more processes — but only after the
state below is shared.

---

## 1 · Must move to Redis before clustering — correctness

### The three-tier rate limiter — `src/middleware/rate-limit.middleware.ts`
Already supports Redis: set `REDIS_URL` and it uses `RedisRateLimitStore`
instead of `memoryStore`. **No code change needed, only the variable.**

Without it, each process keeps its own buckets. With N processes the effective
limit becomes N × the configured capacity, because a client's requests are
spread across processes by the load balancer. That does not break users — it
silently weakens the abuse control, which is worse than breaking loudly.

### The edge guard — `src/app.ts`
`express-rate-limit` with no `store:` configured, so it uses its own in-process
`MemoryStore`. Same fragmentation as above. Needs `rate-limit-redis` wired in,
or the guard reduced to a per-process share of the intended ceiling.

### The device nonce cache — `src/security/device-nonce.service.ts`
`const cache: Map<string, Entry>`. This is **replay protection**: a nonce is
accepted once. Across processes a replayed request that lands on a different
process would be accepted a second time. This is the one item on the list where
fragmentation is a security hole rather than a degradation, and it must be
shared before a second process exists.

---

## 2 · Safe to fragment — but understand what it costs

### The identity cache — `src/middleware/auth.middleware.ts`
Per-process, 5-second TTL. Fragmenting it means N cold caches instead of one,
so the first request per user per process does a database read. Correctness is
unaffected: `forgetIdentity` still runs in the process that made the change, and
the other processes' copies expire within 5 seconds — the same bound the design
already accepts. **No change required.**

### The websocket subscriber maps — `src/realtime/market-channel.ts`,
`src/realtime/match-channel.ts`
`Map<string, Set<Subscriber>>` of who is listening. A socket lives on exactly
one process, so delivery to *that* socket is correct. What breaks is a broadcast
raised on process A reaching a subscriber connected to process B — the client
simply does not receive that update until it re-reads. Live auction prices would
go stale for some clients.

**Requires** a Redis pub/sub fan-out between processes, or sticky sessions plus
accepting that a broadcast only reaches one process's clients. Not a correctness
hole in stored data, but it is a visible product regression on the live market.

---

## 3 · Must NOT run in every process — duplicated work

`src/server.ts` starts six background workers on timers:

- `startAIAgentWorker`
- `startAuctionSettlementWorker` ← **the dangerous one**
- `startRetentionWorker`
- `startNotificationDispatchWorker`
- `startStatsAggregatorWorker`
- `startVideoTranscodeWorker`

With N processes each of these runs N times. Auction settlement is the one that
matters: N processes racing to settle the same due auction. The settlement
itself is guarded by a conditional `updateMany` inside a transaction, so it
should not double-settle — but relying on that under a race nobody designed for
is not a plan, and the other five would duplicate notifications, aggregation and
transcode jobs outright.

**Requires** either a leader election (only one process runs workers) or a
`WORKERS_ENABLED` flag set on exactly one instance.

---

## The order of work

1. Provision Redis; set `REDIS_URL`. The three-tier limiter starts sharing
   immediately with no code change.
2. Wire the edge guard's store to Redis.
3. Move the device nonce cache to Redis. **Security-blocking.**
4. Gate the six background workers to a single process.
5. Fan out websocket broadcasts over Redis pub/sub, or accept stale live prices
   and use sticky sessions.
6. Only then enable clustering / `numInstances > 1`.

And when instances multiply, keep `DB_CONNECTION_LIMIT × instances` under the
database's `max_connections` (currently 25 × N against 100).
