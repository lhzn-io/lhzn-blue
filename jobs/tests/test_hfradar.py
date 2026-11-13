"""The Sound's HF radar archive (hfradar.py): the box, where the files go, and that requests name this site. The
reading and the file format are forcingkit's and tested there. Offline."""

from forcingkit.fetchers import hfradar as fk

from lhzn_blue_jobs import hfradar
from lhzn_blue_jobs.merlin import USER_AGENT


def test_box_is_the_sound():
    assert fk.box_key(hfradar.BBOX) == "40.850N_41.300N_073.800W_071.800W"


def test_store_is_a_directory_unless_a_bucket(tmp_path, monkeypatch):
    monkeypatch.setenv("FORCINGKIT_CACHE_DIR", str(tmp_path))
    assert hfradar.store(None).root == tmp_path / "hfradar"  # forcingkit's own cache
    assert hfradar.store(str(tmp_path / "elsewhere")).root == tmp_path / "elsewhere"


def test_archive_passes_the_box_store_and_user_agent(tmp_path, monkeypatch):
    seen = {}

    def fake(bbox, start, end, store, session):
        seen.update(bbox=bbox, start=start, end=end, store=store, agent=session.headers["User-Agent"])
        return {"1km": [], "2km": []}

    monkeypatch.setattr(fk, "archive", fake)
    assert hfradar.archive(str(tmp_path), "all") == {"1km": [], "2km": []}
    assert seen["bbox"] == hfradar.BBOX and seen["start"] == "all" and seen["end"] is None
    assert seen["store"].root == tmp_path and seen["agent"] == USER_AGENT


def test_layer_keeps_the_last_hours_at_the_cells_with_data():
    import base64
    from datetime import datetime, timezone

    import numpy as np
    import pandas as pd
    import xarray as xr

    time = pd.date_range("2026-11-10T00", periods=80, freq="h")
    lat = np.round(40.9 + 0.009 * np.arange(3), 5)
    lon = np.round(-73.7 + 0.0097 * np.arange(4), 5)
    u = np.full((80, 3, 4), np.nan)
    v = np.full((80, 3, 4), np.nan)
    u[:79, 1, 2], v[:79, 1, 2] = 0.31, -3.0  # the last hour has no totals; v beyond the int8 range is clipped
    u[5, 0, 0] = 0.1  # only in an hour older than the window
    gdop = np.where(np.isfinite(u), 1.12, np.nan)
    ds = xr.Dataset({"u": (("time", "lat", "lon"), u), "v": (("time", "lat", "lon"), v),
                     "hdop": (("time", "lat", "lon"), gdop)},
                    coords={"time": time, "lat": lat, "lon": lon})
    out = hfradar.layer(ds, datetime(2026, 11, 13, 12, tzinfo=timezone.utc))
    assert len(out["frames"]) == hfradar.LIVE_HOURS
    assert out["frames"][-1]["valid_time"] == "2026-11-13T06:00:00Z"  # the newest hour with any total
    assert out["cells"] == [1 * 4 + 2] and out["grid"]["nx"] == 4 and out["grid"]["ny"] == 3
    q = lambda s: np.frombuffer(base64.b64decode(s), dtype=np.int8).tolist()
    assert q(out["frames"][0]["u"]) == [16] and q(out["frames"][0]["v"]) == [-127]  # 0.31 m/s in 0.02 steps
    assert np.frombuffer(base64.b64decode(out["frames"][0]["g"]), dtype=np.uint8).tolist() == [112]
    assert "LISICOS" in out["attribution"]


def test_model_runs_keep_each_run_at_the_radar_cells(tmp_path):
    import base64

    import numpy as np

    from lhzn_blue_jobs import build

    store = build.Store(str(tmp_path))
    grid = {"lon0": -73.7, "lat0": 40.9, "dlon": 0.01, "dlat": 0.01, "nx": 4, "ny": 3}
    store.write_json("v1/fields/hfradar.json", {"grid": grid, "cells": [5, 11]}, max_age=60)
    # One triangle over cell 5 (-73.69, 40.91); cell 11 (-73.67, 40.92) is outside it.
    mesh = {"nodes": [[-73.70, 40.90], [-73.68, 40.90], [-73.69, 40.92]], "triangles": [[0, 1, 2]]}
    data = {"generated_at": "2026-11-13T13:30:00Z", "t0": "2026-11-12T13:00:00Z", "step": 7200, "steps": 2,
            "source": "NECOFS", "layer": "surface", "u": [[30], [-31]], "v": [[0], [4]]}
    hfradar.model_runs(store, mesh, data)
    hfradar.model_runs(store, mesh, data)  # the same run again replaces itself
    out = store.read_json("v1/fields/necofs-at-radar.json")
    assert len(out["runs"]) == 1 and out["grid"] == grid
    q = np.frombuffer(base64.b64decode(out["runs"][0]["u"]), dtype=np.int8).reshape(2, 2).tolist()
    assert q == [[15, -128], [-16, -128]]  # 30 and -31 cm/s in 2 cm/s steps; no element at cell 11
