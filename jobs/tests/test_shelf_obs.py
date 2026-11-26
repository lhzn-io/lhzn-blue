"""Measured currents beside the shelf models (shelf_obs): screening, hours and depths, model sampling, scores, files."""

import json

import numpy as np
import pandas as pd
import pytest

from lhzn_blue_jobs import shelf, shelf_obs, tiles
from lhzn_blue_jobs.build import Store

DAY = pd.Timestamp("2022-08-12", tz="UTC")
LON, LAT = -70.88, 40.10


def _profiles(hours=24, every_min=30, depths=range(2, 121, 4), u=0.2, v=-0.1, start=DAY):
    """An upward-looking profiler: bins from 2 to 118 m, a fixed current."""
    rows = []
    for t in pd.date_range(start, periods=hours * 60 // every_min, freq=f"{every_min}min"):
        for d in depths:
            rows.append((t, float(d), u, v, 0.01))
    return pd.DataFrame(rows, columns=["time", "depth", "u", "v", "evl"])


def test_screen_drops_the_surface_band_spikes_and_noisy_bins():
    df = _profiles(hours=1)
    df.loc[df["depth"] == 30, "u"] = 3.0  # a spike
    df.loc[df["depth"] == 50, "evl"] = 0.4  # a noisy bin
    df.loc[df["depth"] == 70, "u"] = np.nan
    kept, counts = shelf_obs.screen(df)
    # deepest bin 118 m, bins 4 m apart: 0.06 * 122 + 4 = 11.3 m lost under the surface
    assert counts["top_m"] == 11.3 and kept["depth"].min() == 14
    assert counts["too_fast"] == 2 and counts["error_velocity"] == 2 and counts["missing"] == 2
    assert not (kept["depth"].isin([30, 50, 70])).any()


def test_at_depths_averages_hours_and_stays_inside_the_good_bins():
    df = _profiles(depths=range(14, 61, 4))  # good bins 14 to 58 m only
    df.loc[df["time"].dt.minute == 30, "u"] = 0.4  # half-hour profiles differ: the hour mean is centered
    out = shelf_obs.at_depths(df, DAY)
    assert np.isnan(out[10]).all() and np.isnan(out[100]).all()
    # hour 0 holds 00:00 only (23:30 the day before is outside the frame), later hours 00:30 to 01:00 etc.
    assert out[25][0, 0] == pytest.approx(0.2) and out[25][5, 0] == pytest.approx(0.3)
    assert out[50][5, 1] == pytest.approx(-0.1)


def _quad_blob(u, v):
    nodes = np.array([[LON - 0.05, LAT - 0.05], [LON + 0.05, LAT - 0.05], [LON + 0.05, LAT + 0.05], [LON - 0.05, LAT + 0.05]])
    return tiles.encode(nodes, np.array([[0, 1, 2, 3]]), np.array([0]), np.full((24, 1), u), np.full((24, 1), v))


def _tri_pack(u, v):
    nodes = np.array([[LON - 0.05, LAT - 0.05], [LON + 0.05, LAT - 0.05], [LON, LAT + 0.05]])
    blob = tiles.encode(nodes, np.array([[0, 1, 2]]), np.array([0]), np.full((24, 1), u), np.full((24, 1), v))
    x, y = shelf_obs._tile_xy(LON, LAT, 10)
    return blob, {f"10/{x}/{y}": [0, len(blob), 1], "10/0/0": [0, len(blob), 1]}


def _day(ts, rel="days/2022-08-12"):
    """An archived day with both models at 50 m only: DOPPIO one quad (0.2, -0.1), NECOFS one triangle (0.6, 0.1)."""
    ts.put(f"{shelf.BASE}/{rel}/depth/50m/doppio.bin", _quad_blob(0.2, -0.1), 60)
    pack, index = _tri_pack(0.6, 0.1)
    ts.put(f"{shelf.BASE}/{rel}/depth/50m/necofs.bin", pack, 60)
    layer = {"t0": "2022-08-12T00:00:00Z", "step": 3600, "steps": 24}
    idx = {"schema": 1, "day": "2022-08-12", "complete": True, "models": {
        "doppio": {"steps": 24, "depths": {"50": {**layer, "wide": f"{rel}/depth/50m/doppio.bin"}}},
        "necofs": {"steps": 24, "depths": {"50": {**layer, "pack": f"{rel}/depth/50m/necofs.bin", "tiles": index}}}}}
    ts.put(f"{shelf.BASE}/{rel}/index.json", json.dumps(idx).encode(), 60)


def test_model_at_reads_the_cell_holding_the_point(tmp_path):
    ts = tiles.TileStore(str(tmp_path))
    _day(ts)
    idx = json.loads(ts.get(f"{shelf.BASE}/days/2022-08-12/index.json"))["models"]
    d = shelf_obs.model_at(ts, idx["doppio"]["depths"]["50"], LON, LAT)
    n = shelf_obs.model_at(ts, idx["necofs"]["depths"]["50"], LON, LAT)
    assert d.shape == (24, 2) and d[0] == pytest.approx([0.2, -0.1], abs=0.02)
    assert n[3] == pytest.approx([0.6, 0.1], abs=0.02)
    assert shelf_obs.model_at(ts, idx["doppio"]["depths"]["50"], LON + 1, LAT) is None


def test_scores_are_vector_rms_over_the_hours_both_hold():
    m = {k: np.full((24, 2), np.nan) for k in shelf_obs.DEPTHS}
    m[50][:] = [0.2, -0.1]
    m[50][:4] = np.nan  # four hours without a measurement
    model = {k: np.full((24, 2), [0.5, 0.3]) for k in (50,)}
    s = shelf_obs.scores({"a": m}, {"necofs": {"a": model}, "doppio": {"a": {50: np.full((24, 2), [0.2, -0.1])}}})
    assert list(s) == ["50"] and s["50"]["moorings"] == 1
    assert s["50"]["necofs"] == {"rms": 0.5, "n": 20} and s["50"]["doppio"]["rms"] == 0.0


def test_backfill_writes_obs_and_its_index_entry_and_skips_unarchived_days(tmp_path, monkeypatch):
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    _day(ts)
    monkeypatch.setattr(shelf_obs, "moorings", lambda: [
        {"id": "aa", "name": "Test mooring", "lon": LON, "lat": LAT, "first": "2022-01-01", "last": "2022-12-31"},
        {"id": "bb", "name": "Gone", "lon": LON, "lat": LAT, "first": "2020-01-01", "last": "2021-01-01"}])
    asked = []

    def fetch(server, id_, start, end):
        asked.append(id_)
        return _profiles(hours=48, start=DAY - pd.Timedelta(hours=12))

    monkeypatch.setattr(shelf_obs, "fetch", fetch)
    assert shelf_obs.backfill(Store(str(tmp_path / "out")), "2022-08-12", "2022-08-13", ts, server=object()) == []
    assert asked == ["aa"]  # a mooring without data in the span is not asked
    doc = json.loads(ts.get(f"{shelf.BASE}/days/2022-08-12/obs.json"))
    assert doc["source"].startswith("Ocean Observatories Initiative") and doc["moorings"][0]["id"] == "AA"
    assert doc["moorings"][0]["uv"]["50"][0] == [0.2, -0.1]
    got = doc["moorings"][0]["models"]  # each model's hours at the mooring, for the page's time series
    assert sorted(got) == ["doppio", "necofs"] and list(got["necofs"]) == ["50"] and len(got["necofs"]["50"]) == 24
    assert got["doppio"]["50"][7] == pytest.approx([0.2, -0.1], abs=0.02) and got["necofs"]["50"][7] == pytest.approx([0.6, 0.1], abs=0.02)
    assert doc["scores"]["50"]["doppio"]["rms"] == pytest.approx(0.0, abs=0.02)
    assert doc["scores"]["50"]["necofs"]["rms"] == pytest.approx(0.45, abs=0.03)
    idx = json.loads(ts.get(f"{shelf.BASE}/days/2022-08-12/index.json"))
    assert idx["obs"]["file"] == "days/2022-08-12/obs.json" and idx["obs"]["moorings"] == 1
    assert idx["obs"]["depths"] == [25, 50, 100] and idx["models"]["doppio"]["steps"] == 24
    assert ts.get(f"{shelf.BASE}/days/2022-08-13/obs.json") is None  # not archived


def test_backfill_refuses_a_span_too_long(tmp_path):
    with pytest.raises(ValueError):
        shelf_obs.backfill(Store(str(tmp_path)), "2022-01-01", "2022-12-31", tiles.TileStore(str(tmp_path)), server=object())


def test_the_registry_loads_and_lists_the_new_england_moorings():
    got = shelf_obs.moorings()
    assert len(got) == 10 and all(-71 < m["lon"] < -70.7 and 39.9 < m["lat"] < 40.4 for m in got)
    assert all(m["first"] < m["last"] for m in got)
