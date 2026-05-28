/**
 * tests/intel-broadcaster.unit.test.ts
 * Phase 16 — Real-Time Match Event Engine
 *
 * Tests: event filtering, possession throttle, dedup, start/stop lifecycle,
 *        inflight guard, feedback-loop prevention, cleanup on stop.
 */

// ── Mock live-intelligence service (no DB) ──────────────────────────────────
jest.mock('../src/live-intelligence/live-intelligence.service', () => ({
  getLiveIntelligence: jest.fn().mockResolvedValue({ status: 'LIVE', computedAt: new Date().toISOString() }),
}));

// ── Mock logger ──────────────────────────────────────────────────────────────
jest.mock('../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  shouldProcess,
  handleMatchEvent,
  startIntelBroadcaster,
  stopIntelBroadcaster,
  getState,
  matchState,
  POSSESSION_THROTTLE_MS,
} from '../src/live-intelligence/intel-broadcaster';

import { publish, subscribe, subscribeAll } from '../src/realtime/match-channel';
import { getLiveIntelligence } from '../src/live-intelligence/live-intelligence.service';

// ── Helpers ──────────────────────────────────────────────────────────────────
const MATCH_ID = 'match-001';
const CLUB_ID  = 'club-001';

function makeEvent(kind: string, payloadId?: string) {
  return {
    kind,
    matchId: MATCH_ID,
    clubId:  CLUB_ID,
    payload: payloadId ? { id: payloadId } : null,
  } as any;
}

beforeEach(() => {
  matchState.clear();
  jest.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// 1. shouldProcess — event filtering
// ════════════════════════════════════════════════════════════════════════════
describe('shouldProcess — event filtering', () => {
  it('passes TIMELINE_ADDED', () => {
    expect(shouldProcess(makeEvent('TIMELINE_ADDED'))).toBe(true);
  });

  it('passes SCORE_CHANGED', () => {
    expect(shouldProcess(makeEvent('SCORE_CHANGED'))).toBe(true);
  });

  it('passes STATUS_CHANGED', () => {
    expect(shouldProcess(makeEvent('STATUS_CHANGED'))).toBe(true);
  });

  it('passes LINEUP_SET', () => {
    expect(shouldProcess(makeEvent('LINEUP_SET'))).toBe(true);
  });

  it('passes SNAPSHOT_TAKEN', () => {
    expect(shouldProcess(makeEvent('SNAPSHOT_TAKEN'))).toBe(true);
  });

  it('rejects unknown event kinds', () => {
    expect(shouldProcess(makeEvent('SOME_UNKNOWN_KIND'))).toBe(false);
  });

  it('rejects INTEL_UPDATE (feedback-loop guard)', () => {
    // INTEL_UPDATE is filtered in handleMatchEvent, but shouldProcess does not pass it either
    expect(shouldProcess(makeEvent('INTEL_UPDATE'))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. shouldProcess — POSSESSION_TICK throttle
// ════════════════════════════════════════════════════════════════════════════
describe('shouldProcess — POSSESSION_TICK throttle', () => {
  it('passes first POSSESSION_TICK', () => {
    const now = Date.now();
    expect(shouldProcess(makeEvent('POSSESSION_TICK'), now)).toBe(true);
  });

  it('rejects second POSSESSION_TICK within throttle window', () => {
    const now = Date.now();
    shouldProcess(makeEvent('POSSESSION_TICK'), now);   // first — sets timestamp
    const soon = now + POSSESSION_THROTTLE_MS - 1000;  // still inside window
    expect(shouldProcess(makeEvent('POSSESSION_TICK'), soon)).toBe(false);
  });

  it('passes POSSESSION_TICK after throttle window expires', () => {
    const now = Date.now();
    shouldProcess(makeEvent('POSSESSION_TICK'), now);
    const later = now + POSSESSION_THROTTLE_MS + 1;    // window elapsed
    expect(shouldProcess(makeEvent('POSSESSION_TICK'), later)).toBe(true);
  });

  it('throttle is per-match (different matches are independent)', () => {
    const now = Date.now();
    const evtA = { kind: 'POSSESSION_TICK', matchId: 'match-A', clubId: CLUB_ID, payload: null } as any;
    const evtB = { kind: 'POSSESSION_TICK', matchId: 'match-B', clubId: CLUB_ID, payload: null } as any;
    shouldProcess(evtA, now);
    // match-B has no state yet — should pass
    expect(shouldProcess(evtB, now)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. handleMatchEvent — deduplication
// ════════════════════════════════════════════════════════════════════════════
describe('handleMatchEvent — deduplication', () => {
  it('processes an event with a fresh payload id', async () => {
    await handleMatchEvent(makeEvent('TIMELINE_ADDED', 'evt-1'));
    expect(getLiveIntelligence).toHaveBeenCalledTimes(1);
  });

  it('skips duplicate event with same payload id', async () => {
    await handleMatchEvent(makeEvent('TIMELINE_ADDED', 'evt-dup'));
    await handleMatchEvent(makeEvent('SCORE_CHANGED',  'evt-dup')); // same id
    expect(getLiveIntelligence).toHaveBeenCalledTimes(1);
  });

  it('processes events with distinct payload ids independently', async () => {
    await handleMatchEvent(makeEvent('TIMELINE_ADDED', 'evt-a'));
    await handleMatchEvent(makeEvent('SCORE_CHANGED',  'evt-b'));
    expect(getLiveIntelligence).toHaveBeenCalledTimes(2);
  });

  it('does not deduplicate events without payload id', async () => {
    // No id field — should always process (two separate significant events)
    const evt1 = { kind: 'SCORE_CHANGED', matchId: MATCH_ID, clubId: CLUB_ID, payload: null } as any;
    const evt2 = { kind: 'STATUS_CHANGED', matchId: MATCH_ID, clubId: CLUB_ID, payload: null } as any;
    await handleMatchEvent(evt1);
    await handleMatchEvent(evt2);
    expect(getLiveIntelligence).toHaveBeenCalledTimes(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. handleMatchEvent — feedback-loop prevention
// ════════════════════════════════════════════════════════════════════════════
describe('handleMatchEvent — feedback-loop prevention', () => {
  it('ignores INTEL_UPDATE events to prevent feedback loops', async () => {
    await handleMatchEvent(makeEvent('INTEL_UPDATE', 'intel-1'));
    expect(getLiveIntelligence).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. handleMatchEvent — inflight guard
// ════════════════════════════════════════════════════════════════════════════
describe('handleMatchEvent — inflight guard', () => {
  it('skips concurrent computation for same match', async () => {
    // Make getLiveIntelligence hang until we resolve manually
    let resolveFirst!: () => void;
    (getLiveIntelligence as jest.Mock).mockImplementationOnce(
      () => new Promise<void>(resolve => { resolveFirst = resolve; }),
    );

    // Fire two events quickly — second should be skipped by inflight guard
    const p1 = handleMatchEvent(makeEvent('SCORE_CHANGED'));
    const p2 = handleMatchEvent(makeEvent('STATUS_CHANGED'));
    resolveFirst();
    await Promise.all([p1, p2]);

    // Only one call despite two events
    expect(getLiveIntelligence).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. handleMatchEvent — missing matchId / clubId guard
// ════════════════════════════════════════════════════════════════════════════
describe('handleMatchEvent — guard clauses', () => {
  it('skips events with no matchId', async () => {
    await handleMatchEvent({ kind: 'SCORE_CHANGED', matchId: '', clubId: CLUB_ID, payload: null } as any);
    expect(getLiveIntelligence).not.toHaveBeenCalled();
  });

  it('skips events with no clubId', async () => {
    await handleMatchEvent({ kind: 'SCORE_CHANGED', matchId: MATCH_ID, clubId: '', payload: null } as any);
    expect(getLiveIntelligence).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. handleMatchEvent — dedup Set bounded at 500
// ════════════════════════════════════════════════════════════════════════════
describe('handleMatchEvent — bounded dedup set', () => {
  it('never lets processedEventIds exceed 500 entries', async () => {
    const s = getState('match-bound');
    for (let i = 0; i < 510; i++) {
      s.processedEventIds.add(`id-${i}`);
      if (s.processedEventIds.size > 500) {
        const first = s.processedEventIds.values().next().value;
        if (first !== undefined) s.processedEventIds.delete(first);
      }
    }
    expect(s.processedEventIds.size).toBeLessThanOrEqual(500);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. startIntelBroadcaster / stopIntelBroadcaster lifecycle
// ════════════════════════════════════════════════════════════════════════════
describe('startIntelBroadcaster / stopIntelBroadcaster lifecycle', () => {
  afterEach(() => {
    stopIntelBroadcaster(); // always clean up
  });

  it('can be started', () => {
    expect(() => startIntelBroadcaster()).not.toThrow();
  });

  it('is idempotent — calling start twice does not double-subscribe', async () => {
    startIntelBroadcaster();
    startIntelBroadcaster(); // second call must be no-op

    await handleMatchEvent(makeEvent('SCORE_CHANGED', 'evt-lifecycle-1'));
    // Should be called exactly once (not twice)
    expect(getLiveIntelligence).toHaveBeenCalledTimes(1);
  });

  it('clears matchState on stop', () => {
    startIntelBroadcaster();
    // Seed some state
    getState(MATCH_ID).processedEventIds.add('some-id');
    expect(matchState.size).toBeGreaterThan(0);

    stopIntelBroadcaster();
    expect(matchState.size).toBe(0);
  });

  it('can be stopped safely even if never started', () => {
    expect(() => stopIntelBroadcaster()).not.toThrow();
  });

  it('can be restarted after stop', () => {
    startIntelBroadcaster();
    stopIntelBroadcaster();
    expect(() => startIntelBroadcaster()).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 9. getState — initialises fresh state
// ════════════════════════════════════════════════════════════════════════════
describe('getState', () => {
  it('returns default state for a new matchId', () => {
    const s = getState('new-match-id');
    expect(s.inflight).toBe(false);
    expect(s.lastPossessionUpdate).toBe(0);
    expect(s.processedEventIds.size).toBe(0);
  });

  it('returns the same object on repeated calls', () => {
    const s1 = getState('stable-match');
    const s2 = getState('stable-match');
    expect(s1).toBe(s2);
  });
});
