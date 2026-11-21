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

import hashlib
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
FORECAST_HOLDS_DAYS = 3  # NECOFS's rolling forecast file holds about 4 days back; older hours come from SMAST's archive
BACKFILL_MAX_DAYS = 62  # days one backfill command may write
BACKFILL_DAY_S = 20 * 60  # time budget per backfilled day
BACKFILL_DEPTH_MAX_DAYS = 7  # days one backfill may write at depth (about 17 MB and 3 minutes a day)
DAY_S = 86400
IMMUTABLE_S = 365 * 86400
LATEST_S = 300
ISOBATHS = (50, 100, 200, 500, 1000, 2000, 3000)  # meters
SCALARS = {"temp": "temp", "salt": "salinity"}  # stored name -> forcingkit's variable (both models)
DEPTHS = (10, 25, 50, 100, 200, 500)  # meters below the surface, besides the top layer: the run and the daily archive
DEPTH_READ_HOURS = 3  # NECOFS hours per whole-column read for hourly days (45 layers); 6 peaked at 3.6 GB
# The run's 2-hourly steps are read one hour at a time, skipping the hours between: 5.7 s a step against 42 s per
# 6 hours (measured 2026-11-19), about 5 minutes for the window.
DEPTH_BUDGET_S = 25 * 60  # the run's depths (measured 2026-11-19: about 12 minutes)
DAY_DEPTH_BUDGET_S = 15 * 60  # one archived day's depths (4 to 7 minutes with temperature and salinity)
READ_TRIES = 3  # a whole-column read that fails is tried again: the run makes about 50 of them
READ_RETRY_S = 15
ISOBATH_TOL_DEG = 0.0015  # line simplification (about 150 m)
CELL_KM2 = 49.0  # a DOPPIO cell (7 km): NECOFS elements larger than this are drawn as they are in the wide view
KM_PER_DEG = 111.2
NO_ARROW = 255  # arrow level of a wide-view piece that draws no arrow (the page skips it)
NEAR_CELL_DEG = 0.06  # a NECOFS center belongs to the nearest DOPPIO water cell within this (cos-lat scaled degrees)
NECOFS_SOURCE = "NECOFS/UMASSD (FVCOM GOM7, UMass Dartmouth SMAST)"
DOPPIO_SOURCE = "DOPPIO ROMS, Rutgers University Ocean Modeling Group for MARACOOS"


def window(end: datetime) -> tuple[pd.Timestamp, int]:
    """The window's first hour and its length in hours."""
    return pd.Timestamp(end).floor("h").tz_localize(None) - pd.Timedelta(hours=HOURS_BACK), HOURS_BACK + HOURS_AHEAD + 1


def _pieces(start: pd.Timestamp, hours: int) -> list[tuple[pd.Timestamp, int]]:
    return [(start + pd.Timedelta(hours=h), min(READ_HOURS, hours - h)) for h in range(0, hours, READ_HOURS)]


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
            part = fk.read_volume(list(fk.DOMAIN_BBOX), t0, n, variables=["u", "v", *SCALARS.values()], layers=[0])
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
    keep = _step_index(times, start, every)
    scal = {k: np.concatenate([p[name].values[:, 0][:, wet] for p in parts])[keep] for k, name in SCALARS.items()}
    times, u, v = times[keep], u[keep], v[keep]
    h = ds["h"].values.astype(np.float64) if "h" in ds else np.full(lon.shape, np.nan)
    scal["h"] = h[wet]  # the model's own depth per water cell (m), a static field of the value files
    return lon, lat, wet, times, u, v, ds.attrs.get("url"), h, scal


def _necofs_pieces(start: pd.Timestamp, hours: int, now: pd.Timestamp | None = None) -> list[tuple[pd.Timestamp, int, str | None]]:
    """The reads for `hours` hourly records from `start`: (first hour, hours, file). Within the rolling forecast's
    reach the file is None (the forecast); before it, SMAST's archive file that holds each hour (the daily GOM7
    history, the monthly hindcast or the monthly GOM7 archive, per forcingkit), consecutive hours in one file
    read together."""
    from forcingkit.fetchers import necofs as fk

    now = pd.Timestamp(now) if now is not None else pd.Timestamp.now(tz="UTC")
    now = now.tz_convert("UTC").tz_localize(None) if now.tzinfo is not None else now
    if start >= now.normalize() - pd.Timedelta(days=FORECAST_HOLDS_DAYS):
        return [(t0, n, None) for t0, n in _pieces(start, hours)]
    out: list[tuple[pd.Timestamp, int, str | None]] = []
    by_day: dict = {}
    for k in range(hours):
        t = start + pd.Timedelta(hours=k)
        url = fk.necofs_url_for_hour(t, by_day)
        if out and out[-1][2] == url and out[-1][1] < READ_HOURS:
            out[-1] = (out[-1][0], out[-1][1] + 1, url)
        else:
            out.append((t, 1, url))
    return out


def _scaled(lon, lat) -> np.ndarray:
    return np.c_[np.asarray(lon) * np.cos(np.radians(40.0)), np.asarray(lat)]


def _necofs_domain(lon: np.ndarray, lat: np.ndarray, wet: np.ndarray, start: pd.Timestamp, url: str | None) -> tuple[list[int], dict]:
    """The NECOFS elements whose centers lie in DOPPIO's water cells, and the cell each belongs to."""
    from forcingkit.fetchers import doppio as dfk
    from forcingkit.fetchers import necofs as fk
    from scipy.spatial import cKDTree

    probe = fk.read_volume(list(dfk.DOMAIN_BBOX), start, 1, url, variables=["u"], layers=[0])
    dist, cell = cKDTree(_scaled(lon[wet], lat[wet])).query(_scaled(probe["lonc"].values, probe["latc"].values), distance_upper_bound=NEAR_CELL_DEG)
    inside = np.isfinite(dist)
    ids = [int(x) for x in probe["element_id"].values[inside]]
    if not ids:
        raise ValueError("no NECOFS elements in DOPPIO's cells")
    return ids, dict(zip(ids, cell[inside].tolist()))


def necofs_read(lon: np.ndarray, lat: np.ndarray, wet: np.ndarray, end: datetime | None, deadline: float, start: pd.Timestamp | None = None, hours: int | None = None, every: int = STEP_HOURS):
    """The NECOFS elements whose centers lie in DOPPIO's water cells, and their surface forecast (steps, elements).
    Returns the elements' nodes, triangles and centers, the DOPPIO water cell each belongs to, and the forecast."""
    from forcingkit.fetchers import doppio as dfk
    from forcingkit.fetchers import necofs as fk
    from scipy.spatial import cKDTree

    if start is None:
        start, hours = window(end)
    pieces = _necofs_pieces(start, hours)
    ids, cell_of = _necofs_domain(lon, lat, wet, start, pieces[0][2])
    parts = []
    for t0, n, url in pieces:
        if time.monotonic() > deadline:
            raise TimeoutError("shelf time budget spent")
        parts.append(fk.read_volume(None, t0, n, url, variables=["u", "v", *SCALARS.values()], layers=[0], elements=ids))
    ds = parts[0]
    times = pd.DatetimeIndex(np.concatenate([p["time"].values for p in parts]))
    u = np.concatenate([p["u"].values[:, 0, :] for p in parts])
    v = np.concatenate([p["v"].values[:, 0, :] for p in parts])
    keep = _step_index(times, start, every)
    tri = ds["triangles"].values.astype(np.int64)
    # Temperature and salinity are at nodes: each element takes the mean of its three.
    scal = {k: np.concatenate([p[name].values[:, 0, :] for p in parts])[keep][:, tri].mean(axis=2) for k, name in SCALARS.items()}
    times, u, v = times[keep], u[keep], v[keep]
    nodes = np.stack([ds["node_lon"].values, ds["node_lat"].values], axis=1).astype(np.float64)
    centers = np.stack([ds["lonc"].values, ds["latc"].values], axis=1).astype(np.float64)
    cells = np.array([cell_of[int(e)] for e in ds["element_id"].values], dtype=np.int64)
    h = ds["h"].values.astype(np.float64) if "h" in ds else np.full(len(nodes), np.nan)
    scal["h"] = h[tri].mean(axis=1)  # the model's own depth per element (m): the mean of its nodes', as the depths use
    return nodes, tri, centers, cells, times, u, v, ds.attrs.get("url"), h, scal


def _step_index(times: pd.DatetimeIndex, start: pd.Timestamp, every: int) -> list[int]:
    """Indices of the hours on the window's steps of `every` hours (from start), in order, without repeats."""
    keep = [i for i, t in enumerate(times) if int((t - start) / pd.Timedelta(hours=1)) % every == 0]
    return [i for k, i in enumerate(keep) if k == 0 or times[i] != times[keep[k - 1]]]


def at_depths(u: np.ndarray, v: np.ndarray, frac: np.ndarray, column: np.ndarray, depths=DEPTHS) -> dict:
    """Velocity at fixed depths below the surface from a model's own layers. u, v (steps, layers, n) at layer centers;
    frac (layers, n) the sigma of each center, surface first (negative); column (steps, n) the water column, depth plus
    surface elevation. Linear between the two centers around a depth; the top layer above the first center; the
    deepest layer between its center and the bed; NaN where the column is shorter than the depth. Returns
    {depth: (u, v)}, each (steps, n), float32."""
    z = _interp({"u": u, "v": v}, frac, column, depths)
    return {d: (z[d]["u"], z[d]["v"]) for d in depths}


def _interp(fields: dict, frac: np.ndarray, column: np.ndarray, depths=DEPTHS) -> dict:
    """at_depths for any fields at layer centers (name -> (steps, layers, n)): {depth: {name: (steps, n)}}."""
    below = -frac[None, :, :] * column[:, None, :]
    last = next(iter(fields.values())).shape[1] - 1
    out: dict = {}
    for d in depths:
        k = (below < d).sum(axis=1)  # centers above d
        lo = np.clip(k - 1, 0, last)[:, None, :]
        hi = np.clip(k, 0, last)[:, None, :]
        b_lo = np.take_along_axis(below, lo, 1)[:, 0]
        b_hi = np.take_along_axis(below, hi, 1)[:, 0]
        gap = b_hi - b_lo
        w = np.clip(np.where(gap > 0, (d - b_lo) / np.where(gap > 0, gap, 1.0), 0.0), 0.0, 1.0)
        out[d] = {}
        for name, f in fields.items():
            a = np.take_along_axis(f, lo, 1)[:, 0]
            b = np.take_along_axis(f, hi, 1)[:, 0]
            out[d][name] = np.where(d < column, a + (b - a) * w, np.nan).astype(np.float32)
    return out


def _on_steps(times: pd.DatetimeIndex, start: pd.Timestamp, every: int, seen: set) -> list[int]:
    """Indices of the hours on the window's steps that are not yet held."""
    keep = []
    for i, t in enumerate(times):
        if int((t - start) / pd.Timedelta(hours=1)) % every == 0 and t not in seen:
            seen.add(t)
            keep.append(i)
    return keep


def _read_tries(read, label: str):
    """A whole-column read, tried READ_TRIES times when the server fails it (an outage, per outages.is_outage); the
    last failure is raised."""
    for k in range(READ_TRIES):
        try:
            return read()
        except Exception as exc:
            if k == READ_TRIES - 1 or not outages.is_outage(exc):
                raise
            log.warning("%s: %s, trying again in %d s", label, exc.__class__.__name__, READ_RETRY_S)
            time.sleep(READ_RETRY_S)


def doppio_depths(start: pd.Timestamp, hours: int, every: int, deadline: float):
    """DOPPIO's whole grid at DEPTHS: the steps' times, {depth: (u, v)} over the water cells deeper than each depth,
    per depth that mask (over the water cells), and {depth: {temp, salt, h}} over the same cells (h, the model's
    depth, one per cell)."""
    from forcingkit.fetchers import doppio as fk

    acc: dict = {d: {} for d in DEPTHS}
    seen: set = set()
    times: list = []
    wet = h = None
    for t0, n in _pieces(start, hours):
        if time.monotonic() > deadline:
            if times:
                log.warning("shelf doppio depths: budget spent at %s; kept %d steps", t0, len(times))
                break
            raise TimeoutError("shelf depth budget spent")
        try:
            ds = _read_tries(lambda: fk.read_volume(list(fk.DOMAIN_BBOX), t0, n, variables=["u", "v", *SCALARS.values(), "zeta"]), f"doppio depths {t0}")
        except RuntimeError as exc:  # a piece wholly past the forecast's end
            if times and "none of" in str(exc):
                break
            raise
        except Exception as exc:  # still failing: keep the steps already read
            if times and outages.is_outage(exc):
                log.warning("shelf doppio depths: %s at %s; kept %d steps", exc.__class__.__name__, t0, len(times))
                break
            raise
        if wet is None:
            wet = ds["mask"].values.astype(bool) if "mask" in ds else np.ones(ds["lon"].shape, bool)
            h = ds["h"].values[wet].astype(np.float64)
        tt = pd.DatetimeIndex(ds["time"].values)
        keep = _on_steps(tt, start, every, seen)
        if not keep:
            continue
        column = h[None, :] + ds["zeta"].values[keep][:, wet]
        names = {"u": "u", "v": "v", **SCALARS}
        z = _interp({k: ds[name].values[keep][:, :, wet] for k, name in names.items()}, ds["siglay"].values[:, wet], column)
        for d in DEPTHS:  # only the cells deeper than d are drawn at d, so only they are kept
            for k in names:
                acc[d].setdefault(k, []).append(z[d][k][:, h > d])
        times.extend(tt[keep])
    if not times:
        raise ValueError("no DOPPIO hours at depth in the window")
    fields_ = {d: (np.concatenate(acc[d]["u"]), np.concatenate(acc[d]["v"])) for d in DEPTHS}
    scal = {d: {**{k: np.concatenate(acc[d][k]) for k in SCALARS}, "h": h[h > d]} for d in DEPTHS}
    return pd.DatetimeIndex(times), fields_, {d: h > d for d in DEPTHS}, scal


def necofs_depths(lon: np.ndarray, lat: np.ndarray, wet: np.ndarray, start: pd.Timestamp, hours: int, every: int, deadline: float):
    """NECOFS at DEPTHS on the same elements as necofs_read (centers in DOPPIO's water cells), read DEPTH_READ_HOURS
    at a time. Returns nodes, triangles, centers, DOPPIO cell per element, the steps' times, {depth: (u, v)} over the
    elements deeper than each depth, per depth that mask, and {depth: {temp, salt, h}} over the same elements (h, the
    model's depth, one per element)."""
    from forcingkit.fetchers import necofs as fk

    pieces = []
    for t0, n, url in _necofs_pieces(start, hours):
        if every > 1:  # one hour per step
            for k in range(n):
                t = t0 + pd.Timedelta(hours=k)
                if int((t - start) / pd.Timedelta(hours=1)) % every == 0:
                    pieces.append((t, 1, url))
        else:
            for k in range(0, n, DEPTH_READ_HOURS):
                pieces.append((t0 + pd.Timedelta(hours=k), min(DEPTH_READ_HOURS, n - k), url))
    ids, cell_of = _necofs_domain(lon, lat, wet, start, pieces[0][2])
    acc: dict = {d: {} for d in DEPTHS}
    seen: set = set()
    times: list = []
    geo = None
    for t0, n, url in pieces:
        if time.monotonic() > deadline:
            if times:
                log.warning("shelf necofs depths: budget spent at %s; kept %d steps", t0, len(times))
                break
            raise TimeoutError("shelf depth budget spent")
        try:
            ds = _read_tries(lambda: fk.read_volume(None, t0, n, url, variables=["u", "v", *SCALARS.values(), "zeta"], elements=ids), f"necofs depths {t0}")
        except RuntimeError as exc:  # hours past the forecast's end
            if times and "none of" in str(exc):
                break
            raise
        except Exception as exc:  # still failing: keep the steps already read
            if times and outages.is_outage(exc):
                log.warning("shelf necofs depths: %s at %s; kept %d steps", exc.__class__.__name__, t0, len(times))
                break
            raise
        if geo is None:
            tri = ds["triangles"].values.astype(np.int64)
            nodes = np.stack([ds["node_lon"].values, ds["node_lat"].values], axis=1).astype(np.float64)
            centers = np.stack([ds["lonc"].values, ds["latc"].values], axis=1).astype(np.float64)
            cells = np.array([cell_of[int(e)] for e in ds["element_id"].values], dtype=np.int64)
            h_e = ds["h"].values[tri].mean(axis=1).astype(np.float64)
            frac = ds["siglay"].values[:, tri].mean(axis=2)  # (layers, element)
            geo = (nodes, tri, centers, cells)
        tt = pd.DatetimeIndex(ds["time"].values)
        keep = _on_steps(tt, start, every, seen)
        if not keep:
            continue
        column = h_e[None, :] + ds["zeta"].values[keep][:, tri].mean(axis=2)
        layers = {"u": ds["u"].values[keep], "v": ds["v"].values[keep]}
        for k, name in SCALARS.items():  # at nodes: each element takes the mean of its three
            layers[k] = ds[name].values[keep][:, :, tri].mean(axis=3)
        z = _interp(layers, frac, column)
        for d in DEPTHS:  # only the elements deeper than d are drawn at d, so only they are kept
            for k in layers:
                acc[d].setdefault(k, []).append(z[d][k][:, h_e > d])
        times.extend(tt[keep])
        del ds, z, layers
    if geo is None or not times:
        raise ValueError("no NECOFS hours at depth in the window")
    fields_ = {d: (np.concatenate(acc[d]["u"]), np.concatenate(acc[d]["v"])) for d in DEPTHS}
    scal = {d: {**{k: np.concatenate(acc[d][k]) for k in SCALARS}, "h": h_e[h_e > d]} for d in DEPTHS}
    return (*geo, pd.DatetimeIndex(times), fields_, {d: h_e > d for d in DEPTHS}, scal)


def _depth_entries(models: dict, grid, start: pd.Timestamp, hours: int, every: int, deadline: float, prefix: str, put, failed: list, label: str) -> bool:
    """Both models at DEPTHS into files under `prefix` (relative to the tile base), and a `depths` entry on each model
    in `models` that has a surface entry from this same window. Returns whether any depth was added."""
    added = False
    lon, lat, wet = grid
    if "doppio" in models:
        try:
            times, z, deeper, zs = doppio_depths(start, hours, every, deadline)
            entry = {}
            for d in DEPTHS:
                k = deeper[d]
                sub = wet.copy()
                sub[wet] = k
                name = f"depth/{d}m/doppio.bin"
                put(name, _doppio_files(lon, lat, sub, z[d][0], z[d][1]))
                put(f"depth/{d}m/doppio-ts.bin", tiles.encode_values(zs[d]))
                entry[str(d)] = {
                    "t0": iso(times[0].tz_localize("UTC")),
                    "step": every * 3600,
                    "steps": int(times.size),
                    "wide": prefix + name,
                    "cells": int(k.sum()),
                    "ts": {"wide": f"{prefix}depth/{d}m/doppio-ts.bin"},
                }
            models["doppio"]["depths"] = entry
            added = True
            log.info("shelf %s doppio depths: %d steps", label, times.size)
        except Exception as exc:
            outages.record(failed, f"shelf {label} doppio depths", exc, log)
    if "necofs" in models:
        try:
            nodes, tri, centers, cells, times, z, deeper, zs = necofs_depths(lon, lat, wet, start, hours, every, deadline)
            entry = {}
            for d in DEPTHS:
                k = deeper[d]
                pack, index, wide, n_held = _necofs_files(grid, nodes, tri[k], centers[k], cells[k], z[d][0], z[d][1])
                put(f"depth/{d}m/necofs.bin", pack)
                put(f"depth/{d}m/necofs-wide.bin", wide)
                vpack, vindex, vwide = _necofs_values(grid, nodes, tri[k], centers[k], cells[k], zs[d])
                put(f"depth/{d}m/necofs-ts.bin", vpack)
                put(f"depth/{d}m/necofs-wide-ts.bin", vwide)
                entry[str(d)] = {
                    "t0": iso(times[0].tz_localize("UTC")),
                    "step": every * 3600,
                    "steps": int(times.size),
                    "wide": f"{prefix}depth/{d}m/necofs-wide.bin",
                    "pack": f"{prefix}depth/{d}m/necofs.bin",
                    "cells": int(k.sum()),
                    "wide_cells": n_held,
                    "tiles": index,
                    "ts": {"wide": f"{prefix}depth/{d}m/necofs-wide-ts.bin", "pack": f"{prefix}depth/{d}m/necofs-ts.bin", "tiles": vindex},
                }
            models["necofs"]["depths"] = entry
            added = True
            log.info("shelf %s necofs depths: %d elements at 10 m, %d steps", label, int(deeper[DEPTHS[0]].sum()), times.size)
        except Exception as exc:
            outages.record(failed, f"shelf {label} necofs depths", exc, log)
    return added


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


def _half(poly: np.ndarray, a: np.ndarray, b: np.ndarray, left: bool) -> np.ndarray | None:
    """The part of a convex polygon (k, 2) on one side of the line through a and b (Sutherland-Hodgman), or None."""
    d = (b[0] - a[0]) * (poly[:, 1] - a[1]) - (b[1] - a[1]) * (poly[:, 0] - a[0])
    if not left:
        d = -d
    side = d >= 0
    if side.all():  # wholly on this side (most calls): the loop below would copy it point for point
        return poly
    if not side.any():
        return None
    out = []
    for i in range(len(poly)):
        j = (i + 1) % len(poly)
        if d[i] >= 0:
            out.append(poly[i])
        if (d[i] >= 0) != (d[j] >= 0):
            out.append(poly[i] + d[i] / (d[i] - d[j]) * (poly[j] - poly[i]))
    return np.array(out) if len(out) >= 3 else None


def _outside(poly: np.ndarray, t: np.ndarray) -> list[np.ndarray]:
    """A convex polygon less a counter-clockwise triangle t (3, 2), as convex pieces."""
    pieces, rest = [], poly
    for i in range(3):
        a, b = t[i], t[(i + 1) % 3]
        out = _half(rest, a, b, left=False)
        if out is not None:
            pieces.append(out)
        rest = _half(rest, a, b, left=True)
        if rest is None:
            break
    return pieces


def _area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


_SEAMS: dict[bytes, tuple[np.ndarray, dict]] = {}  # _seam's cuts by their inputs: a run cuts each level's seam once
_SEAMS_KEPT = 8  # the surface and the six depths


def _seam_once(c_nodes, c_quad, b_nodes, b_tri, cen_big) -> tuple[np.ndarray, dict]:
    """_seam, kept by its inputs: the currents and the values of a level share one geometry, and so do the run and
    the archived day (the same elements), so a run's 28 wide views make 7 cuts or fewer."""
    digest = hashlib.blake2b(digest_size=16)
    for a in (c_nodes, c_quad, b_nodes, b_tri, cen_big):
        a = np.ascontiguousarray(a)
        digest.update(str((a.dtype, a.shape)).encode())
        digest.update(a.tobytes())
    key = digest.digest()
    if key not in _SEAMS:
        if len(_SEAMS) >= _SEAMS_KEPT:
            _SEAMS.pop(next(iter(_SEAMS)))
        _SEAMS[key] = _seam(c_nodes, c_quad, b_nodes, b_tri, cen_big)
    return _SEAMS[key]


def _seam(c_nodes, c_quad, b_nodes, b_tri, cen_big) -> tuple[np.ndarray, dict]:
    """Where DOPPIO's cells meet NECOFS's large triangles. Per cell, the large triangles that may overlap it: those
    holding its center or a corner, those with a corner inside it, and their neighbors. Returns which cells lie wholly
    under large triangles, and for the cells partly under them the convex pieces left outside."""
    n = len(c_quad)
    corner_big = containing(b_nodes, b_tri, c_nodes[:, 0], c_nodes[:, 1])[c_quad]  # (cells, 4)
    halves = np.vstack([c_quad[:, [0, 1, 2]], c_quad[:, [0, 2, 3]]])
    poke = containing(c_nodes, halves, b_nodes[:, 0], b_nodes[:, 1])  # big-triangle corners inside a cell
    poke = np.where(poke >= 0, poke % n, -1)
    by_node: dict[int, list[int]] = {}
    for t, row in enumerate(b_tri):
        for nd in row:
            by_node.setdefault(int(nd), []).append(t)
    cands: dict[int, set] = {}
    for i in np.flatnonzero((corner_big >= 0).any(axis=1) | (cen_big >= 0)):
        cands[int(i)] = {int(t) for t in corner_big[i] if t >= 0} | ({int(cen_big[i])} if cen_big[i] >= 0 else set())
    for nd in np.flatnonzero(poke >= 0):
        cands.setdefault(int(poke[nd]), set()).update(by_node.get(int(nd), []))
    b_lo, b_hi = b_nodes[b_tri].min(axis=1), b_nodes[b_tri].max(axis=1)
    covered = np.zeros(n, bool)
    partial: dict[int, list[np.ndarray]] = {}
    for i, ts in cands.items():
        near = set(ts)
        for t in ts:
            for nd in b_tri[t]:
                near.update(by_node[int(nd)])
        cell = c_nodes[c_quad[i]]
        whole = _area(cell)
        pieces = [cell]
        # A triangle clear of the cell cuts nothing; clipping by it would only split the cell along its edges' lines.
        near = np.fromiter(near, np.int64)
        lo, hi = cell.min(axis=0), cell.max(axis=0)
        near = near[(b_lo[near] <= hi).all(axis=1) & (b_hi[near] >= lo).all(axis=1)]
        for t in near:
            pieces = [r for q in pieces for r in _outside(q, b_nodes[b_tri[t]])]
            if not pieces:
                break
        pieces = [q for q in pieces if _area(q) > 1e-6 * whole]
        left = sum(_area(q) for q in pieces)
        if left < 1e-3 * whole:
            covered[i] = True
        elif left < (1 - 1e-6) * whole:
            partial[i] = pieces
    return covered, partial


def wide_view(grid, nodes, tri, centers, cells, u, v):
    """NECOFS at DOPPIO's resolution, never finer than NECOFS: elements larger than a DOPPIO cell are kept as they
    are; every other cell takes the area-weighted mean of the smaller elements centered in it, or, holding none, the
    element containing its center. A cell wholly under the large triangles is left out, and one partly under them is
    cut to the part outside, as triangles, so the view covers the water once, without gaps or overlaps (the cells
    are drawn translucent). A cut cell keeps its own value and one arrow; a cell centered under a large triangle and
    holding no smaller element takes, for each piece, the element under the piece's center, and draws no arrow.
    Returns nodes, four-node elements (a triangle repeats its last node), centers, u and v (steps, elements), and
    which elements draw no arrow."""
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
    big_ids = np.flatnonzero(big)
    t_nodes, t_tri = tiles.subset(nodes, tri, big_ids)
    partial: dict[int, list[np.ndarray]] = {}
    if big_ids.size:
        p = t_nodes[t_tri]
        cw = (p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1]) - (p[:, 2, 0] - p[:, 0, 0]) * (p[:, 1, 1] - p[:, 0, 1]) < 0
        t_tri[cw] = t_tri[cw][:, [0, 2, 1]]
        c_nodes, c_quad = quads(lon, lat, wet)  # every water cell, row-major as keep is
        cen_big = np.where(under_big, containing(t_nodes, t_tri, lon[wet], lat[wet]), -1)
        covered, partial = _seam_once(c_nodes, c_quad, t_nodes, t_tri, cen_big)
        keep &= ~covered
        partial = {i: q for i, q in partial.items() if keep[i] or held[i] or at[i] >= 0}
        keep[list(partial)] = False
    rows, cols = np.nonzero(wet)
    mask = np.zeros(wet.shape, bool)
    mask[rows[keep], cols[keep]] = True
    q_nodes, q_quad = quads(lon, lat, mask)  # row-major, as keep is
    # The cut cells' pieces, fanned into triangles: (cell, triangle corners, whether it carries the cell's arrow).
    pieces = []
    for i, polys in sorted(partial.items()):
        fan = [np.stack([q[0], q[k], q[k + 1]]) for q in polys for k in range(1, len(q) - 1)]
        fan = [f for f in fan if _area(f) > 0]
        first = int(np.argmax([_area(f) for f in fan])) if not under_big[i] else -1
        pieces += [(i, f, k == first) for k, f in enumerate(fan)]
    p_xy = np.array([f for _, f, _ in pieces]).reshape(-1, 3, 2)
    p_ctr = p_xy.mean(axis=1)
    p_cell = np.array([i for i, _, _ in pieces], dtype=np.int64)
    own = np.array([not under_big[i] or held[i] for i in p_cell], bool)
    p_at = containing(nodes, tri, p_ctr[:, 0], p_ctr[:, 1]) if len(pieces) else np.zeros(0, np.int64)
    p_at = np.where(p_at >= 0, p_at, at[p_cell] if len(pieces) else p_at)
    pu = np.where(own, au[:, p_cell], u[:, np.clip(p_at, 0, None)])
    pv = np.where(own, av[:, p_cell], v[:, np.clip(p_at, 0, None)])
    p_quiet = np.array([not a for _, _, a in pieces], bool)
    n_q = len(q_nodes)
    p_elems = (n_q + np.arange(3 * len(pieces))).reshape(-1, 3)
    p_elems = np.c_[p_elems, p_elems[:, 2]]
    off = n_q + 3 * len(pieces)
    elems = np.vstack([q_quad, p_elems, np.c_[t_tri, t_tri[:, 2]] + off])
    all_nodes = np.vstack([q_nodes, p_xy.reshape(-1, 2), t_nodes])
    ctr = np.vstack([np.c_[lon[mask], lat[mask]], p_ctr, centers[big_ids]])
    quiet = np.r_[np.zeros(len(q_quad), bool), p_quiet, np.zeros(big_ids.size, bool)]
    wu = np.hstack([au[:, keep], pu, u[:, big_ids]])
    wv = np.hstack([av[:, keep], pv, v[:, big_ids]])
    return all_nodes, elems, ctr, wu, wv, quiet


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


def _necofs_values(grid, nodes, tri, centers, cells, scal: dict) -> tuple[bytes, dict, bytes]:
    """Temperature, salinity and the model's depth for the NECOFS tiles (the same keys and element order as _pack's),
    and for the wide view (the same averaging as the currents, through wide_view; the depth rides as one more row of
    the first field, so the seam is cut once). Returns the value pack, its index, the wide blob."""
    timed = [k for k, a in scal.items() if np.ndim(a) == 2]
    still = [k for k, a in scal.items() if np.ndim(a) == 1]
    blobs, index, off = [], {}, 0
    for key, members in sorted(tiles.pyramid(centers[:, 0], centers[:, 1]).items()):
        blob = tiles.encode_values({k: scal[k][..., members] for k in scal})
        index[key] = [off, len(blob), int(members.size)]
        blobs.append(blob)
        off += len(blob)
    steps = scal[timed[0]].shape[0]
    first = np.vstack([scal[timed[0]], *[scal[k][None, :] for k in still]])
    w0, w1 = wide_view(grid, nodes, tri, centers, cells, first, scal[timed[1]])[3:5]
    wide = {timed[0]: w0[:steps], timed[1]: w1, **{k: w0[steps + i] for i, k in enumerate(still)}}
    return b"".join(blobs), index, tiles.encode_values(wide)


def _doppio_files(lon, lat, wet, u, v) -> bytes:
    nodes, quad = quads(lon, lat, wet)
    return tiles.encode(nodes, quad, fields.arrow_levels(lon[wet], lat[wet]), u, v)


def _necofs_files(grid, nodes, tri, centers, cells, u, v) -> tuple[bytes, dict, bytes, int]:
    """The NECOFS tile pack and its index, and the wide file (wide_view) with its element count."""
    pack, index = _pack(nodes, tri, centers, fields.arrow_levels(centers[:, 0], centers[:, 1]), u, v)
    w_nodes, w_elems, w_ctr, wu, wv, quiet = wide_view(grid, nodes, tri, centers, cells, u, v)
    levels = np.full(len(w_elems), NO_ARROW, dtype=np.int16)
    levels[~quiet] = fields.arrow_levels(w_ctr[~quiet, 0], w_ctr[~quiet, 1])
    wide = tiles.encode(w_nodes, w_elems, levels, wu, wv)
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
        lon, lat, wet, times, u, v, url, h, scal = doppio_read(end, deadline)
        grid = (lon, lat, wet)
        put("doppio.bin", _doppio_files(lon, lat, wet, u, v))
        put("doppio-ts.bin", tiles.encode_values(scal))
        try:
            _put_if_changed(ts, f"{BASE}/isobaths-doppio.json", isobaths_doppio(lon, lat, wet, h))
        except Exception as exc:
            outages.record(failed, "shelf isobaths doppio", exc, log)
        ts.put(f"{BASE}/doppio-grid.npz", _grid_npz(lon, lat, wet), 86400)
        models["doppio"] = {**_header(DOPPIO_SOURCE, url, times, run), "wide": f"runs/{run}/doppio.bin", "cells": int(wet.sum()), "ts": {"wide": f"runs/{run}/doppio-ts.bin"}}
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
        nodes, tri, centers, cells, times, u, v, url, h, scal = necofs_read(lon, lat, wet, end, deadline)
        pack, index, wide, n_held = _necofs_files(grid, nodes, tri, centers, cells, u, v)
        put("necofs.bin", pack)
        put("necofs-wide.bin", wide)
        vpack, vindex, vwide = _necofs_values(grid, nodes, tri, centers, cells, scal)
        put("necofs-ts.bin", vpack)
        put("necofs-wide-ts.bin", vwide)
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
            "ts": {"wide": f"runs/{run}/necofs-wide-ts.bin", "pack": f"runs/{run}/necofs-ts.bin", "tiles": vindex},
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
        failed.extend(archive(ts, end, time.monotonic() + TIME_BUDGET_S, grid))
    except Exception as exc:
        outages.record(failed, "shelf archive", exc, log)

    # The run's depths last, with their own budget: the surface is published first and never waits on them.
    fresh = {k: m for k, m in models.items() if m.get("run") == run}
    if grid is not None and fresh:
        start, hours = window(end)
        if _depth_entries(fresh, grid, start, hours, STEP_HOURS, time.monotonic() + DEPTH_BUDGET_S, f"runs/{run}/", put, failed, "run"):
            latest = {"schema": SCHEMA, "generated_at": iso(end), "base_zoom": tiles.BASE_ZOOM, "models": {**models, **fresh}}
            ts.put(f"{BASE}/latest.json", json.dumps(latest, separators=(",", ":")).encode(), LATEST_S, "application/json")
    return failed


def _utc_day(t) -> pd.Timestamp:
    t = pd.Timestamp(t)
    return (t.tz_convert("UTC").tz_localize(None) if t.tzinfo is not None else t).normalize()


def archive_day(ts: tiles.TileStore, day, deadline: float, grid=None, depths: bool = False) -> tuple[dict, list[str]]:
    """One UTC day, hourly, both models, into days/<day>/ with its index.json; with `depths`, also at DEPTHS (the
    daily run's days; backfills stay at the surface). A model that fails is left out (the index says the day is
    incomplete, so a later run tries it again); missing depths do not make a day incomplete. Returns the index and
    the faults."""
    failed: list[str] = []
    start = _utc_day(day)
    rel = f"days/{start:%Y-%m-%d}"
    models: dict = {}
    put = lambda name, blob: ts.put(f"{BASE}/{rel}/{name}", blob, DAY_S)  # noqa: E731
    try:
        lon, lat, wet, times, u, v, url, _, scal = doppio_read(None, deadline, start, 24, 1)
        grid = (lon, lat, wet)
        put("doppio.bin", _doppio_files(lon, lat, wet, u, v))
        put("doppio-ts.bin", tiles.encode_values(scal))
        models["doppio"] = {**_header(DOPPIO_SOURCE, url, times, rel), "step": 3600, "wide": f"{rel}/doppio.bin", "cells": int(wet.sum()), "ts": {"wide": f"{rel}/doppio-ts.bin"}}
    except Exception as exc:
        outages.record(failed, f"shelf archive {start:%Y-%m-%d} doppio", exc, log)
    try:
        if grid is None:
            raise ValueError("no DOPPIO grid for the NECOFS domain")
        nodes, tri, centers, cells, times, u, v, url, _, scal = necofs_read(*grid, None, deadline, start, 24, 1)
        pack, index, wide, n_held = _necofs_files(grid, nodes, tri, centers, cells, u, v)
        put("necofs.bin", pack)
        put("necofs-wide.bin", wide)
        vpack, vindex, vwide = _necofs_values(grid, nodes, tri, centers, cells, scal)
        put("necofs-ts.bin", vpack)
        put("necofs-wide-ts.bin", vwide)
        models["necofs"] = {
            **_header(NECOFS_SOURCE, url, times, rel),
            "step": 3600,
            "wide": f"{rel}/necofs-wide.bin",
            "pack": f"{rel}/necofs.bin",
            "cells": int(tri.shape[0]),
            "wide_cells": n_held,
            "tiles": index,
            "ts": {"wide": f"{rel}/necofs-wide-ts.bin", "pack": f"{rel}/necofs-ts.bin", "tiles": vindex},
        }
    except Exception as exc:
        outages.record(failed, f"shelf archive {start:%Y-%m-%d} necofs", exc, log)
    complete = set(models) == {"necofs", "doppio"} and all(m["steps"] == 24 for m in models.values())
    if depths and grid is not None and models:
        _depth_entries(models, grid, start, 24, 1, time.monotonic() + DAY_DEPTH_BUDGET_S, f"{rel}/", put, failed, f"archive {start:%Y-%m-%d}")
    entry = {"schema": SCHEMA, "day": f"{start:%Y-%m-%d}", "complete": complete, "base_zoom": tiles.BASE_ZOOM, "models": models}
    if models:
        # Five minutes, not a day: a day's index is rewritten when depths are added or a failed model is retried.
        ts.put(f"{BASE}/{rel}/index.json", json.dumps(entry, separators=(",", ":")).encode(), LATEST_S, "application/json")
    return entry, failed


def _fill_days(ts: tiles.TileStore, keys: list[str], deadline_of, grid=None, depths: bool = False) -> list[str]:
    """Archive each day in `keys` not yet complete, then merge them into days.json (day -> complete)."""
    failed: list[str] = []
    days = dict(json.loads(ts.get(f"{BASE}/days.json") or b"{}").get("days", {}))
    changed = False
    for key in keys:
        if days.get(key) is True and not (depths and not _has_depths(ts, key)):
            continue
        deadline = deadline_of()
        if time.monotonic() > deadline:
            failed.append(f"shelf archive {key}: time budget spent")
            break
        entry, faults = archive_day(ts, key, deadline, grid, depths)
        failed.extend(faults)
        if entry["models"]:
            days[key] = entry["complete"]
            changed = True
            log.info("shelf archive %s: %s", key, "complete" if entry["complete"] else f"partial ({', '.join(entry['models'])})")
    if changed:
        ts.put(f"{BASE}/days.json", json.dumps({"schema": SCHEMA, "days": dict(sorted(days.items()))}, separators=(",", ":")).encode(), 3600, "application/json")
    return failed


def _has_depths(ts: tiles.TileStore, key: str) -> bool:
    """Whether an archived day already holds both models at depth."""
    raw = ts.get(f"{BASE}/days/{key}/index.json")
    models = json.loads(raw).get("models", {}) if raw else {}
    return bool(models) and all("depths" in m for m in models.values())


def archive(ts: tiles.TileStore, end: datetime, deadline: float, grid=None) -> list[str]:
    """The previous UTC day, and the ARCHIVE_LOOKBACK days before it that are missing or incomplete; then days.json."""
    today = _utc_day(end)
    keys = [f"{today - pd.Timedelta(days=k):%Y-%m-%d}" for k in range(ARCHIVE_LOOKBACK, 0, -1)]
    return _fill_days(ts, keys, lambda: deadline, grid, depths=True)


def backfill(store: Store, first: str, last: str, ts: tiles.TileStore | None = None, depths: bool = False) -> list[str]:
    """Past UTC days `first` to `last` (inclusive) into the day archive, from the models' own archives (NECOFS's
    hindcast or GOM7 archive, DOPPIO's reanalysis or forecast history), each day with its own time budget. With
    `depths`, also at DEPTHS (at most BACKFILL_DEPTH_MAX_DAYS days), adding them to days already archived at the
    surface."""
    ts = ts or tiles.store_for(store.root)
    if ts is None:
        return ["shelf backfill: no tile store configured (LHZN_BLUE_TILES)"]
    a, b = _utc_day(first), _utc_day(last)
    if b < a or (b - a).days + 1 > BACKFILL_MAX_DAYS:
        raise ValueError(f"shelf backfill: {first} to {last} is not 1 to {BACKFILL_MAX_DAYS} days")
    if b >= _utc_day(now_utc()):
        raise ValueError("shelf backfill: past days only (the daily run archives yesterday)")
    if depths and (b - a).days + 1 > BACKFILL_DEPTH_MAX_DAYS:
        raise ValueError(f"shelf backfill: at most {BACKFILL_DEPTH_MAX_DAYS} days at depth at once")
    keys = [f"{d:%Y-%m-%d}" for d in pd.date_range(a, b, freq="D")]
    return _fill_days(ts, keys, lambda: time.monotonic() + BACKFILL_DAY_S, depths=depths)
