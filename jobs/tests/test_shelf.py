"""The Northeast U.S. Shelf (shelf.py) and its tiles (tiles.py): the pyramid, the blob format, curvilinear quads, the
averaged wide view, and a whole publish into a local tile store with stand-in model reads."""

import json

import numpy as np
import pandas as pd
import pytest

from lhzn_blue_jobs import shelf, tiles
from lhzn_blue_jobs.build import Store


def test_pyramid_every_point_once_and_split_where_dense():
    rng = np.random.default_rng(1)
    lon = np.r_[rng.uniform(-71, -70, 5000), rng.uniform(-70.02, -70.0, 9000)]  # a sparse area and one dense patch
    lat = np.r_[rng.uniform(40, 41, 5000), rng.uniform(41.0, 41.02, 9000)]
    leaves = tiles.pyramid(lon, lat, base=8, max_zoom=13, max_count=3000)
    allm = np.concatenate(list(leaves.values()))
    assert np.array_equal(np.sort(allm), np.arange(lon.size))
    for key, m in leaves.items():
        z = int(key.split("/")[0])
        assert m.size <= 3000 or z == 13
    assert max(int(k.split("/")[0]) for k in leaves) > 8  # the dense patch was split
    for key, m in leaves.items():  # each point lies in its tile
        z, x, y = map(int, key.split("/"))
        tx, ty = tiles.tile_xy(lon[m], lat[m], z)
        assert (tx == x).all() and (ty == y).all()


def test_blob_roundtrip_and_step_for_fast_water():
    nodes = np.array([[-70.0, 40.0], [-69.9, 40.0], [-69.95, 40.1], [-69.8, 40.1]])
    tri = np.array([[0, 1, 2], [1, 3, 2]])
    u = np.array([[0.1, -0.5], [3.0, np.nan]])  # 3 m/s: more than int8 at 2 cm/s holds
    v = np.array([[0.0, 0.2], [-1.0, 0.04]])
    d = tiles.decode(tiles.encode(nodes, tri, [0, 3], u, v))
    assert d["step_cms"] == 3 and d["index"] == "u16" and d["steps"] == 2 and d["verts"] == 3
    np.testing.assert_allclose(d["node_xy"], nodes, atol=1e-5)
    assert d["elements_ix"].tolist() == tri.tolist() and d["levels"].tolist() == [0, 3]
    np.testing.assert_allclose(d["u"], np.nan_to_num(u), atol=0.015)
    np.testing.assert_allclose(d["v"], v, atol=0.015)
    assert tiles.step_cms(np.array([0.5]), np.array([-2.0])) == 2


def test_subset_renumbers_nodes():
    nodes = np.arange(20, dtype=float).reshape(10, 2)
    tri = np.array([[0, 1, 2], [5, 6, 7], [7, 8, 9]])
    sub_nodes, sub_tri = tiles.subset(nodes, tri, np.array([1, 2]))
    assert sub_nodes.tolist() == nodes[[5, 6, 7, 8, 9]].tolist()
    assert sub_tri.tolist() == [[0, 1, 2], [2, 3, 4]]


def test_quads_cover_chosen_cells_with_extrapolated_edges():
    lon, lat = np.meshgrid(np.arange(4.0), np.arange(3.0))
    cells = np.zeros((3, 4), bool)
    cells[0, 0] = cells[2, 3] = True
    nodes, elems = shelf.quads(lon, lat, cells)
    assert elems.shape == (2, 4)
    first = nodes[elems[0]]
    assert first.min(axis=0).tolist() == [-0.5, -0.5] and first.max(axis=0).tolist() == [0.5, 0.5]
    last = nodes[elems[1]]
    assert last.min(axis=0).tolist() == [2.5, 1.5] and last.max(axis=0).tolist() == [3.5, 2.5]


def test_averaged_is_area_weighted_and_marks_held_cells():
    cells = np.array([0, 0, 2])
    w = np.array([1.0, 3.0, 2.0])
    u = np.array([[1.0, 0.0, 0.5]])
    v = np.array([[0.0, 1.0, np.nan]])
    au, av, held = shelf.averaged(cells, w, u, v, 3)
    assert held.tolist() == [True, False, True]
    np.testing.assert_allclose(au[0, [0, 2]], [0.25, 0.5])
    np.testing.assert_allclose(av[0, [0, 2]], [0.75, 0.0])


def test_two_hourly_keeps_each_step_once():
    start = pd.Timestamp("2026-11-18 00:00")
    times = pd.DatetimeIndex([start + pd.Timedelta(hours=h) for h in [0, 1, 2, 2, 3, 4]])
    u = np.arange(6.0)[:, None]
    t, uu, _ = shelf._two_hourly(times, u, u, start)
    assert [x.hour for x in t] == [0, 2, 4] and uu[:, 0].tolist() == [0, 2, 5]  # the second 02:00 dropped


def _fake_reads(monkeypatch, fail_doppio=False):
    """A 6 x 8 DOPPIO-like grid near 40 N, 70 W, and a NECOFS-like mesh of two triangles per water cell."""
    lon, lat = np.meshgrid(-70 + 0.07 * np.arange(8), 40 + 0.06 * np.arange(6))
    wet = np.ones(lon.shape, bool)
    wet[0, :2] = False
    times2 = pd.date_range("2026-11-17 00:00", periods=5, freq="2h")
    hourly = pd.date_range("2026-11-17 00:00", periods=24, freq="h")

    def doppio_read(end, deadline, start=None, hours=None, every=2):
        if fail_doppio:
            raise RuntimeError("server refused")
        n = int(wet.sum())
        times = hourly if every == 1 else times2
        steps = times.size
        h = 40.0 + 2000.0 * (lon + 70)  # deepening eastward: 40 m to about 1,000 m
        return lon, lat, wet, times, np.full((steps, n), 0.2), np.full((steps, n), -0.1), "https://example/doppio", h

    def necofs_read(glon, glat, gwet, end, deadline, start=None, hours=None, every=2):
        cx, cy = glon[gwet], glat[gwet]
        nodes, tri, centers, cells = [], [], [], []
        for i, (x, y) in enumerate(zip(cx, cy)):
            b = len(nodes)
            nodes += [[x - 0.03, y - 0.03], [x + 0.03, y - 0.03], [x + 0.03, y + 0.03], [x - 0.03, y + 0.03]]
            tri += [[b, b + 1, b + 2], [b, b + 2, b + 3]]
            centers += [[x + 0.01, y - 0.01], [x - 0.01, y + 0.01]]
            cells += [i, i]
        m = len(tri)
        times = hourly if every == 1 else times2
        steps = times.size
        u = np.tile(np.r_[[0.4, 0.0] * (m // 2)], (steps, 1))
        nodes = np.array(nodes)
        h = 40.0 + 2000.0 * (nodes[:, 0] + 70)
        return nodes, np.array(tri), np.array(centers), np.array(cells), times, u, np.zeros((steps, m)), "https://example/necofs", h

    monkeypatch.setattr(shelf, "doppio_read", doppio_read)
    monkeypatch.setattr(shelf, "necofs_read", necofs_read)
    return wet


def test_publish_writes_runs_and_index(tmp_path, monkeypatch):
    wet = _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    assert shelf.publish(Store(str(tmp_path / "out")), pd.Timestamp("2026-11-18 08:00", tz="UTC"), ts) == []
    latest = json.loads(ts.get("shelf/v1/latest.json"))
    nec, dop = latest["models"]["necofs"], latest["models"]["doppio"]
    assert nec["run"] == dop["run"] == "20261118T08Z" and nec["steps"] == 5 and nec["step"] == 7200
    assert dop["cells"] == int(wet.sum()) and nec["cells"] == 2 * int(wet.sum()) and nec["wide_cells"] == int(wet.sum())
    pack = ts.get(f"shelf/v1/{nec['pack']}")
    assert sum(t[2] for t in nec["tiles"].values()) == nec["cells"]
    for off, length, n in nec["tiles"].values():  # each range is a whole blob
        assert tiles.decode(pack[off : off + length])["elements"] == n
    wide = tiles.decode(ts.get(f"shelf/v1/{nec['wide']}"))
    np.testing.assert_allclose(wide["u"], 0.2, atol=0.011)  # the two halves (0.4 and 0) averaged by area
    assert tiles.decode(ts.get(f"shelf/v1/{dop['wide']}"))["verts"] == 4


def test_failed_model_keeps_previous_entry_and_grid(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    store = Store(str(tmp_path / "out"))
    shelf.publish(store, pd.Timestamp("2026-11-17 08:00", tz="UTC"), ts)
    _fake_reads(monkeypatch, fail_doppio=True)
    failed = shelf.publish(store, pd.Timestamp("2026-11-18 08:00", tz="UTC"), ts)
    assert failed and "doppio" in failed[0]
    models = json.loads(ts.get("shelf/v1/latest.json"))["models"]
    assert models["doppio"]["run"] == "20261117T08Z"  # yesterday's, its files kept
    assert models["necofs"]["run"] == "20261118T08Z"  # NECOFS on the saved DOPPIO grid
    assert ts.get(f"shelf/v1/{models['doppio']['wide']}") is not None


def test_cleanup_keeps_newest_and_named_runs(tmp_path):
    ts = tiles.TileStore(str(tmp_path))
    for r in ["20261110T08Z", "20261114T08Z", "20261115T08Z", "20261116T08Z", "20261117T08Z"]:
        ts.put(f"shelf/v1/runs/{r}/x.bin", b"x", 60)
    shelf._cleanup(ts, {"models": {"doppio": {"run": "20261110T08Z"}}})
    assert ts.runs("shelf/v1/runs") == ["20261110T08Z", "20261115T08Z", "20261116T08Z", "20261117T08Z"]


def test_store_for(tmp_path, monkeypatch):
    monkeypatch.delenv("LHZN_BLUE_TILES", raising=False)
    assert tiles.store_for(str(tmp_path)).root == str(tmp_path / "tiles")
    assert tiles.store_for("kv://acct/ns") is None
    monkeypatch.setenv("LHZN_BLUE_TILES", str(tmp_path / "elsewhere"))
    assert tiles.store_for("kv://acct/ns").root == str(tmp_path / "elsewhere")


@pytest.mark.parametrize("n", [10, 70000])
def test_index_width(n):
    nodes = np.zeros((n, 2))
    blob = tiles.encode(nodes, np.array([[0, 1, n - 1]]), [0], np.zeros((1, 1)), np.zeros((1, 1)))
    assert tiles.decode(blob)["index"] == ("u16" if n <= 65535 else "u32")


def test_wide_view_keeps_large_triangles_and_averages_small_ones():
    # A 1 x 4 row of 0.1 degree cells near 40 N (about 72 km2 each). The west two cells are each two small triangles
    # (shared nodes); the east two cells' centers lie under one large triangle, which is drawn as itself and the cells
    # under it left out.
    lon, lat = np.meshgrid(-70 + 0.1 * np.arange(4), np.array([40.0, 40.1]))
    wet = np.zeros(lon.shape, bool)
    wet[0] = True  # the second row is land: the grid needs two rows for its corners
    xs = [-70.05, -69.95, -69.85]
    nodes = [[x, 39.95] for x in xs] + [[x, 40.05] for x in xs]  # 0 1 2 along the south edge, 3 4 5 along the north
    tri = [[0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4]]
    cells = [0, 0, 1, 1]
    nodes += [[-69.5, 40.0]]  # 6: with 2 and 5, a large triangle over the east cells' centers
    tri += [[2, 6, 5]]
    cells += [2]
    nodes, tri = np.array(nodes), np.array(tri)
    centers = nodes[tri].mean(axis=1)
    u = np.array([[0.1, 0.3, 0.2, 0.4, 0.9]])
    v = np.zeros_like(u)
    w_nodes, w_elems, w_ctr, wu, wv = shelf.wide_view((lon, lat, wet), nodes, tri, centers, np.array(cells), u, v)
    assert w_elems.shape == (3, 4)  # two cells and the large triangle
    assert w_elems[2, 3] == w_elems[2, 2]  # the triangle repeats its last node
    np.testing.assert_allclose(wu[0], [0.2, 0.3, 0.9], atol=1e-3)  # small pairs averaged by area; the large one as it is


def test_archive_keeps_past_days_hourly(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    assert shelf.publish(Store(str(tmp_path / "out")), pd.Timestamp("2026-11-18 13:50", tz="UTC"), ts) == []
    days = json.loads(ts.get("shelf/v1/days.json"))["days"]
    assert days == {"2026-11-15": True, "2026-11-16": True, "2026-11-17": True}
    idx = json.loads(ts.get("shelf/v1/days/2026-11-17/index.json"))
    nec = idx["models"]["necofs"]
    assert idx["complete"] and nec["steps"] == 24 and nec["step"] == 3600
    pack = ts.get(f"shelf/v1/{nec['pack']}")
    off, length, n = next(iter(nec["tiles"].values()))
    assert tiles.decode(pack[off : off + length])["steps"] == 24


def test_archive_retries_a_missing_day(tmp_path, monkeypatch):
    _fake_reads(monkeypatch, fail_doppio=True)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    store = Store(str(tmp_path / "out"))
    shelf.publish(store, pd.Timestamp("2026-11-18 13:50", tz="UTC"), ts)  # no DOPPIO grid at all: nothing archived
    assert ts.get("shelf/v1/days.json") is None
    _fake_reads(monkeypatch)
    shelf.publish(store, pd.Timestamp("2026-11-18 14:50", tz="UTC"), ts)
    assert json.loads(ts.get("shelf/v1/days.json"))["days"]["2026-11-17"] is True


def test_isobaths_each_model_on_its_own_grid(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    shelf.publish(Store(str(tmp_path / "out")), pd.Timestamp("2026-11-18 13:50", tz="UTC"), ts)
    for model in ("necofs", "doppio"):
        fc = json.loads(ts.get(f"shelf/v1/isobaths-{model}.json"))
        depths = [f["properties"]["d"] for f in fc["features"]]
        assert depths[:4] == [50, 100, 200, 500] and set(depths) <= set(shelf.ISOBATHS), (model, depths)
        for f in fc["features"]:  # depth grows eastward, 2000 m per degree: each contour near its longitude
            xs = [p[0] for line in f["geometry"]["coordinates"] for p in line]
            assert abs(np.mean(xs) - (-70 + (f["properties"]["d"] - 40) / 2000)) < 0.06
    before = ts.get("shelf/v1/isobaths-doppio.json")
    assert not shelf._put_if_changed(ts, "shelf/v1/isobaths-doppio.json", json.loads(before))


def test_simplify_keeps_corners_and_drops_collinear_points():
    xy = np.array([[0, 0], [1, 0.0001], [2, 0], [2, 1], [2, 2]], dtype=float)
    assert shelf._simplify(xy, 0.001).tolist() == [[0, 0], [2, 0], [2, 2]]
