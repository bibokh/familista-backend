"""
Tactical Attrition Index (TAI) — Python reference.

Identical math to src/fusion/metrics.ts. The Python edition also wraps
the metric in a `TacticalAttritionModel` class so research notebooks can
swap baselines or weights deterministically.

Equation:

    TAI(p, t) = w_b · σ(BLI)
              + w_f · σ(z(dF/dt))         (biochemical fatigue gradient)
              + w_d · σ(z(δ_T))            (tactical delay sec)
              + w_p · σ(z(Δ_P))            (positional deviation m)
              + w_r · σ(z(R))              (recovery lag sec)
              + w_s · (1 − sprint_max_ratio)
              + w_i · P_injury

where σ is the logistic and z is the player-baseline z-score.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Dict, Optional

from .bli import BLIResult


TAI_WEIGHTS: Dict[str, float] = {
    "bli_z":                 0.35,
    "biochem_fatigue_delta": 0.15,
    "tactical_delay_sec":    0.10,
    "positional_deviation_m":0.10,
    "recovery_lag_sec":      0.10,
    "sprint_degradation":    0.10,
    "injury_risk_p":         0.10,
}


def _sigmoid(x: float) -> float:
    if x >= 35:  return 1.0
    if x <= -35: return 0.0
    return 1.0 / (1.0 + math.exp(-x))


def _zscore(value: float, mean: float, std: float) -> float:
    if std <= 0:
        return 0.0
    return max(-3.0, min(3.0, (value - mean) / std))


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


@dataclass
class TAIBaseline:
    biochem_delta_mean:        float = 0.4
    biochem_delta_std:         float = 0.3
    tactical_delay_mean:       float = 1.2
    tactical_delay_std:        float = 0.5
    positional_deviation_mean: float = 3.5
    positional_deviation_std:  float = 2.0
    recovery_lag_mean:         float = 18.0
    recovery_lag_std:          float = 8.0


@dataclass
class TAIInputs:
    player_id:                 str
    window_ms:                 int
    bli:                       BLIResult

    biochem_delta_per_min:     float                # NaN if patch absent
    tactical_delay_sec:        float
    positional_deviation_m:    float
    recovery_lag_sec:          float
    sprint_max_ratio:          float
    injury_risk_p:             Optional[float] = None
    baseline:                  TAIBaseline = field(default_factory=TAIBaseline)


@dataclass
class TAIResult:
    player_id:  str
    window_ms:  int
    components: Dict[str, float]
    value:      float


def tactical_attrition_index(inp: TAIInputs) -> TAIResult:
    biochem_available = not (math.isnan(inp.biochem_delta_per_min) or math.isinf(inp.biochem_delta_per_min))

    c = {
        "bli_z":                 _sigmoid(inp.bli.value),
        "biochem_fatigue_delta": (
            _sigmoid(_zscore(inp.biochem_delta_per_min, inp.baseline.biochem_delta_mean, inp.baseline.biochem_delta_std))
            if biochem_available
            else _sigmoid(inp.bli.value)
        ),
        "tactical_delay_sec":    _sigmoid(_zscore(inp.tactical_delay_sec,     inp.baseline.tactical_delay_mean,       inp.baseline.tactical_delay_std)),
        "positional_deviation_m":_sigmoid(_zscore(inp.positional_deviation_m, inp.baseline.positional_deviation_mean, inp.baseline.positional_deviation_std)),
        "recovery_lag_sec":      _sigmoid(_zscore(inp.recovery_lag_sec,       inp.baseline.recovery_lag_mean,         inp.baseline.recovery_lag_std)),
        "sprint_degradation":    _clamp(1 - inp.sprint_max_ratio, 0.0, 1.0),
        "injury_risk_p":         _clamp(
            inp.injury_risk_p if inp.injury_risk_p is not None else _sigmoid(inp.bli.value - 1.0),
            0.0, 1.0,
        ),
    }
    value = (
        TAI_WEIGHTS["bli_z"]                 * c["bli_z"]
      + TAI_WEIGHTS["biochem_fatigue_delta"] * c["biochem_fatigue_delta"]
      + TAI_WEIGHTS["tactical_delay_sec"]    * c["tactical_delay_sec"]
      + TAI_WEIGHTS["positional_deviation_m"]* c["positional_deviation_m"]
      + TAI_WEIGHTS["recovery_lag_sec"]      * c["recovery_lag_sec"]
      + TAI_WEIGHTS["sprint_degradation"]    * c["sprint_degradation"]
      + TAI_WEIGHTS["injury_risk_p"]         * c["injury_risk_p"]
    )
    return TAIResult(
        player_id=inp.player_id,
        window_ms=inp.window_ms,
        components=c,
        value=round(_clamp(value, 0.0, 1.0), 4),
    )


class TacticalAttritionModel:
    """
    Thin OOP wrapper so research notebooks can construct a model object
    with custom baselines / weights and then call .predict() repeatedly.

    The TS service uses the standalone function form; this class form is
    purely for the Python research side.
    """

    def __init__(self,
                 weights: Dict[str, float] | None = None,
                 baseline: TAIBaseline | None = None) -> None:
        self.weights = weights or TAI_WEIGHTS
        self.baseline = baseline or TAIBaseline()

    def predict(self, inputs: TAIInputs) -> TAIResult:
        # Override baseline only — weights live in the standalone function.
        if inputs.baseline is not self.baseline:
            inputs.baseline = self.baseline
        return tactical_attrition_index(inputs)
