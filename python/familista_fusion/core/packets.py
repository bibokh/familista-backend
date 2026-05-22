"""
Typed dataclasses for every packet shape and the derived player state.

This file mirrors `src/fusion/types.ts` byte-for-byte in semantics. Both
must change together when the wire format evolves.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional, Union, Dict, List, Any


GlobalTimestampMs = int   # ms since unix epoch, backend-aligned

PacketKind = Literal[
    "GPS", "IMU", "ECG", "HEART_RATE", "HEALTH_BUNDLE",
    "EVENT", "VISION_FRAME", "NEURO_VISION_EVENT",
    "BIOCHEM_PATCH", "IBC", "TURF_NODE", "POWER", "DIAGNOSTIC",
    "TACTICAL_EVENT", "POSE_KEYPOINTS", "BALL",
]

# ─────────────────────────────────────────────────────────────────────────
# Payloads
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class GPSReading:
    lat: float
    lon: float
    speed: float                  # m/s
    alt: Optional[float] = None
    heading: Optional[float] = None
    hdop: Optional[float] = None
    x: Optional[float] = None     # pitch-local metres
    y: Optional[float] = None

@dataclass
class IMUReading:
    ax: float
    ay: float
    az: float
    gx: float
    gy: float
    gz: float

@dataclass
class ECGReading:
    bpm: float
    rrIntervalMs: Optional[float] = None
    hrv: Optional[float] = None
    qualityB: Optional[float] = None

@dataclass
class BiochemReading:
    """Epidermal biochemical electronics: lactate, cortisol, glucose, etc."""
    lactateMmol: Optional[float] = None
    cortisolNgMl: Optional[float] = None
    glucoseMgDl: Optional[float] = None
    hydrationPct: Optional[float] = None
    patchTemperature: Optional[float] = None
    q: Optional[float] = None      # quality 0..1

@dataclass
class PoseJoint:
    name: str
    x: float
    y: float
    z: float
    conf: float

@dataclass
class PoseReading:
    joints: List[PoseJoint]

@dataclass
class NeuroVisionEvent:
    """
    A single event from a neuromorphic event-based camera.

    Coordinates are pixel-space; polarity p ∈ {+1, -1} expresses whether
    log-intensity at that pixel crossed the up- or down-threshold.
    """
    x: int
    y: int
    p: int          # +1 or -1
    tUs: int

@dataclass
class BallReading:
    x: float
    y: float
    z: Optional[float] = None
    vx: Optional[float] = None
    vy: Optional[float] = None
    vz: Optional[float] = None

@dataclass
class TacticalEvent:
    kind: str
    side: Literal["HOME", "AWAY"]
    pitchX: Optional[float] = None
    pitchY: Optional[float] = None
    primaryPlayerId: Optional[str] = None
    secondaryPlayerId: Optional[str] = None
    notes: Optional[str] = None


Payload = Union[
    GPSReading, IMUReading, ECGReading, BiochemReading, PoseReading,
    NeuroVisionEvent, BallReading, TacticalEvent, Dict[str, Any],
]

# ─────────────────────────────────────────────────────────────────────────
# The universal envelope
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class FusionPacket:
    kind: PacketKind
    ts: GlobalTimestampMs
    deviceSessionId: str
    clubId: str
    payload: Payload
    teamId: Optional[str]   = None
    matchId: Optional[str]  = None
    trainingId: Optional[str] = None
    playerId: Optional[str] = None
    confidence: float       = 1.0
    sigB64: Optional[str]   = None


# ─────────────────────────────────────────────────────────────────────────
# Derived player state — the spatial primitive of the fusion frame
# ─────────────────────────────────────────────────────────────────────────

@dataclass
class PlayerStateVector:
    playerId: str
    ts: GlobalTimestampMs
    x: float
    y: float
    z: float = 0.0
    vx: float = 0.0
    vy: float = 0.0
    sprint: int = 0          # 0/1
    hr: Optional[float] = None
    distM: float = 0.0
    aLoadZ: float = 0.0
    source: Literal["GPS", "POSE", "GPS+POSE", "IMU", "FUSED"] = "FUSED"
    confidence: float = 0.8
    # Extra slot for sport-plugin-specific annotations.
    annotations: Dict[str, Any] = field(default_factory=dict)
