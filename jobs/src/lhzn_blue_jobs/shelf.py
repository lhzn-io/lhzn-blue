"""The Northeast U.S. Shelf: two regional ocean models' surface currents, each on its own cells, from Cape Hatteras to
Nova Scotia.

NECOFS (FVCOM GOM7, UMass Dartmouth SMAST) runs on an unstructured triangle mesh; DOPPIO (ROMS, Rutgers University
Ocean Modeling Group for MARACOOS) on a 7 km curvilinear grid. The domain is where both run: DOPPIO's water cells,
and the NECOFS elements whose centers lie in them (about 265,000). Only model fields are published.

Published to the tile store (tiles.py: an R2 bucket, served from its own host), under ``shelf/v1/``:

- ``runs/<run>/doppio.bin``: DOPPIO's whole grid, one blob (about 19,500 cells). The page shows it at every zoom.
- ``runs/<run>/necofs-wide.bin``: NECOFS at DOPPIO's resolution, for a wide view: where NECOFS's elements are
  smaller than a DOPPIO cell, their area-weighted vector mean in each cell; where they are larger (offshore), the
  elements themselves, and not the cells under them, so the view never looks finer than NECOFS is. Its elements are
  DOPPIO quadrilaterals and NECOFS triangles (stored as four nodes, the last repeated); where NECOFS's own cells are smaller than a screen pixel. The page
  labels it as averaged.
- ``runs/<run>/necofs.bin``: NECOFS on its own cells, cut into Web Mercator tiles (tiles.pyramid), the blobs one
  after another; the page fetches the tiles in view by range once zoomed in.
- ``latest.json``: the current run's files per model, their time steps and the NECOFS tile index (offset, length,
  elements per tile). Written last; a model that fails keeps its previous entry and files.
- ``isobaths-necofs.json``, ``isobaths-doppio.json``: each model's own depth contours (ISOBATHS, meters), traced on
  its own grid (NECOFS's triangles; DOPPIO's cell centers), as GeoJSON lines with a ``d`` (depth) property. Written
  only when they change.
- ``doppio-grid.npz``: DOPPIO's cell centers and water mask, so NECOFS can still be published on a day DOPPIO's
  server does not answer.
- ``days/<YYYY-MM-DD>/``: the archive, one UTC day hourly (24 steps) per model, in the same files as a run
  (``necofs.bin`` tiles, ``necofs-wide.bin``, ``doppio.bin``) with its own ``index.json``; ``days.json`` lists the
  days kept. Each run archives the previous UTC day, and retries the ARCHIVE_LOOKBACK days before it that are missing
  or incomplete (a model's server did not answer). Kept indefinitely.

Each blob holds the 2-hourly forecast from 24 hours back to 72 hours ahead (DOPPIO's ends about 2 days ahead).
"""

from __future__ import annotations

import io
import json
import logging
import time
from datetime import datetime

import numpy as np
import pandas as pd

from . import fields, outages, tiles
from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

BASE = "shelf/v1"
HOURS_BACK = fields.CURRENT_HOURS_BACK
HOURS_AHEAD = fields.CURRENT_HOURS_AHEAD
STEP_HOURS = fields.CURRENT_STEP_HOURS
READ_HOURS = 24  # hours per read: a whole window in one request can outlast the servers' timeouts
TIME_BUDGET_S = 15 * 60  # the whole shelf step, inside the fields job's hour
KEEP_RUNS = 3  # runs kept in the store (latest.json's runs always)
ARCHIVE_LOOKBACK = 3  # days back that a run fills in when missing or incomplete
DAY_S = 86400
IMMUTABLE_S = 365 * 86400
LATEST_S = 300
ISOBATHS = (50, 100, 200, 500, 1000, 2000, 3000)  # meters
ISOBATH_TOL_DEG = 0.0015  # line simplification (about 150 m)
CELL_KM2 = 49.0  # a DOPPIO cell (7 km): NECOFS elements larger than this are drawn as they are in the wide view
KM_PER_DEG = 111.2
NEAR_CELL_DEG = 0.06  # a NECOFS center belongs to the nearest DOPPIO water cell within this (cos-lat scaled degrees)
NECOFS_SOURCE = "NECOFS/UMASSD (FVCOM GOM7, UMass Dartmouth SMAST)"
DOPPIO_SOURCE = "DOPPIO ROMS, Rutgers University Ocean Modeling Group for MARACOOS"


def window(end: datetime) -> tuple[pd.Timestamp, int]:
    """The window's first hour and its length in hours."""
    return pd.Timestamp(end).floor("h").tz_localize(None) - pd.Timedelta(hours=HOURS_BACK), HOURS_BACK + HOURS_AHEAD + 1


def _pieces(start: pd.Timestamp, hours: int) -> list[tuple[pd.Timestamp, int]]:
    return [(start + pd.Timedelta(hours=h), min(READ_HOURS, hours - h)) for h in range(0, hours, READ_HOURS)]


def _two_hourly(times: pd.DatetimeIndex, u: np.ndarray, v: np.ndarray, start: pd.Timestamp, every: int = STEP_HOURS):
    """Keep the hours on the window's steps of `every` hours (from start), in order, without repeats."""
    keep = [i for i, t in enumerate(times) if int((t - start) / pd.Timedelta(hours=1)) % every == 0]
    keep = [i for k, i in enumerate(keep) if k == 0 or times[i] != times[keep[k - 1]]]
    return times[keep], u[keep], v[keep]


def quads(lon: np.ndarray, lat: np.ndarray, cells: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Corner nodes and four-node elements for chosen cells of a curvilinear grid of cell centers (rows, cols).

    The corners are the means of the four surrounding centers, the grid first padded by one row and column on every
    side by linear extrapolation, so edge cells get corners too. `cells` is a boolean (rows, cols) mask. Returns the
    used corner nodes (n, 2: lon, lat) and per chosen cell (row-major) its corners, counter-clockwise from the
    south-west in index space."""

    def pad(a: np.ndarray) -> np.ndarray:
        a = np.vstack([2 * a[0] - a[1], a, 2 * a[-1] - a[-2]])
        return np.hstack([2 * a[:, :1] - a[:, 1:2], a, 2 * a[:, -1:] - a[:, -2:-1]])

    plon, plat = pad(lon.astype(np.float64)), pad(lat.astype(np.float64))
    clon = 0.25 * (plon[:-1, :-1] + plon[1:, :-1] + plon[:-1, 1:] + plon[1:, 1:])  # (rows+1, cols+1)
    clat = 0.25 * (plat[:-1, :-1] + plat[1:, :-1] + plat[:-1, 1:] + plat[1:, 1:])
    cols1 = clon.shape[1]
    rows, cols = np.nonzero(cells)
    corner = np.stack([rows * cols1 + cols, rows * cols1 + cols + 1, (rows + 1) * cols1 + cols + 1, (rows + 1) * cols1 + cols], axis=1)
    used, local = np.unique(corner, return_inverse=True)
    nodes = np.stack([clon.ravel()[used], clat.ravel()[used]], axis=1)
    return nodes, local.reshape(corner.shape)


def _header(source: str, url: str | None, times: pd.DatetimeIndex, run: str) -> dict:
    return {
        "source": source,
        "url": url,
        "run": run,
        "t0": iso(times[0].tz_localize("UTC")),
        "step": STEP_HOURS * 3600,
        "steps": int(times.size),
    }


def doppio_read(end: datetime | None, deadline: float, start: pd.Timestamp | None = None, hours: int | None = None, every: int = STEP_HOURS):
    """DOPPIO's whole grid: centers, water mask, and the surface forecast at the water cells (steps, cells). The
    window is the run's (from `end`) unless `start` and `hours` are given; steps every `every` hours."""
    from forcingkit.fetchers import doppio as fk

    if start is None:
        start, hours = window(end)
    parts = []
    for t0, n in _pieces(start, hours):
        if time.monotonic() > deadline:
            raise TimeoutError("shelf time budget spent")
        try:
            part = fk.read_volume(list(fk.DOMAIN_BBOX), t0, n, variables=["u", "v"], layers=[0])
        except RuntimeError as exc:  # a piece wholly past the forecast's end: forcingkit says it holds none of it
            if parts and "none of" in str(exc):
                break
            raise
        if part.sizes.get("time", 0):
            parts.append(part)
    if not parts:
        raise ValueError("no DOPPIO hours in the window")
    ds = parts[0]
    lon, lat = ds["lon"].values.astype(np.float64), ds["lat"].values.astype(np.float64)
    wet = ds["mask"].values.astype(bool) if "mask" in ds else np.ones(lon.shape, bool)
    times = pd.DatetimeIndex(np.concatenate([p["time"].values for p in parts]))
    u = np.concatenate([p["u"].values[:, 0][:, wet] for p in parts])
    v = np.concatenate([p["v"].values[:, 0][:, wet] for p in parts])
    times, u, v = _two_hourly(times, u, v, start, every)
    h = ds["h"].values.astype(np.float64) if "h" in ds else np.full(lon.shape, np.nan)
    return lon, lat, wet, times, u, v, ds.attrs.get("url"), h


def _scaled(lon, lat) -> np.ndarray:
    return np.c_[np.asarray(lon) * np.cos(np.radians(40.0)), np.asarray(lat)]


def necofs_read(lon: np.ndarray, lat: np.ndarray, wet: np.ndarray, end: datetime | None, deadline: float, start: pd.Timestamp | None = None, hours: int | None = None, every: int = STEP_HOURS):
    """The NECOFS elements whose centers lie in DOPPIO's water cells, and their surface forecast (steps, elements).
    Returns the elements' nodes, triangles and centers, the DOPPIO water cell each belongs to, and the forecast."""
    from forcingkit.fetchers import doppio as dfk
    from forcingkit.fetchers import necofs as fk
    from scipy.spatial import cKDTree

    if start is None:
        start, hours = window(end)
    probe = fk.read_volume(list(dfk.DOMAIN_BBOX), start, 1, variables=["u"], layers=[0])
    dist, cell = cKDTree(_scaled(lon[wet], lat[wet])).query(_scaled(probe["lonc"].values, probe["latc"].values), distance_upper_bound=NEAR_CELL_DEG)
    inside = np.isfinite(dist)
    ids = [int(x) for x in probe["element_id"].values[inside]]
    if not ids:
        raise ValueError("no NECOFS elements in DOPPIO's cells")
    cell_of = dict(zip(ids, cell[inside].tolist()))
    parts = []
    for t0, n in _pieces(start, hours):
        if time.monotonic() > deadline:
            raise TimeoutError("shelf time budget spent")
        parts.append(fk.read_volume(None, t0, n, variables=["u", "v"], layers=[0], elements=ids))
    ds = parts[0]
    times = pd.DatetimeIndex(np.concatenate([p["time"].values for p in parts]))
    u = np.concatenate([p["u"].values[:, 0, :] for p in parts])
    v = np.concatenate([p["v"].values[:, 0, :] for p in parts])
    times, u, v = _two_hourly(times, u, v, start, every)
    nodes = np.stack([ds["node_lon"].values, ds["node_lat"].values], axis=1).astype(np.float64)
    tri = ds["triangles"].values.astype(np.int64)
    centers = np.stack([ds["lonc"].values, ds["latc"].values], axis=1).astype(np.float64)
    cells = np.array([cell_of[int(e)] for e in ds["element_id"].values], dtype=np.int64)
    h = ds["h"].values.astype(np.float64) if "h" in ds else np.full(len(nodes), np.nan)
    return nodes, tri, centers, cells, times, u, v, ds.attrs.get("url"), h


def areas(nodes: np.ndarray, tri: np.ndarray) -> np.ndarray:
    """Each triangle's area, in cos-lat scaled square degrees (proportional to km2 over a small range of latitude)."""
    p = nodes[tri]  # (m, 3, 2)
    k = np.cos(np.radians(p[:, :, 1].mean(axis=1)))
    dx1, dy1 = (p[:, 1, 0] - p[:, 0, 0]) * k, p[:, 1, 1] - p[:, 0, 1]
    dx2, dy2 = (p[:, 2, 0] - p[:, 0, 0]) * k, p[:, 2, 1] - p[:, 0, 1]
    return 0.5 * np.abs(dx1 * dy2 - dx2 * dy1)


def averaged(cells: np.ndarray, weights: np.ndarray, u: np.ndarray, v: np.ndarray, n_cells: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The area-weighted mean of u and v per cell (steps, n_cells), and which cells hold any element."""
    total = np.bincount(cells, weights=weights, minlength=n_cells)
    held = total > 0
    mean = lambda a: np.stack([np.bincount(cells, weights=weights * np.nan_to_num(a[i]), minlength=n_cells) for i in range(a.shape[0])]) / np.where(held, total, 1.0)  # noqa: E731
    return mean(u), mean(v), held


def containing(nodes, tri, x, y) -> np.ndarray:
    """The element containing each point, or -1 (outside the mesh, or a mesh the point finder will not take)."""
    from matplotlib.tri import Triangulation

    try:
        return Triangulation(nodes[:, 0], nodes[:, 1], tri).get_trifinder()(x, y).astype(np.int64)
    except Exception as exc:
        log.warning("shelf necofs: point finder failed: %s", exc)
        return np.full(np.asarray(x).shape, -1, dtype=np.int64)


def wide_view(grid, nodes, tri, centers, cells, u, v):
    """NECOFS at DOPPIO's resolution, never finer than NECOFS: elements larger than a DOPPIO cell are kept as they
    are (and the cells whose centers they hold are left out); every other cell takes the area-weighted mean of the
    smaller elements centered in it, or, holding none, the element containing its center. Returns nodes, four-node
    elements (a triangle repeats its last node), centers, u and v (steps, elements)."""
    lon, lat, wet = grid
    n_wet = int(wet.sum())
    km2 = areas(nodes, tri) * KM_PER_DEG**2
    big = km2 > CELL_KM2
    small = ~big
    au, av, held = averaged(cells[small], km2[small], u[:, small], v[:, small], n_wet)
    at = containing(nodes, tri, lon[wet], lat[wet])
    under_big = (at >= 0) & big[np.clip(at, 0, None)]
    fill = ~held & ~under_big & (at >= 0)
    au[:, fill], av[:, fill] = u[:, at[fill]], v[:, at[fill]]
    keep = (held | fill) & ~under_big
    rows, cols = np.nonzero(wet)
    mask = np.zeros(wet.shape, bool)
    mask[rows[keep], cols[keep]] = True
    q_nodes, q_quad = quads(lon, lat, mask)  # row-major, as keep is
    big_ids = np.flatnonzero(big)
    t_nodes, t_tri = tiles.subset(nodes, tri, big_ids)
    elems = np.vstack([q_quad, np.c_[t_tri, t_tri[:, 2]] + len(q_nodes)]) if big_ids.size else q_quad
    all_nodes = np.vstack([q_nodes, t_nodes]) if big_ids.size else q_nodes
    ctr = np.vstack([np.c_[lon[mask], lat[mask]], centers[big_ids]])
    return all_nodes, elems, ctr, np.hstack([au[:, keep], u[:, big_ids]]), np.hstack([av[:, keep], v[:, big_ids]])


def _pack(nodes, tri, centers, levels, u, v) -> tuple[bytes, dict]:
    """The NECOFS tiles as one pack and its index: tile -> [offset, length, elements]."""
    blobs, index, off = [], {}, 0
    for key, members in sorted(tiles.pyramid(centers[:, 0], centers[:, 1]).items()):
        sub_nodes, sub_tri = tiles.subset(nodes, tri, members)
        blob = tiles.encode(sub_nodes, sub_tri, levels[members], u[:, members], v[:, members])
        index[key] = [off, len(blob), int(members.size)]
        blobs.append(blob)
        off += len(blob)
    return b"".join(blobs), index


def _doppio_files(lon, lat, wet, u, v) -> bytes:
    nodes, quad = quads(lon, lat, wet)
    return tiles.encode(nodes, quad, fields.arrow_levels(lon[wet], lat[wet]), u, v)


def _necofs_files(grid, nodes, tri, centers, cells, u, v) -> tuple[bytes, dict, bytes, int]:
    """The NECOFS tile pack and its index, and the wide file (wide_view) with its element count."""
    pack, index = _pack(nodes, tri, centers, fields.arrow_levels(centers[:, 0], centers[:, 1]), u, v)
    w_nodes, w_elems, w_ctr, wu, wv = wide_view(grid, nodes, tri, centers, cells, u, v)
    wide = tiles.encode(w_nodes, w_elems, fields.arrow_levels(w_ctr[:, 0], w_ctr[:, 1]), wu, wv)
    return pack, index, wide, int(w_elems.shape[0])


def _simplify(xy: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker: the points of a line kept so none dropped lies farther than tol from the kept line."""
    if len(xy) < 3:
        return xy
    keep = np.zeros(len(xy), bool)
    keep[[0, -1]] = True
    stack = [(0, len(xy) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        p, q = xy[a], xy[b]
        seg = q - p
        n = np.hypot(*seg)
        pts = xy[a + 1 : b] - p
        d = np.abs(seg[0] * pts[:, 1] - seg[1] * pts[:, 0]) / n if n > 0 else np.hypot(pts[:, 0], pts[:, 1])
        i = int(np.argmax(d))
        if d[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return xy[keep]


def _paths_to_lines(cs, levels) -> list[dict]:
    """A matplotlib contour set to GeoJSON features, one MultiLineString per level (lon, lat to 4 decimals)."""
    feats = []
    for level, path in zip(levels, cs.get_paths()):
        v, codes = path.vertices, path.codes
        starts = [0] if codes is None else list(np.flatnonzero(codes == 1))
        bounds = starts + [len(v)]
        lines = []
        for a, b in zip(bounds[:-1], bounds[1:]):
            seg = _simplify(v[a:b], ISOBATH_TOL_DEG)
            if len(seg) >= 2 and np.hypot(*np.ptp(seg, axis=0)) > 3 * ISOBATH_TOL_DEG:  # drop specks
                lines.append(np.round(seg, 4).tolist())
        if lines:
            feats.append({"type": "Feature", "properties": {"d": int(level)}, "geometry": {"type": "MultiLineString", "coordinates": lines}})
    return feats


def isobaths_necofs(nodes: np.ndarray, tri: np.ndarray, h: np.ndarray) -> dict:
    """NECOFS's own depth contours, traced on its triangles (h at nodes, meters, positive down)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.tri import Triangulation

    levels = [d for d in ISOBATHS if np.nanmin(h) < d < np.nanmax(h)]
    fig, ax = plt.subplots()
    try:
        cs = ax.tricontour(Triangulation(nodes[:, 0], nodes[:, 1], tri), h, levels=levels)
        feats = _paths_to_lines(cs, levels)
    finally:
        plt.close(fig)
    return {"type": "FeatureCollection", "source": NECOFS_SOURCE, "units": "m", "features": feats}


def isobaths_doppio(lon: np.ndarray, lat: np.ndarray, wet: np.ndarray, h: np.ndarray) -> dict:
    """DOPPIO's own depth contours, traced between its water cells' centers (h, meters, positive down)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    z = np.ma.masked_where(~wet | ~np.isfinite(h), h)
    levels = [d for d in ISOBATHS if z.min() < d < z.max()]
    fig, ax = plt.subplots()
    try:
        cs = ax.contour(lon, lat, z, levels=levels)
        feats = _paths_to_lines(cs, levels)
    finally:
        plt.close(fig)
    return {"type": "FeatureCollection", "source": DOPPIO_SOURCE, "units": "m", "features": feats}


def _put_if_changed(ts: tiles.TileStore, rel: str, obj: dict) -> bool:
    blob = json.dumps(obj, separators=(",", ":")).encode()
    if ts.get(rel) == blob:
        return False
    ts.put(rel, blob, DAY_S, "application/json")
    return True


def _grid_npz(lon, lat, wet) -> bytes:
    buf = io.BytesIO()
    np.savez_compressed(buf, lon=lon.astype(np.float32), lat=lat.astype(np.float32), wet=wet)
    return buf.getvalue()


def _cleanup(ts: tiles.TileStore, latest: dict) -> None:
    """Keep the newest KEEP_RUNS runs and every run latest.json names."""
    named = {m.get("run") for m in latest.get("models", {}).values()}
    runs = ts.runs(f"{BASE}/runs")
    for run in runs[:-KEEP_RUNS]:
        if run not in named:
            ts.delete_run(f"{BASE}/runs", run)


def publish(store: Store, end: datetime | None = None, ts: tiles.TileStore | None = None) -> list[str]:
    """Both models into the tile store; a model that fails keeps its previous entry and files. Returns faults."""
    failed: list[str] = []
    ts = ts or tiles.store_for(store.root)
    if ts is None:
        log.info("shelf: no tile store configured (LHZN_BLUE_TILES); skipped")
        return failed
    end = end or now_utc()
    run = pd.Timestamp(end).floor("h").strftime("%Y%m%dT%HZ")
    deadline = time.monotonic() + TIME_BUDGET_S
    prev = json.loads(ts.get(f"{BASE}/latest.json") or b"{}")
    models = dict(prev.get("models", {}))
    put = lambda name, blob: ts.put(f"{BASE}/runs/{run}/{name}", blob, IMMUTABLE_S, immutable=True)  # noqa: E731

    grid = None
    try:
        lon, lat, wet, times, u, v, url, h = doppio_read(end, deadline)
        grid = (lon, lat, wet)
        put("doppio.bin", _doppio_files(lon, lat, wet, u, v))
        try:
            _put_if_changed(ts, f"{BASE}/isobaths-doppio.json", isobaths_doppio(lon, lat, wet, h))
        except Exception as exc:
            outages.record(failed, "shelf isobaths doppio", exc, log)
        ts.put(f"{BASE}/doppio-grid.npz", _grid_npz(lon, lat, wet), 86400)
        models["doppio"] = {**_header(DOPPIO_SOURCE, url, times, run), "wide": f"runs/{run}/doppio.bin", "cells": int(wet.sum())}
        log.info("shelf doppio: %d cells, %d steps", wet.sum(), times.size)
    except Exception as exc:
        outages.record(failed, "shelf doppio", exc, log)
        saved = ts.get(f"{BASE}/doppio-grid.npz")
        if saved is not None:
            z = np.load(io.BytesIO(saved))
            grid = (z["lon"].astype(np.float64), z["lat"].astype(np.float64), z["wet"].astype(bool))

    try:
        if grid is None:
            raise ValueError("no DOPPIO grid for the NECOFS domain")
        lon, lat, wet = grid
        nodes, tri, centers, cells, times, u, v, url, h = necofs_read(lon, lat, wet, end, deadline)
        pack, index, wide, n_held = _necofs_files(grid, nodes, tri, centers, cells, u, v)
        put("necofs.bin", pack)
        put("necofs-wide.bin", wide)
        try:
            _put_if_changed(ts, f"{BASE}/isobaths-necofs.json", isobaths_necofs(nodes, tri, h))
        except Exception as exc:
            outages.record(failed, "shelf isobaths necofs", exc, log)
        models["necofs"] = {
            **_header(NECOFS_SOURCE, url, times, run),
            "wide": f"runs/{run}/necofs-wide.bin",
            "pack": f"runs/{run}/necofs.bin",
            "cells": int(tri.shape[0]),
            "wide_cells": n_held,
            "tiles": index,
        }
        log.info("shelf necofs: %d elements in %d tiles (%.1f MB), %d steps", tri.shape[0], len(index), len(pack) / 1e6, times.size)
    except Exception as exc:
        outages.record(failed, "shelf necofs", exc, log)

    if models != prev.get("models", {}):
        latest = {"schema": SCHEMA, "generated_at": iso(end), "base_zoom": tiles.BASE_ZOOM, "models": models}
        ts.put(f"{BASE}/latest.json", json.dumps(latest, separators=(",", ":")).encode(), LATEST_S, "application/json")
        try:
            _cleanup(ts, latest)
        except Exception as exc:  # old runs stay a day longer; nothing is lost
            log.warning("shelf cleanup: %s", exc)
    try:
        failed.extend(archive(ts, end, deadline, grid))
    except Exception as exc:
        outages.record(failed, "shelf archive", exc, log)
    return failed


def _utc_day(t) -> pd.Timestamp:
    t = pd.Timestamp(t)
    return (t.tz_convert("UTC").tz_localize(None) if t.tzinfo is not None else t).normalize()


def archive_day(ts: tiles.TileStore, day, deadline: float, grid=None) -> tuple[dict, list[str]]:
    """One UTC day, hourly, both models, into days/<day>/ with its index.json. A model that fails is left out (the
    index says the day is incomplete, so a later run tries it again). Returns the index and the faults."""
    failed: list[str] = []
    start = _utc_day(day)
    rel = f"days/{start:%Y-%m-%d}"
    models: dict = {}
    put = lambda name, blob: ts.put(f"{BASE}/{rel}/{name}", blob, DAY_S)  # noqa: E731
    try:
        lon, lat, wet, times, u, v, url, _ = doppio_read(None, deadline, start, 24, 1)
        grid = (lon, lat, wet)
        put("doppio.bin", _doppio_files(lon, lat, wet, u, v))
        models["doppio"] = {**_header(DOPPIO_SOURCE, url, times, rel), "step": 3600, "wide": f"{rel}/doppio.bin", "cells": int(wet.sum())}
    except Exception as exc:
        outages.record(failed, f"shelf archive {start:%Y-%m-%d} doppio", exc, log)
    try:
        if grid is None:
            raise ValueError("no DOPPIO grid for the NECOFS domain")
        nodes, tri, centers, cells, times, u, v, url, _ = necofs_read(*grid, None, deadline, start, 24, 1)
        pack, index, wide, n_held = _necofs_files(grid, nodes, tri, centers, cells, u, v)
        put("necofs.bin", pack)
        put("necofs-wide.bin", wide)
        models["necofs"] = {
            **_header(NECOFS_SOURCE, url, times, rel),
            "step": 3600,
            "wide": f"{rel}/necofs-wide.bin",
            "pack": f"{rel}/necofs.bin",
            "cells": int(tri.shape[0]),
            "wide_cells": n_held,
            "tiles": index,
        }
    except Exception as exc:
        outages.record(failed, f"shelf archive {start:%Y-%m-%d} necofs", exc, log)
    complete = set(models) == {"necofs", "doppio"} and all(m["steps"] == 24 for m in models.values())
    entry = {"schema": SCHEMA, "day": f"{start:%Y-%m-%d}", "complete": complete, "base_zoom": tiles.BASE_ZOOM, "models": models}
    if models:
        put("index.json", json.dumps(entry, separators=(",", ":")).encode())
    return entry, failed


def archive(ts: tiles.TileStore, end: datetime, deadline: float, grid=None) -> list[str]:
    """The previous UTC day, and the ARCHIVE_LOOKBACK days before it that are missing or incomplete; then days.json."""
    failed: list[str] = []
    today = _utc_day(end)
    days = dict(json.loads(ts.get(f"{BASE}/days.json") or b"{}").get("days", {}))  # day -> complete
    changed = False
    for k in range(ARCHIVE_LOOKBACK, 0, -1):
        key = f"{today - pd.Timedelta(days=k):%Y-%m-%d}"
        if days.get(key) is True:
            continue
        if time.monotonic() > deadline:
            failed.append(f"shelf archive {key}: time budget spent")
            break
        entry, faults = archive_day(ts, key, deadline, grid)
        failed.extend(faults)
        if entry["models"]:
            days[key] = entry["complete"]
            changed = True
            log.info("shelf archive %s: %s", key, "complete" if entry["complete"] else f"partial ({', '.join(entry['models'])})")
    if changed:
        ts.put(f"{BASE}/days.json", json.dumps({"schema": SCHEMA, "days": dict(sorted(days.items()))}, separators=(",", ":")).encode(), 3600, "application/json")
    return failed
