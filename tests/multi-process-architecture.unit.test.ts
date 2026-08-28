/**
 * tests/multi-process-architecture.unit.test.ts
 *
 * What has to be true before a second Node process is allowed to exist.
 *
 * Every item here was process-local state that would have given the WRONG
 * ANSWER under clustering — not merely a slower one:
 *
 *   1. Rate limits. A bucket per process is N × the configured ceiling, and
 *      nothing says so: the config still reads 300 while 1200 get through.
 *      Both limiters had this — the three-tier one and the edge guard, which
 *      was using express-rate-limit's default in-process MemoryStore.
 *
 *   2. Replay protection. A nonce remembered in process A's Map is not a replay
 *      when the load balancer sends the retry to process B. This is the only
 *      one that is a security hole rather than a degradation, and it is the
 *      only one that fails CLOSED.
 *
 *   3. Background timers. Six of them, each written assuming it is alone. Two
 *      settlement sweeps racing one due auction, two dispatchers sending one
 *      notification, two transcoders claiming one job.
 *
 *   4. Websocket fan-out. A socket lives on one process, so a broadcast raised
 *      on another never reaches it.
 *
 * And the rule that ties them together: a Redis outage may cost availability or
 * freshness. It may never quietly cost a security property. So the limiters
 * degrade to local enforcement and SAY SO, and the nonce store refuses.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const root = (p: string) => join(__dirname, '..', p);
const read = (p: string) => readFileSync(root(p), 'utf8');

function fnBody(src: string, name: string) {
  const at = src.search(new RegExp(`(export )?(async )?function ${name}\\s*\\(`));
  if (at < 0) return '';
  const i = src.indexOf('{', at);
  let depth = 0, j = i;
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) break;
  }
  return src.slice(i, j);
}

describe('rate limiting is one limit, not one per process', () => {
  const REDIS = read('src/middleware/rate-limit-redis.store.ts');
  const EDGE  = read('src/middleware/edge-rate-limit.store.ts');
  const APP   = read('src/app.ts');

  it('the token bucket is a Lua script, so refill-and-decrement is atomic', () => {
    // Read-then-write from four processes would let two of them see the same
    // last token. One round trip inside Redis cannot.
    expect(REDIS).toContain('TAKE_LUA');
    expect(REDIS).toContain('this.client.eval');
  });

  it('and it NO LONGER fails open when Redis is unreachable', () => {
    // The old catch returned `true` — a Redis outage silently removed rate
    // limiting from the whole platform, at the moment infrastructure was
    // already unwell.
    const take = fnBody(REDIS, 'take');
    expect(take).not.toMatch(/catch[\s\S]*return true/);
    expect(REDIS).toContain('return memoryStore.take(key, capacity, refillMs);');
    expect(REDIS).toContain('rate limiting is now PER-PROCESS, not global');
  });

  it('implements peek — without it the credential bucket would be unenforced', () => {
    // rateLimitAuth treats a store with no `peek` as "always has room", so a
    // Redis store missing it leaves the failed-attempt ceiling off while
    // looking enabled.
    expect(REDIS).toContain('async peek(');
    expect(REDIS).toContain('PEEK_LUA');
    // and peek must not spend a token
    expect(fnBody(REDIS, 'peek')).not.toContain('TAKE_LUA');
    const MW = read('src/middleware/rate-limit.middleware.ts');
    expect(MW).toContain('store.peek');
  });

  it('the edge guard has a shared store too, not the library default', () => {
    expect(APP).toContain('store: redisConfigured() ? new RedisEdgeStore() : undefined');
    expect(EDGE).toContain('pipeline.incr(k)');
    // PEXPIRE ... NX keeps the window fixed: a later hit must not push the reset out
    expect(EDGE).toContain("pexpire(k, this.windowMs, 'NX')");
    expect(EDGE).toContain('edge guard is now PER-PROCESS');
  });

  it('a still-opening socket is not treated as an outage', () => {
    // enableOfflineQueue:false rejects commands issued before the socket is
    // writable — which is every command at boot and during a reconnect. Without
    // this the service announces a false outage on every start.
    for (const s of [REDIS, EDGE]) expect(s).toContain('whenReady(');
  });
});

describe('replay protection fails closed, and never falls back to a local map', () => {
  const N = read('src/security/device-nonce.service.ts');

  it('uses SET NX, which IS the check — no read-then-write window', () => {
    expect(N).toMatch(/client\.set\([\s\S]*?'PX', TTL_MS, 'NX'\)/);
    expect(N).toContain("created === 'OK'");
  });

  it('refuses when the shared store cannot answer', () => {
    // An unanswerable replay check is a failed replay check. Refusing a device
    // costs a reading; accepting a replay is a signed request executing twice.
    const f = fnBody(N, 'assertFreshAndRemember');
    expect(f).toContain('noteFailure');
    expect(f).not.toContain('rememberLocally(scopeId, nonce);\n  } catch');
    // the local map is reachable ONLY when Redis is not configured at all
    expect(f).toMatch(/if \(!redisConfigured\(\)\) return rememberLocally/);
  });

  it('and says so, loudly, rather than degrading quietly', () => {
    expect(N).toContain('REFUSING signed device requests (fail-closed)');
    expect(N).toContain('failClosed: true');
  });

  it('every call site awaits it — a floating Promise is always truthy', () => {
    // `if (!assertFreshAndRemember(...))` on a Promise is `if (!truthy)`, which
    // is `if (false)`: replay protection silently switched off everywhere.
    for (const f of ['src/security-l/attestation.service.ts',
                     'src/vision/event-stream.service.ts',
                     'src/vision/biomechanical-ingest.service.ts',
                     'src/federated/federated.service.ts']) {
      const s = read(f);
      expect(s).toContain('await assertFreshAndRemember(');
      expect(s).not.toMatch(/[^t] assertFreshAndRemember\(/);
    }
  });
});

describe('the background timers run in exactly one process', () => {
  const W = read('src/infra/background-workers.ts');
  const L = read('src/infra/leader.ts');
  const S = read('src/server.ts');

  it('server.ts no longer starts them directly', () => {
    expect(S).not.toContain('safeStart(\'startAuctionSettlement\'');
    expect(S).toContain('startOwnedWorkers()');
  });

  it('the settlement sweep is among the leased set', () => {
    expect(W).toContain('startAuctionSettlementWorker');
    expect(W).toContain('startStatsAggregatorWorker');
    expect(W).toContain('startVideoTranscodeWorker');
  });

  it('renewal is compare-and-extend, so a stalled process cannot steal it back', () => {
    // A plain PEXPIRE would let a process paused past its expiry come back and
    // extend a lease somebody else now holds — two owners, which is the whole
    // failure this prevents.
    expect(L).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(L).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[2])");
    // releasing someone else's lease is the same bug
    expect(L).toContain('RELEASE_LUA');
  });

  it('and an owner that loses sight of Redis stands down rather than assuming', () => {
    expect(L).toContain("lose('redis error: '");
    expect(fnBody(L, 'runOnce')).toContain('return false;');
  });

  it('renews well inside the TTL so one blip does not hand ownership around', () => {
    expect(L).toContain('Math.floor(ttlMs / 3)');
  });
});

describe('realtime events cross the process boundary', () => {
  const B  = read('src/infra/channel-bridge.ts');
  const MK = read('src/realtime/market-channel.ts');
  const MT = read('src/realtime/match-channel.ts');
  const VS = read('src/services/vision-realtime.service.ts');

  it('all three realtime channels are bridged, SSE included', () => {
    // The vision live feed is Server-Sent Events, not a websocket — but an SSE
    // connection is pinned to one process the same way, so a sideline dashboard
    // would miss an incident detected on another worker.
    expect(B).toContain('VISION_CHANNEL');
    expect(B).toContain('vision.setRemotePublisher(');
    expect(B).toContain('sub.subscribe(MARKET_CHANNEL, MATCH_CHANNEL, VISION_CHANNEL, IDENTITY_CHANNEL)');
    expect(VS).toContain('export function deliverRemote(');
    expect(fnBody(VS, 'deliverRemote')).not.toContain('remotePublish');
  });

  it('a locally raised event is also published for the other processes', () => {
    expect(MK).toContain('remotePublish?.({ kind: \'public\', event: full });');
    expect(MK).toContain('remotePublish?.({ kind: \'clubs\', clubIds: ids, event: full });');
    expect(MT).toContain('remotePublish?.(event);');
  });

  it('and one received from Redis is delivered locally ONLY — never re-published', () => {
    // Re-publishing a received event would bounce it between processes forever.
    for (const [src, name] of [[MK, 'deliverRemote'], [MT, 'deliverRemote']] as const) {
      expect(fnBody(src, name)).not.toContain('remotePublish');
    }
  });

  it('a process drops its own echo, having already delivered it', () => {
    expect(B).toContain('envelope.origin === INSTANCE_ID');
  });

  it('club scope survives the crossing — a private event stays private', () => {
    expect(MK).toContain('deliverToClubs(payload.clubIds ?? [], payload.event)');
    // and the bridge hands it to that function rather than to the public one
    expect(B).toContain('market.deliverRemote(');
  });

  it('the publisher connection is opened eagerly, not on the first event', () => {
    // A lazily opened connection is still opening when the event that created
    // it tries to use it, and that event is lost.
    expect(B).toContain("getRedis('pub');");
    expect(B).toContain('whenReady(client, 1000)');
  });

  it('and it re-subscribes after a reconnect rather than going deaf', () => {
    expect(B).toContain("sub.on('ready', doSubscribe)");
  });
});

describe('clustering refuses to start unless Redis actually answered', () => {
  const C = read('src/infra/cluster.ts');

  it('a set REDIS_URL is not sufficient — it must reply to PING', () => {
    expect(C).toContain('await verifyRedis()');
    expect(C).toContain('REDIS_URL is set but Redis did not answer');
    expect(C).toContain('REDIS_URL is not set');
  });

  it('and refusing means serving as one process, not failing to boot', () => {
    expect(C).toContain('Serving as a single process');
    // Both refusals return false — the caller then goes on to serve normally.
    // Neither aborts the boot, which would turn a misconfigured REDIS_URL into
    // an outage instead of a slower but correct service.
    const f = fnBody(C, 'startClusterPrimary');
    for (const m of f.matchAll(/Serving as a single process[\s\S]{0,120}?\n\s*\);\n(\s*)return (\w+);/g)) {
      expect(m[2]).toBe('false');
    }
    expect(f.match(/return false;/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('fixed budgets are divided across workers, not multiplied by them', () => {
    // 4 workers × 25 connections would be 100 against a server permitting 100.
    expect(C).toContain('DB_CONNECTION_LIMIT: String(share(dbTotal, workers, 2))');
    expect(C).toContain('UV_THREADPOOL_SIZE: String(share(uvTotal, workers, 2))');
  });

  it('never asks for more processes than there are usable CPUs', () => {
    expect(C).toContain('Math.min(n, Math.max(1, cpus))');
  });

  it('sizes workers from the CONTAINER quota, not the host core count', () => {
    // os.cpus().length reports the host. A 1-CPU instance scheduled onto a
    // 16-core machine reports 16, and forking 16 workers onto 1 CPU is far
    // worse than not clustering — silently, because every number looks
    // plausible.
    expect(C).toContain('/sys/fs/cgroup/cpu.max');
    expect(C).toContain('cpu.cfs_quota_us');
    expect(C).toContain('export function effectiveCpus()');
    // and a fractional allowance floors to one rather than falling through to
    // the host count, which is the half-CPU instance case
    const f = fnBody(C, 'effectiveCpus');
    expect(f).toContain('Math.max(1, Math.min(Math.floor(quota / period), host))');
    expect(f).not.toMatch(/cpus >= 1\) return/);
  });
});

describe('the shared state is observable, so a degradation cannot pass unnoticed', () => {
  const R = read('src/infra/redis.ts');

  it('health distinguishes "not configured" from "configured and down"', () => {
    // The two mean opposite things: one is a supported single-process
    // deployment, the other is a deployment that believes it is sharing state
    // and is not.
    expect(R).toContain('configured: redisConfigured()');
    expect(R).toContain("healthy:    redisHealthy('cmd')");
    expect(R).toContain('everConnected');
  });

  it('and the ops endpoint reports all of it', () => {
    const S = read('src/controllers/security.controller.ts');
    for (const k of ['redisStatus()', 'clusterStatus()', 'workerOwnershipStatus()', 'channelBridgeStatus()']) {
      expect(S).toContain(k);
    }
  });

  it('a lost connection is logged at error level, once per transition', () => {
    expect(R).toContain('shared state is degraded');
    expect(fnBody(R, 'markHealthy')).toContain('if (before === ok) return;');
  });
});
