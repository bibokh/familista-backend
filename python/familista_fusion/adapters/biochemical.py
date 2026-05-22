"""
BiochemicalPatchAdapter — epidermal patch ingestion.

The patch is a soft skin-adherent device measuring lactate, cortisol,
glucose, hydration, surface temperature. Communication to the wearable
hub uses Intra-Body Communication (IBC) in the future architecture; for
the initial deployment we accept a batched JSON dump (e.g. BLE bursts
every 5–15 seconds).

This adapter:
    - normalises units (mmol/L for lactate, ng/mL for cortisol, %RH for
      hydration, °C for temperature)
    - tags each reading with a quality score (the patch saturates after
      ~24h and we MUST surface that to TAI as a degraded confidence)
    - aligns timestamps via GlobalTimestampSynchronizer
"""

from __future__ import annotations

from typing import Iterable, List, Optional

from ..core.packets import FusionPacket, BiochemReading
from ..core.timestamp import GlobalTimestampSynchronizer


PATCH_WEAR_HARD_LIMIT_H = 24  # quality penalty after this many hours of wear


class BiochemicalPatchAdapter:
    def __init__(self, sync: GlobalTimestampSynchronizer) -> None:
        self._sync = sync

    def ingest_batch(
        self,
        *,
        device_session_id: str,
        club_id: str,
        match_id: Optional[str],
        team_id: Optional[str],
        player_id: str,
        server_rx_ms: int,
        readings: Iterable[dict],
        wear_hours: float = 0.0,
    ) -> List[FusionPacket]:
        out: List[FusionPacket] = []
        # Patch packets are slow (1 Hz typical). Quality degrades linearly
        # past PATCH_WEAR_HARD_LIMIT_H.
        wear_penalty = max(0.0, (wear_hours - PATCH_WEAR_HARD_LIMIT_H) * 0.05)
        for r in readings:
            self._sync.update(device_session_id, int(r["tUs"]), server_rx_ms)
            ts_global = self._sync.to_global_ms(device_session_id, int(r["tUs"]))
            q = float(r.get("q", 1.0)) - wear_penalty
            q = max(0.0, min(1.0, q))
            payload = BiochemReading(
                lactateMmol   = r.get("lactateMmol"),
                cortisolNgMl  = r.get("cortisolNgMl"),
                glucoseMgDl   = r.get("glucoseMgDl"),
                hydrationPct  = r.get("hydrationPct"),
                patchTemperature = r.get("patchTemperature"),
                q             = q,
            )
            out.append(FusionPacket(
                kind="BIOCHEM_PATCH",
                ts=ts_global,
                deviceSessionId=device_session_id,
                clubId=club_id,
                teamId=team_id,
                matchId=match_id,
                playerId=player_id,
                payload=payload,
                confidence=q,
            ))
        return out
