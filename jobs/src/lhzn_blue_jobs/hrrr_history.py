"""HRRR's last forecast before each hour at the stations: for every valid hour, the value from the most recent cycle
issued before it (lead 1 h, or 2 or 3 h where that cycle is missing). With the buoys' own records interrupted, this
is the model's closest stand-in for what happened, labelled as a model on the page.

Published per station as ``v1/hrrr-history/<ID>.json``: one hourly frame (``encode_frame``) from 2024-01-01 with
``wind_kt``, ``gust_kt``, ``dir_deg`` (from), ``air_f``, ``pressure_mb`` and ``lead_h`` (the lead used each hour).
``v1/hrrr-history/<ID>-recent.json`` holds the last RECENT_DAYS in the same format, for the page's inline plots.

- ``seed``: once, from the archive of every cycle (``forecast.Archive``), read where the archive can be read (the
  jobs may only create objects in it, so this runs with a person's credentials).
- ``update``: each forecast run, from the forecast job's page file (every cycle of the last KEEP_HOURS), overwriting
  the recent hours; the page file holds every lead, so its shortest-lead choice is the final one. To keep within the
  KV store's daily writes, a station's recent file is rewritten once it is RECENT_EVERY old and its full file once it
  is FULL_EVERY old (the page reads the full file only for plots reaching past RECENT_DAYS); each run builds on both,
  so the full file's lag never loses an hour while the page file still holds it.
"""

from __future__ import annotations

import gzip
import io
import logging
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd

from .build import Store, decode_frame, encode_frame, iso, now_utc

log = logging.getLogger(__name__)

STATIONS = ("WLIS", "EXRX", "ARTG", "CLIS", "KPTN", "BRPT", "NWHV", "NLON", "KBDR", "KHVN")
START = pd.Timestamp("2024-01-01", tz="UTC")
MAX_LEAD = 3  # hours: a valid hour without a cycle in the 3 h before it is left empty
MS_KT = 1.943844
DECIMALS = {"wind_kt": 1, "gust_kt": 1, "dir_deg": 0, "air_f": 1, "pressure_mb": 1, "lead_h": 0}
FIELDS = ("u10", "v10", "gust", "t2m", "mslp")
RECENT_DAYS = 100  # the page's inline plots reach 96 days back
RECENT_EVERY = pd.Timedelta(hours=3)  # the page leaves the last 3 hours to the forecast, so this lags nothing it draws
FULL_EVERY = pd.Timedelta(hours=24)
SLACK = pd.Timedelta(minutes=20)  # the hourly job's start drifts; a file a little short of its age is due


def key(station: str, recent: bool = False) -> str:
    return f"v1/hrrr-history/{station}{'-recent' if recent else ''}.json"


def frames(wide: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Per station, the shortest-lead row for each valid hour, converted to the page's columns. ``wide``: one row per
    (issue_time, valid_time, lead_h, point) with a column per HRRR field."""
    df = wide[(wide["lead_h"] >= 1) & (wide["lead_h"] <= MAX_LEAD)].dropna(subset=["u10", "v10"])
    df = df.sort_values("lead_h").drop_duplicates(["point", "valid_time"], keep="first")
    out: dict[str, pd.DataFrame] = {}
    for point, g in df.groupby("point"):
        g = g.set_index(pd.DatetimeIndex(pd.to_datetime(g["valid_time"], utc=True))).sort_index()
        u, v = g["u10"].astype(float), g["v10"].astype(float)
        out[str(point)] = pd.DataFrame(
            {
                "wind_kt": np.hypot(u, v) * MS_KT,
                "gust_kt": g["gust"].astype(float) * MS_KT if "gust" in g else np.nan,
                "dir_deg": (np.degrees(np.arctan2(-u, -v)) + 360) % 360,
                "air_f": (g["t2m"].astype(float) - 273.15) * 9 / 5 + 32 if "t2m" in g else np.nan,
                "pressure_mb": g["mslp"].astype(float) / 100 if "mslp" in g else np.nan,
                "lead_h": g["lead_h"].astype(float),
            },
            index=g.index,
        )
    return out


def _wide_from_rows(rows: pd.DataFrame) -> pd.DataFrame:
    """The archive's long rows (issue_time, valid_time, lead_h, point, field, value) as one row per forecast."""
    rows = rows[rows["field"].isin(FIELDS)]
    wide = rows.pivot_table(index=["issue_time", "valid_time", "lead_h", "point"], columns="field", values="value", aggfunc="first").reset_index()
    wide["valid_time"] = pd.to_datetime(wide["valid_time"], utc=True)
    wide["lead_h"] = wide["lead_h"].astype(int)
    return wide


def _due(obj: dict | None, every: pd.Timedelta, end) -> bool:
    """Whether a file written at its generated_at is old enough to write again (or was never written)."""
    t = (obj or {}).get("generated_at")
    return t is None or pd.Timestamp(t) <= pd.Timestamp(end) - every + SLACK


def _write(store: Store, per_station: dict[str, pd.DataFrame], end, full: set[str] | None = None, recent: set[str] | None = None) -> list[str]:
    """Write each station's full and recent files (by default both; else those named in full and recent)."""
    done = []
    for sid in STATIONS:
        frame = per_station.get(sid)
        if frame is None or frame.empty:
            continue
        frame = frame[frame.index >= START]
        meta = {"station": sid, "source": "NOAA HRRR, read at the station through forcingkit; each hour from the most recent cycle before it (lead 1 to 3 h)", "generated_at": iso(end)}
        if full is None or sid in full:
            obj = encode_frame(frame, DECIMALS)
            obj.update(meta)
            store.write_json(key(sid), obj, max_age=3600)
        if recent is None or sid in recent:
            obj = encode_frame(frame[frame.index >= end - pd.Timedelta(days=RECENT_DAYS)], DECIMALS)
            obj.update(meta)
            store.write_json(key(sid, recent=True), obj, max_age=3600)
        done.append(sid)
    return done


def seed(store: Store, root: str, workers: int = 16) -> list[str]:
    """Build every station's history from the archive (a gs:// prefix or a local directory of cycle files)."""
    end = now_utc()
    names: list[str] = []
    if root.startswith("gs://"):
        from google.cloud import storage

        bucket_name, _, prefix = root[5:].partition("/")
        bucket = storage.Client().bucket(bucket_name)
        top = prefix.strip("/") + "/"
        # HRRR's cycles only: GFS's are archived beside them under gfs/ (gfs.py).
        blobs = [b for b in bucket.list_blobs(prefix=top) if b.name.endswith(".csv.gz") and not b.name[len(top):].startswith("gfs/")]
        read = lambda b: b.download_as_bytes()  # noqa: E731
        items = blobs
    else:
        from pathlib import Path

        items = [f for f in sorted(Path(root).rglob("cycle=*.csv.gz")) if f.relative_to(root).parts[0] != "gfs"]
        read = lambda p: p.read_bytes()  # noqa: E731
    log.info("HRRR history seed: %d cycle files", len(items))

    def load(item) -> pd.DataFrame:
        df = pd.read_csv(io.BytesIO(gzip.decompress(read(item))))
        return df[df["lead_h"] <= MAX_LEAD]

    with ThreadPoolExecutor(workers) as pool:
        parts = list(pool.map(load, items))
    rows = pd.concat(parts, ignore_index=True)
    names = _write(store, frames(_wide_from_rows(rows)), end)
    log.info("HRRR history seed: wrote %s", names)
    return names


def update(store: Store) -> list[str]:
    """Overwrite each station's recent hours from the forecast job's page file (all cycles of the last KEEP_HOURS), in
    the files that are due (RECENT_EVERY, FULL_EVERY). Returns the stations written."""
    from . import forecast, verify

    end = now_utc()
    recents = {sid: store.read_json(key(sid, recent=True)) for sid in STATIONS}
    recent_due = {sid for sid, obj in recents.items() if _due(obj, RECENT_EVERY, end)}
    if not recent_due:
        return []  # the full file is written with a recent one, never alone
    wide = verify.forecasts_from_page(store.read_json(forecast.KV_KEY))
    if wide.empty:
        return []
    wide["valid_time"] = pd.to_datetime(wide["valid_time"], utc=True)
    fresh = frames(wide)
    merged, full_due = {}, set()
    for sid in recent_due:
        new = fresh.get(sid)
        if new is None or new.empty:
            continue
        full = store.read_json(key(sid))
        if _due(full, FULL_EVERY, end):
            full_due.add(sid)
        # The page file's hours, then the recent file's (newer than a full file a day old), then the full record.
        merged[sid] = new.combine_first(decode_frame(recents[sid])).combine_first(decode_frame(full))
    return _write(store, merged, end, full=full_due, recent=recent_due)
