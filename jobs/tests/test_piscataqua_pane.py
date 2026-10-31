"""The 3D view's rolling window: its file round trip, where each hour comes from, and the window's reach."""

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest
import xarray as xr
from forcingkit.fetchers import necofs

from lhzn_blue_jobs import piscataqua_pane as pp
from lhzn_blue_jobs.build import Store

LON0, LAT0 = pp.BUOY
L = 3  # layers


def volume(times, value, ids=(10, 11)):
    """A two-element subset around the buoy: every u equal to `value` m/s, v its negative, zeta 0.5 m."""
    d = 0.001
    node_lon = np.array([LON0 - d, LON0 + d, LON0, LON0 + 2 * d])
    node_lat = np.array([LAT0 - d, LAT0 - d, LAT0 + d, LAT0 + d])
    tri = np.array([[0, 1, 2], [1, 3, 2]])
    T, E, N = len(times), 2, 4
    return xr.Dataset(
        {
            "u": (("time", "siglay", "element"), np.full((T, L, E), value)),
            "v": (("time", "siglay", "element"), np.full((T, L, E), -value)),
            "zeta": (("time", "node"), np.full((T, N), 0.5)),
            "h": (("node",), np.full(N, 10.0)),
            "siglay": (("siglay", "node"), np.repeat(np.array([[-1 / 6], [-0.5], [-5 / 6]]), N, axis=1)),
            "siglev": (("siglev", "node"), np.repeat(np.array([[0.0], [-1 / 3], [-2 / 3], [-1.0]]), N, axis=1)),
            "node_lon": (("node",), node_lon), "node_lat": (("node",), node_lat),
            "lonc": (("element",), node_lon[tri].mean(1)), "latc": (("element",), node_lat[tri].mean(1)),
            "triangles": (("element", "vertex"), tri),
            "element_id": (("element",), np.array(ids)),
        },
        coords={"time": pd.DatetimeIndex(times)},
    )


class Reader:
    """read_volume's signature: the archive gives `archive` m/s for the hours it is asked for (except the archive
    files dated in `missing`, each holding the hours after the day before's 00:00); the forecast `forecast` m/s for
    hours from `fc_from`."""

    def __init__(self, archive=0.3, forecast=0.1, fc_from=None, missing=(), ids=(10, 11)):
        self.archive, self.forecast, self.fc_from, self.missing, self.ids, self.calls = archive, forecast, fc_from, set(missing), ids, []

    def __call__(self, bbox, start, hours, dap_url=None):
        times = pd.date_range(pd.Timestamp(start), periods=hours, freq="h")
        self.calls.append((dap_url is not None, times[0], len(times)))
        if dap_url is None:
            times = times[times >= self.fc_from] if self.fc_from is not None else times
            return volume(times, self.forecast, self.ids)
        if str(necofs.necofs_archive_file_date(times[0]).date()) in self.missing:  # the archive file holding these hours
            raise OSError("not published")
        return volume(times, self.archive, self.ids)


def store_with_buoy(tmp_path, last="2026-10-30T12:00:00Z"):
    (tmp_path / "v1").mkdir(parents=True, exist_ok=True)
    (tmp_path / "v1/piscataqua.json").write_text(json.dumps({"buoy": {"last": last}}))
    return Store(str(tmp_path))


END = datetime(2026, 10, 30, 14, 30, tzinfo=timezone.utc)


def read_back(tmp_path):
    head, hours = pp.decode((tmp_path / pp.WINDOW_REL).read_bytes())
    mesh = json.loads((tmp_path / pp.MESH_REL).read_text())
    return head, hours, mesh


def test_round_trip():
    t = pd.Timestamp("2026-10-30T00:00")
    hours = {t: {"u": pp.quantise_uv(np.full((L, 2), 0.31)), "v": pp.quantise_uv(np.full((L, 2), -2.9)),
                 "zeta": pp.quantise_zeta(np.array([0.5, -1.25, np.nan, 2.0])), "from": "hindcast"}}
    head, back = pp.decode(pp.encode({"elements": 2, "nodes": 4, "layers": L}, hours))
    h = back[t]
    assert h["from"] == "hindcast" and head["uv_step_mm_s"] == pp.UV_STEP_MM
    assert (h["u"].astype(int) * pp.UV_STEP_MM == 320).all()  # 0.31 m/s to the nearest 2 cm/s
    assert (h["v"].astype(int) == -127).all()  # beyond 2.54 m/s, held at the end of the range
    assert h["zeta"].tolist() == [500, -1250, 0, 2000]


def test_window_around_the_buoy_with_hindcast_before_forecast(tmp_path):
    store = store_with_buoy(tmp_path)
    reader = Reader(fc_from=pd.Timestamp("2026-10-29T00:00"), missing={"2026-10-31"})
    summary = pp.update(store, END, reader=reader, max_new_days=7)
    head, hours, mesh = read_back(tmp_path)
    want = pp.window_hours(pd.Timestamp("2026-10-30T12:00"))
    assert want[0] == pd.Timestamp("2026-10-25T00:00") and want[-1] == pd.Timestamp("2026-11-01T12:00")
    assert sorted(hours) == [t for t in want if t in hours]
    # The archive where it has the hours (to Oct 29 24:00), the forecast after; never the forecast over the archive.
    assert all(h["from"] == "hindcast" for t, h in hours.items() if t <= pd.Timestamp("2026-10-30T00:00"))
    assert all(h["from"] == "forecast" for t, h in hours.items() if t > pd.Timestamp("2026-10-30T00:00"))
    assert (hours[pd.Timestamp("2026-10-27T05:00")]["u"] == 15).all()  # 0.3 m/s
    assert (hours[pd.Timestamp("2026-10-31T05:00")]["u"] == 5).all()  # 0.1 m/s
    assert summary["hours"] == len(hours) == len(mesh["times"])
    assert mesh["files"]["window"] == "window.bin" and mesh["buoy_element"] in (0, 1)
    assert mesh["forecast_from"] == int(pd.Timestamp("2026-10-30T01:00", tz="UTC").timestamp())
    assert (tmp_path / pp.NODES_REL).stat().st_size == 4 * 3 * 4 and (tmp_path / pp.TRI_REL).stat().st_size == 2 * 3 * 2


def test_next_run_reads_only_what_it_lacks(tmp_path):
    store = store_with_buoy(tmp_path)
    pp.update(store, END, reader=Reader(fc_from=pd.Timestamp("2026-10-29T00:00"), missing={"2026-10-31"}), max_new_days=7)
    nodes_written = (tmp_path / pp.NODES_REL).stat().st_mtime_ns
    reader = Reader(fc_from=pd.Timestamp("2026-10-29T00:00"))  # the file dated Oct 31 (Oct 30's hours) is now published
    pp.update(store, END, reader=reader)
    archive_days = [c for c in reader.calls if c[0]]
    assert len(archive_days) == 1  # only the day it lacked
    _, hours, _ = read_back(tmp_path)
    assert hours[pd.Timestamp("2026-10-30T12:00")]["from"] == "hindcast"
    assert (tmp_path / pp.NODES_REL).stat().st_mtime_ns == nodes_written  # the subset is unchanged: not rewritten


def test_a_new_subset_starts_the_window_again(tmp_path):
    store = store_with_buoy(tmp_path)
    pp.update(store, END, reader=Reader(fc_from=pd.Timestamp("2026-10-29T00:00"), missing={"2026-10-31"}), max_new_days=7)
    pp.update(store, END, reader=Reader(archive=0.5, fc_from=pd.Timestamp("2026-10-29T00:00"), missing={"2026-10-31"}, ids=(10, 12)), max_new_days=1)
    _, hours, mesh = read_back(tmp_path)
    assert mesh["element_ids"] == [10, 12]
    assert all((h["u"] == 25).all() for h in hours.values() if h["from"] == "hindcast")  # no hour kept from the old subset


def test_no_buoy_record_centres_the_window_on_now(tmp_path):
    store = Store(str(tmp_path))
    pp.update(store, END, reader=Reader(fc_from=pd.Timestamp("2026-10-29T00:00"), missing={"2026-10-31"}), max_new_days=7)
    _, hours, _ = read_back(tmp_path)
    assert max(hours) == pd.Timestamp("2026-11-01T14:00")


def test_a_run_reads_at_most_two_archive_days_and_only_archive_files(tmp_path):
    store = store_with_buoy(tmp_path)
    reader = Reader(fc_from=pd.Timestamp("2026-10-25T00:00"), missing={"2026-10-31"})
    pp.update(store, END, reader=reader)
    archive = [c for c in reader.calls if c[0]]
    assert len(archive) == 3  # the newest file (not published yet) is tried, then two that are read
    _, hours, _ = read_back(tmp_path)
    hind = sorted(t for t, h in hours.items() if h["from"] == "hindcast")
    assert hind[0] == pd.Timestamp("2026-10-28T01:00") and hind[-1] == pd.Timestamp("2026-10-30T00:00")
    assert hours[pd.Timestamp("2026-10-26T05:00")]["from"] == "forecast"  # the older hours wait for later runs


def test_archive_urls_are_the_daily_files(tmp_path):
    urls = []

    def reader(bbox, start, hours, dap_url=None):
        urls.append(dap_url)
        raise OSError("not published")

    pp.update(store_with_buoy(tmp_path), END, reader=reader)
    assert urls[0].endswith("necofs_history/NECOFS_GOM7_2026_10_31.nc") and urls[-1] is None  # then the forecast


def test_nothing_read_writes_nothing(tmp_path):
    store = Store(str(tmp_path))

    def down(*a, **k):
        raise OSError("server down")

    assert pp.update(store, END, reader=down)["hours"] == 0
    assert not (tmp_path / pp.WINDOW_REL).exists()


@pytest.mark.parametrize("name", ["v1/piscataqua-pane/window.bin", "v1/piscataqua-pane/mesh.json"])
def test_writable(name, tmp_path):
    Store(str(tmp_path)).write_bytes(name, b"x", max_age=60)
