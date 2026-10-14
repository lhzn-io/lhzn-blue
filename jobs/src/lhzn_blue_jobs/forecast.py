"""HRRR forecasts at the stations, archived with both times: when each forecast was issued and the time it is for.

Every run takes the HRRR cycles of the last few hours that are complete on NOAA's bucket and not yet archived, and
reads them at the 4 buoys and 4 shore stations through forcingkit (`hrrr_points.fetch_points`): leads 1 to 18 h, and
to 48 h on the 00, 06, 12 and 18 UTC cycles. Each cycle is kept twice:

- ``<archive>/YYYY/MM/cycle=YYYYMMDDHH.csv.gz`` (a gs:// prefix, or a local directory): every row, create-only,
  never overwritten or deleted; the long record that verification draws on (Coldline after 30 days).
- ``v1/forecast-hrrr.json`` (KV): the cycles of the last 48 hours, per station and field, for the page.

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
KEEP_HOURS = 48  # cycles kept in the page's file
# How far a station may reach for HRRR water cells: New London sits on the Thames, narrower than HRRR's 3 km
# cells, whose nearest water cells are about 7 km away in the Sound. The buoys find theirs within 3 km.
MAX_KM = 10.0
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
        name = self.name(cycle)
        if self.dir is not None:
            return (self.dir / name).exists()
        return self.bucket.blob(self._path(name)).exists()

    def put(self, cycle: pd.Timestamp, data: bytes) -> None:
        name = self.name(cycle)
        if not NAME.fullmatch(name):
            raise ValueError(f"refusing to write {name}")
        if self.dir is not None:
            path = self.dir / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return
        blob = self.bucket.blob(self._path(name))
        blob.upload_from_string(data, content_type="application/gzip", if_generation_match=0)  # never overwrite


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
    """The last 48 hours of cycles per station: {station: {issue_time: {field: [values by lead]}, ...}}, with the
    leads listed once per cycle."""
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
    cycles = {k: v for k, v in sorted(cycles.items()) if pd.Timestamp(k.replace("Z", "")) >= cutoff}
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
    now = pd.Timestamp(end).tz_localize(None).floor("h")
    todo = [c for c in (now - pd.Timedelta(hours=h) for h in range(lookback_hours, 0, -1)) if not arch.has(c) and complete(c)]
    pts = points()
    frames = []
    for cycle in todo:
        df = fetch_points([cycle], LEADS, pts, FIELDS, max_km=MAX_KM)
        if df.empty:
            log.warning("HRRR %s: no rows", cycle)
            continue
        arch.put(cycle, to_csv_gz(df))
        log.info("HRRR %s: %d rows archived", cycle, len(df))
        frames.append(df)
    if frames:
        store.write_json(KV_KEY, page_file(store.read_json(KV_KEY), pd.concat(frames), end), max_age=600)
    return [f"{c:%Y-%m-%d %HZ}" for c in todo]


def read_cycle(root: str, cycle: pd.Timestamp) -> pd.DataFrame:
    """One archived cycle back as rows (for verification and checks)."""
    arch = Archive(root)
    name = arch.name(cycle)
    data = (arch.dir / name).read_bytes() if arch.dir is not None else arch.bucket.blob(arch._path(name)).download_as_bytes()
    return pd.read_csv(io.BytesIO(gzip.decompress(data)), parse_dates=["issue_time", "valid_time"])


__all__ = ["archive", "read_cycle", "points", "page_file"]
