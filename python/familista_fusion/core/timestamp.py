"""
GlobalTimestampSynchronizer — Python reference implementation.

Mirrors src/fusion/timestamp.ts. Heterogeneous sensors arrive with
heterogeneous clocks (GPS quartz, ECG AFE, neuromorphic ASIC, biochem
patch, human operator). Every packet must be projected onto ONE monotonic
axis before the fusion engine touches it:

    globalMs(p) ≈ deviceUs(p)/1000 + offsetMs(session) - drift_ppm·Δt/1e6

The estimator is per-DeviceSession: one EMA-smoothed offset and one
drift-ppm slope. Memory: O(1) per session.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional

from .packets import GlobalTimestampMs


EMA_ALPHA = 0.05      # smoothing factor — slow & stable
DRIFT_PPM_CLAMP = 200 # legitimate quartz drift is rarely > 50 ppm


@dataclass
class _SessionClock:
    offset_ms: float
    drift_ppm: float = 0.0
    last_device_us: int = 0
    last_server_ms: GlobalTimestampMs = 0
    samples: int = 0


class GlobalTimestampSynchronizer:
    """
    One instance per process. Carries an in-memory map
    device_session_id → SessionClock. Thread-safety is the caller's
    responsibility — the fusion engine accesses it from a single asyncio
    loop in production.
    """

    def __init__(self) -> None:
        self._clocks: Dict[str, _SessionClock] = {}

    def bootstrap(self, device_session_id: str, device_us: int, server_rx_ms: GlobalTimestampMs) -> None:
        offset = server_rx_ms - device_us / 1000.0
        self._clocks[device_session_id] = _SessionClock(
            offset_ms=offset,
            last_device_us=device_us,
            last_server_ms=server_rx_ms,
            samples=1,
        )

    def update(self, device_session_id: str, device_us: int, server_rx_ms: GlobalTimestampMs) -> None:
        cur = self._clocks.get(device_session_id)
        if cur is None:
            return self.bootstrap(device_session_id, device_us, server_rx_ms)

        new_offset = server_rx_ms - device_us / 1000.0
        cur.offset_ms = cur.offset_ms * (1 - EMA_ALPHA) + new_offset * EMA_ALPHA

        d_dev = (device_us - cur.last_device_us) / 1000.0
        d_srv = server_rx_ms - cur.last_server_ms
        if d_dev > 1 and d_srv > 1:
            sample_drift_ppm = ((d_dev - d_srv) / d_srv) * 1_000_000
            clamped = max(-DRIFT_PPM_CLAMP, min(DRIFT_PPM_CLAMP, sample_drift_ppm))
            cur.drift_ppm = cur.drift_ppm * (1 - EMA_ALPHA) + clamped * EMA_ALPHA

        cur.last_device_us = device_us
        cur.last_server_ms = server_rx_ms
        cur.samples += 1

    def to_global_ms(self, device_session_id: str, device_us: int) -> GlobalTimestampMs:
        cur = self._clocks.get(device_session_id)
        if cur is None:
            # Without an anchor, the best we can do is project as if offset is 0.
            return device_us // 1000
        t_dev_ms = device_us / 1000.0
        dt_ms    = t_dev_ms - cur.last_device_us / 1000.0
        drift_correction = (cur.drift_ppm * dt_ms) / 1_000_000.0
        return int(round(t_dev_ms + cur.offset_ms - drift_correction))

    def inspect(self, device_session_id: str) -> Optional[Dict[str, float]]:
        cur = self._clocks.get(device_session_id)
        if cur is None:
            return None
        return {
            "offset_ms":   cur.offset_ms,
            "drift_ppm":   cur.drift_ppm,
            "samples":     cur.samples,
            "last_device_us": cur.last_device_us,
            "last_server_ms": cur.last_server_ms,
        }

    def reset(self) -> None:
        """Test-only hook."""
        self._clocks.clear()
