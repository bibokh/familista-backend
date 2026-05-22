"""
NeuromorphicVisionAdapter — translates neuromorphic event-camera batches
into FusionPacket(kind='NEURO_VISION_EVENT', ...).

The wire format on the PCB side (likely an ESP32-S3 + Prophesee/Inivation
ASIC) is expected to be:

    struct NeuroEvent {
        uint16_t x;
        uint16_t y;
        int8_t   polarity;   // +1 or -1
        uint64_t t_us;       // device-local microseconds
    } __attribute__((packed));

This adapter accepts already-decoded Python dicts (the device-side
serialiser is out of scope here). Its job is to:

    1. apply the GlobalTimestampSynchronizer to every t_us
    2. attach (clubId, teamId, matchId) from the session row
    3. emit immutable FusionPacket objects
    4. optionally compress: only keep events whose absolute t_us delta
       to the previous packet is < HOT_WINDOW_US (≈ 50 ms)
"""

from __future__ import annotations

from typing import Iterable, List

from ..core.packets import FusionPacket, NeuroVisionEvent
from ..core.timestamp import GlobalTimestampSynchronizer


HOT_WINDOW_US = 50_000   # 50 ms — events outside this are "stale", flagged


class NeuromorphicVisionAdapter:
    """
    Stateless apart from the synchroniser. Safe to share between
    coroutines as long as the synchroniser is not concurrently mutated.
    """

    def __init__(self, sync: GlobalTimestampSynchronizer) -> None:
        self._sync = sync

    def ingest_batch(
        self,
        *,
        device_session_id: str,
        club_id: str,
        team_id: str | None,
        match_id: str | None,
        server_rx_ms: int,
        events: Iterable[dict],
    ) -> List[FusionPacket]:
        """
        Each event is a dict with keys {x, y, p, tUs}. Returns a list of
        FusionPacket objects ready for the fusion engine.
        """
        out: List[FusionPacket] = []
        for e in events:
            self._sync.update(device_session_id, int(e["tUs"]), server_rx_ms)
            ts_global = self._sync.to_global_ms(device_session_id, int(e["tUs"]))
            payload = NeuroVisionEvent(
                x=int(e["x"]), y=int(e["y"]),
                p=1 if int(e["p"]) > 0 else -1,
                tUs=int(e["tUs"]),
            )
            out.append(FusionPacket(
                kind="NEURO_VISION_EVENT",
                ts=ts_global,
                deviceSessionId=device_session_id,
                clubId=club_id,
                teamId=team_id,
                matchId=match_id,
                payload=payload,
                confidence=1.0,
            ))
        return out

    @staticmethod
    def filter_hot(events: List[FusionPacket], now_ms: int) -> List[FusionPacket]:
        """Drop events older than HOT_WINDOW_US relative to `now_ms`."""
        cutoff = now_ms - (HOT_WINDOW_US // 1000)
        return [e for e in events if e.ts >= cutoff]
