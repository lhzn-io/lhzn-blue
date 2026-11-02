"""The Sound's 3D windows: the anchor on the Groton meter, each place's files, the selection asked of forcingkit, and
the section along an axis."""

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import xarray as xr

from lhzn_blue_jobs import lis_pane as lp
from lhzn_blue_jobs.build import Store

LON0, LAT0 = lp.ORIGIN
END = datetime(2026, 11, 2, 14, 30, tzinfo=timezone.utc)
L = 4  # layers in the synthetic file
D = 0.001  # degrees between the synthetic nodes
SIGLEV = np.linspace(0.0, -1.0, L + 1)


def volume(times, value=0.4, layers=None, elements=None, variables=("u", "v", "zeta")):
    """A strip of four elements around the meter, as read_volume returns it for a selection: u `value` m/s plus a
    tenth of the layer index, v its negative, zeta 0.5 m."""
    node_lon = LON0 + D * np.array([-1, 1, 3, 5, -1, 1, 3, 5], dtype=float) - D
    node_lat = LAT0 + D * np.array([-1, -1, -1, -1, 1, 1, 1, 1], dtype=float)
    tri_all = np.array([[0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5]])
    ids_all = np.array([10, 11, 12, 13])
    keep = np.arange(4) if elements is None else np.flatnonzero(np.isin(ids_all, elements))
    tri_g = tri_all[keep]
    nodes, tri = np.unique(tri_g, return_inverse=True)
    tri = tri.reshape(tri_g.shape)
    ks = list(range(L)) if layers is None else sorted({k % L for k in layers})
    T, E, N = len(times), len(keep), len(nodes)
    u = np.stack([np.full((T, E), value + 0.1 * k) for k in ks], axis=1)
    data = {
        "u": (("time", "siglay", "element"), u),
        "v": (("time", "siglay", "element"), -u),
        "zeta": (("time", "node"), np.full((T, N), 0.5)),
        "h": (("node",), np.full(N, 12.0)),
        "siglay": (("siglay", "node"), np.repeat(((SIGLEV[:-1] + SIGLEV[1:]) / 2)[ks][:, None], N, axis=1)),
        "siglev": (("siglev", "node"), np.repeat(SIGLEV[:, None], N, axis=1)),
        "node_lon": (("node",), node_lon[nodes]), "node_lat": (("node",), node_lat[nodes]),
        "lonc": (("element",), node_lon[tri_g].mean(1)), "latc": (("element",), node_lat[tri_g].mean(1)),
        "triangles": (("element", "vertex"), tri),
        "element_id": (("element",), ids_all[keep]),
    }
    data = {k: v for k, v in data.items() if k not in ("u", "v", "zeta") or k in variables}
    coords = {"time": pd.DatetimeIndex(times)}
    if layers is not None:
        coords["layer"] = ("siglay", np.array(ks))
    return xr.Dataset(data, coords=coords)


class Reader:
    """read_volume's signature: the forecast only (archive days are not published), recording each call."""

    def __init__(self):
        self.calls = []

    def __call__(self, bbox, start, hours, dap_url=None, **sel):
        self.calls.append({"bbox": bbox, "url": dap_url, **sel})
        if dap_url is not None:
            raise OSError("not published")
        times = pd.date_range(pd.Timestamp(start), periods=hours, freq="h")
        return volume(times, layers=sel.get("layers"), elements=sel.get("elements"), variables=sel.get("variables", ("u", "v", "zeta")))


# A line west to east just south of the strip's middle: through elements 11, 10 and 13.
TEST_AXIS = ((LON0 - 2.5 * D, LAT0 - 0.4 * D), (LON0 + 0.6 * D, LAT0 - 0.4 * D))
BOX = (LON0 - 0.1, LAT0 - 0.1, LON0 + 0.1, LAT0 + 0.1)
SOUND = lp.Place("sound", "Whole Sound", "v1/lis-pane/sound/", BOX, (0, -1), TEST_AXIS)
EAST = lp.Place("east", "Eastern Sound", "v1/lis-pane/", BOX, None)


def test_anchor_on_the_meter(tmp_path):
    (tmp_path / "v1").mkdir()
    (tmp_path / "v1/shore.json").write_text(json.dumps({"meters": {"GRTN": {"last_obs": {"time": "2026-11-01T09:00:00Z"}}}}))
    store = Store(str(tmp_path))
    assert lp.anchor_time(store, END) == pd.Timestamp("2026-11-01T09:00")
    assert lp.window_hours(lp.anchor_time(store, END))[-1] == pd.Timestamp("2026-11-03T09:00")


def test_anchor_without_the_meter_is_now(tmp_path):
    assert lp.anchor_time(Store(str(tmp_path)), END) == pd.Timestamp("2026-11-02T14:30")


def test_the_eastern_window_reads_every_layer_of_u_v_and_zeta(tmp_path):
    reader = Reader()
    out = lp.update(Store(str(tmp_path)), END, reader=reader, places=(EAST,))["east"]
    assert out["hours"] > 0 and out["hindcast"] == 0 and out["section_hours"] == 0
    assert all(c["variables"] == ["u", "v", "zeta"] and "layers" not in c for c in reader.calls)
    head, hours = lp.decode((tmp_path / "v1/lis-pane/window.bin").read_bytes())
    mesh = json.loads((tmp_path / "v1/lis-pane/mesh.json").read_text())
    assert head["layers"] == L and mesh["place"]["key"] == "east" and mesh["origin"]["id"] == "GRTN"
    assert mesh["siglev"] == mesh["model_siglev"] and mesh["layer_index"] == list(range(L))
    assert "section" not in mesh and not (tmp_path / "v1/lis-pane/section.bin").exists()
    held = mesh["buoy_element"]  # the element holding the meter
    assert held >= 0 and mesh["element_ids"][held] in (10, 11)
    assert next(iter(hours.values()))["u"][0, 0] == 20  # 0.4 m/s in 2 cm/s steps


def test_the_sound_window_has_the_surface_and_bottom_and_a_full_depth_section(tmp_path, monkeypatch):
    monkeypatch.setattr(lp, "SECTION_STEP_M", 5.0)  # the synthetic elements are about 80 m across
    reader = Reader()
    out = lp.update(Store(str(tmp_path)), END, reader=reader, places=(SOUND,))["sound"]
    assert out["hours"] > 0 and out["section_hours"] == out["hours"]
    window_calls = [c for c in reader.calls if c["bbox"] is not None]
    section_calls = [c for c in reader.calls if c["bbox"] is None]
    assert all(c["layers"] == [0, -1] and c["variables"] == ["u", "v", "zeta"] for c in window_calls)
    assert all(c["variables"] == ["u", "v"] and "layers" not in c for c in section_calls)
    assert section_calls and all(c["elements"] == [10, 11, 13] for c in section_calls)  # the elements the axis crosses
    mesh = json.loads((tmp_path / "v1/lis-pane/sound/mesh.json").read_text())
    assert mesh["layers"] == 2 and mesh["layer_index"] == [0, L - 1]
    assert mesh["siglev"] == [0.0, round(float(SIGLEV[1]), 6), -1.0]  # the surface layer's interfaces, then the bed
    assert len(mesh["model_siglev"]) == L + 1
    head, hours = lp.decode((tmp_path / "v1/lis-pane/sound/window.bin").read_bytes())
    h = next(iter(hours.values()))
    assert h["u"].shape == (2, 4) and list(h["u"][:, 0]) == [20, 35]  # 0.4 and 0.7 m/s
    sec = mesh["section"]
    assert sec["element_ids"] == [10, 11, 13] and sec["layers"] == L and mesh["files"]["section"] == "section.bin"
    assert [r[0] for r in sec["runs"]] == [1, 0, 2]  # west to east: elements 11, 10, 13
    for r in sec["runs"]:
        for end in (r[1:9], r[9:17]):
            assert abs(sum(end[5:8]) - 1) < 1e-3 and min(end[5:8]) >= -1e-3  # inside its element
    shead, shours = lp.decode((tmp_path / "v1/lis-pane/sound/section.bin").read_bytes())
    s = next(iter(shours.values()))
    assert shead["nodes"] == 0 and s["u"].shape == (L, 3) and s["zeta"].size == 0
    assert list(s["u"][:, 0]) == [20, 25, 30, 35]


def test_a_place_that_reads_nothing_leaves_the_other(tmp_path):
    reader = Reader()

    def broken(bbox, start, hours, dap_url=None, **sel):
        if sel.get("layers"):
            raise ValueError("server down")
        return reader(bbox, start, hours, dap_url, **sel)

    out = lp.update(Store(str(tmp_path)), END, reader=broken, places=(SOUND, EAST))
    assert out["sound"]["hours"] == 0 and out["east"]["hours"] > 0
    assert (tmp_path / "v1/lis-pane/window.bin").exists() and not (tmp_path / "v1/lis-pane/sound").exists()
