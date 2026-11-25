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


def test_step_index_keeps_each_step_once():
    start = pd.Timestamp("2026-11-18 00:00")
    times = pd.DatetimeIndex([start + pd.Timedelta(hours=h) for h in [0, 1, 2, 2, 3, 4]])
    assert shelf._step_index(times, start, 2) == [0, 2, 5]  # the second 02:00 dropped


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
        scal = {"temp": np.full((steps, n), 12.0), "salt": np.full((steps, n), 32.5)}
        return lon, lat, wet, times, np.full((steps, n), 0.2), np.full((steps, n), -0.1), "https://example/doppio", h, scal

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
        scal = {"temp": np.tile(np.linspace(8, 20, m), (steps, 1)), "salt": np.full((steps, m), 33.0)}
        return nodes, np.array(tri), np.array(centers), np.array(cells), times, u, np.zeros((steps, m)), "https://example/necofs", h, scal

    def doppio_depths(start, hours, every, deadline):
        if fail_doppio:
            raise RuntimeError("server refused")
        times = hourly if every == 1 else times2
        n = int(wet.sum())
        h = (40.0 + 2000.0 * (lon + 70))[wet]
        deeper = {d: h > d for d in shelf.DEPTHS}
        z = {d: (np.full((times.size, int(k.sum())), 0.1, np.float32), np.full((times.size, int(k.sum())), 0.05, np.float32)) for d, k in deeper.items()}
        zs = {d: {"temp": np.full((times.size, int(k.sum())), 9.0), "salt": np.full((times.size, int(k.sum())), 34.0)} for d, k in deeper.items()}
        return times, z, deeper, zs

    def necofs_depths(glon, glat, gwet, start, hours, every, deadline):
        nodes, tri, centers, cells, times, u, v, _, h, scal = necofs_read(glon, glat, gwet, None, deadline, start, hours, every)
        h_e = h[tri].mean(axis=1)
        deeper = {d: h_e > d for d in shelf.DEPTHS}
        z = {d: (u[:, k].astype(np.float32) / 2, v[:, k].astype(np.float32)) for d, k in deeper.items()}
        zs = {d: {"temp": scal["temp"][:, k] - d / 100, "salt": scal["salt"][:, k]} for d, k in deeper.items()}
        return nodes, tri, centers, cells, times, z, deeper, zs

    monkeypatch.setattr(shelf, "doppio_read", doppio_read)
    monkeypatch.setattr(shelf, "necofs_read", necofs_read)
    monkeypatch.setattr(shelf, "doppio_depths", doppio_depths)
    monkeypatch.setattr(shelf, "necofs_depths", necofs_depths)
    monkeypatch.setattr(shelf, "_source", lambda url, runs=False: {"title": "stand-in"})  # no server for provenance
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
    w_nodes, w_elems, w_ctr, wu, wv, quiet = shelf.wide_view((lon, lat, wet), nodes, tri, centers, np.array(cells), u, v)
    assert w_elems[-1, 3] == w_elems[-1, 2]  # the large triangle, last, repeats its last node
    np.testing.assert_allclose(wu[0, [0, 1, -1]], [0.2, 0.3, 0.9], atol=1e-3)  # small pairs averaged by area; the large one as it is
    # The east cells stick out of the large triangle: the parts outside are kept as pieces, with no arrow of their own.
    assert len(w_elems) > 3 and quiet[2:-1].all() and not quiet[[0, 1, -1]].any()
    # Every point of the four cells is covered once: no gaps, no overlaps.
    gx, gy = np.meshgrid(np.linspace(-70.0493, -69.6517, 81), np.linspace(39.9511, 40.0489, 21))
    pts = np.c_[gx.ravel(), gy.ravel()]
    hits = np.zeros(len(pts), int)
    for el in w_elems:
        ring = w_nodes[el[[0, 1, 2]] if el[3] == el[2] else el]
        area2 = np.sum(ring[:, 0] * np.roll(ring[:, 1], -1) - ring[:, 1] * np.roll(ring[:, 0], -1))
        side = [(b[0] - a[0]) * (pts[:, 1] - a[1]) - (b[1] - a[1]) * (pts[:, 0] - a[0]) for a, b in zip(ring, np.roll(ring, -1, axis=0))]
        hits += np.all(np.sign(area2) * np.array(side) > -1e-12, axis=0)
    assert hits.min() == 1 and hits.max() == 1



def test_seam_cuts_only_by_triangles_that_reach_the_cell_and_cuts_each_geometry_once():
    # One 1 x 1 cell. A large triangle overlaps its east half; its neighbor (sharing a corner) lies well clear of the
    # cell, but one of its edges' lines (y = 0.2 to 0.3 across the cell) would split the part outside: it must cut
    # nothing, leaving that part in one piece.
    c_nodes = np.array([[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]])
    c_quad = np.array([[0, 1, 2, 3]])
    b_nodes = np.array([[0.5, -1.0], [3.0, 0.5], [0.5, 2.0], [3.5, 1.5], [4.0, 0.6]])
    b_tri = np.array([[0, 1, 2], [1, 4, 3]])  # both counter-clockwise; the neighbor shares node 1
    covered, partial = shelf._seam(c_nodes, c_quad, b_nodes, b_tri, np.array([0]))
    assert not covered[0] and len(partial[0]) == 1
    np.testing.assert_allclose(shelf._area(partial[0][0]), 0.5)
    shelf._SEAMS.clear()
    first = shelf._seam_once(c_nodes, c_quad, b_nodes, b_tri, np.array([0]))
    assert shelf._seam_once(c_nodes.copy(), c_quad, b_nodes, b_tri, np.array([0])) is first and len(shelf._SEAMS) == 1

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


def test_backfill_merges_past_days_into_days_json(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    store = Store(str(tmp_path / "out"))
    shelf.publish(store, pd.Timestamp("2026-11-18 13:50", tz="UTC"), ts)  # the daily run's own days
    before = json.loads(ts.get(f"{shelf.BASE}/days.json"))["days"]
    assert shelf.backfill(store, "2022-08-11", "2022-08-12", ts) == []
    days = json.loads(ts.get(f"{shelf.BASE}/days.json"))["days"]
    assert days == {**before, "2022-08-11": True, "2022-08-12": True}
    idx = json.loads(ts.get(f"{shelf.BASE}/days/2022-08-11/index.json"))
    assert idx["complete"] and {m["steps"] for m in idx["models"].values()} == {24}
    with pytest.raises(ValueError):
        shelf.backfill(store, "2022-08-12", "2022-08-11", ts)
    with pytest.raises(ValueError):
        shelf.backfill(store, "2022-01-01", "2022-12-31", ts)


def test_necofs_pieces_use_the_forecast_only_within_its_reach(monkeypatch):
    from forcingkit.fetchers import necofs as fk

    monkeypatch.setattr(fk, "necofs_url_for_hour", lambda t, by_day=None: f"file-{t:%Y%m}")
    now = pd.Timestamp("2026-11-19 14:00", tz="UTC")
    recent = shelf._necofs_pieces(pd.Timestamp("2026-11-17"), 24, now)
    assert [u for _, _, u in recent] == [None]
    old = shelf._necofs_pieces(pd.Timestamp("2022-07-31 20:00"), 30, now)
    assert [(str(t0), n, u) for t0, n, u in old] == [("2022-07-31 20:00:00", 4, "file-202207"), ("2022-08-01 00:00:00", 24, "file-202208"), ("2022-08-02 00:00:00", 2, "file-202208")]


def test_at_depths_interpolates_between_layers_and_leaves_the_bed_out():
    # Two columns, four layers at sigma -0.125, -0.375, -0.625, -0.875; u is the layer's index, v its negative.
    frac = np.tile(np.array([-0.125, -0.375, -0.625, -0.875])[:, None], (1, 2))
    u = np.tile(np.arange(4.0)[None, :, None], (1, 1, 2))
    column = np.array([[80.0, 20.0]])  # centers at 10, 30, 50, 70 m and 2.5, 7.5, 12.5, 17.5 m
    z = shelf.at_depths(u, -u, frac, column, depths=(5, 10, 40, 75, 25))
    assert z[5][0][0, 0] == 0.0  # above the first center: the top layer
    assert z[10][0][0, 0] == 0.0 and np.isclose(z[10][0][0, 1], 1.5)
    assert np.isclose(z[40][0][0, 0], 1.5) and np.isclose(z[40][1][0, 0], -1.5)
    assert z[75][0][0, 0] == 3.0  # between the deepest center and the bed: the bottom layer
    assert np.isnan(z[25][0][0, 1]) and np.isnan(z[40][0][0, 1])  # deeper than the 20 m column


def test_run_and_daily_archive_carry_depths_but_backfills_do_not(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    store = Store(str(tmp_path / "out"))
    shelf.publish(store, pd.Timestamp("2026-11-18 13:50", tz="UTC"), ts)
    latest = json.loads(ts.get(f"{shelf.BASE}/latest.json"))
    for name in ("necofs", "doppio"):
        dep = latest["models"][name]["depths"]
        assert sorted(dep, key=int) == [str(d) for d in shelf.DEPTHS]
        assert ts.get(f"{shelf.BASE}/{dep['50']['wide']}") is not None
        assert dep["500"]["cells"] < dep["10"]["cells"]  # the eastward-deepening grid: fewer cells below 500 m
    assert "tiles" in latest["models"]["necofs"]["depths"]["50"]
    day = json.loads(ts.get(f"{shelf.BASE}/days/2026-11-17/index.json"))
    assert day["complete"] and day["models"]["necofs"]["depths"]["100"]["steps"] == 24
    shelf.backfill(store, "2022-08-11", "2022-08-11", ts)
    old = json.loads(ts.get(f"{shelf.BASE}/days/2022-08-11/index.json"))
    assert old["complete"] and "depths" not in old["models"]["necofs"] and "depths" not in old["models"]["doppio"]


def test_failed_depths_leave_the_surface_published(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)

    def broken(*a, **k):
        raise RuntimeError("server refused")

    monkeypatch.setattr(shelf, "necofs_depths", broken)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    failed = shelf.publish(Store(str(tmp_path / "out")), pd.Timestamp("2026-11-18 13:50", tz="UTC"), ts)
    latest = json.loads(ts.get(f"{shelf.BASE}/latest.json"))
    assert "depths" not in latest["models"]["necofs"] and "depths" in latest["models"]["doppio"]
    assert any("necofs depths" in f for f in failed)


def test_backfill_with_depths_adds_them_to_days_held_at_the_surface(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    store = Store(str(tmp_path / "out"))
    shelf.backfill(store, "2022-08-11", "2022-08-12", ts)
    assert "depths" not in json.loads(ts.get(f"{shelf.BASE}/days/2022-08-11/index.json"))["models"]["necofs"]
    assert shelf.backfill(store, "2022-08-11", "2022-08-12", ts, depths=True) == []
    for day in ("2022-08-11", "2022-08-12"):
        idx = json.loads(ts.get(f"{shelf.BASE}/days/{day}/index.json"))
        assert idx["complete"] and all(m["depths"]["50"]["steps"] == 24 for m in idx["models"].values())
    assert json.loads(ts.get(f"{shelf.BASE}/days.json"))["days"] == {"2022-08-11": True, "2022-08-12": True}
    with pytest.raises(ValueError):
        shelf.backfill(store, "2022-08-01", "2022-08-31", ts, depths=True)


def test_value_blobs_round_trip_with_gaps():
    a = np.array([[10.0, 12.5, np.nan], [11.0, 13.0, 14.0]])
    b = np.array([[30.0, 30.0, 30.0], [31.0, np.nan, 32.0]])
    d = tiles.decode_values(tiles.encode_values({"temp": a, "salt": b}))
    assert d["elements"] == 3 and d["steps"] == 2
    assert np.isnan(d["temp"][0, 2]) and np.isnan(d["salt"][1, 1])
    ok = np.isfinite(a)
    assert np.allclose(d["temp"][ok], a[ok], atol=(14 - 10) / 254 / 2 + 1e-9)
    assert np.allclose(tiles.decode_values(tiles.encode_values({"c": np.full((1, 2), 5.0)}))["c"], 5.0)


def test_temperature_and_salinity_follow_the_currents_files(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    shelf.publish(Store(str(tmp_path / "out")), pd.Timestamp("2026-11-18 13:50", tz="UTC"), ts)
    latest = json.loads(ts.get(f"{shelf.BASE}/latest.json"))
    nec, dop = latest["models"]["necofs"], latest["models"]["doppio"]
    # The value tiles have the currents tiles' keys and element counts, so the page pairs them.
    assert {k: v[2] for k, v in nec["ts"]["tiles"].items()} == {k: v[2] for k, v in nec["tiles"].items()}
    wide = tiles.decode(ts.get(f"{shelf.BASE}/{nec['wide']}"))
    vwide = tiles.decode_values(ts.get(f"{shelf.BASE}/{nec['ts']['wide']}"))
    assert vwide["elements"] == wide["elements"] and 8 - 0.1 <= np.nanmin(vwide["temp"]) <= np.nanmax(vwide["temp"]) <= 20 + 0.1
    d = tiles.decode_values(ts.get(f"{shelf.BASE}/{dop['ts']['wide']}"))
    assert np.allclose(d["temp"], 12.0) and np.allclose(d["salt"], 32.5)
    at50 = nec["depths"]["50"]
    assert {k: v[2] for k, v in at50["ts"]["tiles"].items()} == {k: v[2] for k, v in at50["tiles"].items()}
    assert ts.get(f"{shelf.BASE}/{dop['depths']['200']['ts']['wide']}") is not None
    day = json.loads(ts.get(f"{shelf.BASE}/days/2026-11-17/index.json"))
    assert "ts" in day["models"]["necofs"] and "ts" in day["models"]["necofs"]["depths"]["10"]


def test_interp_carries_any_field():
    frac = np.tile(np.array([-0.25, -0.75])[:, None], (1, 1))
    temp = np.array([[[20.0], [10.0]]])  # centers at 25 and 75 m in a 100 m column
    z = shelf._interp({"temp": temp}, frac, np.array([[100.0]]), depths=(50, 150))
    assert np.isclose(z[50]["temp"][0, 0], 15.0) and np.isnan(z[150]["temp"][0, 0])


def test_a_failed_read_is_tried_again(monkeypatch):
    monkeypatch.setattr(shelf, "READ_RETRY_S", 0)
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise TimeoutError("server timed out")
        return "ds"

    assert shelf._read_tries(flaky, "test") == "ds" and len(calls) == 3
    calls.clear()

    def down():
        calls.append(1)
        raise TimeoutError("server timed out")

    with pytest.raises(TimeoutError):
        shelf._read_tries(down, "test")
    assert len(calls) == shelf.READ_TRIES


def test_value_blobs_carry_a_static_depth_to_a_tenth_of_a_meter():
    temp = np.array([[9.0, 10.0, 11.0]])
    h = np.array([12.3, np.nan, 4987.6])
    out = tiles.decode_values(tiles.encode_values({"temp": temp, "h": h}))
    assert [f["name"] for f in out["static"]] == ["h"]
    np.testing.assert_allclose(out["h"][[0, 2]], [12.3, 4987.6], atol=0.08)
    assert np.isnan(out["h"][1])
    np.testing.assert_allclose(out["temp"], temp, atol=0.01)
    # without a static field the header is as before
    assert "static" not in tiles.decode_values(tiles.encode_values({"temp": temp}))


def test_wide_and_tile_values_hold_each_models_depth(monkeypatch):
    # The wide view's depth rides as one more row of the first field: it comes out averaged like the values.
    lon, lat = np.meshgrid(-70 + 0.1 * np.arange(4), np.array([40.0, 40.1]))
    wet = np.zeros(lon.shape, bool)
    wet[0] = True
    xs = [-70.05, -69.95, -69.85]
    nodes = np.array([[x, 39.95] for x in xs] + [[x, 40.05] for x in xs])
    tri = np.array([[0, 1, 4], [0, 4, 3], [1, 2, 5], [1, 5, 4]])
    centers = nodes[tri].mean(axis=1)
    scal = {"temp": np.full((2, 4), 9.0), "salt": np.full((2, 4), 34.0), "h": np.array([10.0, 30.0, 50.0, 70.0])}
    pack, index, wide = shelf._necofs_values((lon, lat, wet), nodes, tri, centers, np.array([0, 0, 1, 1]), scal)
    w = tiles.decode_values(wide)
    assert w["temp"].shape == (2, w["elements"]) and w["h"].shape == (w["elements"],)
    np.testing.assert_allclose(w["h"][:2], [20.0, 60.0], atol=0.01)  # area-weighted means of each cell's pair
    off, length, n = next(iter(index.values()))
    tile = tiles.decode_values(pack[off : off + length])
    assert sorted(np.round(tile["h"], 2)) == [10.0, 30.0, 50.0, 70.0]


def test_written_reads_the_newest_history_entry():
    h = "Wed Aug 27 15:41:31 2025: ncrcat -O -v x,y in.nc out.nc\nTue Aug 26 03:00:00 2025: older"
    assert shelf.written(h) == "2025-08-27T15:41:31"
    assert shelf.written("Wed Aug  6 09:05:00 2025: ncks") == "2025-08-06T09:05:00"
    assert shelf.written("") is None and shelf.written(None) is None


def test_necofs_prov_names_the_daily_file_behind_each_hour(monkeypatch):
    from forcingkit.fetchers import necofs as fk

    base = "http://smast/Archive/necofs_history/NECOFS_GOM7_"
    monkeypatch.setattr(fk, "necofs_url_for_hour", lambda t, by_day=None: f"{base}{fk.necofs_archive_file_date(t):%Y_%m_%d}.nc")
    monkeypatch.setattr(shelf, "_source", lambda url, runs=False: {"title": "HINDCAST UPDATE", "history": f"Wed Aug 27 15:41:31 2025: ncrcat {url[-6:]}"})
    times = pd.date_range("2025-08-27", periods=24, freq="h")
    prov = shelf.necofs_prov(times, f"{base}2025_08_27.nc")
    assert [(p["from"], p["to"], p["url"][-13:]) for p in prov] == [
        ("2025-08-27T00:00:00Z", "2025-08-27T00:00:00Z", "2025_08_27.nc"),
        ("2025-08-27T01:00:00Z", "2025-08-27T23:00:00Z", "2025_08_28.nc"),
    ]
    assert prov[0]["title"] == "HINDCAST UPDATE" and prov[0]["written"] == "2025-08-27T15:41:31"
    fc = "http://smast/Forecasts/NECOFS_GOM7_FORECAST.nc"
    assert shelf.necofs_prov(times, fc, live=False) == [{"from": "2025-08-27T00:00:00Z", "to": "2025-08-27T23:00:00Z", "url": fc}]
    assert shelf.necofs_prov(times, None) == []


def test_doppio_prov_groups_hours_by_run(monkeypatch):
    from forcingkit.fetchers import doppio as dfk

    times = pd.date_range("2025-08-27", periods=6, freq="h")
    runs = {t: pd.Timestamp("2025-08-26") if t.hour < 3 else pd.Timestamp("2025-08-27") for t in times}
    monkeypatch.setattr(shelf, "_source", lambda url, runs_=False, **k: {"run_at": runs})
    prov = shelf.doppio_prov(times, dfk.REALTIME_URL)
    assert [(p["from"], p["to"], p["run"]) for p in prov] == [
        ("2025-08-27T00:00:00Z", "2025-08-27T02:00:00Z", "2025-08-26T00:00:00Z"),
        ("2025-08-27T03:00:00Z", "2025-08-27T05:00:00Z", "2025-08-27T00:00:00Z"),
    ]
    assert prov[0]["product"] == dfk.doppio_product(dfk.REALTIME_URL)
    re = shelf.doppio_prov(times, dfk.REANALYSIS_URL)
    assert len(re) == 1 and "run" not in re[0] and re[0]["product"].startswith("reanalysis")


def test_refresh_prov_writes_archived_days_and_a_failure_leaves_them(tmp_path, monkeypatch):
    _fake_reads(monkeypatch)
    ts = tiles.TileStore(str(tmp_path / "tiles"))
    store = Store(str(tmp_path / "out"))
    shelf.backfill(store, "2025-08-27", "2025-08-27", ts)
    key = f"{shelf.BASE}/days/2025-08-27/index.json"
    idx = json.loads(ts.get(key))
    for m in idx["models"].values():  # stand-in urls that the provenance does not follow
        m["url"] = None
    ts.put(key, json.dumps(idx).encode(), 60, "application/json")
    assert sorted(shelf.refresh_prov(store, "2025-08-27", "2025-08-28", ts)) == ["shelf prov 2025-08-27 doppio: not found", "shelf prov 2025-08-27 necofs: not found"]
    monkeypatch.setattr(shelf, "doppio_prov", lambda times, url: [{"from": "a", "to": "b", "url": "d"}])
    monkeypatch.setattr(shelf, "necofs_prov", lambda times, url, live=True: [{"from": "a", "to": "b", "url": "n", "live": live}])
    assert shelf.refresh_prov(store, "2025-08-27", "2025-08-27", ts) == []
    got = json.loads(ts.get(key))["models"]
    assert got["doppio"]["prov"][0]["url"] == "d" and got["necofs"]["prov"][0]["live"] is False
    assert got["necofs"]["steps"] == 24  # the rest of the entry is kept
