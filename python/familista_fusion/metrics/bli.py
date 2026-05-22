"""
Biomechanical Load Index (BLI) — Python reference.

Identical math to src/fusion/metrics.ts. The reference exists so:
    - sports-science reviewers can run pytest without Node
    - patent prosecution can cite a deterministic function with named
      weights + clamps, reproducible from first principles
    - ML researchers can vectorise over historical sessions in pandas

Equation:

    BLI(p, t, W) = w_a · z(A) + w_s · z(S) + w_h · z(H) + w_j · z(J) + w_m · z(M)

where z(x) = clamp((x − μ_x)/σ_x, ±3).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict


BLI_WEIGHTS: Dict[str, float] = {
    "accel_load":      0.30,
    "sprint_load":     0.25,
    "hr_stress":       0.20,
    "joint_strain":    0.15,
    "mechanical_work": 0.10,
}

# Same constants as the TS implementation.
SPRINT_THRESHOLD_MPS = 7.0
HR_STRESS_THRESHOLD_BPM = 160


def _zscore(value: float, mean: float, std: float) -> float:
    if std <= 0:
        return 0.0
    z = (value - mean) / std
    return max(-3.0, min(3.0, z))


@dataclass
class BLIBaseline:
    accel_mag_sq_mean: float = 100.0; accel_mag_sq_std: float = 40.0
    sprint_vsq_mean:   float = 600.0; sprint_vsq_std:   float = 200.0
    hr_stress_mean:    float = 8000.0; hr_stress_std:   float = 3500.0
    joint_strain_mean: float = 25.0;  joint_strain_std: float = 10.0
    mechanical_work_mean: float = 18000.0; mechanical_work_std: float = 7000.0


@dataclass
class BLIInputs:
    player_id: str
    window_ms: int
    accel_mag_sq_sum:    float
    sprint_vsq_integral: float
    hr_stress_integral:  float
    joint_strain_integral: float
    mechanical_work:     float
    baseline:            BLIBaseline = field(default_factory=BLIBaseline)


@dataclass
class BLIResult:
    player_id: str
    window_ms: int
    components: Dict[str, float]
    value: float


def biomechanical_load_index(inp: BLIInputs) -> BLIResult:
    aZ = _zscore(inp.accel_mag_sq_sum,       inp.baseline.accel_mag_sq_mean,    inp.baseline.accel_mag_sq_std)
    sZ = _zscore(inp.sprint_vsq_integral,    inp.baseline.sprint_vsq_mean,      inp.baseline.sprint_vsq_std)
    hZ = _zscore(inp.hr_stress_integral,     inp.baseline.hr_stress_mean,       inp.baseline.hr_stress_std)
    jZ = _zscore(inp.joint_strain_integral,  inp.baseline.joint_strain_mean,    inp.baseline.joint_strain_std)
    mZ = _zscore(inp.mechanical_work,        inp.baseline.mechanical_work_mean, inp.baseline.mechanical_work_std)
    value = (
        BLI_WEIGHTS["accel_load"]      * aZ
      + BLI_WEIGHTS["sprint_load"]     * sZ
      + BLI_WEIGHTS["hr_stress"]       * hZ
      + BLI_WEIGHTS["joint_strain"]    * jZ
      + BLI_WEIGHTS["mechanical_work"] * mZ
    )
    return BLIResult(
        player_id=inp.player_id,
        window_ms=inp.window_ms,
        components={
            "accel_load": aZ, "sprint_load": sZ, "hr_stress": hZ,
            "joint_strain": jZ, "mechanical_work": mZ,
        },
        value=round(value, 4),
    )
