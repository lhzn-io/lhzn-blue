"""GFS 10 m wind at the stations, for the hours past HRRR's 48: archived with both times, and kept for the page.

NOAA's GFS runs four times a day (00, 06, 12 and 18 UTC) on a 0.25 degree global grid (about 28 by 20 km here), out to
16 days. Each cycle is on NOAA's public bucket ``noaa-gfs-bdp-pds`` (from 2021), one GRIB2 file per lead with an
index, so only the messages needed are read: 10 m east and north wind and the surface gust, at leads every 3 h to
LAST_LEAD. Each run takes the newest complete cycles (their last lead posted) not yet kept and reads them at the same
stations as HRRR (`forecast.points`): an inverse-distance-squared mean of the nearest water cells (by GFS's land
mask), so a station's value is over water, as at the buoys.

Each cycle is kept twice, as HRRR's are (`forecast`):

- ``<archive>/gfs/YYYY/MM/cycle=YYYYMMDDHH.csv.gz``: every row, create-only, never overwritten.
- ``v1/forecast-gfs.json`` (KV): every lead of the last KEEP_FULL_HOURS of cycles, for the page, and the verification
  leads of the cycles of the last KEEP_DAYS, for the daily verification (`verify`), which reads only this file.

`backfill` archives past cycles at the verification leads only, split across Cloud Run tasks.

Rows are (issue_time, valid_time, lead_h, point, field, value) in GFS's units (m/s).
"""

from __future__ import annotations

import concurrent.futures
import logging
import os
import tempfile
from datetime import datetime

import numpy as np
import pandas as pd

from . import forecast
from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

BUCKET = "noaa-gfs-bdp-pds"
CYCLE_HOURS = 6
LAST_LEAD = 168  # 7 days: the page's longest view
LEADS = list(range(3, LAST_LEAD + 1, 3))
VERIFY_LEADS = [6, 12, 24, 36, 48, 60, 72, 96, 120, 144, 168]
MESSAGES = {"u10": ":UGRD:10 m above ground:", "v10": ":VGRD:10 m above ground:", "gust": ":GUST:surface:"}
WIND = {k: MESSAGES[k] for k in ("u10", "v10")}  # the backfill's: verification scores the wind, not the gust
LAND = ":LAND:surface:"  # in each cycle's analysis file (f000): 1 land, 0 water
LOOKBACK_CYCLES = 4  # a day of cycles is tried each run; GFS posts a cycle's last lead within about 5 hours
KEEP_FULL_HOURS = 30  # cycles whose every lead stays in the page's file (the newest, and the one before it, always)
KEEP_DAYS = 8  # cycles kept at the verification leads: their 168 h leads have all passed, with a day spare
NEAREST = 4  # water cells averaged per station
MAX_KM = 40.0  # GFS cells are about 28 by 20 km here; New London's nearest water cell is in the Sound
KV_KEY = "v1/forecast-gfs.json"


def key(cycle: pd.Timestamp, lead: int) -> str:
    return f"{BUCKET}/gfs.{cycle:%Y%m%d}/{cycle:%H}/atmos/gfs.t{cycle:%H}z.pgrb2.0p25.f{lead:03d}"


def complete(cycle: pd.Timestamp) -> bool:
    """Whether a cycle's last lead is on the bucket (GFS posts leads in order)."""
    from forcingkit.fetchers.hrrr import fs

    try:
        return fs.exists(key(cycle, LAST_LEAD) + ".idx")
    except Exception as exc:  # treat as not yet
        log.warning("GFS %s: could not check completeness: %s", cycle, exc)
        return False


def read_messages(cycle: pd.Timestamp, lead: int, patterns: dict[str, str], coords: bool = False) -> dict[str, np.ndarray]:
    """The named messages of one lead's file, each as a 2D array on GFS's grid (latitude, longitude), and with
    coords the grid's "lat" and "lon" (1D, as in the file). Raises FileNotFoundError when the file, or one of the
    messages, is not posted."""
    from forcingkit.fetchers.hrrr import _fetch_s3_byte_ranges, _parse_idx, fs
    from forcingkit.fetchers.hrrr_atmosphere import _read_message

    k = key(cycle, lead)
    with fs.open(k + ".idx", "r") as f:
        idx = f.read()
    out = {}
    with tempfile.TemporaryDirectory() as d:
        for name, pattern in patterns.items():
            ranges = _parse_idx(idx, (pattern,))
            if len(ranges) != 1:
                raise FileNotFoundError(f"GFS s3://{k}: {len(ranges)} messages for {pattern}")
            path = os.path.join(d, f"{name}.grib2")
            _fetch_s3_byte_ranges(k, ranges, path)
            da = _read_message(path)
            out[name] = np.asarray(da.values, dtype=np.float64)
            if coords and "lat" not in out:
                out["lat"] = np.asarray(da["latitude"].values, dtype=np.float64)
                out["lon"] = np.asarray(da["longitude"].values, dtype=np.float64)
    return out


def weights(land: np.ndarray, lat: np.ndarray, lon: np.ndarray, pts: dict[str, tuple[float, float]], k: int = NEAREST, max_km: float = MAX_KM) -> dict:
    """Per station, the flat indices of its nearest water cells (up to k within max_km) and their inverse-distance-
    squared weights, summing to 1, on a grid of 1D lat and lon (degrees east, any range). A station with no water cell
    in reach is left out."""
    glon, glat = np.meshgrid(lon, lat)
    water = np.flatnonzero(np.asarray(land).ravel() < 0.5)
    wlon, wlat = glon.ravel()[water], glat.ravel()[water]
    out = {}
    for pid, (plon, plat) in pts.items():
        dx = (((wlon - plon % 360.0) + 180.0) % 360.0 - 180.0) * 111.32 * np.cos(np.radians(plat))
        dy = (wlat - plat) * 110.95
        km = np.hypot(dx, dy)
        near = np.argsort(km)[:k]
        near = near[km[near] <= max_km]
        if near.size == 0:
            log.warning("GFS: no water cell within %g km of %s", max_km, pid)
            continue
        w = 1.0 / np.maximum(km[near], 0.5) ** 2
        out[pid] = (water[near], w / w.sum())
    return out


def fetch_cycle(cycle: pd.Timestamp, leads: list[int], pts: dict[str, tuple[float, float]], workers: int = 6, messages: dict[str, str] = MESSAGES) -> pd.DataFrame:
    """One cycle's rows at the stations; leads not posted are left out (a backfill's old cycle may lack one)."""
    a = read_messages(cycle, 0, {"land": LAND}, coords=True)
    wts = weights(a["land"], a["lat"], a["lon"], pts)

    def one(lead: int) -> list[tuple]:
        try:
            msgs = read_messages(cycle, lead, messages)
        except FileNotFoundError as exc:
            log.warning("GFS %s f%03d: %s", cycle, lead, exc)
            return []
        valid = cycle + pd.Timedelta(hours=lead)
        rows = []
        for pid, (cells, w) in wts.items():
            for field, a in msgs.items():
                v = a.ravel()[cells]
                ok = np.isfinite(v)
                if ok.any():
                    rows.append((cycle, valid, lead, pid, field, float((v[ok] * w[ok]).sum() / w[ok].sum())))
        return rows

    rows: list[tuple] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(one, leads):
            rows.extend(r)
    return pd.DataFrame(rows, columns=["issue_time", "valid_time", "lead_h", "point", "field", "value"])


def page_file(prev: dict | None, new: pd.DataFrame, end: datetime) -> dict:
    """The cycles of the last KEEP_FULL_HOURS at every lead, and those of the last KEEP_DAYS at VERIFY_LEADS, in the
    shape of HRRR's file: {cycles: {"YYYY-MM-DDTHHZ": {leads, points: {station: {field: [values by lead]}}}}}. The
    longer record builds up from the cycles already in the file (the job cannot read its archive back)."""
    cycles: dict = {} if not prev else dict(prev.get("cycles", {}))
    for issue, g in new.groupby("issue_time"):
        leads = sorted(int(x) for x in g["lead_h"].unique())
        entry: dict = {"leads": leads, "points": {}}
        for (point, field), h in g.groupby(["point", "field"]):
            s = h.set_index("lead_h")["value"].reindex(leads)
            entry["points"].setdefault(point, {})[field] = [None if pd.isna(v) else round(float(v), 2) for v in s]
        cycles[pd.Timestamp(issue).strftime("%Y-%m-%dT%HZ")] = entry
    now = pd.Timestamp(end).tz_convert("UTC").tz_localize(None) if pd.Timestamp(end).tzinfo else pd.Timestamp(end)
    full, short = now - pd.Timedelta(hours=KEEP_FULL_HOURS), now - pd.Timedelta(days=KEEP_DAYS)
    newest = sorted(cycles)[-2:]  # the newest two keep every lead whatever their age (GFS late, or the job down)
    out = {}
    for k, c in sorted(cycles.items()):
        t = pd.Timestamp(k.replace("Z", ""))
        if t < short:
            continue
        if t < full and k not in newest:
            keep = [i for i, lead in enumerate(c["leads"]) if lead in VERIFY_LEADS]
            c = {"leads": [c["leads"][i] for i in keep],
                 "points": {p: {f: [vals[i] for i in keep] for f, vals in fs.items()} for p, fs in c["points"].items()}}
        out[k] = c
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": "NOAA GFS 0.25 degree (noaa-gfs-bdp-pds), read at the stations from its nearest water cells",
        "units": {"u10": "m/s", "v10": "m/s", "gust": "m/s"},
        "cycles": out,
    }


def archive(store: Store, root: str, lookback: int = LOOKBACK_CYCLES) -> list[str]:
    """Archive the recent complete cycles not yet kept; refresh the page's file. Returns the cycles written."""
    end = now_utc()
    arch = forecast.Archive(_gfs_root(root))
    prev = store.read_json(KV_KEY)
    kept = set((prev or {}).get("cycles", {}))
    now = pd.Timestamp(end).tz_localize(None).floor(f"{CYCLE_HOURS}h")
    recent = [now - pd.Timedelta(hours=CYCLE_HOURS * i) for i in range(lookback, -1, -1)]
    todo = [c for c in recent if f"{c:%Y-%m-%dT%HZ}" not in kept and not arch.has(c) and complete(c)]
    pts = forecast.points()
    frames = []
    for cycle in todo:
        df = fetch_cycle(cycle, LEADS, pts)
        if df.empty:
            log.warning("GFS %s: no rows", cycle)
            continue
        log.info("GFS %s: %d rows, %s", cycle, len(df), "archived" if arch.put(cycle, forecast.to_csv_gz(df)) else "already archived")
        frames.append(df)
    if frames:
        store.write_json(KV_KEY, page_file(prev, pd.concat(frames), end), max_age=1800)
    return [f"{c:%Y-%m-%d %HZ}" for c in todo]


def backfill(root: str, start: str, end: str, task: int = 0, tasks: int = 1, hours: tuple[int, ...] = (0, 12), workers: int = 3) -> dict[str, int]:
    """Archive past cycles from start to end (UTC, inclusive) at VERIFY_LEADS, wind only: the cycles at the given hours, this task
    taking every `tasks`-th from `task` (Cloud Run's task index and count). Create-only; one that fails is logged and
    left for a rerun. The page's file is not touched."""
    arch = forecast.Archive(_gfs_root(root))
    pts = forecast.points()
    cycles = [c for c in pd.date_range(start, end, freq=f"{CYCLE_HOURS}h") if c.hour in hours][task::tasks]
    counts = {"cycles": len(cycles), "archived": 0, "already": 0, "empty": 0, "failed": 0}
    for cycle in cycles:
        try:
            if arch.has(cycle):
                counts["already"] += 1
                continue
            df = fetch_cycle(cycle, VERIFY_LEADS, pts, workers=workers, messages=WIND)
            counts["empty" if df.empty else "archived" if arch.put(cycle, forecast.to_csv_gz(df)) else "already"] += 1
        except Exception as exc:
            counts["failed"] += 1
            log.warning("GFS %s: failed: %s", cycle, exc)
    log.info("GFS backfill task %d of %d: %s", task + 1, tasks, counts)
    return counts


def _gfs_root(root: str) -> str:
    """GFS's cycles beside HRRR's in the forecast archive, under gfs/."""
    return f"{root.rstrip('/')}/gfs"


__all__ = ["archive", "backfill", "fetch_cycle", "page_file", "weights"]
