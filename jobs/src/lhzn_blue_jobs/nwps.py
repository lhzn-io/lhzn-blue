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
            new[key] = pts_run
        # Written after every run (a run takes about 2 minutes on one vCPU), so a job stopped by its timeout keeps
        # what it read and the next run does not fetch it again.
        store.write_json(KV_KEY, page_file(prev, new, archived, end), max_age=1800)
    if prev is None and not new:
        store.write_json(KV_KEY, page_file(prev, new, archived, end), max_age=1800)
    return sorted(new)
