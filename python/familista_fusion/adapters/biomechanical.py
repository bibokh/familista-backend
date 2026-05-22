"""
WearableBiomechanicsAdapter — translates the wearable PCB (IMU + GPS +
ECG + HR-monitor + edge AI output) into normalised FusionPacket objects.

This is the highest-throughput adapter:
    - IMU @ 100 Hz × 6 axes
    - GPS @ 10 Hz
    - ECG @ 250 Hz (downsampled to 1 Hz HR at the edge if needed)

The wearable's edge AI can pre-compute joint strain + fatigue locally
(per the architecture note "Neuromorphic Edge Compute"). When the
field 'edge.fatigue_score' is present in a packet we forward it as
metadata — the cloud BLI/TAI calculator uses it as a tie-breaker.
"""

from __future__ import annotations

from typing import Iterable, List, Optional

from ..core.packets import FusionPacket, IMUReading, GPSReading, ECGReading
from ..core.timestamp import GlobalTimestampSynchronizer


class WearableBiomechanicsAdapter:
    def __init__(self, sync: GlobalTimestampSynchronizer) -> None:
        self._sync = sync

    def _wrap(
        self,
        *,
        kind: str,
        ts: int,
        session_id: str,
        club_id: str,
        team_id: Optional[str],
        match_id: Optional[str],
        player_id: str,
        payload,
        confidence: float = 1.0,
    ) -> FusionPacket:
        return FusionPacket(
            kind=kind, ts=ts,                    # type: ignore[arg-type]
            deviceSessionId=session_id,
            clubId=club_id,
            teamId=team_id,
            matchId=match_id,
            playerId=player_id,
            payload=payload,
            confidence=confidence,
        )

    def ingest_imu(self, *, device_session_id: str, club_id: str, team_id: Optional[str],
                   match_id: Optional[str], player_id: str, server_rx_ms: int,
                   samples: Iterable[dict]) -> List[FusionPacket]:
        out: List[FusionPacket] = []
        for s in samples:
            self._sync.update(device_session_id, int(s["tUs"]), server_rx_ms)
            ts = self._sync.to_global_ms(device_session_id, int(s["tUs"]))
            payload = IMUReading(
                ax=float(s["ax"]), ay=float(s["ay"]), az=float(s["az"]),
                gx=float(s["gx"]), gy=float(s["gy"]), gz=float(s["gz"]),
            )
            out.append(self._wrap(
                kind="IMU", ts=ts, session_id=device_session_id,
                club_id=club_id, team_id=team_id, match_id=match_id,
                player_id=player_id, payload=payload,
            ))
        return out

    def ingest_gps(self, *, device_session_id: str, club_id: str, team_id: Optional[str],
                   match_id: Optional[str], player_id: str, server_rx_ms: int,
                   samples: Iterable[dict]) -> List[FusionPacket]:
        out: List[FusionPacket] = []
        for s in samples:
            self._sync.update(device_session_id, int(s["tUs"]), server_rx_ms)
            ts = self._sync.to_global_ms(device_session_id, int(s["tUs"]))
            payload = GPSReading(
                lat=float(s["lat"]), lon=float(s["lon"]),
                speed=float(s.get("speed", 0.0)),
                alt=s.get("alt"), heading=s.get("heading"), hdop=s.get("hdop"),
                x=s.get("x"), y=s.get("y"),
            )
            out.append(self._wrap(
                kind="GPS", ts=ts, session_id=device_session_id,
                club_id=club_id, team_id=team_id, match_id=match_id,
                player_id=player_id, payload=payload,
            ))
        return out

    def ingest_ecg_bpm(self, *, device_session_id: str, club_id: str, team_id: Optional[str],
                       match_id: Optional[str], player_id: str, server_rx_ms: int,
                       samples: Iterable[dict]) -> List[FusionPacket]:
        out: List[FusionPacket] = []
        for s in samples:
            self._sync.update(device_session_id, int(s["tUs"]), server_rx_ms)
            ts = self._sync.to_global_ms(device_session_id, int(s["tUs"]))
            payload = ECGReading(
                bpm=float(s["bpm"]),
                rrIntervalMs=s.get("rrIntervalMs"),
                hrv=s.get("hrv"),
                qualityB=s.get("qualityB"),
            )
            out.append(self._wrap(
                kind="ECG", ts=ts, session_id=device_session_id,
                club_id=club_id, team_id=team_id, match_id=match_id,
                player_id=player_id, payload=payload,
                confidence=payload.qualityB or 1.0,
            ))
        return out
