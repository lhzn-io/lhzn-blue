"""HRRR forecasts at the stations, archived with both times: when each forecast was issued and the time it is for.

Every run takes the HRRR cycles of the last few hours that are complete on NOAA's bucket and not yet archived, and
reads them at the 4 buoys and 4 shore stations through forcingkit (`hrrr_points.fetch_points`): leads 1 to 18 h, and
to 48 h on the 00, 06, 12 and 18 UTC cycles. Each cycle is kept twice:

- ``<archive>/YYYY/MM/cycle=YYYYMMDDHH.csv.gz`` (a gs:// prefix, or a local directory): every row, create-only,
  never overwritten or deleted; the long record that verification draws on (Coldline after 30 days).
- ``v1/forecast-hrrr.json`` (KV): the cycles of the last KEEP_HOURS, and the 48 h cycles (00, 06, 12 and 18 UTC)
  of the last LONG_KEEP_DAYS, per station and field, for the page (its forecast vintage slider) and for the daily
  verification (``verify``).

`backfill` fills the archive for past cycles (HRRR is on the bucket from 2014-07-30) at fewer leads, split across
Cloud Run tasks.

Rows are (issue_time, valid_time, lead_h, point, field, value) in HRRR's units (m/s, K, Pa, m). A cycle is taken
only once its longest lead is published, so an archived cycle is complete.
"""

from __future__ import annotations

import gzip
import io
import json
import logging
import os
import re
from datetime import datetime
from pathlib import Path

import pandas as pd

from .build import SCHEMA, Store, iso, load_stations, now_utc

log = logging.getLogger(__name__)

LEADS = list(range(1, 49))  # fetch_points skips the leads a cycle does not carry (18 h except 00/06/12/18 UTC)
FIELDS = ("u10", "v10", "gust", "t2m", "d2m", "mslp", "vis")
LOOKBACK_HOURS = 4  # cycles this recent are tried each run; HRRR posts a cycle's last lead within about 2 hours
KEEP_HOURS = 78  # cycles kept in the page's file: a 48 h lead for a day of valid times, with a few hours spare
LONG_KEEP_DAYS = 7  # the 48 h cycles kept longer, so the page can compare a week of forecasts with what happened
# How far a station may reach for HRRR water cells: New London sits on the Thames, narrower than HRRR's 3 km
# cells, whose nearest water cells are about 7 km away in the Sound. The buoys find theirs within 3 km.
MAX_KM = 10.0
BACKFILL_LEADS = [1, 2, 3, 6, 9, 12, 18, 24, 36, 48]  # past cycles: the leads verification bins on, not every hour
KV_KEY = "v1/forecast-hrrr.json"
NAME = re.compile(r"\d{4}/\d{2}/cycle=\d{10}\.csv\.gz")
SHORE_FILE = Path(
    os.environ.get("LHZN_BLUE_SHORE_STATIONS", Path(__file__).resolve().parents[3] / "stations" / "shore.json")
)


def points() -> dict[str, tuple[float, float]]:
    """The buoys and the shore stations, {id: (lon, lat)}."""
    pts = {st["id"]: (st["lon"], st["lat"]) for st in load_stations()["stations"]}
    for st in json.loads(SHORE_FILE.read_text())["stations"]:
        pts[st["id"]] = (st["lon"], st["lat"])
    return pts


class Archive:
    """Where the cycles go: a local directory, or a gs://bucket/prefix (create-only)."""

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
    def name(cycle: pd.Timestamp) -> str:
        return f"{cycle:%Y/%m}/cycle={cycle:%Y%m%d%H}.csv.gz"

    def _path(self, name: str) -> str:
        return f"{self.prefix}/{name}" if self.prefix else name

    def has(self, cycle: pd.Timestamp) -> bool:
        """Locally, whether the file exists. On GCS the jobs may create objects but not read them, so this is
        False and the caller relies on the page's file and on put() refusing to overwrite."""
        return (self.dir / self.name(cycle)).exists() if self.dir is not None else False

    def put(self, cycle: pd.Timestamp, data: bytes) -> bool:
        """Write the cycle; False if it was already archived (the object exists and is never overwritten)."""
        name = self.name(cycle)
        if not NAME.fullmatch(name):
            raise ValueError(f"refusing to write {name}")
        if self.dir is not None:
            path = self.dir / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return True
        from google.api_core.exceptions import PreconditionFailed

        blob = self.bucket.blob(self._path(name))
        try:
            blob.upload_from_string(data, content_type="application/gzip", if_generation_match=0)  # never overwrite
        except PreconditionFailed:
            return False
        return True


def complete(cycle: pd.Timestamp) -> bool:
    """Whether a cycle's longest lead is on the bucket (HRRR posts leads in order)."""
    from forcingkit.fetchers import hrrr_points as hp

    try:
        return hp.fs.exists(hp.s3_key(cycle, hp.max_lead(cycle)) + ".idx")
    except Exception as exc:  # treat as not yet
        log.warning("HRRR %s: could not check completeness: %s", cycle, exc)
        return False


def to_csv_gz(df: pd.DataFrame) -> bytes:
    out = df.copy()
    for c in ("issue_time", "valid_time"):
        out[c] = pd.to_datetime(out[c]).dt.strftime("%Y-%m-%dT%H:%MZ")
    out["value"] = out["value"].round(3)
    return gzip.compress(out.to_csv(index=False).encode(), mtime=0)


def page_file(prev: dict | None, new: pd.DataFrame, end: datetime) -> dict:
    """The last KEEP_HOURS of cycles, and the 48 h cycles of the last LONG_KEEP_DAYS, per station:
    {station: {issue_time: {field: [values by lead]}, ...}}, with the leads listed once per cycle. The longer record
    builds up from the cycles already in the file (the job cannot read its archive back)."""
    cycles: dict = {} if not prev else dict(prev.get("cycles", {}))
    for issue, g in new.groupby("issue_time"):
        key = pd.Timestamp(issue).strftime("%Y-%m-%dT%HZ")
        leads = sorted(g["lead_h"].unique().tolist())
        entry: dict = {"leads": leads, "points": {}}
        for (point, field), h in g.groupby(["point", "field"]):
            s = h.set_index("lead_h")["value"].reindex(leads)
            entry["points"].setdefault(point, {})[field] = [None if pd.isna(v) else round(float(v), 2) for v in s]
        cycles[key] = entry
    cutoff = pd.Timestamp(end).tz_localize(None) - pd.Timedelta(hours=KEEP_HOURS)
    long_cutoff = pd.Timestamp(end).tz_localize(None) - pd.Timedelta(days=LONG_KEEP_DAYS)
    keep = lambda t: t >= cutoff or (t.hour % 6 == 0 and t >= long_cutoff)  # noqa: E731
    cycles = {k: v for k, v in sorted(cycles.items()) if keep(pd.Timestamp(k.replace("Z", "")))}
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": "NOAA HRRR (noaa-hrrr-bdp-pds), read at the stations through forcingkit",
        "units": {"u10": "m/s", "v10": "m/s", "gust": "m/s", "t2m": "K", "d2m": "K", "mslp": "Pa", "vis": "m"},
        "cycles": cycles,
    }


def archive(store: Store, root: str, lookback_hours: int = LOOKBACK_HOURS) -> list[str]:
    """Archive the recent complete cycles not yet kept; refresh the page's file. Returns the cycles written."""
    from forcingkit.fetchers.hrrr_points import fetch_points

    end = now_utc()
    arch = Archive(root)
    prev = store.read_json(KV_KEY)
    kept = set((prev or {}).get("cycles", {}))  # the last KEEP_HOURS of cycles: what this job has archived
    now = pd.Timestamp(end).tz_localize(None).floor("h")
    recent = [now - pd.Timedelta(hours=h) for h in range(lookback_hours, 0, -1)]
    todo = [c for c in recent if f"{c:%Y-%m-%dT%HZ}" not in kept and not arch.has(c) and complete(c)]
    pts = points()
    frames = []
    for cycle in todo:
        df = fetch_points([cycle], LEADS, pts, FIELDS, max_km=MAX_KM)
        if df.empty:
            log.warning("HRRR %s: no rows", cycle)
            continue
        if arch.put(cycle, to_csv_gz(df)):
            log.info("HRRR %s: %d rows archived", cycle, len(df))
        else:
            log.info("HRRR %s: already archived", cycle)
        frames.append(df)
    if frames:
        store.write_json(KV_KEY, page_file(prev, pd.concat(frames), end), max_age=600)
    return [f"{c:%Y-%m-%d %HZ}" for c in todo]


def backfill(root: str, start: str, end: str, task: int = 0, tasks: int = 1, workers: int = 4) -> dict[str, int]:
    """Archive past cycles, start to end hourly (UTC, inclusive), at BACKFILL_LEADS: this task takes every
    `tasks`-th cycle from `task` (Cloud Run's task index and count). Create-only, so a cycle already in the archive
    is read again but never overwritten; one that fails is logged and left for a rerun. The page's file is not
    touched."""
    import concurrent.futures

    from forcingkit.fetchers.hrrr_points import fetch_points

    arch = Archive(root)
    pts = points()
    cycles = list(pd.date_range(start, end, freq="h"))[task::tasks]
    counts = {"cycles": len(cycles), "archived": 0, "already": 0, "empty": 0, "failed": 0}

    def one(cycle: pd.Timestamp) -> str:
        if arch.has(cycle):
            return "already"
        df = fetch_points([cycle], BACKFILL_LEADS, pts, FIELDS, max_km=MAX_KM, max_workers=2)
        if df.empty:
            return "empty"
        return "archived" if arch.put(cycle, to_csv_gz(df)) else "already"

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(one, c): c for c in cycles}
        for f in concurrent.futures.as_completed(futures):
            try:
                counts[f.result()] += 1
            except Exception as exc:
                counts["failed"] += 1
                log.warning("HRRR %s: failed: %s", futures[f], exc)
    log.info("backfill task %d of %d: %s", task + 1, tasks, counts)
    return counts


def read_cycle(root: str, cycle: pd.Timestamp) -> pd.DataFrame:
    """One archived cycle back as rows (for verification and checks)."""
    arch = Archive(root)
    name = arch.name(cycle)
    data = (arch.dir / name).read_bytes() if arch.dir is not None else arch.bucket.blob(arch._path(name)).download_as_bytes()
    return pd.read_csv(io.BytesIO(gzip.decompress(data)), parse_dates=["issue_time", "valid_time"])


__all__ = ["archive", "read_cycle", "points", "page_file"]
