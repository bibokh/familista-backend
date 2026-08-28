// Familista — websocket fan-out across processes
// ─────────────────────────────────────────────────────────────────────────────
// The three realtime channels — the transfer market and match websockets, and
// the vision live feed's SSE — are in-process pub/sub: a publisher walks a
// `Map<topic, Set<callback>>` and calls everyone in it. That is complete and
// correct for the connections held by THIS process, and blind to every other
// one.
//
// With four processes behind a load balancer, four clubs watching the same
// auction are spread across four processes. A bid placed on process 2 reaches
// the one club whose socket is there. The other three see the old price until
// they re-read for some unrelated reason — which, on a live auction with a
// countdown, is a visible product regression, not a subtle one.
//
// This bridge repeats every locally-raised event on a Redis channel, and repeats
// every event it receives from Redis to the local sockets. Two rules make that
// safe:
//
//   · An event received from Redis is delivered LOCALLY ONLY. If a received
//     event were re-published, two processes would bounce it between them
//     forever. `deliverRemote` on each channel exists precisely to be the
//     one-way door.
//
//   · A process ignores its own messages. Redis pub/sub delivers to every
//     subscriber including the publisher, and the publishing process already
//     delivered locally, so its own echo is dropped by `origin`.
//
// ── Scope is preserved, not widened
//
// A CLUB-scoped market event carries the club ids it may reach, and the
// receiving process delivers it to exactly those clubs' subscriber sets — the
// same authorisation the originating process applied. Crossing a process
// boundary does not turn a private event into a public one. This matters because
// market events are invalidations rather than state: what travels is "these
// surfaces went stale", never a fee, a bid, a balance or a message. The client
// then re-reads the canonical endpoint, which authorises the read on its own.
// So even a mis-delivered invalidation cannot leak anything an HTTP request
// would have refused.
//
// ── When Redis is unreachable
//
// Delivery degrades to local, which is what it was before this file existed:
// clients on the affected process see stale prices until they re-read, and
// nothing stored is wrong. This is the one piece of shared state whose failure
// is allowed to be quiet-ish — it costs freshness, never correctness and never
// a security property — but it is still logged, because an operator watching
// "why are prices stale for some users" should not have to guess.

import { getRedis, redisConfigured, rkey, whenReady } from './redis';
import { INSTANCE_ID } from './leader';
import { logger } from '../utils/logger';
import * as market from '../realtime/market-channel';
import * as match from '../realtime/match-channel';
import * as vision from '../services/vision-realtime.service';
import * as identity from '../middleware/auth.middleware';

const MARKET_CHANNEL = rkey('ch', 'market');
const MATCH_CHANNEL  = rkey('ch', 'match');
// The vision live feed is SSE rather than a websocket, but a Server-Sent Events
// connection is pinned to one process in exactly the same way, so it needs the
// same bridge. A sideline dashboard must not miss an incident because the
// detection was published on a different worker.
const VISION_CHANNEL = rkey('ch', 'vision');
// Who a user currently is — which club they act for above all — is cached for a
// few seconds in each process. A switch invalidates it, and that invalidation
// has to reach every process or the others keep answering as the club the user
// just left. This is the one channel here that carries a security property
// rather than freshness.
const IDENTITY_CHANNEL = rkey('ch', 'identity');

interface Envelope<T> { origin: string; body: T }

let started = false;
let published = 0;
let received = 0;
let dropped = 0;

function send(channel: string, body: unknown): void {
  const client = getRedis('pub');
  if (!client) return;
  const envelope: Envelope<unknown> = { origin: INSTANCE_ID, body };
  const payload = JSON.stringify(envelope);
  // Fire and forget. A realtime invalidation that fails to cross is a stale
  // screen, and awaiting it here would put Redis latency on the request that
  // placed the bid.
  //
  // `whenReady` first, because `enableOfflineQueue: false` rejects a publish
  // issued on a socket that is still opening — which is every publish in the
  // first moments after boot, and every publish during a reconnect. Resolved
  // instantly once connected, so the steady-state path is unchanged.
  whenReady(client, 1000)
    .then(() => client.publish(channel, payload))
    .then(
      () => { published++; },
      (err: Error) => { noteFailure('publish', err); },
    );
}

let lastFailureLoggedAt = 0;
function noteFailure(op: string, err: Error): void {
  const now = Date.now();
  if (now - lastFailureLoggedAt < 30_000) return;
  lastFailureLoggedAt = now;
  logger.error('[channel-bridge] cross-process realtime delivery failing — clients on other processes will see stale data until they re-read', {
    op, err: err.message,
  });
}

/**
 * Start bridging. Idempotent, and a no-op without Redis — in which case there
 * is one process and in-process pub/sub already reaches every socket.
 */
export function startChannelBridge(): void {
  if (started) return;
  if (!redisConfigured()) {
    logger.info('[channel-bridge] no Redis — single process, in-process fan-out already reaches every socket');
    return;
  }
  const sub = getRedis('sub');
  if (!sub) return;
  // Open the publisher NOW rather than on the first event. A connection opened
  // lazily is a connection that is still opening when the event it was created
  // for tries to use it, and that event is lost.
  getRedis('pub');
  started = true;

  market.setRemotePublisher((payload) => send(MARKET_CHANNEL, payload));
  match.setRemotePublisher((event) => send(MATCH_CHANNEL, event));
  vision.setRemotePublisher((payload) => send(VISION_CHANNEL, payload));
  identity.setRemoteIdentityPublisher((userId) => send(IDENTITY_CHANNEL, { userId }));

  sub.on('message', (channel: string, raw: string) => {
    let envelope: Envelope<unknown>;
    try { envelope = JSON.parse(raw) as Envelope<unknown>; }
    catch { dropped++; return; }
    // Our own echo. We already delivered it locally when we published it.
    if (envelope.origin === INSTANCE_ID) { dropped++; return; }
    received++;
    try {
      if (channel === MARKET_CHANNEL) {
        market.deliverRemote(envelope.body as Parameters<typeof market.deliverRemote>[0]);
      } else if (channel === MATCH_CHANNEL) {
        match.deliverRemote(envelope.body as Parameters<typeof match.deliverRemote>[0]);
      } else if (channel === VISION_CHANNEL) {
        vision.deliverRemote(envelope.body as Parameters<typeof vision.deliverRemote>[0]);
      } else if (channel === IDENTITY_CHANNEL) {
        // Local only — forgetIdentityLocal does not re-publish, so a forget
        // cannot bounce between processes.
        identity.forgetIdentityLocal((envelope.body as { userId: string | null }).userId);
      }
    } catch (err) {
      // One malformed message must never take the subscriber down; the socket
      // it would have refreshed simply re-reads on its own schedule.
      logger.warn('[channel-bridge] delivery threw', { channel, err: (err as Error).message });
    }
  });

  // Subscribe on `ready`, not now. The connection is still opening at boot, and
  // with `enableOfflineQueue: false` a SUBSCRIBE issued before the socket is
  // writable fails outright — which would leave this process publishing to the
  // others and deaf to them, the hardest version of this bug to notice.
  //
  // Binding to the event rather than awaiting it once also re-subscribes after
  // a reconnect, so a Redis restart does not permanently unhook the process.
  const doSubscribe = () => {
    sub.subscribe(MARKET_CHANNEL, MATCH_CHANNEL, VISION_CHANNEL, IDENTITY_CHANNEL).then(
      () => logger.info('[channel-bridge] subscribed', {
        channels: [MARKET_CHANNEL, MATCH_CHANNEL, VISION_CHANNEL, IDENTITY_CHANNEL], instance: INSTANCE_ID,
      }),
      (err: Error) => noteFailure('subscribe', err),
    );
  };
  if (sub.status === 'ready') doSubscribe();
  sub.on('ready', doSubscribe);
}

export async function stopChannelBridge(): Promise<void> {
  if (!started) return;
  started = false;
  market.setRemotePublisher(null);
  match.setRemotePublisher(null);
  vision.setRemotePublisher(null);
  identity.setRemoteIdentityPublisher(null);
  const sub = getRedis('sub');
  if (sub) { try { await sub.unsubscribe(MARKET_CHANNEL, MATCH_CHANNEL, VISION_CHANNEL, IDENTITY_CHANNEL); } catch { /* closing anyway */ } }
}

/** For the ops endpoint. */
export function channelBridgeStatus() {
  return { started, published, received, droppedEchoes: dropped, instance: INSTANCE_ID };
}
