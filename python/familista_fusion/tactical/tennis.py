"""
TennisTacticalPlugin — court positioning, rally fatigue, stroke recovery,
lateral load.

Coordinate system: court-local, origin = our baseline-deuce corner.
Length 23.77 m (singles), width 8.23 m (singles) or 10.97 m (doubles).
"""

from __future__ import annotations

import math
from typing import List, Optional, Tuple

from ..core.packets import FusionPacket, PlayerStateVector
from .base import SportPluginBase, TacticalAnnotations


# Singles baseline anchors. Plugin owners can override at construction.
_BASELINE_DEUCE = (0.0, 6.17)
_BASELINE_AD    = (0.0, 2.06)


class TennisTacticalPlugin(SportPluginBase):
    sport_name = "tennis"

    def __init__(self, *, court_length_m: float = 23.77, court_width_m: float = 8.23) -> None:
        self._L = court_length_m
        self._W = court_width_m

    def interpret(self, *, now_ms: int, states: List[PlayerStateVector], events: List[FusionPacket]) -> TacticalAnnotations:
        # Tennis is 1v1 or 2v2 — derive phase from latest BALL packet velocity.
        ball_events = [e for e in events if e.kind == "BALL"]
        phase = "OPEN_PLAY"
        if ball_events:
            last = ball_events[-1].payload
            vx = float(getattr(last, "vx", 0.0) or 0.0)
            vy = float(getattr(last, "vy", 0.0) or 0.0)
            speed = math.hypot(vx, vy)
            if speed < 1.0:
                phase = "DEAD_BALL"
            elif speed > 25.0:
                phase = "RALLY_FAST"
            else:
                phase = "RALLY"

        ann = TacticalAnnotations(
            phase=phase,
            team_shape={
                "court_length_m": self._L,
                "court_width_m":  self._W,
                "n_players":      len(states),
            },
        )

        # Per-player annotations: lateral travel, time-since-stroke, sprint flag.
        for s in states:
            ann.per_player[s.playerId] = {
                "lateral_m":   abs(s.y - (self._W / 2)),
                "sprint":      float(s.sprint),
                "distM":       s.distM,
                "deviation_m": self._distance_to_anchor(s, side="deuce"),
            }
        return ann

    def _distance_to_anchor(self, state: PlayerStateVector, *, side: str = "deuce") -> float:
        ax, ay = _BASELINE_DEUCE if side == "deuce" else _BASELINE_AD
        return math.hypot(state.x - ax, state.y - ay)

    def expected_position(self, *, player_id: str, role: str, ts_ms: int) -> Optional[Tuple[float, float]]:
        # Tennis has no fixed formation — we model "neutral" position as
        # one step behind baseline centre.
        return (0.5, self._W / 2)
