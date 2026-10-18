"""HRRR's last forecast before each hour at the stations: for every valid hour, the value from the most recent cycle
issued before it (lead 1 h, or 2 or 3 h where that cycle is missing). With the buoys' own records interrupted, this
is the model's closest stand-in for what happened, labelled as a model on the page.

Published per station as ``v1/hrrr-history/<ID>.json``: one hourly frame (``encode_frame``) from 2024-01-01 with
``wind_kt``, ``gust_kt``, ``dir_deg`` (from), ``air_f``, ``pressure_mb`` and ``lead_h`` (the lead used each hour).
``v1/hrrr-history/<ID>-recent.json`` holds the last RECENT_DAYS in the same format, for the page's inline plots.

- ``seed``: once, from the archive of every cycle (``forecast.Archive``), read where the archive can be read (the
  jobs may only create objects in it, so this runs with a person's credentials).
- ``update``: each forecast run, from the forecast job's page file (every cycle of the last KEEP_HOURS), overwriting
  the recent hours; the page file holds every lead, so its shortest-lead choice is the final one.
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


def _write(store: Store, per_station: dict[str, pd.DataFrame], end) -> list[str]:
    done = []
    for sid in STATIONS:
        frame = per_station.get(sid)
        if frame is None or frame.empty:
            continue
        frame = frame[frame.index >= START]
        obj = encode_frame(frame, DECIMALS)
        obj.update({"station": sid, "source": "NOAA HRRR, read at the station through forcingkit; each hour from the most recent cycle before it (lead 1 to 3 h)", "generated_at": iso(end)})
        store.write_json(key(sid), obj, max_age=3600)
        recent = encode_frame(frame[frame.index >= end - pd.Timedelta(days=RECENT_DAYS)], DECIMALS)
        recent.update({k: obj[k] for k in ("station", "source", "generated_at")})
        store.write_json(key(sid, recent=True), recent, max_age=3600)
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
        blobs = [b for b in bucket.list_blobs(prefix=prefix.strip("/") + "/") if b.name.endswith(".csv.gz")]
        read = lambda b: b.download_as_bytes()  # noqa: E731
        items = blobs
    else:
        from pathlib import Path

        items = sorted(Path(root).rglob("cycle=*.csv.gz"))
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
    """Overwrite each station's recent hours from the forecast job's page file (all cycles of the last KEEP_HOURS)."""
    from . import forecast, verify

    end = now_utc()
    wide = verify.forecasts_from_page(store.read_json(forecast.KV_KEY))
    if wide.empty:
        return []
    wide["valid_time"] = pd.to_datetime(wide["valid_time"], utc=True)
    fresh = frames(wide)
    merged = {}
    for sid in STATIONS:
        old = decode_frame(store.read_json(key(sid)))
        new = fresh.get(sid)
        if new is None or new.empty:
            continue
        merged[sid] = new.combine_first(old) if not old.empty else new
    return _write(store, merged, end)
