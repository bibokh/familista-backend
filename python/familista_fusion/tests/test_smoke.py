"""Minimal smoke tests: package imports, math sane, plugin contract OK."""

import math

import familista_fusion as ff
from familista_fusion.core.packets import (
    FusionPacket, GPSReading, IMUReading,
)


def test_imports():
    assert ff.SensorVisionFusionEngine
    assert ff.GlobalTimestampSynchronizer
    assert ff.FootballTacticalPlugin
    assert ff.TennisTacticalPlugin


def test_bli_default_baseline_returns_zero_ish_value_when_inputs_at_mean():
    inp = ff.BLIInputs(
        player_id="p1", window_ms=300_000,
        accel_mag_sq_sum=100.0, sprint_vsq_integral=600.0,
        hr_stress_integral=8000.0, joint_strain_integral=25.0,
        mechanical_work=18000.0,
    )
    res = ff.biomechanical_load_index(inp)
    assert abs(res.value) < 0.01
    assert set(res.components.keys()) == {
        "accel_load", "sprint_load", "hr_stress", "joint_strain", "mechanical_work",
    }


def test_tai_bounded_zero_to_one():
    bli = ff.biomechanical_load_index(ff.BLIInputs(
        player_id="p1", window_ms=300_000,
        accel_mag_sq_sum=100.0, sprint_vsq_integral=600.0,
        hr_stress_integral=8000.0, joint_strain_integral=25.0,
        mechanical_work=18000.0,
    ))
    tai = ff.tactical_attrition_index(ff.TAIInputs(
        player_id="p1", window_ms=300_000,
        bli=bli,
        biochem_delta_per_min=float("nan"),
        tactical_delay_sec=1.2,
        positional_deviation_m=3.5,
        recovery_lag_sec=18.0,
        sprint_max_ratio=1.0,
    ))
    assert 0.0 <= tai.value <= 1.0


def test_timestamp_synchronizer_aligns_first_packet():
    s = ff.GlobalTimestampSynchronizer()
    s.bootstrap("sess-1", device_us=1_000_000, server_rx_ms=1_700_000_000_000)
    out = s.to_global_ms("sess-1", 1_000_000)
    assert abs(out - 1_700_000_000_000) <= 1


def test_football_plugin_returns_expected_position_for_known_role():
    plugin = ff.FootballTacticalPlugin()
    pos = plugin.expected_position(player_id="p1", role="DCl", ts_ms=0)
    assert pos is not None
    x, y = pos
    assert 0 <= x <= 105
    assert 0 <= y <= 68


def test_fusion_engine_ingests_and_rolls_up_player_states():
    plugin = ff.FootballTacticalPlugin()
    engine = ff.SensorVisionFusionEngine(plugin=plugin)
    packet = FusionPacket(
        kind="GPS", ts=1_700_000_000_000,
        deviceSessionId="sess-1", clubId="club-1",
        matchId="m-1", playerId="player-1",
        payload=GPSReading(lat=52.5, lon=13.4, speed=8.0, x=50.0, y=30.0),
        confidence=1.0,
    )
    engine.ingest(packet)
    states = engine.player_states("m-1")
    assert len(states) == 1
    assert states[0].playerId == "player-1"
    assert states[0].sprint == 1     # speed 8.0 > SPRINT_THRESHOLD_MPS
