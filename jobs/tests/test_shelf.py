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
    times = pd.date_range("2026-11-17 00:00", periods=5, freq="2h")
    steps = times.size

    def doppio_read(end, deadline):
        if fail_doppio:
            raise RuntimeError("server refused")
        n = int(wet.sum())
        return lon, lat, wet, times, np.full((steps, n), 0.2), np.full((steps, n), -0.1), "https://example/doppio"

    def necofs_read(glon, glat, gwet, end, deadline):
        cx, cy = glon[gwet], glat[gwet]
        nodes, tri, centers, cells = [], [], [], []
        for i, (x, y) in enumerate(zip(cx, cy)):
            b = len(nodes)
            nodes += [[x - 0.03, y - 0.03], [x + 0.03, y - 0.03], [x + 0.03, y + 0.03], [x - 0.03, y + 0.03]]
            tri += [[b, b + 1, b + 2], [b, b + 2, b + 3]]
            centers += [[x + 0.01, y - 0.01], [x - 0.01, y + 0.01]]
            cells += [i, i]
        m = len(tri)
        u = np.tile(np.r_[[0.4, 0.0] * (m // 2)], (steps, 1))
        return np.array(nodes), np.array(tri), np.array(centers), np.array(cells), times, u, np.zeros((steps, m)), "https://example/necofs"

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


def test_fill_coarse_takes_the_containing_triangle():
    nodes = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
    tri = np.array([[0, 1, 2], [1, 3, 2]])
    x, y = np.array([0.2, 0.8, 5.0]), np.array([0.2, 0.8, 5.0])  # one cell in each triangle, one outside the mesh
    held = np.array([False, False, False])
    au, av = np.zeros((1, 3)), np.zeros((1, 3))
    shelf.fill_coarse(nodes, tri, x, y, held, au, av, np.array([[1.0, 2.0]]), np.array([[3.0, 4.0]]))
    assert held.tolist() == [True, True, False] and au[0].tolist() == [1.0, 2.0, 0.0] and av[0].tolist() == [3.0, 4.0, 0.0]
