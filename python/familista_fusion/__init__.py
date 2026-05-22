"""
Familista — Cognitive Sensor-to-Vision Spatial Fusion Protocol
================================================================

Offline reference implementation in Python. This package mirrors the
TypeScript runtime in `src/fusion/` but exists as a pure analytics +
research surface so:

    1. Sports scientists can reproduce the math without spinning up a Node
       runtime or a Render deploy.
    2. Patent prosecution can cite a concrete, executable reference for
       every claim in the patent application.
    3. Machine-learning models that consume the FusionPacket stream can be
       prototyped + benchmarked here before being lifted to the production
       worker tier.

The class hierarchy is INTENTIONALLY narrow:

    SensorVisionFusionEngine          ← immutable core; never subclassed
        └─ GlobalTimestampSynchronizer
        └─ adapters: NeuromorphicVisionAdapter,
                     BiochemicalPatchAdapter,
                     WearableBiomechanicsAdapter
        └─ tactical: SportPluginBase (abstract)
                     └─ FootballTacticalPlugin
                     └─ TennisTacticalPlugin
        └─ metrics: BiomechanicalLoadIndex, TacticalAttritionIndex
"""

from .core.packets import (
    GlobalTimestampMs,
    FusionPacket,
    PlayerStateVector,
    GPSReading, IMUReading, ECGReading, BiochemReading, PoseReading,
    NeuroVisionEvent, BallReading, TacticalEvent,
)
from .core.timestamp import GlobalTimestampSynchronizer
from .core.fusion_engine import SensorVisionFusionEngine

from .adapters.neuromorphic    import NeuromorphicVisionAdapter
from .adapters.biochemical     import BiochemicalPatchAdapter
from .adapters.biomechanical   import WearableBiomechanicsAdapter

from .tactical.base       import SportPluginBase, TacticalContextEngine
from .tactical.football   import FootballTacticalPlugin
from .tactical.tennis     import TennisTacticalPlugin

from .metrics.bli         import biomechanical_load_index, BLIInputs, BLIResult, BLI_WEIGHTS
from .metrics.tai         import tactical_attrition_index, TAIInputs, TAIResult, TAI_WEIGHTS
from .metrics.tai         import TacticalAttritionModel

__all__ = [
    "GlobalTimestampMs", "FusionPacket", "PlayerStateVector",
    "GPSReading", "IMUReading", "ECGReading", "BiochemReading",
    "PoseReading", "NeuroVisionEvent", "BallReading", "TacticalEvent",
    "GlobalTimestampSynchronizer", "SensorVisionFusionEngine",
    "NeuromorphicVisionAdapter", "BiochemicalPatchAdapter", "WearableBiomechanicsAdapter",
    "SportPluginBase", "TacticalContextEngine",
    "FootballTacticalPlugin", "TennisTacticalPlugin",
    "biomechanical_load_index", "BLIInputs", "BLIResult", "BLI_WEIGHTS",
    "tactical_attrition_index", "TAIInputs", "TAIResult", "TAI_WEIGHTS",
    "TacticalAttritionModel",
]

__version__ = "0.1.0"
