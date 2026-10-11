"""Surface fields for the map: satellite rasters and modelled surface currents, fetched with forcingkit.

forcingkit (https://github.com/lhzn-io/forcingkit) does the fetching: CoastWatch ERDDAP composites (each pixel's
most recent valid value across sensors, with its age) and the NECOFS FVCOM surface layer on the model's own mesh.
This module only encodes them compactly for the page and publishes them. It keeps no cache and no state: each run
overwrites the same few files.

Published layout (under ``<root>/v1/fields/``):

- ``sst.json``, ``chl.json``, ``kd490.json``: one raster each over the waterway's box. ``grid`` gives the
  south-west cell centre, spacing and size; ``values`` is row-major from the south, as integers to multiply by
  ``scale`` (null where there is no value: land, cloud, the masked coastal band); ``age_days`` is each pixel's age at
  ``time`` (null where no value). Sources and attribution travel with the file.
- ``currents-mesh.json``: the model mesh inside the box: node positions, triangles (indices into the nodes),
  element centres, and each element's arrow level (0 shows at the widest zoom, higher levels fill in as the map zooms
  in).
- ``currents.json``: surface (top sigma layer) eastward and northward current per element, in cm/s, every
  ``step`` seconds from ``t0``: a model forecast, labelled as one.
- ``sst-90d.bin``, ``chl-90d.bin``, ``kd490-90d.bin``: the last 90 days of each raster, one frame per UTC day (the
  composite at the day's end, or now for today), for playing the recent past. Gzipped; inside, ``LHZF``, a
  little-endian uint32 header length, a JSON header (grid, days, encoding, sources), then per frame one byte per
  pixel for the value (0 = no value; 1 to 255 spread linearly, or in log10 for chlorophyll and Kd490, over the
  field's fixed range) and, for the composited fields, one byte per pixel for the age (tenths of a day; 255 = none).
  The ranges are fixed so frames kept from earlier runs never need re-encoding. Each run recomputes the last
  ``HISTORY_RECOMPUTE_DAYS`` (late passes fill in) and drops days older than ``HISTORY_DAYS``; the file is
  overwritten in place.
"""

from __future__ import annotations

import gzip
import json
import logging
import struct
from datetime import date, datetime, time, timedelta, timezone

import numpy as np
import pandas as pd

from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

# Long Island Sound from Throgs Neck to The Race, south to take in Long Island's south-shore bays and about 20 km of
# the ocean in front. Every field uses this box, and every satellite pixel outside the currents model's water mesh is
# dropped, so all fields share one coastline (MUR, for one, fills Long Island itself with interpolated values).
BBOX = [-73.9, 40.45, -71.8, 41.45]
WATER_SOURCE = "NECOFS FVCOM GOM7 mesh"  # the coastline every raster is cut to
# name -> (forcingkit quantity, composite window in days, coastal pixels masked, scale: value = int * scale)
RASTERS = {
    "sst": ("sst", 2, 0, 0.01),  # MUR is a gap-free analysis: no compositing or coastal mask needed
    "chl": ("chlor_a", 7, 1, 0.01),
    "kd490": ("kd_490", 7, 1, 0.001),
}
CURRENT_HOURS_BACK = 24
CURRENT_HOURS_AHEAD = 72
CURRENT_STEP_HOURS = 2  # keeps the file near 5 MB for about 12,500 elements
ARROW_LEVELS = 6
ARROW_CELL_DEG = 0.08  # level 0: one arrow per 0.08 degree cell; each level halves the cell
HISTORY_DAYS = 90
HISTORY_RECOMPUTE_DAYS = 10
# name -> (low, high, log10 scale): fixed quantisation ranges for the history files
HISTORY_RANGE = {"sst": (-2.0, 32.0, False), "chl": (0.05, 50.0, True), "kd490": (0.02, 5.0, True)}
HISTORY_AGE = {"sst": True, "chl": True, "kd490": True}  # SST too: the newest frame may still be yesterday's analysis
AGE_STEP = 0.1  # days per age unit
MAGIC = b"LHZF"


def water_mask(lon: np.ndarray, lat: np.ndarray, mesh: dict) -> np.ndarray:
    """(lat, lon) booleans: True where the pixel centre lies on the model's water mesh."""
    from matplotlib.tri import Triangulation

    nodes = np.asarray(mesh["nodes"], dtype=np.float64)
    tri = Triangulation(nodes[:, 0], nodes[:, 1], np.asarray(mesh["triangles"], dtype=np.int64))
    x, y = np.meshgrid(lon, lat)
    return tri.get_trifinder()(x, y) >= 0


def cut_to_water(ds, mesh: dict | None):
    """Drop every pixel off the water mesh (value and age), for one field or a series of frames."""
    if mesh is None:
        return ds
    keep = water_mask(ds["lon"].values, ds["lat"].values, mesh)
    out = ds.copy()
    for name in ("value", "age_days"):
        if name in out:
            arr = out[name].values.copy()
            arr[..., ~keep] = np.nan
            out[name] = (out[name].dims, arr, out[name].attrs)
    return out


def raster(name: str, end: datetime | None = None, water: dict | None = None) -> dict:
    """One satellite raster, cut to the water mesh, encoded for the page."""
    from forcingkit.fetchers import coastwatch

    quantity, days, coast, scale = RASTERS[name]
    end = end or now_utc()
    ds = cut_to_water(coastwatch.composite(coastwatch.QUANTITIES[quantity], BBOX, end, days), water)
    ds = coastwatch.mask_coast(ds, coast)  # the coastal band, measured from the mesh's coastline
    lat, lon = ds["lat"].values, ds["lon"].values
    value, age = ds["value"].values, ds["age_days"].values
    ints = np.where(np.isfinite(value), np.round(value / scale), np.nan)
    products = str(ds.attrs.get("products", "")).split(",")
    return {
        "schema": SCHEMA,
        "kind": name,
        "quantity": quantity,
        "units": ds["value"].attrs.get("units", ""),
        "scale": scale,
        "time": ds.attrs.get("end", iso(end)),
        "window_days": days,
        "coast_mask_pixels": coast,
        "water": WATER_SOURCE if water is not None else None,
        "grid": {
            "lon0": round(float(lon[0]), 6),
            "lat0": round(float(lat[0]), 6),
            "dlon": round(float(np.diff(lon).mean()), 7),
            "dlat": round(float(np.diff(lat).mean()), 7),
            "nx": int(lon.size),
            "ny": int(lat.size),
        },
        "values": [None if np.isnan(v) else int(v) for v in ints.ravel()],
        "age_days": [None if np.isnan(a) else round(float(a), 1) for a in age.ravel()],
        "valid_share": round(float(np.isfinite(value).mean()), 3),
        "products": products,
        "sources": [coastwatch.PRODUCTS[p].dataset for p in products if p in coastwatch.PRODUCTS],
        "attribution": ds.attrs.get("attribution", ""),
    }


def _grid(ds) -> dict:
    lat, lon = ds["lat"].values, ds["lon"].values
    return {
        "lon0": round(float(lon[0]), 6),
        "lat0": round(float(lat[0]), 6),
        "dlon": round(float(np.diff(lon).mean()), 7),
        "dlat": round(float(np.diff(lat).mean()), 7),
        "nx": int(lon.size),
        "ny": int(lat.size),
    }


def quantise(values: np.ndarray, lo: float, hi: float, log10: bool) -> np.ndarray:
    """Values to bytes: 0 where there is no value, 1 to 255 across [lo, hi] (clipped), linear or in log10."""
    v = np.asarray(values, dtype=np.float64)
    ok = np.isfinite(v) & (v > 0 if log10 else True)
    x = np.log10(np.where(ok, v, 1.0)) if log10 else np.where(ok, v, 0.0)
    a, b = (np.log10(lo), np.log10(hi)) if log10 else (lo, hi)
    q = 1 + np.round(np.clip((x - a) / (b - a), 0.0, 1.0) * 254)
    return np.where(ok, q, 0).astype(np.uint8)


def dequantise(q: np.ndarray, lo: float, hi: float, log10: bool) -> np.ndarray:
    a, b = (np.log10(lo), np.log10(hi)) if log10 else (lo, hi)
    x = a + (q.astype(np.float64) - 1) / 254 * (b - a)
    v = 10**x if log10 else x
    return np.where(q > 0, v, np.nan)


def quantise_age(age: np.ndarray) -> np.ndarray:
    a = np.asarray(age, dtype=np.float64)
    return np.where(np.isfinite(a), np.clip(np.round(a / AGE_STEP), 0, 254), 255).astype(np.uint8)


def encode_history(header: dict, frames: list[tuple[np.ndarray, np.ndarray | None]]) -> bytes:
    head = json.dumps(header, separators=(",", ":")).encode()
    body = b"".join(v.tobytes() + (a.tobytes() if a is not None else b"") for v, a in frames)
    return gzip.compress(MAGIC + struct.pack("<I", len(head)) + head + body, compresslevel=9, mtime=0)


def decode_history(blob: bytes) -> tuple[dict, list[tuple[np.ndarray, np.ndarray | None]]]:
    raw = gzip.decompress(blob)
    if raw[:4] != MAGIC:
        raise ValueError("not a history file")
    (n,) = struct.unpack("<I", raw[4:8])
    header = json.loads(raw[8 : 8 + n])
    px = header["grid"]["nx"] * header["grid"]["ny"]
    per = px * (2 if header.get("age") else 1)
    body = np.frombuffer(raw, dtype=np.uint8, offset=8 + n)
    frames = []
    for i in range(len(header["days"])):
        chunk = body[i * per : (i + 1) * per]
        frames.append((chunk[:px].copy(), chunk[px:].copy() if header.get("age") else None))
    return header, frames


def _frame_end(day: date, now: datetime) -> datetime:
    return min(datetime.combine(day, time(23, 59, 59), tzinfo=timezone.utc), now)


def history(name: str, existing: bytes | None, end: datetime | None = None, water: dict | None = None) -> tuple[bytes, dict]:
    """The 90-day history file for a raster: frames kept from `existing` where still trusted, the rest computed.
    Returns the file and a short summary for the log."""
    from forcingkit.fetchers import coastwatch

    quantity, window, coast, _ = RASTERS[name]
    lo, hi, log10 = HISTORY_RANGE[name]
    with_age = HISTORY_AGE[name]
    end = end or now_utc()
    today = end.astimezone(timezone.utc).date()
    days = [today - timedelta(days=k) for k in range(HISTORY_DAYS - 1, -1, -1)]
    kept: dict[str, tuple[np.ndarray, np.ndarray | None]] = {}
    old_grid = None
    if existing:
        try:
            header, frames = decode_history(existing)
            same = (
                header.get("encoding") == {"low": lo, "high": hi, "log10": log10, "levels": 254}
                and bool(header.get("age")) == with_age
                and header.get("domain") == BBOX
                and header.get("water") == (WATER_SOURCE if water is not None else None)
            )
            if same:
                old_grid = header["grid"]
                fresh = {d.isoformat() for d in days[: HISTORY_DAYS - HISTORY_RECOMPUTE_DAYS]}
                # A frame with no valid pixel is computed again: usually a server outage on its days, not cloud.
                kept = {d: f for d, f in zip(header["days"], frames) if d in fresh and bool((f[0] > 0).any())}
        except Exception:
            log.warning("history %s unreadable; rebuilding", name)
    todo = [d for d in days if d.isoformat() not in kept]
    ds = coastwatch.composite_series(coastwatch.QUANTITIES[quantity], BBOX, [_frame_end(d, end) for d in todo], window)
    ds = coastwatch.mask_coast(cut_to_water(ds, water), coast)
    grid = _grid(ds)
    if old_grid is not None and old_grid != grid and len(todo) < len(days):
        log.warning("history %s grid changed; rebuilding", name)
        return history(name, None, end, water)
    new = {
        d.isoformat(): (quantise(ds["value"].values[i], lo, hi, log10).ravel(), quantise_age(ds["age_days"].values[i]).ravel() if with_age else None)
        for i, d in enumerate(todo)
    }
    frames = [kept.get(d.isoformat()) or new[d.isoformat()] for d in days]
    products = str(ds.attrs.get("products", "")).split(",")
    header = {
        "schema": SCHEMA,
        "kind": name,
        "quantity": quantity,
        "units": ds["value"].attrs.get("units", ""),
        "grid": grid,
        "days": [d.isoformat() for d in days],
        "frame_time": "each UTC day's end (today: the time of the run)",
        "window_days": window,
        "coast_mask_pixels": coast,
        "domain": BBOX,
        "water": WATER_SOURCE if water is not None else None,
        "encoding": {"low": lo, "high": hi, "log10": log10, "levels": 254},
        "age": {"step_days": AGE_STEP} if with_age else None,
        "generated_at": iso(end),
        "products": products,
        "sources": [coastwatch.PRODUCTS[p].dataset for p in products if p in coastwatch.PRODUCTS],
        "attribution": ds.attrs.get("attribution", ""),
    }
    blob = encode_history(header, frames)
    valid = [round(float((v > 0).mean()), 2) for v, _ in frames]
    return blob, {"computed": len(todo), "kept": len(kept), "bytes": len(blob), "valid_min": min(valid), "valid_max": max(valid)}


def arrow_levels(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Thinning level per element: at level k the box is cut into cells of ARROW_CELL_DEG / 2**k, and in each cell
    the element nearest the cell's centre that has no level yet takes level k. Unassigned elements take the last
    level. The map shows levels up to a zoom-dependent limit, so arrows stay evenly spaced at every zoom."""
    levels = np.full(lon.size, ARROW_LEVELS, dtype=np.int8)
    for k in range(ARROW_LEVELS):
        size = ARROW_CELL_DEG / 2**k
        ix, iy = np.floor(lon / size), np.floor(lat / size)
        dist = (lon - (ix + 0.5) * size) ** 2 + (lat - (iy + 0.5) * size) ** 2
        free = levels == ARROW_LEVELS
        order = np.lexsort((dist, iy, ix))  # by cell, nearest the centre first
        seen: set[tuple[float, float]] = set()
        for i in order:
            cell = (ix[i], iy[i])
            if cell in seen:
                continue
            seen.add(cell)
            if free[i]:
                levels[i] = k
    return levels


def currents(end: datetime | None = None) -> tuple[dict, dict]:
    """The mesh and the surface current forecast, encoded for the page."""
    from forcingkit.fetchers import necofs

    end = end or now_utc()
    start = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=CURRENT_HOURS_BACK)
    ds = necofs.read_surface(BBOX, start, CURRENT_HOURS_BACK + CURRENT_HOURS_AHEAD + 1)
    ds = ds.isel(time=slice(0, None, CURRENT_STEP_HOURS))
    lonc, latc = ds["lonc"].values.astype(np.float64), ds["latc"].values.astype(np.float64)
    mesh = {
        "schema": SCHEMA,
        "source": "NECOFS FVCOM GOM7, UMass Dartmouth (SMAST)",
        "bbox": BBOX,
        "nodes": [[round(float(x), 5), round(float(y), 5)] for x, y in zip(ds["node_lon"].values, ds["node_lat"].values)],
        "triangles": ds["triangles"].values.astype(int).tolist(),
        "centres": [[round(float(x), 5), round(float(y), 5)] for x, y in zip(lonc, latc)],
        "arrow_level": arrow_levels(lonc, latc).astype(int).tolist(),
        "arrow_levels": ARROW_LEVELS,
    }
    times = pd.DatetimeIndex(ds["time"].values).tz_localize("UTC")  # forcingkit returns naive UTC
    to_cm = lambda a: np.where(np.isfinite(a), np.round(a * 100.0), 0).astype(int)  # noqa: E731
    data = {
        "schema": SCHEMA,
        "kind": "currents",
        "label": "model forecast",
        "source": "NECOFS FVCOM GOM7, UMass Dartmouth (SMAST)",
        "url": ds.attrs.get("url"),
        "layer": "surface (top sigma layer)",
        "units": "cm/s",
        "generated_at": iso(end),
        "t0": iso(times[0]),
        "step": CURRENT_STEP_HOURS * 3600,
        "steps": int(times.size),
        "elements": int(lonc.size),
        "u": [to_cm(ds["u"].values[i]).tolist() for i in range(times.size)],
        "v": [to_cm(ds["v"].values[i]).tolist() for i in range(times.size)],
    }
    return mesh, data


def publish(store: Store) -> list[str]:
    """Fetch every field and write it; a field that fails is logged and left as it was. Returns the failures."""
    failed = []
    end = now_utc()
    # Currents first: their mesh is the coastline every raster is cut to (the stored mesh if today's read fails).
    water = None
    try:
        mesh, data = currents(end)
        store.write_json("v1/fields/currents-mesh.json", mesh, max_age=86400)
        store.write_json("v1/fields/currents.json", data, max_age=3600)
        water = mesh
    except Exception:
        log.exception("currents not refreshed")
        failed.append("currents")
        water = store.read_json("v1/fields/currents-mesh.json")
        if water is None or water.get("bbox") != BBOX:
            log.warning("no water mesh for this box; rasters are not cut to the coastline this run")
            water = None
    for name in RASTERS:
        try:
            store.write_json(f"v1/fields/{name}.json", raster(name, end, water), max_age=3600)
        except Exception:
            log.exception("field %s not refreshed", name)
            failed.append(name)
    for name in RASTERS:
        rel = f"v1/fields/{name}-90d.bin"
        try:
            blob, summary = history(name, store.read_bytes(rel), end, water)
            store.write_bytes(rel, blob, max_age=3600)
            log.info("history %s: %s", name, summary)
        except Exception:
            log.exception("history %s not refreshed", name)
            failed.append(f"{name}-90d")
    return failed

