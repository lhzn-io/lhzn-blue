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
- ``frames``: ``{valid_time, cycle, lead, u, v, gust}``, with ``u`` and ``v`` (east and north, m/s) per cell as int8
  in steps of ``encoding.step`` (clipped to +-31.75 m/s), base64, and ``gust`` (HRRR's surface wind gust, m/s) in steps
  of ``encoding.gust_step`` (0 to 31.75 m/s). Frames written before 2026-10-29 have no ``gust``.

The past beyond that window (``v1/fields/hrrr-wind-history.json``): the hours from ``HISTORY_DAYS`` back up to the
main file's first frame, which the page loads only when its time bar goes back past the main file. Each run moves
the frames that leave the main file's window into it and drops those older than ``HISTORY_DAYS``. Same ``box``,
``encoding`` and frame format; ``mesh`` holds only ``version``, ``nx``, ``ny`` and ``block`` (the page draws the
history on the main file's mesh, and checks that these match). ``cycles`` lists the runs its frames come from.
``backfill`` fills the missing hours once, each from the cycle 1 hour before it (2 or 3 hours where that cycle is
not published), as the main file fills its past hours.
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
HISTORY_KEY = "v1/fields/hrrr-wind-history.json"
HISTORY_DAYS = 14  # the Wind & waves time bar reaches 14 days back
BACKFILL_MAX_LEAD = 3  # hours: a past hour with no cycle in the 3 h before it stays empty
BACKFILL_WORKERS = 6  # leads fetched at once
BACKFILL_FLUSH_HOURS = 24  # the backfill writes after each day of hours, so a timed-out run keeps what it read


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
    patterns = {"u10": hp.idx_pattern("u10", lead), "v10": hp.idx_pattern("v10", lead), "gust": hp.idx_pattern("gust", lead)}
    if land:
        patterns["land"] = ":LAND:surface:"
    out, nbytes = {}, len(idx)
    for name, pattern in patterns.items():
        ranges = _parse_idx(idx, (pattern,))[:1] if name == "land" else _parse_idx(idx, (pattern,))
        if len(ranges) != 1 and name == "gust":  # the gust is extra: a lead without one still gives the wind
            log.warning("HRRR s3://%s: no single message for %r; frame without gust", key, pattern)
            continue
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


def _block(lon: np.ndarray, lat: np.ndarray, box: tuple[float, ...] = BOX) -> tuple[slice, slice]:
    """The rows and columns of the full grid whose centres fall in ``box`` (the Sound's by default), as one
    rectangular block."""
    x0, y0, x1, y1 = box
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


def _encode(a: np.ndarray, lo: int = -127) -> str:
    q = np.clip(np.round(np.where(np.isfinite(a), a, 0.0) / STEP), lo, 127).astype(np.int8)
    return base64.b64encode(q.ravel().tobytes()).decode()


def decode(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=np.int8).astype(np.float64) * STEP


def _frame(cycle: pd.Timestamp, lead: int, d: dict, lon: np.ndarray) -> dict:
    """One published frame from a lead's u10 and v10 on the block, rotated to east and north where HRRR gives them
    on the grid axes, with the surface gust where the lead has one."""
    u, v = d["u10"].values.astype(np.float64).ravel(), d["v10"].values.astype(np.float64).ravel()
    a = d["u10"].attrs
    if int(a.get("GRIB_uvRelativeToGrid", 1)) == 1:
        from forcingkit.fetchers.hrrr_atmosphere import earth_relative_winds

        cone = float(np.sin(np.deg2rad(a["GRIB_Latin1InDegrees"])))
        u, v = earth_relative_winds(u, v, lon, cone, float(a["GRIB_LoVInDegrees"]))
    valid = cycle + pd.Timedelta(hours=lead)
    vkey = _valid_key(valid)
    out = {"valid_time": vkey, "cycle": _cycle_key(cycle), "lead": lead, "u": _encode(u), "v": _encode(v)}
    if "gust" in d:
        out["gust"] = _encode(d["gust"].values.astype(np.float64).ravel(), lo=0)
    return out


def _valid_key(t: pd.Timestamp) -> str:
    return f"{t:%Y-%m-%dT%H:%MZ}"


def _hour(end) -> pd.Timestamp:
    """`end` (now by default) as a naive UTC timestamp, floored to the hour."""
    t = pd.Timestamp(end or now_utc())
    return (t.tz_convert("UTC").tz_localize(None) if t.tzinfo else t).floor("h")

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


def build(prev: dict | None, end=None, box: tuple[float, ...] = BOX) -> tuple[dict | None, dict]:
    """The new file from the previous one and the cycles not yet read, over ``box`` (the Sound's by default).
    Returns (file or None, summary)."""
    from forcingkit.fetchers import hrrr_points as hp

    t0 = time.monotonic()
    end = end or now_utc()
    now = _hour(end)
    lo, hi = now - pd.Timedelta(hours=HOURS_BACK), now + pd.Timedelta(hours=HOURS_AHEAD)
    if prev and (
        prev.get("box") != list(box)
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
                block = _block(((full["longitude"].values + 180.0) % 360.0) - 180.0, full["latitude"].values, box)
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
                f = _frame(cycle, lead, d, lon)
                frames[f["valid_time"]] = f
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
        "field": "10 m wind, east and north components; gust: surface wind gust, where present",
        "units": "m/s",
        "generated_at": iso(end),
        "box": list(box),
        "encoding": {"type": "int8 base64", "step": STEP, "clip": round(127 * STEP, 2), "gust_step": STEP},
        "cycles_read": sorted(c for c in used if _parse_key(c) >= cutoff),
        "mesh": mesh,
        "frames": kept,
    }
    summary = {"cycles": read or "none new", "frames": len(kept), "mb": round(nbytes / 1e6, 1), "seconds": round(time.monotonic() - t0, 1)}
    return out, summary


def _vtime(f: dict) -> pd.Timestamp:
    return pd.Timestamp(f["valid_time"].replace("Z", ""))


def _same_grid(a: dict | None, b: dict | None) -> bool:
    """Whether two files (main or history) hold frames on the same cells in the same encoding."""
    if not a or not b:
        return False
    ma, mb = a.get("mesh") or {}, b.get("mesh") or {}
    return (
        a.get("box") == b.get("box") == list(BOX)
        and (a.get("encoding") or {}).get("step") == (b.get("encoding") or {}).get("step") == STEP
        and ma.get("version") == mb.get("version") == MESH_VERSION
        and all(ma.get(k) == mb.get(k) for k in ("nx", "ny", "block"))
    )


def history(prev_hist: dict | None, prev_main: dict | None, main: dict, end=None, days: int = HISTORY_DAYS) -> dict:
    """The history file after a run: its previous frames, plus the frames of the previous main file that the new
    main file no longer holds, from `days` back up to the new main file's first frame. Frames from a file on
    another grid or encoding are dropped (as the main file starts over)."""
    now = _hour(end)
    lo = now - pd.Timedelta(days=days)
    hi = _vtime(main["frames"][0]) if main.get("frames") else now - pd.Timedelta(hours=HOURS_BACK)
    frames: dict[str, dict] = {}
    if _same_grid(prev_hist, main):
        frames.update((f["valid_time"], f) for f in prev_hist.get("frames", []))
    if _same_grid(prev_main, main):
        for f in prev_main.get("frames", []):
            frames.setdefault(f["valid_time"], f)  # history first: a past hour's frame does not change
    return _history_doc(frames.values(), main, lo, hi)


def _history_doc(frames, main: dict, lo: pd.Timestamp, hi: pd.Timestamp) -> dict:
    kept = sorted((f for f in frames if lo <= _vtime(f) < hi), key=lambda f: f["valid_time"])
    m = main["mesh"]
    return {
        "schema": SCHEMA,
        "kind": "wind",
        "label": "model forecast, past hours",
        "source": SOURCE,
        "attribution": ATTRIBUTION,
        "field": "10 m wind, east and north components; gust: surface wind gust, where present",
        "units": "m/s",
        "generated_at": iso(now_utc()),
        "box": list(BOX),
        "encoding": {"type": "int8 base64", "step": STEP, "clip": round(127 * STEP, 2), "gust_step": STEP},
        "cycles": sorted({f["cycle"] for f in kept}),
        "mesh": {"version": m.get("version"), "nx": m["nx"], "ny": m["ny"], "block": m["block"]},
        "frames": kept,
    }


def publish(store: Store, key: str = KEY, box: tuple[float, ...] = BOX, with_history: bool = True) -> None:
    """Refresh the HRRR wind layer, then move the hours that left it into the history file; log what was read.
    Another waterway passes its own ``key`` and ``box``, and may skip the history file (``with_history``)."""
    prev = store.read_json(key)
    out, summary = build(prev, box=box)
    log.info("HRRR grid %s: %s", key, summary)
    if out is None:
        log.warning("HRRR grid: nothing to publish")
        return
    store.write_json(key, out, max_age=600)
    if not with_history:
        return
    hist = history(store.read_json(HISTORY_KEY), prev, out)
    store.write_json(HISTORY_KEY, hist, max_age=3600)
    log.info("HRRR grid history: %d frames, %s to %s", len(hist["frames"]),
             hist["frames"][0]["valid_time"] if hist["frames"] else "-", hist["frames"][-1]["valid_time"] if hist["frames"] else "-")


def backfill(store: Store, days: int = HISTORY_DAYS, workers: int = BACKFILL_WORKERS, end=None) -> dict:
    """Fill the history file's missing hours (`days` back up to the main file's first frame), each from the newest
    cycle issued before it: lead 1, or 2 or 3 where that cycle is not published. Hours already in the file are
    skipped, and the file is written after each BACKFILL_FLUSH_HOURS of hours, so a run cut off by its timeout can be
    run again to finish. Reads the main file for the mesh block; run after the forecast job has written it."""
    t0 = time.monotonic()
    main = store.read_json(KEY)
    if not main or not main.get("frames") or not main.get("mesh"):
        raise RuntimeError(f"{KEY} not found or empty: run the forecast job first")
    now = _hour(end)
    lo = now - pd.Timedelta(days=days)
    hi = _vtime(main["frames"][0])
    m = main["mesh"]
    block = (slice(m["block"]["row0"], m["block"]["row0"] + m["ny"]), slice(m["block"]["col0"], m["block"]["col0"] + m["nx"]))
    lon = np.asarray(m["centre_lon"], dtype=np.float64)
    prev = store.read_json(HISTORY_KEY)
    have = {f["valid_time"] for f in prev.get("frames", [])} if _same_grid(prev, main) else set()
    hours = [t for t in pd.date_range(lo, hi - pd.Timedelta(hours=1), freq="h") if _valid_key(t) not in have]
    log.info("HRRR grid backfill: %d hours to read (%s to %s), %d present", len(hours),
             _valid_key(hours[0]) if hours else "-", _valid_key(hours[-1]) if hours else "-", len(have))
    nbytes, got, missing = 0, 0, []

    def one(valid: pd.Timestamp, workdir: str) -> tuple[dict | None, int]:
        n = 0
        for lead in range(1, BACKFILL_MAX_LEAD + 1):
            cycle = valid - pd.Timedelta(hours=lead)
            d, b = _fetch(cycle, lead, block, False, workdir)
            n += b
            if d is not None:
                return _frame(cycle, lead, d, lon), n
        return None, n

    with tempfile.TemporaryDirectory() as workdir:
        for i in range(0, len(hours), BACKFILL_FLUSH_HOURS):
            chunk = hours[i : i + BACKFILL_FLUSH_HOURS]
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
                res = list(ex.map(lambda t: one(t, workdir), chunk))
            new = [f for f, _ in res if f is not None]
            nbytes += sum(n for _, n in res)
            got += len(new)
            missing += [_valid_key(t) for t, (f, _) in zip(chunk, res) if f is None]
            # Read both files again before writing: the hourly forecast job may have run meanwhile.
            latest = store.read_json(KEY)
            if not _same_grid(latest, main) or not latest.get("frames"):
                raise RuntimeError(f"{KEY} changed grid during the backfill; run it again")
            cur = store.read_json(HISTORY_KEY)
            frames = {f["valid_time"]: f for f in new}
            if _same_grid(cur, latest):
                frames.update((f["valid_time"], f) for f in cur.get("frames", []))
            store.write_json(HISTORY_KEY, _history_doc(frames.values(), latest, lo, _vtime(latest["frames"][0])), max_age=3600)
            log.info("HRRR grid backfill: %d of %d hours read (%.0f s)", i + len(chunk), len(hours), time.monotonic() - t0)
    summary = {"hours_read": got, "not_published": missing, "mb": round(nbytes / 1e6, 1), "seconds": round(time.monotonic() - t0, 1)}
    log.info("HRRR grid backfill: %s", summary)
    return summary


__all__ = ["publish", "build", "decode", "corners", "history", "backfill"]
