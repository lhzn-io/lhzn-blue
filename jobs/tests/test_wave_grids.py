"""wave_grids.py: NWPS and NECOFS waves on their own grids for the Waves view, written only when a model has a newer run."""

import base64

import numpy as np
import pandas as pd
import pytest
import xarray as xr

from lhzn_blue_jobs import wave_grids as wg

T = pd.Timestamp


def unb64(s):
    return np.frombuffer(base64.b64decode(s), np.uint8)


def nwps_doc(cycle="2026-11-25T00Z", hours=range(0, 80), hs=1.0, to_deg=90.0):
    """A 2 x 2 NWPS map layer; the north-east cell is land."""
    step, tp_step = 0.05, 0.125
    to = np.radians(to_deg)
    q = lambda a, k: base64.b64encode(np.clip(np.round(np.asarray(a) / k), -127, 127).astype(np.int8).tobytes()).decode()  # noqa: E731
    frames = []
    for h in hours:
        t = T("2026-11-25T00:00") + pd.Timedelta(hours=h)
        frames.append({"valid_time": f"{t:%Y-%m-%dT%H:%MZ}", "cycle": cycle, "lead": h,
                       "u": q(np.full(4, hs * np.sin(to)), step), "v": q(np.full(4, hs * np.cos(to)), step), "tp": q(np.full(4, 8.0), tp_step)})
    return {"encoding": {"step": step, "tp_step": tp_step},
            "mesh": {"nx": 2, "ny": 2, "corner_lon": list(range(9)), "corner_lat": list(range(9)), "land": [0, 0, 0, 1]},
            "frames": frames}


def necofs_ds(start="2026-11-24T12:00", hours=90, wdir_from=270.0):
    t = pd.date_range(start, periods=hours, freq="1h")
    n = 4
    return xr.Dataset(
        {"hs": (("time", "node"), np.full((hours, n), 0.6, np.float32)),
         "wdir": (("time", "node"), np.full((hours, n), wdir_from, np.float32)),
         "tpeak": (("time", "node"), np.full((hours, n), 4.0, np.float32)),
         "node_lon": (("node",), np.array([-72.0, -71.9, -72.0, -71.9], np.float32)),
         "node_lat": (("node",), np.array([41.0, 41.0, 41.1, 41.1], np.float32)),
         "triangles": (("element", "vertex"), np.array([[0, 1, 2], [1, 3, 2]], np.int32))},
        coords={"time": t},
    )


def test_frame_times_every_3_hours_to_72():
    times = wg.frame_times(T("2026-11-25T04:40", tz="UTC"))
    assert times[0] == T("2026-11-25T03:00") and times[-1] == T("2026-11-28T03:00") and len(times) == 25


def test_bytes_mark_missing_and_wrap_directions():
    assert wg._bytes([0.0, 0.05, np.nan, 99.0], 0.05).tolist() == [0, 1, 255, 254]
    assert wg._bytes([359.9, 0.0, 180.0, np.nan], wg.DIR_STEP, 360.0).tolist() == [0, 0, 128, 255]


def test_nwps_frames_give_height_direction_of_travel_and_peak_period_with_land_marked():
    m = wg.nwps_model(nwps_doc(hs=1.0, to_deg=90.0), wg.frame_times(T("2026-11-25T04:00")))
    assert m["period"] == "peak period" and m["run"] == "2026-11-25T00Z" and m["grid"]["land"] == [0, 0, 0, 1]
    f = m["frames"][0]
    assert f["valid_time"] == "2026-11-25T03:00Z" and f["lead_h"] == 3
    assert unb64(f["hs"]).tolist() == [20, 20, 20, 255]
    assert unb64(f["dir"]).tolist()[:3] == [64, 64, 64]  # 90 degrees: travelling east
    assert unb64(f["tp"]).tolist()[:3] == [64, 64, 64]
    assert len(m["frames"]) == 25 - 0  # 03:00 to 72 h later all inside the doc's 80 hours


def test_necofs_direction_is_turned_from_coming_from_to_travel():
    times = wg.frame_times(T("2026-11-25T04:00"))
    m = wg.necofs_model(necofs_ds(wdir_from=270.0), times)
    f = m["frames"][0]
    assert unb64(f["dir"]).tolist() == [64] * 4  # from the west, so travelling east
    assert unb64(f["hs"]).tolist() == [12] * 4 and unb64(f["tp"]).tolist() == [32] * 4
    assert m["period"].startswith("mean period") and m["run"] == "2026-11-28T05:00Z"
    assert m["grid"]["type"] == "nodes" and m["grid"]["tri"] == [0, 1, 2, 1, 3, 2]
    assert len(m["frames"]) == 25 - 0 or m["frames"][-1]["valid_time"] <= "2026-11-28T05:00Z"


def never(start, hours):
    raise AssertionError("NECOFS should not be asked")


def test_first_run_writes_then_nothing_new_writes_nothing():
    out, s = wg.build(None, nwps_doc(), T("2026-11-25T12:30"), read_necofs=lambda start, hours: necofs_ds())
    assert out is not None and set(out["models"]) == {"nwps", "necofs"} and len(out["times"]) == 25
    again, s2 = wg.build(out, nwps_doc(), T("2026-11-25T13:30"), read_necofs=lambda start, hours: necofs_ds())
    assert again is None and s2["asked_necofs"]  # asked (morning hours) but the same run


def test_necofs_is_not_asked_outside_its_hours_and_a_new_nwps_run_rewrites():
    out, _ = wg.build(None, nwps_doc(), T("2026-11-25T12:30"), read_necofs=lambda start, hours: necofs_ds(hours=120))
    new, s = wg.build(out, nwps_doc(cycle="2026-11-25T12Z"), T("2026-11-25T19:30"), read_necofs=never)
    assert not s["asked_necofs"] and new is not None
    assert new["models"]["nwps"]["run"] == "2026-11-25T12Z"
    kept = new["models"]["necofs"]
    assert kept["run"] == out["models"]["necofs"]["run"] and all(f["valid_time"] in new["times"] for f in kept["frames"])


def test_a_short_necofs_reach_asks_again_and_a_failed_read_keeps_the_old_frames():
    out, _ = wg.build(None, nwps_doc(), T("2026-11-25T12:30"), read_necofs=lambda start, hours: necofs_ds(hours=40))
    def fails(start, hours):
        raise RuntimeError("server down")
    new, s = wg.build(out, nwps_doc(cycle="2026-11-25T12Z"), T("2026-11-25T20:30"), read_necofs=fails)
    assert s["asked_necofs"]  # reach ends 2026-11-26T03:00, under 60 h ahead
    assert new["models"]["necofs"]["run"] == out["models"]["necofs"]["run"]


def test_no_models_no_file():
    def fails(start, hours):
        raise RuntimeError("down")
    out, _ = wg.build(None, None, T("2026-11-25T12:30"), read_necofs=fails)
    assert out is None


def test_read_starts_at_the_newest_posted_run_day():
    assert wg.read_window(T("2026-11-25T11:30"), T("2026-11-25T09:00")) == (T("2026-11-24T00:00"), 33 + 120)
    assert wg.read_window(T("2026-11-25T13:30"), T("2026-11-25T12:00")) == (T("2026-11-25T00:00"), 12 + 120)
    seen = []
    wg.build(None, nwps_doc(), T("2026-11-25T13:30"), read_necofs=lambda start, hours: seen.append((start, hours)) or necofs_ds())
    assert seen == [(T("2026-11-25T00:00"), 132)]


PTS = {"NEAR": (-71.99, 41.005), "FAR": (-71.0, 41.0)}


def test_buoy_file_reads_the_nearest_node_from_the_run_start():
    ds = necofs_ds(start="2026-11-24T00:00", hours=121 + 24)  # ends 2026-11-30T00: run start 2026-11-25T00
    doc = wg.buoy_file(None, ds, PTS, T("2026-11-25T13:30"))
    assert list(doc["runs"]) == ["2026-11-25T00Z"] and set(doc["cells"]) == {"NEAR"}  # FAR has no node within 4 km
    assert doc["cells"]["NEAR"] == {"lat": 41.0, "lon": -72.0, "km": 1.0}
    r = doc["runs"]["2026-11-25T00Z"]
    assert r["steps"][0] == 0 and r["steps"][-1] == 120 and len(r["steps"]) == 121
    p = r["points"]["NEAR"]
    assert p["hs"][0] == 0.6 and p["tp"][0] == 4.0 and p["dir"][0] == 270  # the direction the waves come from


def test_buoy_file_writes_once_per_run_and_keeps_96_hours():
    ds = necofs_ds(start="2026-11-24T00:00", hours=145)
    doc = wg.buoy_file(None, ds, PTS, T("2026-11-25T13:30"))
    assert wg.buoy_file(doc, ds, PTS, T("2026-11-25T14:30")) is None  # the same run read again
    # A later read of the same run starting after its first hours keeps those hours.
    late = wg.buoy_file(doc, necofs_ds(start="2026-11-25T06:00", hours=115), PTS, T("2026-11-25T15:30"))
    assert late is None
    nxt = wg.buoy_file(doc, necofs_ds(start="2026-11-25T00:00", hours=145), PTS, T("2026-11-26T13:30"))
    assert list(nxt["runs"]) == ["2026-11-25T00Z", "2026-11-26T00Z"]
    later = wg.buoy_file(nxt, necofs_ds(start="2026-11-28T00:00", hours=145), PTS, T("2026-11-29T13:30"))
    assert list(later["runs"]) == ["2026-11-26T00Z", "2026-11-29T00Z"]  # 2026-11-25T00Z is past 96 h


def test_archive_names_the_run_start_and_refuses_a_second_write(tmp_path):
    ds = necofs_ds(start="2026-11-24T00:00", hours=145)  # ends 2026-11-30T00: run start 2026-11-25T00
    ds["wdir"].values[:] = 359.9  # packed directions must reach 360
    assert wg.archive(str(tmp_path), ds, T("2026-11-24T00:00"), 145) == "2026/11/necofs_waves_gom7_20261125_00.nc"
    f = tmp_path / "2026/11/necofs_waves_gom7_20261125_00.nc"
    assert f.stat().st_size > 0
    back = xr.open_dataset(f, engine="h5netcdf")
    assert back.attrs["attribution"] == "NECOFS/UMASSD" and float(back["hs"].values[0, 0]) == pytest.approx(0.6)
    assert float(back["wdir"].values[0, 0]) == pytest.approx(359.9, abs=0.02)
    back.close()
    assert wg.archive(str(tmp_path), ds, T("2026-11-24T00:00"), 145) is None  # create-only


def test_a_read_missing_the_run_start_is_not_archived(tmp_path):
    ds = necofs_ds(start="2026-11-25T06:00", hours=115)  # run start 2026-11-25T00, read from 06:00
    assert wg.archive(str(tmp_path), ds, T("2026-11-25T06:00"), 115) is None
    assert not any(tmp_path.rglob("*.nc"))


def test_publish_archives_only_when_it_read_necofs(tmp_path, monkeypatch):
    from lhzn_blue_jobs import build

    store = build.Store(str(tmp_path / "kv"))
    arch = tmp_path / "arch"
    monkeypatch.setattr(wg, "_read_necofs", lambda start, hours: necofs_ds(start="2026-11-24T00:00", hours=145))
    wg.publish(store, T("2026-11-25T13:30"), archive_root=str(arch))
    assert [p.name for p in arch.rglob("*.nc")] == ["necofs_waves_gom7_20261125_00.nc"]
    monkeypatch.setattr(wg, "_read_necofs", never)
    wg.publish(store, T("2026-11-25T19:30"), archive_root=str(arch))  # outside its hours: not asked, nothing archived
    assert len(list(arch.rglob("*.nc"))) == 1
