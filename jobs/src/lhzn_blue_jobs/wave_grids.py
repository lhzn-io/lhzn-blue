"""Waves over the Sound for the next 72 hours on two models' own grids, for the "Models compared" page's Waves view.

Frames every ``FRAME_H`` hours from the current 3-hourly hour to ``HOURS_AHEAD`` ahead. For each model, every frame
comes from the newest run that reaches it, with no regridding:

- NWPS (NWS Nearshore Wave Prediction System, SWAN on WFO New York's grid CG1, about 1.8 km): taken from
  ``v1/fields/nwps-waves.json``, which the ``nwps`` step writes just before this one in the same run (its cells,
  newest run per hour). No download here. Its period is the peak period.
- NECOFS (UMass Dartmouth SMAST, on the GOM7 mesh's nodes): ``forcingkit.fetchers.necofs.read_waves`` over the map's
  box. Each value belongs to its node's median dual cell, which the page builds from the triangles. Its period is
  the mean period T0m1 (the file's ``tpeak``), not a peak period. Its ``wdir`` is the direction the waves come
  from: turned around, it matches NWPS's direction of travel within about 10 degrees (median over 287 hour-points
  in the open Sound and the New York Bight, 2026-11-25), so it is stored as the direction of travel, like NWPS's.
  The file's title names WAVEWATCH III; which wave model it is, SMAST does not say in the file.

NECOFS publishes one forecast a day, so the server is asked only between ``NECOFS_CHECK_UTC`` hours (after its
morning run), or when the frames held reach less than ``NECOFS_MIN_REACH_H`` hours ahead; otherwise its frames are
kept from the previous file. The file is written only when a model has a newer run: NWPS twice a day, NECOFS once,
so 2 to 3 Workers KV writes a day.

The same NECOFS read gives the buoys' waves plots their NECOFS line (``v1/waves-necofs.json``, one more write a day,
when a new run appears). Its file spans 72 h before to 120 h after 00 UTC of its run day, so the run's start is taken
as its last hour less ``NECOFS_RUN_H``; the read starts at 00 UTC of the newest run day that can be posted, to hold the
run's first hours. Each buoy reads its nearest node within ``nwps.MAX_KM``: the node's own value, which holds over its
dual cell, with no interpolation. Layout, as ``waves-nwps.json``: ``{runs: {run start: {steps, points: {buoy: {hs,
tp, dir}}}}, cells: {buoy: {lat, lon, km}}}``, hourly leads from 0, ``tp`` the mean period T0m1 and ``dir`` the
direction the waves come from; runs kept ``nwps.KEEP_HOURS``.

SMAST keeps no wave history, so each whole run read is also archived, privately, for verification: given an archive
root (``--necofs-waves``, a local directory or gs://bucket/prefix), ``YYYY/MM/necofs_waves_gom7_YYYYMMDD_HH.nc`` keyed
by the run start, create-only (a repeat read of the same run is refused). Only a read that starts at or before the
run start is archived, so each file holds the whole run. Contents: the read as is (hs, wdir coming from, tpeak as the
mean period T0m1, node coordinates, triangles), NetCDF4 through h5netcdf packed to int16 with zlib, crediting NECOFS/UMASSD. Never
served.

Published layout (``v1/fields/wave-grids.json``): ``{schema, generated_at, box, encoding, times, models}``. Each
model: ``{id, label, grid_label, spacing_km, source, attribution, period, run, grid, frames}``. ``grid`` is
``{type: "quads", nx, ny, lon, lat, land}`` (NWPS: cell corners, (ny+1) x (nx+1), row-major from the south-west, and a
land flag per cell) or ``{type: "nodes", n, lon, lat, tri}`` (NECOFS: node coordinates and the triangles as node
indices, 3 per triangle). ``frames``: ``{valid_time, issue_time, lead_h, hs, dir, tp}``, each field one byte per
cell or node in base64: ``hs`` in steps of ``encoding.hs_step`` m, ``dir`` (direction of travel, degrees clockwise
from north) in steps of ``encoding.dir_step``, ``tp`` in steps of ``encoding.tp_step`` s; ``encoding.none`` where
there is no value. NECOFS frames carry no issue time or lead (the file does not give its run's start); its ``run``
is the last hour its forecast reaches.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import tempfile
import time
from datetime import datetime

import numpy as np
import pandas as pd

from . import nwps
from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

KEY = "v1/fields/wave-grids.json"
BOX = nwps.FIELD_BOX
FRAME_H = 3
HOURS_AHEAD = 72
READ_AHEAD_H = 120  # NECOFS hours asked for: past its end, so the read shows where its forecast stops
HS_STEP = 0.05  # m per unit (to 12.7 m; this week reached 6.7 m in the New York Bight)
DIR_STEP = 360 / 256  # degrees per unit
TP_STEP = 0.125  # s per unit (to 31.75 s)
NONE = 255
NECOFS_CHECK_UTC = range(11, 17)  # its daily forecast is posted by about 12:30 UTC
NECOFS_MIN_REACH_H = 60
NECOFS_RUN_H = 120  # hours its forecast reaches past its run start (00 UTC of the run day)
NECOFS_POSTED_H = 12  # about when a run is posted, after its start
BUOY_KEY = "v1/waves-necofs.json"
ARCHIVE_NAME = re.compile(r"\d{4}/\d{2}/necofs_waves_gom7_\d{8}_\d{2}\.nc")
NECOFS_SOURCE = "NECOFS/UMASSD wave forecast (UMass Dartmouth SMAST), on the GOM7 mesh's nodes"
NWPS_SOURCE = "NWS Nearshore Wave Prediction System (SWAN), WFO New York grid CG1, on the model's own 1.8 km cells"


def _naive(t) -> pd.Timestamp:
    t = pd.Timestamp(t)
    return t.tz_convert("UTC").tz_localize(None) if t.tzinfo else t


def _key(t: pd.Timestamp) -> str:
    return f"{t:%Y-%m-%dT%H:%MZ}"


def frame_times(now) -> list[pd.Timestamp]:
    t0 = _naive(now).floor(f"{FRAME_H}h")
    return [t0 + pd.Timedelta(hours=h) for h in range(0, HOURS_AHEAD + 1, FRAME_H)]


def _b64(q: np.ndarray) -> str:
    return base64.b64encode(np.asarray(q, dtype=np.uint8).ravel().tobytes()).decode()


def _bytes(a, step: float, mod: float | None = None) -> np.ndarray:
    """Values to one byte each, NONE where missing; `mod` wraps directions."""
    a = np.asarray(a, dtype=np.float64)
    ok = np.isfinite(a)
    if mod is not None:
        a = np.mod(a, mod)
        q = np.round(np.where(ok, a, 0) / step) % round(mod / step)
    else:
        q = np.clip(np.round(np.where(ok, a, 0) / step), 0, NONE - 1)
    return np.where(ok, q, NONE).astype(np.uint8)


def nwps_model(doc: dict, times: list[pd.Timestamp]) -> dict | None:
    """NWPS frames at `times` from the map layer's file (hs along the direction of travel as east and north int8)."""
    mesh, enc = doc.get("mesh"), doc.get("encoding", {})
    if not mesh or not doc.get("frames"):
        return None
    step, tp_step = float(enc["step"]), float(enc.get("tp_step", nwps.FIELD_TP_STEP))
    land = np.asarray(mesh["land"], dtype=bool)
    by = {f["valid_time"]: f for f in doc["frames"]}
    dec = lambda s, k: np.frombuffer(base64.b64decode(s), np.int8).astype(np.float64) * k  # noqa: E731
    frames = []
    for t in times:
        f = by.get(_key(t))
        if f is None:
            continue
        u, v = dec(f["u"], step), dec(f["v"], step)
        hs = np.where(land, np.nan, np.hypot(u, v))
        to = np.where(land | (hs <= 0), np.nan, np.degrees(np.arctan2(u, v)))
        tp = np.where(land, np.nan, dec(f["tp"], tp_step)) if "tp" in f else np.full(hs.size, np.nan)
        frames.append({"valid_time": _key(t), "issue_time": f["cycle"], "lead_h": f["lead"],
                       "hs": _b64(_bytes(hs, HS_STEP)), "dir": _b64(_bytes(to, DIR_STEP, 360.0)), "tp": _b64(_bytes(tp, TP_STEP))})
    if not frames:
        return None
    return {
        "id": "nwps", "label": "NWPS", "grid_label": "1.8 km cells", "spacing_km": 1.8,
        "source": NWPS_SOURCE, "attribution": "NWS NWPS (NOAA NOMADS)", "period": "peak period",
        "run": sorted({f["issue_time"] for f in frames})[-1],
        "grid": {"type": "quads", "nx": mesh["nx"], "ny": mesh["ny"], "lon": mesh["corner_lon"], "lat": mesh["corner_lat"],
                 "land": [int(x) for x in land]},
        "frames": frames,
    }


def necofs_model(ds, times: list[pd.Timestamp]) -> dict:
    """NECOFS frames at `times` from a read_waves dataset (hs, wdir coming from, tpeak as the mean period)."""
    held = pd.DatetimeIndex(ds.time.values)
    frames = []
    for t in times:
        if t not in held:
            continue
        k = held.get_loc(t)
        hs = ds["hs"].values[k].astype(np.float64)
        to = (ds["wdir"].values[k].astype(np.float64) + 180.0) % 360.0
        frames.append({"valid_time": _key(t), "issue_time": None, "lead_h": None, "hs": _b64(_bytes(hs, HS_STEP)),
                       "dir": _b64(_bytes(np.where(hs > 0, to, np.nan), DIR_STEP, 360.0)),
                       "tp": _b64(_bytes(ds["tpeak"].values[k], TP_STEP))})
    r4 = lambda a: np.round(np.asarray(a, dtype=np.float64), 4).tolist()  # noqa: E731
    return {
        "id": "necofs", "label": "NECOFS", "grid_label": "mesh nodes, 0.2 to 1.5 km", "spacing_km": None,
        "source": NECOFS_SOURCE, "attribution": "NECOFS/UMASSD", "period": "mean period (T0m1)",
        "run": _key(held[-1]),
        "grid": {"type": "nodes", "n": int(ds.sizes["node"]), "lon": r4(ds["node_lon"].values), "lat": r4(ds["node_lat"].values),
                 "tri": np.asarray(ds["triangles"].values, dtype=np.int64).ravel().tolist()},
        "frames": frames,
    }


def _read_necofs(start: pd.Timestamp, hours: int):
    from forcingkit.fetchers import necofs

    return necofs.read_waves(list(BOX), start, hours, ("hs", "wdir", "tpeak"))


def read_window(now: pd.Timestamp, first: pd.Timestamp) -> tuple[pd.Timestamp, int]:
    """The NECOFS read's start and hours: from 00 UTC of the newest run day that can be posted (or the first frame,
    if earlier) to ``READ_AHEAD_H`` past the first frame."""
    start = min(first, (now - pd.Timedelta(hours=NECOFS_POSTED_H)).floor("D"))
    return start, int((first - start) / pd.Timedelta(hours=1)) + READ_AHEAD_H


def _reach(model: dict | None) -> pd.Timestamp | None:
    if not model or not model.get("frames"):
        return None
    return pd.Timestamp(model["frames"][-1]["valid_time"].replace("Z", ""))


def build(prev: dict | None, nwps_doc: dict | None, end=None, read_necofs=_read_necofs) -> tuple[dict | None, dict]:
    """The new file, or None when neither model has a newer run; and a summary."""
    t_start = time.monotonic()
    now = _naive(end or now_utc())
    times = frame_times(now)
    wanted = {_key(t) for t in times}
    old = (prev or {}).get("models", {})
    models: dict[str, dict] = {}

    nw = nwps_model(nwps_doc, times) if nwps_doc else None
    if nw:
        models["nwps"] = nw
    elif old.get("nwps"):
        models["nwps"] = {**old["nwps"], "frames": [f for f in old["nwps"]["frames"] if f["valid_time"] in wanted]}

    reach = _reach(old.get("necofs"))
    ask = old.get("necofs") is None or now.hour in NECOFS_CHECK_UTC or reach is None or reach < now + pd.Timedelta(hours=NECOFS_MIN_REACH_H)
    if ask:
        try:
            models["necofs"] = necofs_model(read_necofs(*read_window(now, times[0])), times)
        except Exception as exc:  # the previous frames stay; the page shows what they reach
            log.warning("wave grids: NECOFS read failed: %s", exc)
    if "necofs" not in models and old.get("necofs"):
        models["necofs"] = {**old["necofs"], "frames": [f for f in old["necofs"]["frames"] if f["valid_time"] in wanted]}

    runs = {k: m.get("run") for k, m in models.items()}
    before = {k: m.get("run") for k, m in old.items()}
    summary = {"runs": runs, "asked_necofs": ask, "seconds": round(time.monotonic() - t_start, 1)}
    if not models or runs == before:
        return None, summary
    out = {
        "schema": SCHEMA,
        "generated_at": iso(pd.Timestamp(now).tz_localize("UTC")),
        "box": list(BOX),
        "encoding": {"type": "uint8 base64", "hs_step": HS_STEP, "dir_step": DIR_STEP, "tp_step": TP_STEP, "none": NONE,
                     "dir": "direction of travel, degrees clockwise from north"},
        "times": sorted(wanted),
        "models": {k: models[k] for k in ("nwps", "necofs") if k in models},
    }
    return out, summary


def _value(v: float, digits: int) -> float | int | None:
    if not np.isfinite(v):
        return None
    return round(float(v), digits) if digits else round(float(v))


def buoy_file(prev: dict | None, ds, pts: dict[str, tuple[float, float]], end) -> dict | None:
    """The NECOFS runs at the buoys after a read, or None when the read adds nothing (the run is already held)."""
    held = pd.DatetimeIndex(ds.time.values)
    if not len(held):
        return None
    run0 = held[-1] - pd.Timedelta(hours=NECOFS_RUN_H)
    key = f"{run0:%Y-%m-%dT%HZ}"
    idx = np.where(held >= run0)[0]
    steps = [int((held[k] - run0) / pd.Timedelta(hours=1)) for k in idx]
    lon, lat = ds["node_lon"].values.astype(np.float64), ds["node_lat"].values.astype(np.float64)
    points: dict = {}
    cells: dict = {}
    for pid, (x, y) in pts.items():
        dist = np.hypot((lon - x) * 111.2 * np.cos(np.radians(y)), (lat - y) * 111.2)
        n = int(np.argmin(dist)) if dist.size else -1
        if n < 0 or dist[n] > nwps.MAX_KM:
            continue
        cells[pid] = {"lat": round(float(lat[n]), 4), "lon": round(float(lon[n]), 4), "km": round(float(dist[n]), 1)}
        series = {name: [_value(v, dec) for v in ds[var].values[idx, n]] for name, var, dec in (("hs", "hs", 2), ("tp", "tpeak", 1), ("dir", "wdir", 0))}
        series["hs"] = [None if v is not None and v < 0 else v for v in series["hs"]]
        points[pid] = series
    if not points:
        return None
    runs = dict((prev or {}).get("runs", {}))
    old = runs.get(key)
    if old:  # a run read again: its earlier hours stay where this read starts later
        by = {s: {pid: {k: p[k][i] for k in p} for pid, p in old["points"].items()} for i, s in enumerate(old["steps"])}
        for i, s in enumerate(steps):
            for pid, p in points.items():
                by.setdefault(s, {})[pid] = {k: p[k][i] for k in p}
        steps = sorted(by)
        ids = sorted({pid for row in by.values() for pid in row})
        points = {pid: {k: [by[s].get(pid, {}).get(k) for s in steps] for k in ("hs", "tp", "dir")} for pid in ids}
    new_run = {"steps": steps, "points": points}
    if old == new_run:
        return None
    runs[key] = new_run
    cutoff = _naive(end) - pd.Timedelta(hours=nwps.KEEP_HOURS)
    runs = {k: v for k, v in sorted(runs.items()) if pd.Timestamp(k.replace("Z", "")) >= cutoff}
    return {
        "schema": SCHEMA,
        "generated_at": iso(pd.Timestamp(_naive(end)).tz_localize("UTC")),
        "source": "NECOFS/UMASSD wave forecast (UMass Dartmouth SMAST), GOM7 mesh; read at the nearest node to each buoy",
        "attribution": "NECOFS/UMASSD",
        "units": {"hs": "m", "tp": "s, mean period (T0m1)", "dir": "deg true, from"},
        "cells": {**(prev or {}).get("cells", {}), **cells},
        "runs": runs,
    }


def archive_name(run0) -> str:
    return f"{run0:%Y/%m}/necofs_waves_gom7_{run0:%Y%m%d_%H}.nc"


def archive_bytes(ds, start, hours: int) -> bytes:
    """The read as NetCDF4 (h5netcdf, zlib), with plain attributes and the source credited."""
    out = ds.copy()
    for v in out.variables.values():
        v.encoding = {}
        v.attrs = {k: a for k, a in v.attrs.items() if isinstance(a, (str, int, float))}
    from forcingkit.fetchers import necofs

    out.attrs = {
        "source": necofs.NECOFS_WAVE_URL,
        "attribution": "NECOFS/UMASSD",
        "title": "NECOFS wave forecast over the Long Island Sound box, as read by longhorizon.blue",
        "box": ", ".join(str(x) for x in BOX),
        "read_start": str(pd.Timestamp(start)),
        "read_hours": int(hours),
        "notes": "wdir: direction the waves come from; tpeak: the mean period T0m1 (named tpeak in the source)",
    }
    # Packed to 1 mm, 0.02 degree and 1 ms (int16, shuffled, zlib): float32 noise left the file at 22 MB a run.
    pack = {"hs": 0.001, "wdir": 0.02, "tpeak": 0.001}  # int16 reaches 32.7 m, 655 degrees, 32.7 s
    enc = {k: {"zlib": True, "complevel": 4, "shuffle": True,
               **({"dtype": "int16", "scale_factor": pack[k], "_FillValue": -32768} if k in pack else {})}
           for k in out.data_vars}
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "run.nc")
        out.to_netcdf(path, engine="h5netcdf", encoding=enc)
        with open(path, "rb") as f:
            return f.read()


def archive(root: str, ds, start, hours: int) -> str | None:
    """Archive a read's run; the path written, or None (already archived, or a read that misses the run's start)."""
    held = pd.DatetimeIndex(ds.time.values)
    if not len(held):
        return None
    run0 = held[-1] - pd.Timedelta(hours=NECOFS_RUN_H)
    if _naive(start) > run0 or held[0] > run0:
        return None
    arch = nwps.Archive(root, name=archive_name, pattern=ARCHIVE_NAME, content_type="application/x-netcdf")
    return archive_name(run0) if arch.put(run0, archive_bytes(ds, start, hours)) else None


def publish(store: Store, end: datetime | None = None, archive_root: str | None = None) -> None:
    read: dict = {}

    def reading(start, hours):
        read["ds"] = _read_necofs(start, hours)
        read["start"], read["hours"] = start, hours
        return read["ds"]

    out, summary = build(store.read_json(KEY), store.read_json(nwps.FIELD_KEY), end, read_necofs=reading)
    log.info("wave grids: %s", summary)
    if out is not None:
        store.write_json(KEY, out, max_age=3600)
    if "ds" in read:
        doc = buoy_file(store.read_json(BUOY_KEY), read["ds"], nwps.buoys(), end or now_utc())
        if doc is not None:
            store.write_json(BUOY_KEY, doc, max_age=1800)
            log.info("NECOFS waves at the buoys: runs %s, buoys %s", list(doc["runs"]), sorted(doc["cells"]))
        if archive_root:
            try:
                log.info("NECOFS waves archived: %s", archive(archive_root, read["ds"], read["start"], read["hours"]) or "none new")
            except Exception as exc:  # the page's files are written; the archive tries again on the next read
                log.warning("NECOFS waves archive failed: %s", exc)
