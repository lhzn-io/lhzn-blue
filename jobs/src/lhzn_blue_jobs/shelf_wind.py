"""10 m wind over the Northeast U.S. Shelf, on HRRR's and GFS's own cells, into the shelf's tile store (tiles.py).

The domain is the shelf page's: the water cells of DOPPIO's grid, which the `shelf` job saves as
``shelf/v1/doppio-grid.npz``. Each model keeps its own cells near that water, with no regridding or blending:

- HRRR (NOAA, 3 km Lambert grid): the cells within ``NEAR_DEG`` of DOPPIO water, cut from the full grid by index as
  in ``hrrr_grid``, rotated from the grid's axes to east and north. HRRR's grid ends at about 61 W in the north and
  72 W in the south, so it misses the Scotian Shelf and the farthest offshore water.
- GFS (NOAA, 0.25 degree): the cells within ``GFS_NEAR_DEG`` of DOPPIO water, everywhere, with a static flag
  ``in_hrrr`` for the cells whose centers HRRR's grid covers. The page draws GFS outside HRRR, and everywhere past
  HRRR's last hour.

Hourly frames from ``HOURS_BACK`` before the run to ``HOURS_AHEAD`` after (the currents' window). A past hour comes
from the cycle 1 hour before it (2 or 3 where that one is missing); a later hour from the newest complete cycle that
reaches it: HRRR's newest hourly cycle (18 h), then its newest 00/06/12/18 UTC cycle (48 h); GFS's newest cycle whose
leads reach the window's end (and, for past hours, the newest cycle at or before the hour). Nothing is carried over
from the previous run: each run reads its hours afresh (about 300 MB of byte-range reads, under a minute).

Velocities go through ``tiles.encode``, whose int8 step is chosen per blob from the strongest wind in it, so storm
winds are not clipped; the gust rides in a values blob (``tiles.encode_values``) with the same element order.

Published layout (under ``shelf/v1/``):

- ``wind/runs/<run>/hrrr.bin`` (tiles packed one after another, ``latest`` indexes them), ``hrrr-gust.bin`` (same
  tiles), ``hrrr-wide.bin`` and ``hrrr-wide-gust.bin`` (the cells of arrow level <= ``WIDE_LEVEL``: the wide view),
  ``gfs.bin`` and ``gfs-ts.bin`` (gust, and static ``in_hrrr``). Immutable.
- ``wind-latest.json`` (5 minutes): ``{schema, generated_at, base_zoom, models: {hrrr, gfs}}``; each model
  ``{source, run, times, cycles, cells, ...files}``, with ``times`` the valid hours held (ISO, UTC) and ``cycles`` the
  ``[cycle, lead]`` each came from. A model that fails keeps its previous entry and files.
- ``wind/days/<YYYY-MM-DD>/`` (the same files and an ``index.json``) and ``wind/days.json`` (day -> complete): the
  previous UTC days, hourly, kept like the currents' archive.
"""

from __future__ import annotations

import concurrent.futures
import io
import json
import logging
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime

import numpy as np
import pandas as pd

from . import fields, gfs, hrrr_grid, outages, shelf, tiles
from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

BASE = "shelf/v1/wind"
LATEST = "shelf/v1/wind-latest.json"
GRID = "shelf/v1/doppio-grid.npz"  # the domain, written by the `shelf` job
HOURS_BACK = fields.CURRENT_HOURS_BACK
HOURS_AHEAD = fields.CURRENT_HOURS_AHEAD
NEAR_DEG = 0.07  # an HRRR cell is kept within this of DOPPIO water (cos-lat scaled degrees, about 7 km: one DOPPIO cell)
GFS_NEAR_DEG = 0.25  # a GFS cell likewise (one GFS cell)
HRRR_INSIDE_DEG = 0.03  # a GFS center is inside HRRR's grid when an HRRR center lies this close (about 3 km)
WIDE_LEVEL = 0  # arrow levels in the wide view's HRRR file (0: about 4,000 cells, one per 0.16 degree; 1 was 2 MB)
PAST_LEADS = (1, 2, 3)  # a past hour from the cycle this many hours before it, in order
HOURLY_LOOKBACK = 4  # HRRR's newest complete cycle: tried from 1 to this many hours back
SYNOPTIC_LOOKBACK = 12  # its newest complete 00/06/12/18 UTC cycle: tried this far back
GFS_LOOKBACK_CYCLES = 4
WORKERS = 6
TIME_BUDGET_S = 12 * 60
DAY_BUDGET_S = 5 * 60
KEEP_RUNS = 3
ARCHIVE_LOOKBACK = 3
DAY_S = 86400
LATEST_S = 300
IMMUTABLE_S = 365 * 86400
HRRR_SOURCE = "NOAA HRRR (noaa-hrrr-bdp-pds), 10 m wind and surface gust on the native 3 km grid"
GFS_SOURCE = "NOAA GFS (noaa-gfs-bdp-pds), 10 m wind and surface gust on the 0.25 degree grid"


def _scaled(lon, lat) -> np.ndarray:
    return np.c_[np.ravel(lon) * np.cos(np.radians(40.0)), np.ravel(lat)]


def near_water(lon: np.ndarray, lat: np.ndarray, water_lon: np.ndarray, water_lat: np.ndarray, deg: float) -> np.ndarray:
    """Which points (any shape) lie within `deg` (cos-lat scaled) of a water cell center."""
    from scipy.spatial import cKDTree

    dist, _ = cKDTree(_scaled(water_lon, water_lat)).query(_scaled(lon, lat), distance_upper_bound=deg)
    return np.isfinite(dist).reshape(np.shape(lon))


def _hour(end) -> pd.Timestamp:
    t = pd.Timestamp(end or now_utc())
    return (t.tz_convert("UTC").tz_localize(None) if t.tzinfo else t).floor("h")


def _ckey(c: pd.Timestamp) -> str:
    return f"{c:%Y-%m-%dT%HZ}"


# ---------------------------------------------------------------------------------------------
# Which cycle and lead each hour comes from


def hrrr_cycles(now: pd.Timestamp, complete) -> tuple[pd.Timestamp | None, pd.Timestamp | None]:
    """HRRR's newest complete cycle (18 h) and newest complete synoptic cycle (48 h) before `now`."""
    hourly = next((c for c in (now - pd.Timedelta(hours=h) for h in range(1, HOURLY_LOOKBACK + 1)) if complete(c)), None)
    synoptic = next(
        (c for c in (now - pd.Timedelta(hours=h) for h in range(1, SYNOPTIC_LOOKBACK + 1)) if c.hour % 6 == 0 and complete(c)),
        None,
    )
    return hourly, synoptic


def hrrr_plan(hours: list[pd.Timestamp], now: pd.Timestamp, hourly, synoptic) -> dict[pd.Timestamp, list[tuple[pd.Timestamp, int]]]:
    """Per hour, the (cycle, lead) to try in order. Past hours (up to `now`): the cycles 1, 2 and 3 hours before.
    Later ones: the hourly cycle where it reaches, then the synoptic one. An hour neither reaches is left out."""
    plan = {}
    for t in hours:
        if t <= now:
            plan[t] = [(t - pd.Timedelta(hours=k), k) for k in PAST_LEADS]
            continue
        cands = []
        for c, reach in ((hourly, 18), (synoptic, 48)):
            if c is not None and 0 < (t - c) / pd.Timedelta(hours=1) <= reach:
                cands.append((c, int((t - c) / pd.Timedelta(hours=1))))
        if cands:
            plan[t] = cands
    return plan


def gfs_plan(hours: list[pd.Timestamp], newest: pd.Timestamp | None) -> dict[pd.Timestamp, list[tuple[pd.Timestamp, int]]]:
    """Per hour, GFS's (cycle, lead) to try in order: the newest cycle at or before the hour (never past `newest`),
    then the one 6 hours earlier."""
    if newest is None:
        return {}
    plan = {}
    for t in hours:
        c = min(t.floor("6h"), newest)
        plan[t] = [(c, int((t - c) / pd.Timedelta(hours=1))), (c - pd.Timedelta(hours=6), int((t - c) / pd.Timedelta(hours=1)) + 6)]
    return plan


def gfs_newest(now: pd.Timestamp, last_hour: pd.Timestamp, has_lead) -> pd.Timestamp | None:
    """The newest GFS cycle before `now` whose lead for `last_hour` is posted (GFS posts leads in order)."""
    for i in range(GFS_LOOKBACK_CYCLES):
        c = now.floor("6h") - pd.Timedelta(hours=6 * i)
        lead = int((last_hour - c) / pd.Timedelta(hours=1))
        if c < now and lead >= 0 and has_lead(c, lead):
            return c
    return None


def _gfs_has_lead(cycle: pd.Timestamp, lead: int) -> bool:
    from forcingkit.fetchers.hrrr import fs

    try:
        return fs.exists(gfs.key(cycle, lead) + ".idx")
    except Exception as exc:  # treat as not yet
        log.warning("GFS %s f%03d: could not check: %s", cycle, lead, exc)
        return False


# ---------------------------------------------------------------------------------------------
# Reading


@dataclass
class HrrrMesh:
    block: tuple[slice, slice]
    flat: np.ndarray  # kept cells, flat indices into the block
    lon: np.ndarray  # kept cell centers
    lat: np.ndarray
    full_lon: np.ndarray  # every center of the full grid, for GFS's in_hrrr flag
    full_lat: np.ndarray
    keep: np.ndarray  # (ny, nx) mask on the block
    block_lon: np.ndarray
    block_lat: np.ndarray


def hrrr_mesh(full_u, water_lon, water_lat, box) -> HrrrMesh:
    """The block and the kept cells, from one lead's u10 on the full grid."""
    flon = ((full_u["longitude"].values.astype(np.float64) + 180.0) % 360.0) - 180.0
    flat_ = full_u["latitude"].values.astype(np.float64)
    block = hrrr_grid._block(flon, flat_, box)
    blon, blat = flon[block], flat_[block]
    keep = near_water(blon, blat, water_lon, water_lat, NEAR_DEG)
    idx = np.flatnonzero(keep.ravel())
    return HrrrMesh(block, idx, blon.ravel()[idx], blat.ravel()[idx], flon, flat_, keep, blon, blat)


def _full_u(cycle: pd.Timestamp, lead: int, workdir: str):
    """One lead's u10 on HRRR's full grid (None if not posted): the mesh is cut from it."""
    d, _ = hrrr_grid._fetch(cycle, lead, None, False, workdir)
    return None if d is None else d["u10"]


def _hrrr_hour(cands, mesh: HrrrMesh, workdir: str):
    """(cycle, lead, u, v, gust) for one hour from the first candidate posted, on the kept cells; None if none is."""
    from forcingkit.fetchers.hrrr_atmosphere import earth_relative_winds

    for c, lead in cands:
        try:
            d, _ = hrrr_grid._fetch(c, lead, mesh.block, False, workdir)
        except Exception as exc:
            log.warning("HRRR %s f%02d: %s", _ckey(c), lead, exc)
            d = None
        if d is None:
            continue
        u = d["u10"].values.astype(np.float64).ravel()[mesh.flat]
        v = d["v10"].values.astype(np.float64).ravel()[mesh.flat]
        a = d["u10"].attrs
        if int(a.get("GRIB_uvRelativeToGrid", 1)) == 1:
            cone = float(np.sin(np.deg2rad(a["GRIB_Latin1InDegrees"])))
            u, v = earth_relative_winds(u, v, mesh.lon, cone, float(a["GRIB_LoVInDegrees"]))
        g = d["gust"].values.astype(np.float64).ravel()[mesh.flat] if "gust" in d else np.full(u.size, np.nan)
        return c, lead, u.astype(np.float32), v.astype(np.float32), g.astype(np.float32)
    return None


def _gfs_hour(cands, rows: np.ndarray, cols: np.ndarray, cells: np.ndarray):
    """(cycle, lead, u, v, gust) for one hour on the chosen GFS cells; None if no candidate is posted."""
    for c, lead in cands:
        try:
            try:
                m = gfs.read_messages(c, lead, gfs.MESSAGES)
            except FileNotFoundError:
                m = gfs.read_messages(c, lead, gfs.WIND)  # a lead without a gust message still gives the wind
        except Exception as exc:
            log.warning("GFS %s f%03d: %s", _ckey(c), lead, exc)
            continue
        cut = lambda a: a[np.ix_(rows, cols)].ravel()[cells].astype(np.float32)  # noqa: E731
        g = cut(m["gust"]) if "gust" in m else np.full(cells.size, np.nan, np.float32)
        return c, lead, cut(m["u10"]), cut(m["v10"]), g
    return None


def _gather(plan: dict, one, deadline: float, label: str) -> tuple[list, list, np.ndarray, np.ndarray, np.ndarray]:
    """Read each hour of `plan` with `one(cands)` in threads, keeping what arrives before the deadline. Returns the
    hours held, their [cycle, lead], and u, v, gust (hours, cells)."""
    hours = sorted(plan)
    got = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(lambda t=t: None if time.monotonic() > deadline else one(plan[t])): t for t in hours}
        for f in concurrent.futures.as_completed(futures):
            r = f.result()
            if r is not None:
                got[futures[f]] = r
    held = [t for t in hours if t in got]
    if len(held) < len(hours):
        log.warning("%s: %d of %d hours read", label, len(held), len(hours))
    if not held:
        raise RuntimeError(f"{label}: no hour read")
    cyc = [[_ckey(got[t][0]), got[t][1]] for t in held]
    u, v, g = (np.stack([got[t][k] for t in held]) for k in (2, 3, 4))
    return held, cyc, u, v, g


# ---------------------------------------------------------------------------------------------
# Files


def _hrrr_files(mesh: HrrrMesh, u, v, g) -> tuple[dict[str, bytes], dict]:
    """The HRRR tile pack and gust pack with their shared index, and the wide view's two blobs."""
    nodes, quad = shelf.quads(mesh.block_lon, mesh.block_lat, mesh.keep)
    # Halved coordinates, as hrrr_grid: 3 km cells are dense, so level 0 takes one arrow per 0.16 degree.
    levels = fields.arrow_levels(mesh.lon / 2, mesh.lat / 2)
    pack, gpack, index, off, goff = [], [], {}, 0, 0
    for key, m in sorted(tiles.pyramid(mesh.lon, mesh.lat).items()):
        sub_nodes, sub_quad = tiles.subset(nodes, quad, m)
        b = tiles.encode(sub_nodes, sub_quad, levels[m], u[:, m], v[:, m])
        gb = tiles.encode_values({"gust": g[:, m]})
        index[key] = [off, len(b), int(m.size), goff, len(gb)]
        pack.append(b)
        gpack.append(gb)
        off += len(b)
        goff += len(gb)
    wide = np.flatnonzero(levels <= WIDE_LEVEL)
    w_nodes, w_quad = tiles.subset(nodes, quad, wide)
    files = {
        "hrrr.bin": b"".join(pack),
        "hrrr-gust.bin": b"".join(gpack),
        "hrrr-wide.bin": tiles.encode(w_nodes, w_quad, levels[wide], u[:, wide], v[:, wide]),
        "hrrr-wide-gust.bin": tiles.encode_values({"gust": g[:, wide]}),
    }
    return files, {"index": index, "wide_cells": int(wide.size)}


def _gfs_grid(cycle: pd.Timestamp, water_lon, water_lat, box, mesh: HrrrMesh | None):
    """GFS's rows and columns over the box, the chosen cells (flat, in that cut), their 2D centers and mask, and the
    in_hrrr flag per chosen cell."""
    a = gfs.read_messages(cycle, 0, {"land": gfs.LAND}, coords=True)
    lon180 = ((a["lon"] + 180.0) % 360.0) - 180.0
    pad = 0.5
    cols = np.flatnonzero((lon180 >= box[0] - pad) & (lon180 <= box[2] + pad))
    rows = np.flatnonzero((a["lat"] >= box[1] - pad) & (a["lat"] <= box[3] + pad))
    glon, glat = np.meshgrid(lon180[cols], a["lat"][rows])
    keep = near_water(glon, glat, water_lon, water_lat, GFS_NEAR_DEG)
    cells = np.flatnonzero(keep.ravel())
    if mesh is None:
        inside = np.zeros(cells.size)
    else:
        inside = near_water(glon.ravel()[cells], glat.ravel()[cells], mesh.full_lon.ravel(), mesh.full_lat.ravel(), HRRR_INSIDE_DEG).astype(float)
    return rows, cols, cells, glon, glat, keep, inside


def _gfs_files(glon, glat, keep, u, v, g, inside) -> dict[str, bytes]:
    nodes, quad = shelf.quads(glon, glat, keep)
    levels = fields.arrow_levels(glon[keep] / 2, glat[keep] / 2)
    return {
        "gfs.bin": tiles.encode(nodes, quad, levels, u, v),
        "gfs-ts.bin": tiles.encode_values({"gust": g, "in_hrrr": inside}),
    }


def _domain(ts: tiles.TileStore):
    raw = ts.get(GRID)
    if raw is None:
        raise RuntimeError(f"no {GRID} in the tile store: the shelf job writes it")
    z = np.load(io.BytesIO(raw))
    lon, lat, wet = z["lon"].astype(np.float64), z["lat"].astype(np.float64), z["wet"].astype(bool)
    box = (float(lon[wet].min()), float(lat[wet].min()), float(lon[wet].max()), float(lat[wet].max()))
    return lon[wet], lat[wet], box


class Reader:
    """One run's readers: the domain, HRRR's mesh (from the first lead read) and GFS's grid, each found once."""

    def __init__(self, ts: tiles.TileStore):
        self.water_lon, self.water_lat, self.box = _domain(ts)
        self.mesh: HrrrMesh | None = None
        self.gfs_grid = None

    def hrrr(self, plan: dict, deadline: float, workdir: str) -> tuple[dict[str, bytes], dict]:
        if not plan:
            raise RuntimeError("HRRR: no cycle reaches the window")
        if self.mesh is None:
            for c, lead in (cl for cands in plan.values() for cl in cands):
                full = _full_u(c, lead, workdir)
                if full is not None:
                    self.mesh = hrrr_mesh(full, self.water_lon, self.water_lat, self.box)
                    log.info("shelf wind HRRR: block %s, %d cells kept", self.mesh.keep.shape, self.mesh.flat.size)
                    break
            else:
                raise RuntimeError("HRRR: no lead posted")
        held, cyc, u, v, g = _gather(plan, lambda cands: _hrrr_hour(cands, self.mesh, workdir), deadline, "HRRR")
        files, extra = _hrrr_files(self.mesh, u, v, g)
        return files, {"times": [iso(t.tz_localize("UTC")) for t in held], "cycles": cyc, "cells": int(self.mesh.flat.size), **extra}

    def gfs(self, plan: dict, deadline: float) -> tuple[dict[str, bytes], dict]:
        if not plan:
            raise RuntimeError("GFS: no complete cycle")
        if self.gfs_grid is None:
            newest = max(c for cands in plan.values() for c, _ in cands[:1])
            self.gfs_grid = _gfs_grid(newest, self.water_lon, self.water_lat, self.box, self.mesh)
        rows, cols, cells, glon, glat, keep, inside = self.gfs_grid
        held, cyc, u, v, g = _gather(plan, lambda cands: _gfs_hour(cands, rows, cols, cells), deadline, "GFS")
        files = _gfs_files(glon, glat, keep, u, v, g, inside)
        return files, {"times": [iso(t.tz_localize("UTC")) for t in held], "cycles": cyc, "cells": int(cells.size), "in_hrrr": int(inside.sum())}


def _models(reader: Reader, hours: list[pd.Timestamp], hplan: dict, gplan: dict, deadline: float, put, rel: str, failed: list, label: str) -> dict:
    """Both models' files through `put(name, blob)` (named under `rel`), and their entries; a failure is recorded."""
    models = {}
    with tempfile.TemporaryDirectory() as wd:
        try:
            files, meta = reader.hrrr(hplan, deadline, wd)
            for name, blob in files.items():
                put(name, blob)
            models["hrrr"] = {"source": HRRR_SOURCE, "run": rel, **{k: f"{rel}/{n}" for k, n in (("pack", "hrrr.bin"), ("gust", "hrrr-gust.bin"), ("wide", "hrrr-wide.bin"), ("wide_gust", "hrrr-wide-gust.bin"))}, **meta}
        except Exception as exc:
            outages.record(failed, f"{label} hrrr", exc, log)
    try:
        files, meta = reader.gfs(gplan, deadline)
        for name, blob in files.items():
            put(name, blob)
        models["gfs"] = {"source": GFS_SOURCE, "run": rel, "wide": f"{rel}/gfs.bin", "ts": f"{rel}/gfs-ts.bin", **meta}
    except Exception as exc:
        outages.record(failed, f"{label} gfs", exc, log)
    return models


# ---------------------------------------------------------------------------------------------
# The run, the day archive


def _window(now: pd.Timestamp) -> list[pd.Timestamp]:
    return list(pd.date_range(now - pd.Timedelta(hours=HOURS_BACK), now + pd.Timedelta(hours=HOURS_AHEAD), freq="h"))


def _cleanup(ts: tiles.TileStore, latest: dict) -> None:
    """Keep the newest KEEP_RUNS runs and every run latest names."""
    named = {m.get("run", "").rsplit("/", 1)[-1] for m in latest.get("models", {}).values()}
    for run in ts.runs(f"{BASE}/runs")[:-KEEP_RUNS]:
        if run not in named:
            ts.delete_run(f"{BASE}/runs", run)


def publish(store: Store, end: datetime | None = None, ts: tiles.TileStore | None = None, *, hrrr_complete=None, gfs_has_lead=None) -> list[str]:
    """The run's window into the tile store, then the archive's missing days. Returns faults."""
    failed: list[str] = []
    ts = ts or tiles.store_for(store.root)
    if ts is None:
        log.info("shelf wind: no tile store configured (LHZN_BLUE_TILES); skipped")
        return failed
    from .forecast import complete

    hrrr_complete = hrrr_complete or complete
    gfs_has_lead = gfs_has_lead or _gfs_has_lead
    now = _hour(end)
    run = f"{now:%Y%m%dT%HZ}"
    rel = f"wind/runs/{run}"
    deadline = time.monotonic() + TIME_BUDGET_S
    try:
        reader = Reader(ts)
    except Exception as exc:
        outages.record(failed, "shelf wind domain", exc, log)
        return failed
    hours = _window(now)
    hplan = hrrr_plan(hours, now, *hrrr_cycles(now, hrrr_complete))
    gplan = gfs_plan(hours, gfs_newest(now, hours[-1], gfs_has_lead))
    put = lambda name, blob: ts.put(f"shelf/v1/{rel}/{name}", blob, IMMUTABLE_S, immutable=True)  # noqa: E731
    fresh = _models(reader, hours, hplan, gplan, deadline, put, rel, failed, "shelf wind")
    prev = json.loads(ts.get(LATEST) or b"{}")
    models = {**prev.get("models", {}), **fresh}
    if fresh:
        latest = {"schema": SCHEMA, "generated_at": iso(now.tz_localize("UTC")), "base_zoom": tiles.BASE_ZOOM, "models": models}
        ts.put(LATEST, json.dumps(latest, separators=(",", ":")).encode(), LATEST_S, "application/json")
        log.info("shelf wind: %s", ", ".join(f"{k} {len(m['times'])} hours, {m['cells']} cells" for k, m in fresh.items()))
        try:
            _cleanup(ts, latest)
        except Exception as exc:  # old runs stay until the next run; nothing is lost
            log.warning("shelf wind cleanup: %s", exc)
    try:
        failed.extend(archive(ts, now, reader))
    except Exception as exc:
        outages.record(failed, "shelf wind archive", exc, log)
    return failed


def archive_day(ts: tiles.TileStore, day: pd.Timestamp, reader: Reader, now: pd.Timestamp) -> tuple[dict, list[str]]:
    """One past UTC day, hourly, both models, into wind/days/<day>/ with its index.json."""
    failed: list[str] = []
    rel = f"wind/days/{day:%Y-%m-%d}"
    hours = list(pd.date_range(day, day + pd.Timedelta(hours=23), freq="h"))
    hplan = hrrr_plan(hours, now, None, None)  # all past: each from the cycle just before it
    gplan = gfs_plan(hours, hours[-1].floor("6h"))  # each from the cycle at or before it
    put = lambda name, blob: ts.put(f"shelf/v1/{rel}/{name}", blob, DAY_S)  # noqa: E731
    models = _models(reader, hours, hplan, gplan, time.monotonic() + DAY_BUDGET_S, put, rel, failed, f"shelf wind {day:%Y-%m-%d}")
    complete = set(models) == {"hrrr", "gfs"} and all(len(m["times"]) == 24 for m in models.values())
    entry = {"schema": SCHEMA, "day": f"{day:%Y-%m-%d}", "complete": complete, "base_zoom": tiles.BASE_ZOOM, "models": models}
    if models:
        ts.put(f"shelf/v1/{rel}/index.json", json.dumps(entry, separators=(",", ":")).encode(), LATEST_S, "application/json")
    return entry, failed


def archive(ts: tiles.TileStore, now: pd.Timestamp, reader: Reader) -> list[str]:
    """The previous UTC day and the ARCHIVE_LOOKBACK days before it that are missing or incomplete; then days.json."""
    failed: list[str] = []
    days = dict(json.loads(ts.get(f"{BASE}/days.json") or b"{}").get("days", {}))
    changed = False
    today = now.normalize()
    for k in range(ARCHIVE_LOOKBACK, 0, -1):
        day = today - pd.Timedelta(days=k)
        key = f"{day:%Y-%m-%d}"
        if days.get(key) is True:
            continue
        entry, faults = archive_day(ts, day, reader, now)
        failed.extend(faults)
        if entry["models"]:
            days[key] = entry["complete"]
            changed = True
            log.info("shelf wind archive %s: %s", key, "complete" if entry["complete"] else f"partial ({', '.join(entry['models'])})")
    if changed:
        ts.put(f"{BASE}/days.json", json.dumps({"schema": SCHEMA, "days": dict(sorted(days.items()))}, separators=(",", ":")).encode(), 3600, "application/json")
    return failed
