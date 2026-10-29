"""NWS Nearshore Wave Prediction System (NWPS) runs for the Sound: archived whole, read at the buoys for the page.

NWPS is SWAN run by each NWS forecast office on its own grid, forced by the office's forecast winds. WFO New York
(OKX) runs it at 00 and 12 UTC; its main grid (CG1, about 1.8 km, 39.75 to 41.40 N, 74.45 to 71.05 W) covers the
whole Sound. Each run is one GRIB2 file on NOMADS (about 26 MB): the analysis and hourly steps to 144 h of
significant wave height, swell height, primary wave period and direction, wind, and surface current. NOMADS keeps
about five days and we found no public archive, so every run is kept here:

- ``<archive>/YYYY/MM/okx_nwps_CG1_YYYYMMDD_HH00.grib2`` (a gs:// prefix, or a local directory): the file as
  published, create-only, never overwritten or deleted (Coldline after 30 days).
- ``v1/waves-nwps.json`` (KV): the runs of the last KEEP_HOURS read at the buoys, from the nearest water cell, for
  the page. The page shows, for each hour, the newest run that covers it, labelled as a model; it never stands in
  for the buoys' own wave sensors.

A run is taken only once its file decodes with every step, so an archived run is complete.
"""

from __future__ import annotations

import logging
import math
import re
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import requests

from . import wat
from .build import SCHEMA, Store, iso, load_stations, now_utc

log = logging.getLogger(__name__)

BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod"
WFO = "okx"
GRID = "CG1"
CYCLES = (0, 12)
DAYS_BACK = 5  # NOMADS keeps about five days
STEPS = 145  # the analysis and 144 hourly steps
KEEP_HOURS = 96  # runs kept in the page's file: past hours from the newest run covering them, with spare
MAX_KM = 4.0  # the nearest water cell must be this close to the buoy
KV_KEY = "v1/waves-nwps.json"
FIELD_KEY = "v1/fields/nwps-waves.json"
FIELD_BOX = (-74.40, 40.30, -71.40, 41.70)  # the HRRR layer's box (NWPS CG1 ends at 41.40 N)
FIELD_BACK, FIELD_AHEAD = 24, 72  # hours of frames kept around now
FIELD_STEP = 0.05  # m per int8 unit (to 6.35 m)
FIELD_TP_STEP = 0.125  # s per int8 unit (to 15.9 s), for the peak period
FIELD_MESH_VERSION = 1
UA = {"User-Agent": "longhorizon.blue ingest (https://longhorizon.blue; dfry@lhzn.io)"}
# GRIB short name -> (published name, decimals)
FIELDS = {"swh": ("hs", 2), "shts": ("swell", 2), "perpw": ("tp", 1), "dirpw": ("dir", 0), "ws": ("wind", 1), "wdir": ("wind_dir", 0)}
NAME = re.compile(r"\d{4}/\d{2}/okx_nwps_CG1_\d{8}_\d{2}00\.grib2")


def file_name(run: datetime) -> str:
    return f"okx_nwps_CG1_{run:%Y%m%d_%H}00.grib2"


def url(run: datetime) -> str:
    return f"{BASE}/er.{run:%Y%m%d}/{WFO}/{run:%H}/{GRID}/{file_name(run)}"


class Archive:
    """Where the runs go: a local directory, or a gs://bucket/prefix (create-only)."""

    def __init__(self, root: str):
        if root.startswith("gs://"):
            from google.cloud import storage

            bucket, _, prefix = root[5:].partition("/")
            self.bucket = storage.Client().bucket(bucket)
            self.prefix = prefix.strip("/")
            self.dir = None
        else:
            self.dir = Path(root)

    @staticmethod
    def name(run: datetime) -> str:
        return f"{run:%Y/%m}/{file_name(run)}"

    def put(self, run: datetime, data: bytes) -> bool:
        """Write the run; False if it was already archived (the object exists and is never overwritten)."""
        name = self.name(run)
        if not NAME.fullmatch(name):
            raise ValueError(f"refusing to write {name}")
        if self.dir is not None:
            path = self.dir / name
            if path.exists():
                return False
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return True
        from google.api_core.exceptions import PreconditionFailed

        blob = self.bucket.blob(f"{self.prefix}/{name}" if self.prefix else name)
        try:
            blob.upload_from_string(data, content_type="application/octet-stream", if_generation_match=0)
        except PreconditionFailed:
            return False
        return True


def buoys() -> dict[str, tuple[float, float]]:
    """The buoys, {id: (lon, lat)}."""
    return {st["id"]: (st["lon"], st["lat"]) for st in load_stations()["stations"]}


def recent_runs(end: datetime) -> list[datetime]:
    """The runs NOMADS may still hold, oldest first, ending with the newest that could be posted (about 7 h
    after its cycle time)."""
    day0 = end.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)
    runs = [day0 - timedelta(days=d) + timedelta(hours=h) for d in range(DAYS_BACK, -1, -1) for h in CYCLES]
    latest = end.replace(tzinfo=None) - timedelta(hours=4)
    return [r for r in runs if r <= latest]


def fetch(run: datetime) -> bytes | None:
    """The run's file, or None if it is not (or no longer) on NOMADS."""
    r = requests.get(url(run), headers=UA, timeout=180)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.content


def read_points(data: bytes, pts: dict[str, tuple[float, float]]) -> dict:
    """Decode a run and read it at each point's nearest water cell: {steps, points: {id: {field: [...]}}, cells}.
    Raises if the file lacks steps (still being written)."""
    import cfgrib

    with tempfile.NamedTemporaryFile(suffix=".grib2") as f:
        f.write(data)
        f.flush()
        dss = cfgrib.open_datasets(f.name, backend_kwargs={"indexpath": ""})
        fc = next(d for d in dss if "step" in d.dims)
        an = next((d for d in dss if "step" not in d.dims), None)
        steps = [0] + [int(s / np.timedelta64(1, "h")) for s in fc.step.values]
        if len(steps) < STEPS:
            raise ValueError(f"{len(steps)} steps of {STEPS}")
        lat = fc.latitude.values
        lon = ((fc.longitude.values + 180) % 360) - 180
        wet = np.isfinite(fc["swh"].isel(step=0).values)
        out: dict = {"steps": steps, "points": {}, "cells": {}}
        # The grid over the map's box, for the layer: height and the direction the waves come from, every step.
        rows = np.where((lat >= FIELD_BOX[1]) & (lat <= FIELD_BOX[3]))[0]
        cols = np.where((lon >= FIELD_BOX[0]) & (lon <= FIELD_BOX[2]))[0]
        stack = lambda name: np.concatenate(  # noqa: E731
            [(an[name].values[None] if an is not None and name in an else np.full((1, lat.size, lon.size), np.nan)), fc[name].values]
        )[:, rows][:, :, cols].astype(np.float32)
        out["grid"] = {"lat": lat[rows], "lon": lon[cols], "hs": stack("swh"), "dir": stack("dirpw"), "tp": stack("perpw")}
        for pid, (x, y) in pts.items():
            dy = (lat[:, None] - y) * 111.2
            dx = (lon[None, :] - x) * 111.2 * math.cos(math.radians(y))
            dist = np.where(wet, np.hypot(dx, dy), np.inf)
            i, j = np.unravel_index(np.argmin(dist), dist.shape)
            if dist[i, j] > MAX_KM:
                log.warning("NWPS: no water cell within %.0f km of %s", MAX_KM, pid)
                continue
            out["cells"][pid] = {"lat": round(float(lat[i]), 4), "lon": round(float(lon[j]), 4), "km": round(float(dist[i, j]), 1)}
            series: dict = {}
            for short, (key, dec) in FIELDS.items():
                if short not in fc:
                    continue
                first = [float(an[short].values[i, j])] if an is not None and short in an else [math.nan]
                vals = first + fc[short].values[:, i, j].astype(float).tolist()
                series[key] = [None if not math.isfinite(v) else round(v, dec) if dec else int(round(v)) for v in vals]
            out["points"][pid] = series
        return out


def page_file(prev: dict | None, new: dict[str, dict], archived: list[str], end: datetime) -> dict:
    """The runs of the last KEEP_HOURS: {runs: {issue: {steps, points}}, cells}, and the runs NOMADS still holds
    that are already archived (so they are not fetched again)."""
    runs = {} if not prev else dict(prev.get("runs", {}))
    cells = {} if not prev else dict(prev.get("cells", {}))
    for key, r in new.items():
        runs[key] = {"steps": r["steps"], "points": r["points"]}
        cells.update(r["cells"])
    cutoff = end.replace(tzinfo=None) - timedelta(hours=KEEP_HOURS)
    runs = {k: v for k, v in sorted(runs.items()) if datetime.strptime(k, "%Y-%m-%dT%HZ") >= cutoff}
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": "NWS Nearshore Wave Prediction System (SWAN), WFO New York grid CG1, forced by NWS forecast winds; "
        "read at the nearest water cell to each buoy",
        "units": {"hs": "m", "swell": "m", "tp": "s", "dir": "deg true, from", "wind": "m/s", "wind_dir": "deg true, from"},
        "cells": cells,
        "archived": sorted(set(archived))[-2 * len(CYCLES) * (DAYS_BACK + 1):],
        "runs": runs,
    }


def field_file(prev: dict | None, runs: dict[str, dict], end: datetime) -> dict | None:
    """The map layer: frames from 24 h back to 72 h ahead, each from the newest run covering its hour; the previous
    file's frames are kept where no newer run covers them. ``runs``: {issue key: read_points output with "grid"}."""
    import base64

    from .fields import arrow_levels
    from .hrrr_grid import corners

    if prev and (prev.get("encoding", {}).get("step") != FIELD_STEP or prev.get("mesh", {}).get("version") != FIELD_MESH_VERSION):
        prev = None
    now = end.replace(tzinfo=None, minute=0, second=0, microsecond=0)
    lo, hi = now - timedelta(hours=FIELD_BACK), now + timedelta(hours=FIELD_AHEAD)
    frames: dict[str, dict] = {f["valid_time"]: f for f in (prev or {}).get("frames", [])}
    mesh = (prev or {}).get("mesh")
    enc = lambda a: base64.b64encode(np.clip(np.round(np.nan_to_num(a) / FIELD_STEP), -127, 127).astype(np.int8).ravel().tobytes()).decode()  # noqa: E731
    enc_tp = lambda a: base64.b64encode(np.clip(np.round(np.nan_to_num(a) / FIELD_TP_STEP), 0, 127).astype(np.int8).ravel().tobytes()).decode()  # noqa: E731
    for key in sorted(runs, reverse=True):  # newest first: an older run fills only hours no newer one covers
        g = runs[key].get("grid")
        if not g:
            continue
        issue = datetime.strptime(key, "%Y-%m-%dT%HZ")
        lon2, lat2 = np.meshgrid(g["lon"].astype(np.float64), g["lat"].astype(np.float64))
        if mesh is None:
            r4 = lambda a: np.round(a, 4).ravel().tolist()  # noqa: E731
            mesh = {
                "nx": int(lon2.shape[1]), "ny": int(lon2.shape[0]),
                "corner_lon": r4(corners(lon2)), "corner_lat": r4(corners(lat2)),
                "centre_lon": r4(lon2), "centre_lat": r4(lat2),
                "land": (~np.isfinite(g["hs"]).any(axis=0)).astype(int).ravel().tolist(),
                "arrow_level": arrow_levels(lon2.ravel() / 2, lat2.ravel() / 2).astype(int).tolist(),
                "version": FIELD_MESH_VERSION,
            }
        for k, lead in enumerate(runs[key]["steps"]):
            valid = issue + timedelta(hours=lead)
            if not lo <= valid <= hi:
                continue
            vkey = f"{valid:%Y-%m-%dT%H:%MZ}"
            have = frames.get(vkey)
            if have and have["cycle"] >= key:
                continue
            hs, frm = g["hs"][k].astype(np.float64), g["dir"][k].astype(np.float64)
            to = np.deg2rad((frm + 180.0) % 360.0)  # where the waves travel
            frames[vkey] = {"valid_time": vkey, "cycle": key, "lead": int(lead), "u": enc(hs * np.sin(to)), "v": enc(hs * np.cos(to)),
                            "tp": enc_tp(g["tp"][k].astype(np.float64))}
    if mesh is None:
        return None
    kept = sorted((f for f in frames.values() if lo <= datetime.strptime(f["valid_time"], "%Y-%m-%dT%H:%MZ") <= hi), key=lambda f: f["valid_time"])
    return {
        "schema": SCHEMA,
        "kind": "waves",
        "label": "model forecast",
        "source": "NWS Nearshore Wave Prediction System (SWAN), WFO New York grid CG1, on the model's own 1.8 km cells",
        "attribution": "NWS NWPS (NOAA NOMADS)",
        "field": "significant wave height along the direction the waves travel (east and north components); "
        "tp: peak wave period, where present (older frames lack it)",
        "units": "m",
        "tp_units": "s",
        "generated_at": iso(end),
        "box": list(FIELD_BOX),
        "encoding": {"type": "int8 base64", "step": FIELD_STEP, "clip": round(127 * FIELD_STEP, 2),
                     "tp_step": FIELD_TP_STEP, "tp_clip": 127 * FIELD_TP_STEP},
        "mesh": mesh,
        "frames": kept,
    }


def publish(store: Store, root: str | None) -> list[str]:
    """Archive the runs on NOMADS not yet kept (when root is given) and refresh the page's file. Returns the runs
    read this time."""
    end = now_utc()
    prev = store.read_json(KV_KEY)
    kept = set((prev or {}).get("runs", {})) | set((prev or {}).get("archived", []))
    archived = sorted(kept)
    arch = Archive(root) if root else None
    cutoff = end.replace(tzinfo=None) - timedelta(hours=KEEP_HOURS)
    new: dict[str, dict] = {}
    grids: dict[str, dict] = {}
    pts = buoys()
    for run in recent_runs(end):
        key = f"{run:%Y-%m-%dT%HZ}"
        if key in kept:  # read and archived on an earlier run
            continue
        data = fetch(run)
        if data is None:
            continue
        try:
            pts_run = read_points(data, pts)
        except Exception as exc:  # still being written, or damaged: try again next run
            log.warning("NWPS %s: not taken (%s)", key, exc)
            continue
        if arch is not None:
            log.info("NWPS %s: %s", key, "archived" if arch.put(run, data) else "already archived")
        archived.append(key)
        if run >= cutoff:
            grids[key] = pts_run
            new[key] = {k: v for k, v in pts_run.items() if k != "grid"}
        # Written after every run (a run takes about 2 minutes on one vCPU), so a job stopped by its timeout keeps
        # what it read and the next run does not fetch it again.
        store.write_json(KV_KEY, page_file(prev, new, archived, end), max_age=1800)
    if prev is None and not new:
        store.write_json(KV_KEY, page_file(prev, new, archived, end), max_age=1800)
    # The map layers. The newest run is read again for its grid when a layer is missing, or when the currents have a
    # newer run than the wind-against-tide layer was built from (once a day).
    prev_field = store.read_json(FIELD_KEY)
    prev_wat = store.read_json(wat.KEY)
    currents, mesh = store.read_json("v1/fields/currents.json"), store.read_json("v1/fields/currents-mesh.json")
    built_from = max((f.get("currents_run", "") for f in (prev_wat or {}).get("frames", [])), default="")
    stale = currents is not None and mesh is not None and built_from < currents["generated_at"]
    if (prev_field is None or stale) and not grids:
        for key in sorted((prev or {}).get("runs", {}), reverse=True)[:1]:
            data = fetch(datetime.strptime(key, "%Y-%m-%dT%HZ"))
            if data is not None:
                grids[key] = read_points(data, pts)
    if grids:
        field = field_file(prev_field, grids, end)
        if field is not None:
            store.write_json(FIELD_KEY, field, max_age=1800)
        if currents is not None and mesh is not None:
            layer = wat.build(prev_wat, grids, currents, mesh, end)
            if layer is not None:
                store.write_json(wat.KEY, layer, max_age=1800)
    return sorted(new)
