"""The Sound's HF radar surface currents, kept beyond the public server's rolling window.

The Western Long Island Sound HF radar sites are operated by the University of Connecticut (LISICOS); the NOAA IOOS HF
Radar National Network (HFRNet) combines their radials into hourly total vectors, which NOAA NDBC serves for about 92
days. forcingkit's ``hfradar`` fetcher reads them and writes the archive: one NetCDF-4 file per UTC day and grid, values
as stored on the server, with the credit in ``source_credit`` (see its documentation for the layout). This module only
says which box and where: the Sound's box, into a local directory (by default forcingkit's own cache,
``FORCINGKIT_CACHE_DIR/hfradar``) or a gs://bucket/prefix the job may create objects in but neither read, overwrite
nor delete. The snapshot job runs it three times a week; ``hfradar --start all`` takes every day the server holds.

``publish`` writes the map layer: the last 72 hours of the 1 km totals at the cells that hold any, hourly, to
``v1/fields/hfradar.json`` (the forecast job, hourly). ``model_runs`` keeps the NECOFS surface current at the same
cells from each of the last few daily runs, as issued, in ``v1/fields/necofs-at-radar.json`` (the fields job, daily),
so a page can set the measured current beside the forecast made a day or more before.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone

import numpy as np
import requests
from forcingkit.fetchers import hfradar

from .merlin import USER_AGENT

# The Sound from the East River to past New London: [min_lon, min_lat, max_lon, max_lat].
BBOX = [-73.8, 40.85, -71.8, 41.3]

# The map layer: hours kept, and the encoding (one signed byte per component in steps of STEP m/s; MISSING: no total).
# The geometric dilution of precision (GDOP, the network's hdop) goes with each total as an unsigned byte in hundredths
# (GDOP_MISSING: none).
LIVE_HOURS = 72
STEP = 0.02
MISSING = -128
GDOP_MISSING = 255
# NECOFS at the radar cells: runs kept (a day apart), and the encoding (signed bytes in steps of RUN_STEP_CMS cm/s).
RUNS_KEEP = 5
RUN_STEP_CMS = 2


class Bucket:
    """A gs://bucket/prefix, create-only: the job cannot read the bucket, so `has` is always False and `put` refuses
    an existing object."""

    def __init__(self, root: str):
        from google.cloud import storage

        bucket, _, prefix = root[5:].partition("/")
        self.bucket = storage.Client().bucket(bucket)
        self.prefix = prefix.strip("/")

    def has(self, name: str) -> bool:
        return False

    def put(self, name: str, data: bytes) -> bool:
        from google.api_core.exceptions import PreconditionFailed

        if not hfradar.NAME.fullmatch(name):
            raise ValueError(f"refusing to write {name}")
        path = f"{self.prefix}/{name}" if self.prefix else name
        try:
            self.bucket.blob(path).upload_from_string(data, content_type="application/x-netcdf", if_generation_match=0)
        except PreconditionFailed:
            return False
        return True


def store(root: str | None):
    """The archive: a bucket for gs://, else a directory (forcingkit's cache when ``root`` is None)."""
    if root and root.startswith("gs://"):
        return Bucket(root)
    return hfradar.LocalStore(root)


def archive(root: str | None, start: str | None = None, end: str | None = None) -> dict[str, list[str]]:
    """Keep every ready day of the Sound's box not yet kept, at 1 km and 2 km (forcingkit ``hfradar.archive``)."""
    return hfradar.archive(BBOX, start, end, store=store(root), session=_session())


def _session() -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    return session


def _b64(q: np.ndarray) -> str:
    return base64.b64encode(q.astype(np.int8).tobytes()).decode()


def layer(ds, now: datetime) -> dict:
    """The map layer from decoded 1 km totals (u, v in m/s on a regular lat-lon grid): the last LIVE_HOURS hours up
    to the newest hour with any total, at the cells holding a total in any of them."""
    u = ds["u"].values
    v = ds["v"].values
    times = ds["time"].values.astype("datetime64[s]")
    filled = np.isfinite(u).any(axis=(1, 2))
    if not filled.any():
        raise RuntimeError("no HF radar totals in the box")
    newest = times[np.flatnonzero(filled)[-1]]
    hours = (times > newest - np.timedelta64(LIVE_HOURS, "h")) & (times <= newest)
    u, v, times = u[hours], v[hours], times[hours]
    gdop = ds["hdop"].values[hours] if "hdop" in ds else None
    lat = ds["lat"].values.astype(float)
    lon = ds["lon"].values.astype(float)
    dlat, dlon = np.diff(lat), np.diff(lon)
    if np.ptp(dlat) > 1e-4 or np.ptp(dlon) > 1e-4:
        raise RuntimeError("the HF radar grid is not regular")
    cells = np.flatnonzero(np.isfinite(u).any(axis=0).ravel())

    def q(a: np.ndarray) -> np.ndarray:
        flat = a.reshape(len(a), -1)[:, cells]
        out = np.clip(np.round(np.nan_to_num(flat, nan=0.0) / STEP), -127, 127)
        return np.where(np.isfinite(flat), out, MISSING)

    qu, qv = q(u), q(v)
    qg = None
    if gdop is not None:
        flat = gdop.reshape(len(gdop), -1)[:, cells]
        ok = np.isfinite(flat) & (qu != MISSING)
        qg = np.where(ok, np.clip(np.round(np.nan_to_num(flat) * 100), 0, 254), GDOP_MISSING).astype(np.uint8)

    def frame(k: int, t) -> dict:
        f = {"valid_time": f"{t}Z", "n": int((qu[k] != MISSING).sum()), "u": _b64(qu[k]), "v": _b64(qv[k])}
        if qg is not None:
            f["g"] = base64.b64encode(qg[k].tobytes()).decode()
        return f
    return {
        "generated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": "NOAA IOOS HFRNet hourly totals, 1 km (NOAA NDBC)",
        "attribution": hfradar.CREDIT,
        "grid": {
            "lon0": round(float(lon[0]), 5),
            "lat0": round(float(lat[0]), 5),
            "dlon": round(float(dlon.mean()), 6),
            "dlat": round(float(dlat.mean()), 6),
            "nx": len(lon),
            "ny": len(lat),
        },
        "cells": cells.tolist(),
        "encoding": {"step": STEP, "missing": MISSING, "gdop_step": 0.01, "gdop_missing": GDOP_MISSING},
        "frames": [frame(k, t) for k, t in enumerate(times)],
    }


def publish(store, now: datetime | None = None) -> None:
    """Write the map layer (``v1/fields/hfradar.json``) from the archive and the server."""
    now = now or datetime.now(timezone.utc)
    fmt = "%Y-%m-%dT%H"
    start = (now - timedelta(hours=LIVE_HOURS + 12)).strftime(fmt)
    ds = hfradar.load(BBOX, start, (now + timedelta(hours=1)).strftime(fmt), grid="1km", session=_session())
    store.write_json("v1/fields/hfradar.json", layer(ds, now), max_age=1800)


def _containing(nodes: np.ndarray, triangles: np.ndarray, points: np.ndarray) -> np.ndarray:
    """For each point (lon, lat), the triangle holding it, or -1 (lon and lat as plane coordinates: the triangles are
    under 2 km)."""
    a, b, c = (nodes[triangles[:, k]] for k in range(3))
    out = np.full(len(points), -1)
    for i, p in enumerate(points):
        d1 = (p[0] - b[:, 0]) * (a[:, 1] - b[:, 1]) - (a[:, 0] - b[:, 0]) * (p[1] - b[:, 1])
        d2 = (p[0] - c[:, 0]) * (b[:, 1] - c[:, 1]) - (b[:, 0] - c[:, 0]) * (p[1] - c[:, 1])
        d3 = (p[0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (p[1] - a[:, 1])
        inside = ~(((d1 < 0) | (d2 < 0) | (d3 < 0)) & ((d1 > 0) | (d2 > 0) | (d3 > 0)))
        hit = np.flatnonzero(inside)
        if hit.size:
            out[i] = hit[0]
    return out


def model_runs(store, mesh: dict, data: dict) -> None:
    """Add this NECOFS run (as fields.currents returns it, cm/s per element) at the radar layer's cells to
    ``v1/fields/necofs-at-radar.json``, keeping the newest RUNS_KEEP runs."""
    radar = store.read_json("v1/fields/hfradar.json")
    if not radar:
        raise RuntimeError("no HF radar layer to take the cells from")
    g = radar["grid"]
    cells = np.asarray(radar["cells"])
    points = np.c_[g["lon0"] + (cells % g["nx"]) * g["dlon"], g["lat0"] + (cells // g["nx"]) * g["dlat"]]
    elem = _containing(np.asarray(mesh["nodes"], dtype=float), np.asarray(mesh["triangles"]), points)

    def q(a) -> str:
        vals = np.asarray(a, dtype=float)[:, np.maximum(elem, 0)]
        out = np.clip(np.round(vals / RUN_STEP_CMS), -127, 127)
        out[:, elem < 0] = MISSING
        return _b64(out)

    run = {
        "issued": data["generated_at"],
        "t0": data["t0"],
        "step": data["step"],
        "steps": data["steps"],
        "cells": cells.tolist(),
        "u": q(data["u"]),
        "v": q(data["v"]),
    }
    prev = store.read_json("v1/fields/necofs-at-radar.json") or {"runs": []}
    runs = sorted([r for r in prev["runs"] if r["issued"] != run["issued"]] + [run], key=lambda r: r["issued"])
    store.write_json(
        "v1/fields/necofs-at-radar.json",
        {
            "generated_at": run["issued"],
            "source": data["source"],
            "layer": data["layer"],
            "grid": g,
            "encoding": {"step_cms": RUN_STEP_CMS, "missing": MISSING, "order": "per run: time step, then cell"},
            "runs": runs[-RUNS_KEEP:],
        },
        max_age=3600,
    )
