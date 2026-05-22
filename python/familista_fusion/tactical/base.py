"""
Tactical plugin contract.

The SensorVisionFusionEngine is sport-agnostic. Every sport-specific
interpretation (formation, pressing lines, court positioning, rally
fatigue) lives behind the SportPluginBase interface so the engine
remains the immutable core.

Plugins receive:
    - the latest PlayerStateVector per player (post-fusion)
    - the rolling window of FusionPacket(kind='TACTICAL_EVENT', ...)
    - the rolling window of FusionPacket(kind='NEURO_VISION_EVENT', ...)
Plugins emit:
    - a flat dict of tactical scalar features the TAI/BLI math can ingest
    - structured tactical phase annotations (open play / set piece / ...)
    - per-player annotations attached back to PlayerStateVector.annotations
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..core.packets import FusionPacket, PlayerStateVector


@dataclass
class TacticalAnnotations:
    """Sport-agnostic feature bag the metrics layer can consume."""
    phase: str = "OPEN_PLAY"
    team_shape: Dict[str, float] = field(default_factory=dict)
    per_player: Dict[str, Dict[str, float]] = field(default_factory=dict)
    diagnostics: List[str] = field(default_factory=list)


class SportPluginBase(ABC):
    """
    Subclass to add sport-specific interpretation.

    Plugin classes MUST be pure: identical inputs ⇒ identical outputs.
    No I/O, no clocks, no random sources. The engine takes care of
    timing and persistence.
    """

    sport_name: str = "unknown"

    @abstractmethod
    def interpret(
        self,
        *,
        now_ms: int,
        states: List[PlayerStateVector],
        events: List[FusionPacket],
    ) -> TacticalAnnotations:
        """
        Args:
            now_ms: latest backend-aligned timestamp considered.
            states: one PlayerStateVector per active player.
            events: window of FusionPackets (any kind) considered relevant.
        Returns:
            TacticalAnnotations enriching the fusion frame.
        """
        ...

    @abstractmethod
    def expected_position(self, *, player_id: str, role: str, ts_ms: int) -> Optional[tuple[float, float]]:
        """
        For positional deviation in TAI.

        Returns the expected (x, y) on the pitch for the given player in
        the given tactical role at the given time. Plugins are free to
        return None when the role is unknown — the TAI calculator falls
        back to centroid-based estimates.
        """
        ...


class TacticalContextEngine:
    """
    Lightweight orchestrator. Holds the active plugin and exposes a
    single .interpret() that re-dispatches into it. Kept separate from
    the SensorVisionFusionEngine because in multi-sport venues (e.g.
    arenas hosting both football + handball) you may swap plugins
    without rebuilding the fusion engine.
    """

    def __init__(self, plugin: SportPluginBase) -> None:
        self._plugin = plugin

    @property
    def plugin(self) -> SportPluginBase:
        return self._plugin

    def set_plugin(self, plugin: SportPluginBase) -> None:
        self._plugin = plugin

    def interpret(self, *, now_ms: int, states, events) -> TacticalAnnotations:
        return self._plugin.interpret(now_ms=now_ms, states=states, events=events)
