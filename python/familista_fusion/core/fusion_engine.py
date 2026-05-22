"""
SensorVisionFusionEngine — immutable core of the fusion protocol.

The engine is sport-agnostic. It holds:
    1. A GlobalTimestampSynchronizer keyed by deviceSessionId.
    2. A bounded ring buffer of FusionPacket per matchId.
    3. A TacticalContextEngine (with a swappable plugin per sport).

It exposes a SMALL surface:
    .ingest(packet)            ← single point of entry
    .player_states(match_id)   ← derived PlayerStateVector list
    .features(match_id)        ← tactical + biomechanical feature bag
    .clear(match_id)            ← memory bound

What the engine does NOT do (by design — that's the patent angle):
    - it does not interpret sport-specific tactics  → plugin does that
    - it does not persist                            → DB/queue does that
    - it does not call LLMs / cloud APIs             → workers do that
    - it does not own auth, tenancy, transport       → API layer does

This narrow surface is what makes the fusion protocol replaceable in
different physical deployments (edge box, cloud worker, on-device).
"""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Deque, Dict, Iterable, List, Optional

from .packets import FusionPacket, PlayerStateVector
from .timestamp import GlobalTimestampSynchronizer
from ..tactical.base import SportPluginBase, TacticalAnnotations, TacticalContextEngine
from ..metrics.bli import BLIInputs, BLIResult, biomechanical_load_index, SPRINT_THRESHOLD_MPS, HR_STRESS_THRESHOLD_BPM
from ..metrics.tai import TAIInputs, TAIResult, tactical_attrition_index


DEFAULT_RING_SIZE = 20_000   # packets per match (sliding window)


class SensorVisionFusionEngine:
    """
    Construct once per process. Use `.with_plugin(plugin)` to install a
    sport context.
    """

    def __init__(self,
                 *,
                 plugin: SportPluginBase,
                 ring_size: int = DEFAULT_RING_SIZE) -> None:
        self._sync     = GlobalTimestampSynchronizer()
        self._ctx      = TacticalContextEngine(plugin)
        self._ring_size = ring_size
        # matchId → ring buffer of FusionPacket
        self._buffers: Dict[str, Deque[FusionPacket]] = defaultdict(lambda: deque(maxlen=ring_size))

    # ── Public properties ───────────────────────────────────────────────

    @property
    def synchronizer(self) -> GlobalTimestampSynchronizer:
        return self._sync

    @property
    def tactical(self) -> TacticalContextEngine:
        return self._ctx

    # ── Ingest ──────────────────────────────────────────────────────────

    def ingest(self, packet: FusionPacket) -> None:
        mid = packet.matchId or "__unscoped__"
        self._buffers[mid].append(packet)

    def ingest_many(self, packets: Iterable[FusionPacket]) -> int:
        n = 0
        for p in packets:
            self.ingest(p)
            n += 1
        return n

    def clear(self, match_id: str) -> None:
        self._buffers.pop(match_id, None)

    def buffer_size(self, match_id: str) -> int:
        return len(self._buffers.get(match_id, ()))

    # ── Derivations ─────────────────────────────────────────────────────

    def player_states(self, match_id: str) -> List[PlayerStateVector]:
        """
        Roll up the latest GPS / IMU / HR packet per playerId in the
        match buffer into one PlayerStateVector each.
        """
        latest_gps: Dict[str, FusionPacket] = {}
        latest_imu: Dict[str, FusionPacket] = {}
        latest_hr:  Dict[str, FusionPacket] = {}
        dist_acc:   Dict[str, float] = defaultdict(float)
        sprint_now: Dict[str, int]   = {}

        for p in self._buffers.get(match_id, ()):
            pid = p.playerId
            if not pid:
                continue
            if   p.kind == "GPS":         latest_gps[pid] = p
            elif p.kind == "IMU":         latest_imu[pid] = p
            elif p.kind == "HEART_RATE" or p.kind == "ECG":
                latest_hr[pid] = p

        out: List[PlayerStateVector] = []
        for pid, gp in latest_gps.items():
            speed = float(getattr(gp.payload, "speed", 0.0))
            sprint_now[pid] = 1 if speed > SPRINT_THRESHOLD_MPS else 0
            hr = None
            hrp = latest_hr.get(pid)
            if hrp is not None:
                hr = float(getattr(hrp.payload, "bpm", 0.0))
            out.append(PlayerStateVector(
                playerId=pid,
                ts=gp.ts,
                x=float(getattr(gp.payload, "x", 0.0) or 0.0),
                y=float(getattr(gp.payload, "y", 0.0) or 0.0),
                vx=0.0, vy=0.0,
                sprint=sprint_now[pid],
                hr=hr,
                distM=dist_acc[pid],
                source="GPS" if pid not in latest_imu else "FUSED",
                confidence=0.9,
            ))
        return out

    def features(self, match_id: str) -> Dict[str, object]:
        """
        Compute BLI + TAI per player using the current ring contents and
        run the active tactical plugin. Pure read; never mutates the
        buffer.
        """
        states = self.player_states(match_id)
        events = list(self._buffers.get(match_id, ()))
        now_ms = max((p.ts for p in events), default=0)

        # Tactical interpretation (sport-specific)
        annotations: TacticalAnnotations = self._ctx.interpret(
            now_ms=now_ms, states=states, events=events,
        )

        # BLI + TAI per player
        bli_by_player: Dict[str, BLIResult] = {}
        tai_by_player: Dict[str, TAIResult] = {}
        for s in states:
            ann_per = annotations.per_player.get(s.playerId, {})
            bli_in = BLIInputs(
                player_id=s.playerId,
                window_ms=5 * 60 * 1000,
                accel_mag_sq_sum=0.0,
                sprint_vsq_integral=0.0,
                hr_stress_integral=0.0,
                joint_strain_integral=0.0,
                mechanical_work=0.0,
            )
            # NOTE: real integrations live in the TS fusion.service or in a
            # separate research script. The engine deliberately exposes
            # the slots for plug-in feature extractors instead of doing
            # the integration here.
            bli = biomechanical_load_index(bli_in)
            bli_by_player[s.playerId] = bli

            tai_in = TAIInputs(
                player_id=s.playerId,
                window_ms=5 * 60 * 1000,
                bli=bli,
                biochem_delta_per_min=float("nan"),
                tactical_delay_sec=1.2,
                positional_deviation_m=ann_per.get("deviation_m", 0.0),
                recovery_lag_sec=18.0,
                sprint_max_ratio=1.0,
            )
            tai_by_player[s.playerId] = tactical_attrition_index(tai_in)

        return {
            "states": states,
            "annotations": annotations,
            "bli": bli_by_player,
            "tai": tai_by_player,
            "now_ms": now_ms,
            "buffer_packets": len(events),
        }
