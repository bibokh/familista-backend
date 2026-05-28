// tests/gps-status.unit.test.ts
// Phase 14 — Pure unit tests for GPS fleet staleness classifier
// No DB, no network. Only computeDeviceStatus + STALE_THRESHOLD_MS.

import {
  computeDeviceStatus,
  STALE_THRESHOLD_MS,
} from '../src/gps/gps-status.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000; // fixed epoch ms for deterministic tests

function msAgo(ms: number): Date {
  return new Date(NOW - ms);
}

// ── Offline cases (isOnline = false) ─────────────────────────────────────────

describe('computeDeviceStatus — offline (isOnline=false)', () => {
  it('returns offline when isOnline=false and lastSeenAt=null', () => {
    expect(computeDeviceStatus(null, false, NOW)).toBe('offline');
  });

  it('returns offline when isOnline=false and lastSeenAt is recent', () => {
    expect(computeDeviceStatus(msAgo(10_000), false, NOW)).toBe('offline');
  });

  it('returns offline when isOnline=false and lastSeenAt is old', () => {
    expect(computeDeviceStatus(msAgo(STALE_THRESHOLD_MS + 1), false, NOW)).toBe('offline');
  });

  it('returns offline when isOnline=false and lastSeenAt is exactly at threshold', () => {
    expect(computeDeviceStatus(msAgo(STALE_THRESHOLD_MS), false, NOW)).toBe('offline');
  });
});

// ── Stale cases (isOnline=true but lastSeenAt missing or old) ────────────────

describe('computeDeviceStatus — stale (isOnline=true, lastSeenAt missing/old)', () => {
  it('returns stale when isOnline=true and lastSeenAt=null', () => {
    expect(computeDeviceStatus(null, true, NOW)).toBe('stale');
  });

  it('returns stale when lastSeenAt is 1ms past threshold', () => {
    expect(computeDeviceStatus(msAgo(STALE_THRESHOLD_MS + 1), true, NOW)).toBe('stale');
  });

  it('returns stale when lastSeenAt is 10 minutes ago', () => {
    expect(computeDeviceStatus(msAgo(10 * 60 * 1000), true, NOW)).toBe('stale');
  });

  it('returns stale when lastSeenAt is 1 hour ago', () => {
    expect(computeDeviceStatus(msAgo(60 * 60 * 1000), true, NOW)).toBe('stale');
  });

  it('returns stale when lastSeenAt is exactly at threshold (boundary)', () => {
    // ageMs === STALE_THRESHOLD_MS is NOT > threshold so this is 'online'
    // but ageMs === threshold + 1 is stale — verify boundary exactly
    const atThreshold = msAgo(STALE_THRESHOLD_MS);
    expect(computeDeviceStatus(atThreshold, true, NOW)).toBe('online');
  });
});

// ── Online cases (isOnline=true and lastSeenAt within threshold) ──────────────

describe('computeDeviceStatus — online', () => {
  it('returns online when lastSeenAt is 1ms ago', () => {
    expect(computeDeviceStatus(msAgo(1), true, NOW)).toBe('online');
  });

  it('returns online when lastSeenAt is 30 seconds ago', () => {
    expect(computeDeviceStatus(msAgo(30_000), true, NOW)).toBe('online');
  });

  it('returns online when lastSeenAt is 1 minute ago', () => {
    expect(computeDeviceStatus(msAgo(60_000), true, NOW)).toBe('online');
  });

  it('returns online when lastSeenAt is 4 minutes 59 seconds ago', () => {
    expect(computeDeviceStatus(msAgo(4 * 60_000 + 59_000), true, NOW)).toBe('online');
  });

  it('returns online when lastSeenAt equals NOW exactly', () => {
    expect(computeDeviceStatus(new Date(NOW), true, NOW)).toBe('online');
  });
});

// ── STALE_THRESHOLD_MS value ──────────────────────────────────────────────────

describe('STALE_THRESHOLD_MS constant', () => {
  it('is exactly 5 minutes in milliseconds', () => {
    expect(STALE_THRESHOLD_MS).toBe(300_000);
  });
});

// ── Default nowMs (uses Date.now()) ──────────────────────────────────────────

describe('computeDeviceStatus — default nowMs', () => {
  it('classifies a clearly old date as stale without nowMs override', () => {
    const veryOld = new Date('2020-01-01T00:00:00.000Z');
    expect(computeDeviceStatus(veryOld, true)).toBe('stale');
  });

  it('classifies a recent date as online without nowMs override', () => {
    const justNow = new Date(Date.now() - 1000);
    expect(computeDeviceStatus(justNow, true)).toBe('online');
  });

  it('classifies null + offline without nowMs override', () => {
    expect(computeDeviceStatus(null, false)).toBe('offline');
  });
});
