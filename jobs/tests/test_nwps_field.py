"""The NWPS map layer (nwps.field_file), from a synthetic grid without network access."""

from __future__ import annotations

import base64
from datetime import datetime, timezone

import numpy as np

from lhzn_blue_jobs import nwps

END = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)


def grid_run(tp: float) -> dict:
    lat, lon = np.array([41.0, 41.02], dtype=np.float32), np.array([-73.0, -72.98, -72.96], dtype=np.float32)
    shape = (3, lat.size, lon.size)
    hs = np.full(shape, 1.2, dtype=np.float32)
    hs[:, 0, 0] = np.nan  # land
    return {"steps": [0, 1, 2], "grid": {"lat": lat, "lon": lon, "hs": hs, "dir": np.full(shape, 270.0, dtype=np.float32),
                                         "tp": np.where(np.isnan(hs), np.nan, tp).astype(np.float32)}}


def decode(b64: str, step: float) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b64), dtype=np.int8) * step


def test_frames_carry_the_peak_period():
    doc = nwps.field_file(None, {"2026-10-29T06Z": grid_run(6.3)}, END)
    enc = doc["encoding"]
    assert enc["tp_step"] == nwps.FIELD_TP_STEP
    for f in doc["frames"]:
        tp = decode(f["tp"], enc["tp_step"])
        assert tp[0] == 0  # land
        assert np.allclose(tp[1:], 6.25)  # nearest step of 0.125 s
        u = decode(f["u"], enc["step"])
        assert np.allclose(u[1:], 1.2)  # from the west: travelling east


def test_long_periods_clip_at_the_top_of_the_scale():
    doc = nwps.field_file(None, {"2026-10-29T06Z": grid_run(22.0)}, END)
    tp = decode(doc["frames"][0]["tp"], doc["encoding"]["tp_step"])
    assert tp[1:].max() == doc["encoding"]["tp_clip"]


def test_frames_from_before_the_period_are_kept():
    old = nwps.field_file(None, {"2026-10-29T06Z": grid_run(6.0)}, END)
    for f in old["frames"]:
        del f["tp"]
    old["encoding"] = {"type": "int8 base64", "step": nwps.FIELD_STEP, "clip": round(127 * nwps.FIELD_STEP, 2)}
    doc = nwps.field_file(old, {}, END)
    assert [f["valid_time"] for f in doc["frames"]] == [f["valid_time"] for f in old["frames"]]
