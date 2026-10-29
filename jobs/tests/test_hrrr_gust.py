"""HRRR gusts in the wind map layer (hrrr_grid._frame and history), without network access."""

from __future__ import annotations

import numpy as np
import pandas as pd
import xarray as xr

from lhzn_blue_jobs import hrrr_grid as hg

CYCLE = pd.Timestamp("2026-10-29T12:00")


def lead_data(gust: list[float] | None) -> dict:
    attrs = {"GRIB_uvRelativeToGrid": 0}  # already east and north: no rotation
    d = {"u10": xr.DataArray(np.array([[2.0, -3.0]]), attrs=attrs), "v10": xr.DataArray(np.array([[1.0, 0.5]]), attrs=attrs)}
    if gust is not None:
        d["gust"] = xr.DataArray(np.array([gust]))
    return d


def test_frame_carries_the_gust():
    f = hg._frame(CYCLE, 1, lead_data([9.0, 40.0]), np.array([-73.0, -72.9]))
    assert np.allclose(hg.decode(f["u"]), [2.0, -3.0])
    assert np.allclose(hg.decode(f["gust"]), [9.0, 127 * hg.STEP])  # clipped at the top of the scale


def test_gust_is_never_negative():
    f = hg._frame(CYCLE, 1, lead_data([-1.0, np.nan]), np.array([-73.0, -72.9]))
    assert np.allclose(hg.decode(f["gust"]), [0.0, 0.0])


def test_a_lead_without_gust_still_gives_the_wind():
    f = hg._frame(CYCLE, 1, lead_data(None), np.array([-73.0, -72.9]))
    assert "gust" not in f and np.allclose(hg.decode(f["v"]), [1.0, 0.5])


def test_history_keeps_gusts_and_frames_without_them():
    mesh = {"version": hg.MESH_VERSION, "nx": 2, "ny": 1, "block": {"row0": 0, "col0": 0}, "centre_lon": [-73.0, -72.9]}
    enc = {"type": "int8 base64", "step": hg.STEP, "clip": round(127 * hg.STEP, 2), "gust_step": hg.STEP}
    old = hg._frame(CYCLE - pd.Timedelta(hours=40), 1, lead_data(None), np.array([-73.0, -72.9]))
    new = hg._frame(CYCLE - pd.Timedelta(hours=30), 1, lead_data([8.0, 8.0]), np.array([-73.0, -72.9]))
    prev_main = {"box": list(hg.BOX), "encoding": enc, "mesh": mesh, "frames": [old, new]}
    main = {"box": list(hg.BOX), "encoding": enc, "mesh": mesh,
            "frames": [hg._frame(CYCLE, 1, lead_data([5.0, 5.0]), np.array([-73.0, -72.9]))]}
    h = hg.history(None, prev_main, main, end=CYCLE)
    assert h["encoding"]["gust_step"] == hg.STEP
    by = {f["valid_time"]: f for f in h["frames"]}
    assert "gust" not in by[old["valid_time"]] and np.allclose(hg.decode(by[new["valid_time"]]["gust"]), 8.0)
