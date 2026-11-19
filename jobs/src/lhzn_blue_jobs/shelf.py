"""The Northeast U.S. Shelf: two regional ocean models' surface currents, each on its own cells, from Cape Hatteras to
Nova Scotia.

NECOFS (FVCOM GOM7, UMass Dartmouth SMAST) runs on an unstructured triangle mesh; DOPPIO (ROMS, Rutgers University
Ocean Modeling Group for MARACOOS) on a 7 km curvilinear grid. The domain is where both run: DOPPIO's water cells,
and the NECOFS elements whose centers lie in them (about 265,000). Only model fields are published.

Published to the tile store (tiles.py: an R2 bucket, served from its own host), under ``shelf/v1/``:

- ``runs/<run>/doppio.bin``: DOPPIO's whole grid, one blob (about 19,500 cells). The page shows it at every zoom.
- ``runs/<run>/necofs-wide.bin``: NECOFS averaged into DOPPIO's cells (area-weighted vector mean of the elements
  whose centers each cell holds; where NECOFS's triangles are larger than the cells, offshore, the value of the
  triangle holding the cell's center), for a wide view, where NECOFS's own cells are smaller than a screen pixel. The page
  labels it as averaged.
- ``runs/<run>/necofs.bin``: NECOFS on its own cells, cut into Web Mercator tiles (tiles.pyramid), the blobs one
  after another; the page fetches the tiles in view by range once zoomed in.
- ``latest.json``: the current run's files per model, their time steps and the NECOFS tile index (offset, length,
  elements per tile). Written last; a model that fails keeps its previous entry and files.
- ``doppio-grid.npz``: DOPPIO's cell centers and water mask, so NECOFS can still be published on a day DOPPIO's
  server does not answer.

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
IMMUTABLE_S = 365 * 86400
LATEST_S = 300
NEAR_CELL_DEG = 0.06  # a NECOFS center belongs to the nearest DOPPIO water cell within this (cos-lat scaled degrees)
NECOFS_SOURCE = "NECOFS/UMASSD (FVCOM GOM7, UMass Dartmouth SMAST)"
DOPPIO_SOURCE = "DOPPIO ROMS, Rutgers University Ocean Modeling Group for MARACOOS"


def window(end: datetime) -> tuple[pd.Timestamp, int]:
    """The window's first hour and its length in hours."""
    return pd.Timestamp(end).floor("h").tz_localize(None) - pd.Timedelta(hours=HOURS_BACK), HOURS_BACK + HOURS_AHEAD + 1


def _pieces(start: pd.Timestamp, hours: int) -> list[tuple[pd.Timestamp, int]]:
    return [(start + pd.Timedelta(hours=h), min(READ_HOURS, hours - h)) for h in range(0, hours, READ_HOURS)]


def _two_hourly(times: pd.DatetimeIndex, u: np.ndarray, v: np.ndarray, start: pd.Timestamp):
    """Keep the hours on the window's 2-hour steps (from start), in order, without repeats."""
    keep = [i for i, t in enumerate(times) if int((t - start) / pd.Timedelta(hours=1)) % STEP_HOURS == 0]
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


def doppio_read(end: datetime, deadline: float):
    """DOPPIO's whole grid: centers, water mask, and the surface forecast at the water cells (steps, cells)."""
    from forcingkit.fetchers import doppio as fk

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
    times, u, v = _two_hourly(times, u, v, start)
    return lon, lat, wet, times, u, v, ds.attrs.get("url")


def _scaled(lon, lat) -> np.ndarray:
    return np.c_[np.asarray(lon) * np.cos(np.radians(40.0)), np.asarray(lat)]


def necofs_read(lon: np.ndarray, lat: np.ndarray, wet: np.ndarray, end: datetime, deadline: float):
    """The NECOFS elements whose centers lie in DOPPIO's water cells, and their surface forecast (steps, elements).
    Returns the elements' nodes, triangles and centers, the DOPPIO water cell each belongs to, and the forecast."""
    from forcingkit.fetchers import doppio as dfk
    from forcingkit.fetchers import necofs as fk
    from scipy.spatial import cKDTree

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
    times, u, v = _two_hourly(times, u, v, start)
    nodes = np.stack([ds["node_lon"].values, ds["node_lat"].values], axis=1).astype(np.float64)
    tri = ds["triangles"].values.astype(np.int64)
    centers = np.stack([ds["lonc"].values, ds["latc"].values], axis=1).astype(np.float64)
    cells = np.array([cell_of[int(e)] for e in ds["element_id"].values], dtype=np.int64)
    return nodes, tri, centers, cells, times, u, v, ds.attrs.get("url")


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


def fill_coarse(nodes, tri, x, y, held, au, av, u, v) -> None:
    """Where a cell holds no element center (NECOFS's offshore triangles are larger than DOPPIO's cells), the value of
    the element that contains the cell's center, if any. In place."""
    from matplotlib.tri import Triangulation

    miss = np.flatnonzero(~held)
    if not miss.size:
        return
    e = Triangulation(nodes[:, 0], nodes[:, 1], tri).get_trifinder()(x[miss], y[miss])
    ok = e >= 0
    cells, elems = miss[ok], e[ok]
    au[:, cells], av[:, cells] = u[:, elems], v[:, elems]
    held[cells] = True


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
        lon, lat, wet, times, u, v, url = doppio_read(end, deadline)
        grid = (lon, lat, wet)
        nodes, quad = quads(lon, lat, wet)
        levels = fields.arrow_levels(lon[wet], lat[wet])
        put("doppio.bin", tiles.encode(nodes, quad, levels, u, v))
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
        nodes, tri, centers, cells, times, u, v, url = necofs_read(lon, lat, wet, end, deadline)
        levels = fields.arrow_levels(centers[:, 0], centers[:, 1])
        pack, index = _pack(nodes, tri, centers, levels, u, v)
        # The wide view: NECOFS averaged into DOPPIO's water cells (only those holding a NECOFS center).
        n_wet = int(wet.sum())
        au, av, held = averaged(cells, areas(nodes, tri), u, v, n_wet)
        try:
            fill_coarse(nodes, tri, lon[wet], lat[wet], held, au, av, u, v)
        except Exception as exc:  # a mesh the point finder will not take: those cells stay empty
            log.warning("shelf necofs: coarse cells not filled: %s", exc)
        rows, cols = np.nonzero(wet)
        cell_mask = np.zeros(wet.shape, bool)
        cell_mask[rows[held], cols[held]] = True
        q_nodes, q_quad = quads(lon, lat, cell_mask)
        q_levels = fields.arrow_levels(lon[cell_mask], lat[cell_mask])
        put("necofs.bin", pack)
        put("necofs-wide.bin", tiles.encode(q_nodes, q_quad, q_levels, au[:, held], av[:, held]))
        models["necofs"] = {
            **_header(NECOFS_SOURCE, url, times, run),
            "wide": f"runs/{run}/necofs-wide.bin",
            "pack": f"runs/{run}/necofs.bin",
            "cells": int(tri.shape[0]),
            "wide_cells": int(held.sum()),
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
    return failed
