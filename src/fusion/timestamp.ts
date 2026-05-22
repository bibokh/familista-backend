// Familista — Global timestamp synchroniser (Phase D-IP)
// ─────────────────────────────────────────────────────────────────────────
// Heterogeneous sensors arrive with heterogeneous clocks:
//   - GPS quartz oscillator (PPM range)
//   - ECG analogue front-end (jitters with skin contact)
//   - Neuromorphic vision (microsecond-accurate ASIC clock)
//   - Biochemical patch (slow polling, batched)
//   - Match operator (human-entered, second-precision)
//
// The fusion protocol requires every packet to be projected onto ONE
// monotonic axis: GlobalTimestampMs (ms since unix epoch, server-aligned).
//
// We estimate a linear correction per DeviceSession:
//     globalMs ≈ deviceUs/1000 + offsetMs(t) + drift_ppm · (t - t0)
//
// `offsetMs` is bootstrapped from the handshake (sessionKey response time
// vs ts received) and refined on every packet using the receiver timestamp.

import type { DeviceTimestamp, GlobalTimestampMs } from './types';

/** Per-session synchronisation state. */
interface SessionClock {
  /** Offset from device-monotonic to server-wall, ms. */
  offsetMs:   number;
  /** Optional drift rate (ppm) — slope of (device_clock - server_clock). */
  driftPpm:   number;
  /** Last packet device microsecond timestamp (for drift estimation). */
  lastDeviceUs:  number;
  /** Last packet server reception time (ms). */
  lastServerMs:  GlobalTimestampMs;
  /** Number of packets used so far for the estimate. */
  samples:    number;
}

const clocks = new Map<string, SessionClock>();

/** Smoothing factor for offset EMA. 0.05 = slow, stable. */
const EMA_ALPHA = 0.05;

/**
 * Initialise the clock for a session. Called once when the handshake
 * receives the first batch from a device.
 */
export function bootstrapClock(deviceSessionId: string, firstPacket: { deviceUs: number; serverRxMs: GlobalTimestampMs }): void {
  // Initial offset: server_now_ms - device_now_ms.
  const offsetMs = firstPacket.serverRxMs - firstPacket.deviceUs / 1000;
  clocks.set(deviceSessionId, {
    offsetMs,
    driftPpm:     0,
    lastDeviceUs: firstPacket.deviceUs,
    lastServerMs: firstPacket.serverRxMs,
    samples:      1,
  });
}

/**
 * Update the clock based on a newly received packet.
 *
 * If a device drifts faster than the server clock by N ppm, our offset
 * needs to be lowered over time. The drift estimator is a simple linear
 * regression in incremental form to keep memory O(1) per session.
 */
export function updateClock(deviceSessionId: string, packet: { deviceUs: number; serverRxMs: GlobalTimestampMs }): void {
  const cur = clocks.get(deviceSessionId);
  if (!cur) return bootstrapClock(deviceSessionId, packet);

  const newOffsetMs = packet.serverRxMs - packet.deviceUs / 1000;

  // Exponential moving average → resists jitter, follows slow drift.
  cur.offsetMs = cur.offsetMs * (1 - EMA_ALPHA) + newOffsetMs * EMA_ALPHA;

  // Drift estimate (ppm) between consecutive samples.
  if (cur.lastDeviceUs && cur.lastServerMs) {
    const dDev = (packet.deviceUs - cur.lastDeviceUs) / 1000; // ms
    const dSrv = packet.serverRxMs - cur.lastServerMs;
    if (dDev > 1 && dSrv > 1) {
      const sampleDriftPpm = ((dDev - dSrv) / dSrv) * 1_000_000;
      // Clamp pathological values; legitimate drift is typically <50 ppm.
      const clamped = Math.max(-200, Math.min(200, sampleDriftPpm));
      cur.driftPpm = cur.driftPpm * (1 - EMA_ALPHA) + clamped * EMA_ALPHA;
    }
  }

  cur.lastDeviceUs = packet.deviceUs;
  cur.lastServerMs = packet.serverRxMs;
  cur.samples += 1;
}

/**
 * Project a device-local microsecond timestamp onto the GlobalTimestamp axis.
 * If the session has no clock yet, falls back to "now".
 */
export function toGlobalMs(deviceSessionId: string, deviceUs: number): GlobalTimestampMs {
  const cur = clocks.get(deviceSessionId);
  if (!cur) return Date.now();
  // Project: deviceUs/1000 + offset, then subtract drift correction.
  const tDevMs = deviceUs / 1000;
  // Drift is in ppm: 1 ppm = 1µs per second. The longer the session, the
  // more we have to subtract. Use last-known anchor.
  const dtMs   = tDevMs - cur.lastDeviceUs / 1000;
  const driftCorrection = (cur.driftPpm * dtMs) / 1_000_000;
  return tDevMs + cur.offsetMs - driftCorrection;
}

/** Read-only inspector for diagnostics endpoints. */
export function inspectClock(deviceSessionId: string): DeviceTimestamp & { samples: number } | null {
  const cur = clocks.get(deviceSessionId);
  if (!cur) return null;
  return {
    deviceUs:   cur.lastDeviceUs,
    serverRxMs: cur.lastServerMs,
    offsetMs:   cur.offsetMs,
    driftPpm:   cur.driftPpm,
    samples:    cur.samples,
  };
}

/** Reset all in-memory clocks. Called only by tests. */
export function _resetAllClocks(): void { clocks.clear(); }
