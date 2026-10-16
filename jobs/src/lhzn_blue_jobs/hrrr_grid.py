"""HRRR 10 m wind over the Sound on the model's own grid, for the map's wind layer.

The native 3 km Lambert grid is cut by index to the block of rows and columns whose cell centres fall in ``BOX``, and
each cell is published as its own quadrilateral (corners halfway between neighbouring centres), so the page draws the
field as HRRR holds it: no regridding, smoothing or interpolation. Winds are rotated from the grid axes to east and
north as in forcingkit's ``hrrr_points``.

One frame per valid hour from ``HOURS_BACK`` ago to ``HOURS_AHEAD`` ahead, each from the newest cycle that covers it.
The previous file is read back and its frames kept, so a run reads only cycles not used before (at most
``MAX_CYCLES``): the newest complete cycle, and the newest 00/06/12/18 UTC cycle (48 h) if not yet used. Leads already
covered by a newer cycle are not read.

Published layout (``v1/fields/hrrr-wind.json``):

- ``mesh``: ``nx``, ``ny``; ``corner_lon``/``corner_lat`` ((ny+1) x (nx+1), row-major from the south-west);
  ``centre_lon``/``centre_lat``, ``land`` (1 where HRRR's LAND mask says land) and ``arrow_level`` per cell
  (ny x nx, row-major from the south-west); ``block`` (the first row and column in HRRR's full grid).
- ``frames``: ``{valid_time, cycle, lead, u, v}``, with ``u`` and ``v`` (east and north, m/s) per cell as int8 in
  steps of ``encoding.step`` (clipped to +-31.75 m/s), base64.
"""

from __future__ import annotations

import base64
import concurrent.futures
import logging
import os
import tempfile
import time

import numpy as np
import pandas as pd

from .build import SCHEMA, Store, iso, now_utc
from .fields import arrow_levels

log = logging.getLogger(__name__)

KEY = "v1/fields/hrrr-wind.json"
BOX = (-74.40, 40.30, -71.40, 41.70)  # lon_min, lat_min, lon_max, lat_max: the Sound, its shores, and the views around it
HOURS_BACK = 24
HOURS_AHEAD = 48
MAX_CYCLES = 2  # cycles read per run, at most
LOOKBACK_HOURS = 4  # newest complete cycle: tried from 1 to this many hours back
SYNOPTIC_LOOKBACK_HOURS = 12  # newest 00/06/12/18 UTC cycle: tried this far back
STEP = 0.25  # m/s per int8 unit
MESH_VERSION = 1  # bump when the mesh block changes form: the next run starts over
SOURCE = "NOAA HRRR (noaa-hrrr-bdp-pds), 10 m wind on the native 3 km grid"
ATTRIBUTION = "NOAA HRRR, read through forcingkit"


def _cycle_key(c: pd.Timestamp) -> str:
    return f"{c:%Y-%m-%dT%HZ}"


def _parse_key(k: str) -> pd.Timestamp:
    return pd.Timestamp(k.replace("Z", ""))


def _fetch(cycle: pd.Timestamp, lead: int, block: tuple[slice, slice] | None, land: bool, workdir: str):
    """u10, v10 (and LAND if asked) of one lead on HRRR's grid, cut to `block` (whole grid if None).
    Returns (dict of DataArrays, bytes read), or (None, bytes) if the file is not published."""
    from forcingkit.fetchers import hrrr_points as hp
    from forcingkit.fetchers.hrrr import _fetch_s3_byte_ranges, _parse_idx
    from forcingkit.fetchers.hrrr_atmosphere import _read_message

    key = hp.s3_key(cycle, lead)
    try:
        with hp.fs.open(key + ".idx", "r") as f:
            idx = f.read()
    except FileNotFoundError:
        return None, 0
    patterns = {"u10": hp.idx_pattern("u10", lead), "v10": hp.idx_pattern("v10", lead)}
    if land:
        patterns["land"] = ":LAND:surface:"
    out, nbytes = {}, len(idx)
    for name, pattern in patterns.items():
        ranges = _parse_idx(idx, (pattern,))[:1] if name == "land" else _parse_idx(idx, (pattern,))
        if len(ranges) != 1:
            raise FileNotFoundError(f"HRRR s3://{key}: expected one message for {pattern!r}, found {len(ranges)}")
        path = os.path.join(workdir, f"{name}_{cycle:%Y%m%d%H}_f{lead:02d}.grib2")
        _fetch_s3_byte_ranges(key, ranges, path)
        nbytes += os.path.getsize(path)
        try:
            da = _read_message(path)
        finally:
            os.remove(path)
        out[name] = da if block is None else da.isel(y=block[0], x=block[1])
    return out, nbytes


def _block(lon: np.ndarray, lat: np.ndarray) -> tuple[slice, slice]:
    """The rows and columns of the full grid whose centres fall in BOX, as one rectangular block."""
    x0, y0, x1, y1 = BOX
    inside = (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1)
    rows = np.flatnonzero(inside.any(axis=1))
    cols = np.flatnonzero(inside.any(axis=0))
    if not rows.size:
        raise ValueError("no HRRR cell centre in the box")
    return slice(int(rows[0]), int(rows[-1]) + 1), slice(int(cols[0]), int(cols[-1]) + 1)


def corners(c: np.ndarray) -> np.ndarray:
    """(ny+1, nx+1) cell corners from (ny, nx) centres: the mean of the four surrounding centres, with the block's
    edges extrapolated one cell out."""
    p = np.empty((c.shape[0] + 2, c.shape[1] + 2))
    p[1:-1, 1:-1] = c
    p[0, 1:-1] = 2 * c[0] - c[1]
    p[-1, 1:-1] = 2 * c[-1] - c[-2]
    p[:, 0] = 2 * p[:, 1] - p[:, 2]
    p[:, -1] = 2 * p[:, -2] - p[:, -3]
    return (p[:-1, :-1] + p[1:, :-1] + p[:-1, 1:] + p[1:, 1:]) / 4


def _mesh(u, land, block: tuple[slice, slice]) -> dict:
    lon = ((u["longitude"].values.astype(np.float64) + 180.0) % 360.0) - 180.0
    lat = u["latitude"].values.astype(np.float64)
    ny, nx = lon.shape
    r4 = lambda a: np.round(a, 4).ravel().tolist()  # noqa: E731
    return {
        "nx": int(nx),
        "ny": int(ny),
        "block": {"row0": block[0].start, "col0": block[1].start},
        "corner_lon": r4(corners(lon)),
        "corner_lat": r4(corners(lat)),
        "centre_lon": r4(lon),
        "centre_lat": r4(lat),
        "land": (np.asarray(land.values) >= 0.5).astype(int).ravel().tolist(),
        # Halved coordinates: level 0 takes one cell per 0.16 degree (twice the currents' spacing), as 3 km cells
        # are dense at the map's widest zoom; each level halves it.
        "arrow_level": arrow_levels(lon.ravel() / 2, lat.ravel() / 2).astype(int).tolist(),
        "version": MESH_VERSION,
    }


def _encode(a: np.ndarray) -> str:
    q = np.clip(np.round(np.where(np.isfinite(a), a, 0.0) / STEP), -127, 127).astype(np.int8)
    return base64.b64encode(q.ravel().tobytes()).decode()


def decode(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=np.int8).astype(np.float64) * STEP


def _candidates(now: pd.Timestamp, used: set[str]) -> list[pd.Timestamp]:
    """Cycles to read this run, newest first: the newest complete cycle, and the newest complete synoptic cycle,
    each only if not used before."""
    from .forecast import complete

    todo: list[pd.Timestamp] = []
    for h in range(1, LOOKBACK_HOURS + 1):
        c = now - pd.Timedelta(hours=h)
        if complete(c):
            if _cycle_key(c) not in used:
                todo.append(c)
            break
    for h in range(1, SYNOPTIC_LOOKBACK_HOURS + 1):
        c = now - pd.Timedelta(hours=h)
        if c.hour % 6:
            continue
        if complete(c):
            if _cycle_key(c) not in used and c not in todo:
                todo.append(c)
            break
    return sorted(todo, reverse=True)[:MAX_CYCLES]


def build(prev: dict | None, end=None) -> tuple[dict | None, dict]:
    """The new file from the previous one and the cycles not yet read. Returns (file or None, summary)."""
    from forcingkit.fetchers import hrrr_points as hp
    from forcingkit.fetchers.hrrr_atmosphere import earth_relative_winds

    t0 = time.monotonic()
    end = end or now_utc()
    now = pd.Timestamp(end).tz_convert("UTC").tz_localize(None).floor("h") if pd.Timestamp(end).tzinfo else pd.Timestamp(end).floor("h")
    lo, hi = now - pd.Timedelta(hours=HOURS_BACK), now + pd.Timedelta(hours=HOURS_AHEAD)
    if prev and (
        prev.get("box") != list(BOX)
        or prev.get("encoding", {}).get("step") != STEP
        or prev.get("mesh", {}).get("version") != MESH_VERSION
    ):
        log.info("HRRR grid: previous file has another box, encoding or mesh form; starting over")
        prev = None
    mesh = prev.get("mesh") if prev else None
    frames: dict[str, dict] = {f["valid_time"]: f for f in (prev or {}).get("frames", [])}
    used = set((prev or {}).get("cycles_read", []))
    todo = _candidates(now, used)
    nbytes, read = 0, []
    block = (slice(mesh["block"]["row0"], mesh["block"]["row0"] + mesh["ny"]), slice(mesh["block"]["col0"], mesh["block"]["col0"] + mesh["nx"])) if mesh else None
    with tempfile.TemporaryDirectory() as workdir:
        for cycle in todo:  # newest first: an older cycle fills only the hours no newer one covers
            ckey = _cycle_key(cycle)
            leads = []
            for lead in range(1, hp.max_lead(cycle) + 1):
                valid = cycle + pd.Timedelta(hours=lead)
                if not (lo <= valid <= hi):
                    continue
                have = frames.get(f"{valid:%Y-%m-%dT%H:%MZ}")
                if have and _parse_key(have["cycle"]) >= cycle:
                    continue
                leads.append(lead)
            if mesh is None and leads:  # the first read: the full grid, to find the block and the land mask
                first, n = _fetch(cycle, leads[0], None, True, workdir)
                nbytes += n
                if first is None:
                    log.warning("HRRR grid %s f%02d not published; cycle skipped", ckey, leads[0])
                    continue
                full = first["u10"]
                block = _block(((full["longitude"].values + 180.0) % 360.0) - 180.0, full["latitude"].values)
                cut = {k: v.isel(y=block[0], x=block[1]) for k, v in first.items()}
                mesh = _mesh(cut["u10"], cut["land"], block)
                pre = {leads[0]: cut}
            else:
                pre = {}
            rest = [ld for ld in leads if ld not in pre]
            with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
                got = dict(zip(rest, ex.map(lambda ld: _fetch(cycle, ld, block, False, workdir), rest)))
            nbytes += sum(n for _, n in got.values())
            native = pre | {ld: d for ld, (d, _) in got.items() if d is not None}
            lon = np.asarray(mesh["centre_lon"], dtype=np.float64)
            for lead, d in sorted(native.items()):
                u, v = d["u10"].values.astype(np.float64).ravel(), d["v10"].values.astype(np.float64).ravel()
                a = d["u10"].attrs
                if int(a.get("GRIB_uvRelativeToGrid", 1)) == 1:
                    cone = float(np.sin(np.deg2rad(a["GRIB_Latin1InDegrees"])))
                    u, v = earth_relative_winds(u, v, lon, cone, float(a["GRIB_LoVInDegrees"]))
                valid = cycle + pd.Timedelta(hours=lead)
                vkey = f"{valid:%Y-%m-%dT%H:%MZ}"
                frames[vkey] = {"valid_time": vkey, "cycle": ckey, "lead": lead, "u": _encode(u), "v": _encode(v)}
            used.add(ckey)
            read.append(f"{ckey} ({len(native)} leads)")
    if mesh is None:
        return None, {"cycles": read, "mb": round(nbytes / 1e6, 1), "seconds": round(time.monotonic() - t0, 1)}
    kept = sorted((f for f in frames.values() if lo <= pd.Timestamp(f["valid_time"].replace("Z", "")) <= hi), key=lambda f: f["valid_time"])
    cutoff = now - pd.Timedelta(hours=HOURS_BACK + HOURS_AHEAD)
    out = {
        "schema": SCHEMA,
        "kind": "wind",
        "label": "model forecast",
        "source": SOURCE,
        "attribution": ATTRIBUTION,
        "field": "10 m wind, east and north components",
        "units": "m/s",
        "generated_at": iso(end),
        "box": list(BOX),
        "encoding": {"type": "int8 base64", "step": STEP, "clip": round(127 * STEP, 2)},
        "cycles_read": sorted(c for c in used if _parse_key(c) >= cutoff),
        "mesh": mesh,
        "frames": kept,
    }
    summary = {"cycles": read or "none new", "frames": len(kept), "mb": round(nbytes / 1e6, 1), "seconds": round(time.monotonic() - t0, 1)}
    return out, summary


def publish(store: Store) -> None:
    """Refresh the HRRR wind layer; log what was read."""
    out, summary = build(store.read_json(KEY))
    log.info("HRRR grid: %s", summary)
    if out is None:
        log.warning("HRRR grid: nothing to publish")
        return
    store.write_json(KEY, out, max_age=600)


__all__ = ["publish", "build", "decode", "corners"]
