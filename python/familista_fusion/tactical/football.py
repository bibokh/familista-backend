"""
FootballTacticalPlugin — pressing, defensive line, sprint lanes,
off-ball movement.

Coordinate system: pitch local, origin = lower-left corner of OUR half.
Length 105 m, width 68 m (UEFA defaults; configurable via constructor).
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

from ..core.packets import FusionPacket, PlayerStateVector
from .base import SportPluginBase, TacticalAnnotations


# 4-3-3 baseline template, expressed as (x_ratio, y_ratio) in [0,1].
_FORMATION_4_3_3 = {
    "GK":   (0.05, 0.50),
    "DL":   (0.25, 0.15),
    "DCl":  (0.25, 0.38),
    "DCr":  (0.25, 0.62),
    "DR":   (0.25, 0.85),
    "DMC":  (0.40, 0.50),
    "ML":   (0.55, 0.25),
    "MR":   (0.55, 0.75),
    "AML":  (0.80, 0.20),
    "AMR":  (0.80, 0.80),
    "ST":   (0.85, 0.50),
}


class FootballTacticalPlugin(SportPluginBase):
    sport_name = "football"

    def __init__(self, *, pitch_length_m: float = 105.0, pitch_width_m: float = 68.0,
                 formation: Dict[str, Tuple[float, float]] | None = None) -> None:
        self._L = pitch_length_m
        self._W = pitch_width_m
        self._formation = formation or _FORMATION_4_3_3

    # ── Sport-specific computations ──────────────────────────────────────

    def _defensive_line_y(self, states: List[PlayerStateVector]) -> float:
        """Mean x-coordinate of the back four (lowest x of outfielders)."""
        outfield = [s for s in states if s.annotations.get("role") not in ("GK",)]
        if not outfield:
            return 0.0
        outfield.sort(key=lambda s: s.x)
        back_four = outfield[:4]
        return sum(s.x for s in back_four) / max(1, len(back_four))

    def _team_centroid(self, states: List[PlayerStateVector]) -> Tuple[float, float]:
        if not states:
            return (self._L / 2, self._W / 2)
        cx = sum(s.x for s in states) / len(states)
        cy = sum(s.y for s in states) / len(states)
        return (cx, cy)

    def _pressing_index(self, states: List[PlayerStateVector], opp_states: List[PlayerStateVector]) -> float:
        """
        Crude pressing index: average inverse distance between each of our
        forward 3 and the nearest opponent within 15 m. Higher = pressing
        more aggressively. Returns 0 when no opponents are tracked.
        """
        if not opp_states:
            return 0.0
        ours = sorted(states, key=lambda s: -s.x)[:3]   # most advanced 3
        total = 0.0
        n = 0
        for u in ours:
            best = min((math.hypot(u.x - o.x, u.y - o.y) for o in opp_states), default=999.0)
            if best <= 15.0:
                total += 1.0 / max(1.0, best)
                n += 1
        return (total / n) if n else 0.0

    # ── SportPluginBase ──────────────────────────────────────────────────

    def interpret(self, *, now_ms: int, states: List[PlayerStateVector], events: List[FusionPacket]) -> TacticalAnnotations:
        # Phase detection: latest TACTICAL_EVENT.kind wins, with fallback OPEN_PLAY.
        tactical = [e for e in events if e.kind == "TACTICAL_EVENT"]
        phase = "OPEN_PLAY"
        if tactical:
            kind = getattr(tactical[-1].payload, "kind", None) or tactical[-1].payload.get("kind") if isinstance(tactical[-1].payload, dict) else None
            if kind in ("CORNER", "PENALTY_AWARDED", "FOUL"):
                phase = "SET_PIECE_FOR" if (getattr(tactical[-1].payload, "side", None) or "HOME") == "HOME" else "SET_PIECE_AGAINST"

        # Team-shape scalars
        cx, cy = self._team_centroid(states)
        dl = self._defensive_line_y(states)
        annotations = TacticalAnnotations(
            phase=phase,
            team_shape={
                "centroid_x":         cx,
                "centroid_y":         cy,
                "defensive_line_x":   dl,
                "spread_x":           max((s.x for s in states), default=0) - min((s.x for s in states), default=0),
                "spread_y":           max((s.y for s in states), default=0) - min((s.y for s in states), default=0),
                "pressing_index":     self._pressing_index(states, []),
                "n_players":          len(states),
            },
        )

        # Per-player deltas: distance to expected position + sprint flag
        for s in states:
            role = s.annotations.get("role")
            exp  = self.expected_position(player_id=s.playerId, role=role or "DCl", ts_ms=now_ms)
            if exp:
                ex, ey = exp
                dist = math.hypot(s.x - ex, s.y - ey)
            else:
                dist = 0.0
            annotations.per_player[s.playerId] = {
                "deviation_m":  dist,
                "sprint":       float(s.sprint),
                "distM":        s.distM,
            }
        return annotations

    def expected_position(self, *, player_id: str, role: str, ts_ms: int) -> Optional[Tuple[float, float]]:
        coords = self._formation.get(role)
        if not coords:
            return None
        rx, ry = coords
        return (rx * self._L, ry * self._W)
