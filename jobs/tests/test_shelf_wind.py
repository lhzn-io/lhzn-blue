"""Wind over the Northeast U.S. Shelf (shelf_wind.py): which cycle each hour comes from, the cells kept, and a whole
run into a local tile store with stand-in model reads."""

import io
import json

import numpy as np
import pandas as pd
import xarray as xr

from lhzn_blue_jobs import shelf_wind as sw
from lhzn_blue_jobs import tiles
from lhzn_blue_jobs.build import Store

T = pd.Timestamp
H = pd.Timedelta(hours=1)


def test_hrrr_plan_past_hours_from_the_cycle_before_and_later_ones_from_the_newest_that_reaches():
    now = T("2026-11-24 12:00")
    hourly, synoptic = T("2026-11-24 11:00"), T("2026-11-24 06:00")
    hours = [T("2026-11-24 11:00"), T("2026-11-24 13:00"), T("2026-11-25 05:00"), T("2026-11-25 06:00"), T("2026-11-26 06:00"), T("2026-11-26 07:00")]
    plan = sw.hrrr_plan(hours, now, hourly, synoptic)
    assert plan[hours[0]] == [(T("2026-11-24 10:00"), 1), (T("2026-11-24 09:00"), 2), (T("2026-11-24 08:00"), 3)]
    assert plan[hours[1]] == [(hourly, 2), (synoptic, 7)]
    assert plan[hours[2]] == [(hourly, 18), (synoptic, 23)]  # the hourly cycle's last lead
    assert plan[hours[3]] == [(synoptic, 24)]
    assert plan[hours[4]] == [(synoptic, 48)]
    assert hours[5] not in plan  # past HRRR's reach: GFS only


def test_hrrr_cycles_newest_hourly_and_synoptic():
    posted = {T("2026-11-24 09:00"), T("2026-11-24 06:00"), T("2026-11-24 00:00")}
    assert sw.hrrr_cycles(T("2026-11-24 12:00"), lambda c: c in posted) == (T("2026-11-24 09:00"), T("2026-11-24 06:00"))


def test_gfs_newest_and_plan():
    now = T("2026-11-24 12:00")
    newest = sw.gfs_newest(now, now + 72 * H, lambda c, lead: c <= T("2026-11-24 06:00") and lead <= 120)
    assert newest == T("2026-11-24 06:00")  # 12Z is the run's own hour, not yet out
    assert sw.gfs_newest(now, T("2026-11-23 23:00"), lambda c, lead: True) == T("2026-11-23 18:00")  # never a negative lead
    plan = sw.gfs_plan([T("2026-11-24 03:00"), T("2026-11-24 20:00")], newest)
    assert plan[T("2026-11-24 03:00")] == [(T("2026-11-24 00:00"), 3), (T("2026-11-23 18:00"), 9)]
    assert plan[T("2026-11-24 20:00")][0] == (newest, 14)
    assert sw.gfs_plan([now], None) == {}


def test_near_water_by_distance():
    wl, wa = np.array([-70.0]), np.array([40.0])
    lon = np.array([[-70.0, -70.05, -70.2]])
    lat = np.array([[40.0, 40.0, 40.0]])
    assert sw.near_water(lon, lat, wl, wa, 0.07).tolist() == [[True, True, False]]


# ---------------------------------------------------------------------------------------------
# A whole run with stand-in reads


def _fake(monkeypatch, tmp_path, gfs_fails=False):
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    lon, lat = np.meshgrid(np.arange(-71.0, -69.0, 0.1), np.arange(40.0, 41.0, 0.1))
    wet = np.ones(lon.shape, bool)
    wet[-2:, :] = False  # the north edge is land
    buf = io.BytesIO()
    np.savez_compressed(buf, lon=lon.astype(np.float32), lat=lat.astype(np.float32), wet=wet)
    ts.put(sw.GRID, buf.getvalue(), 60)
    # "HRRR": a 0.03 degree grid reaching only to 70 W, so the eastern half is GFS's alone.
    hl, ha = np.meshgrid(np.arange(-72.0, -70.0, 0.03), np.arange(39.5, 41.5, 0.03))
    full = xr.DataArray(np.zeros(hl.shape), dims=("y", "x"), coords={"longitude": (("y", "x"), hl + 360.0), "latitude": (("y", "x"), ha)})
    monkeypatch.setattr(sw, "_full_u", lambda c, lead, wd: full)

    def hrrr_hour(cands, mesh, wd):
        c, lead = cands[0]
        n = mesh.flat.size
        u = np.full(n, 5.0, np.float32)
        u[0] = 40.0  # a storm cell: more than the Sound's int8 at 0.25 m/s holds
        return c, lead, u, np.full(n, -3.0, np.float32), np.full(n, 38.0, np.float32)

    def gfs_grid(cycle, water_lon, water_lat, box, mesh):
        gl, ga = np.meshgrid(np.arange(-71.25, -68.75, 0.25), np.arange(39.75, 41.25, 0.25))
        keep = sw.near_water(gl, ga, water_lon, water_lat, sw.GFS_NEAR_DEG)
        cells = np.flatnonzero(keep.ravel())
        inside = sw.near_water(gl.ravel()[cells], ga.ravel()[cells], mesh.full_lon.ravel(), mesh.full_lat.ravel(), sw.HRRR_INSIDE_DEG).astype(float)
        return None, None, cells, gl, ga, keep, inside

    def gfs_hour(cands, rows, cols, cells):
        if gfs_fails:
            return None
        c, lead = cands[0]
        return c, lead, np.full(cells.size, 6.0, np.float32), np.zeros(cells.size, np.float32), np.full(cells.size, 9.0, np.float32)

    monkeypatch.setattr(sw, "_hrrr_hour", hrrr_hour)
    monkeypatch.setattr(sw, "_gfs_grid", gfs_grid)
    monkeypatch.setattr(sw, "_gfs_hour", gfs_hour)
    return ts


def _run(ts, tmp_path, end):
    return sw.publish(Store(str(tmp_path / "out")), T(end, tz="UTC"), ts, hrrr_complete=lambda c: True, gfs_has_lead=lambda c, lead: True)


def test_publish_writes_both_models_and_the_archive(tmp_path, monkeypatch):
    ts = _fake(monkeypatch, tmp_path)
    assert _run(ts, tmp_path, "2026-11-24 12:00") == []
    latest = json.loads(ts.get(sw.LATEST))
    hr, gf = latest["models"]["hrrr"], latest["models"]["gfs"]
    assert hr["run"] == gf["run"] == "wind/runs/20261124T12Z"
    assert len(gf["times"]) == sw.HOURS_BACK + sw.HOURS_AHEAD + 1  # GFS covers the whole window
    assert hr["times"][-1] == "2026-11-26T06:00:00Z"  # HRRR to its 06Z cycle's 48th hour; GFS beyond
    assert hr["cycles"][0] == ["2026-11-23T11Z", 1] and hr["cycles"][-1] == ["2026-11-24T06Z", 48]
    pack = ts.get(f"shelf/v1/{hr['pack']}")
    gust = ts.get(f"shelf/v1/{hr['gust']}")
    assert sum(t[2] for t in hr["index"].values()) == hr["cells"]
    peak = 0.0
    for off, length, n, goff, glen in hr["index"].values():  # each range is a whole blob, wind and gust alike
        d = tiles.decode(pack[off : off + length])
        assert d["elements"] == n and d["verts"] == 4 and d["steps"] == len(hr["times"])
        peak = max(peak, float(d["u"].max()))
        np.testing.assert_allclose(tiles.decode_values(gust[goff : goff + glen])["gust"], 38.0, atol=0.2)
    assert abs(peak - 40.0) < 0.2  # not clipped
    assert 0 < hr["wide_cells"] < hr["cells"]
    g = tiles.decode_values(ts.get(f"shelf/v1/{gf['ts']}"))
    assert 0 < gf["in_hrrr"] < gf["cells"] and set(np.unique(g["in_hrrr"])) == {0.0, 1.0}
    days = json.loads(ts.get(f"{sw.BASE}/days.json"))["days"]
    assert days == {"2026-11-21": True, "2026-11-22": True, "2026-11-23": True}
    day = json.loads(ts.get(f"{sw.BASE}/days/2026-11-23/index.json"))
    assert day["models"]["hrrr"]["cycles"][0] == ["2026-11-22T23Z", 1] and day["models"]["gfs"]["cycles"][0] == ["2026-11-23T00Z", 0]


def test_a_failed_model_keeps_its_previous_entry_and_old_runs_go(tmp_path, monkeypatch):
    ts = _fake(monkeypatch, tmp_path)
    for h in ("06", "12", "18"):
        _run(ts, tmp_path, f"2026-11-24 {h}:00")
    ts = _fake(monkeypatch, tmp_path, gfs_fails=True)
    failed = _run(ts, tmp_path, "2026-11-25 00:00")
    assert failed and "gfs" in failed[0]
    models = json.loads(ts.get(sw.LATEST))["models"]
    assert models["hrrr"]["run"] == "wind/runs/20261125T00Z"
    assert models["gfs"]["run"] == "wind/runs/20261124T18Z"  # yesterday's, its files kept
    assert ts.get(f"shelf/v1/{models['gfs']['wide']}") is not None
    assert ts.runs(f"{sw.BASE}/runs") == ["20261124T12Z", "20261124T18Z", "20261125T00Z"]


def test_no_domain_is_a_fault_not_a_crash(tmp_path):
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    failed = sw.publish(Store(str(tmp_path / "out")), T("2026-11-24 12:00", tz="UTC"), ts)
    assert failed and "domain" in failed[0]
