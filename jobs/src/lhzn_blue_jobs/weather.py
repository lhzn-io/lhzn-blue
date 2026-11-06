"""Buoy weather history: daily means of wind, air temperature and pressure, for the seasonal %iles.

The server keeps only the last few years of each ``<STATION>_MET`` dataset, so the record is joined from
three sources, later ones winning where they overlap:

1. NDBC's yearly standard meteorological archives of the same buoys (``ndbc`` in stations.json), which
   reach back to 2004 and 2005. NDBC reports wind in m/s; it is converted to knots. Over 2023 at
   Execution Rocks, the two agree to about 1% in wind and 0.1 in air temperature and pressure.
2. Our own saved downloads of the server's datasets (each covers a year or more).
3. The server itself, over the years it still publishes.

Published layout (under ``<root>/v1/``):

- ``archive/<STATION>_MET.json``: daily means from sources 1 and 2. Converted once by ``import-weather``
  (past years do not change); read by the history build, not served to the page.
- ``history-met.json``: the full daily record per station; rebuilt daily from the archive and the server,
  never dropping a day it held. Loaded only when a reader switches to Wind and waves.

A day is the mean of its hourly means (UTC), kept when at least 16 of the 24 hours have a value.
Directions are not kept: the daily means serve the %iles only.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pandas as pd
from insitukit import ndbc

from . import merlin
from .build import MET_COLUMNS, SCHEMA, Store, iso, load_stations, met_hourly, now_utc

log = logging.getLogger(__name__)

COLUMNS = ["wind_kt", "air_f", "pressure_mb"]
MIN_HOURS = 16
FIRST_NDBC_YEAR = 2002
FIRST_SERVER_YEAR = 2021  # the earliest year any *_MET dataset still holds on the server
MS_TO_KT = 1.943844
QC_DESCRIPTION = (
    "Weather history: daily means of hourly means (at least 16 hours a day) of wind, air temperature and pressure, "
    "after the same gross-range checks as the live weather; NDBC archives before the server's record."
)


def met_stations() -> list[dict]:
    return [st for st in load_stations()["stations"] if (st.get("met") or {}).get("dataset")]


def daily(hourly: pd.DataFrame) -> pd.DataFrame:
    """Daily means of the hourly frame's wind, air and pressure; days with too few hours are dropped."""
    if hourly.empty:
        return pd.DataFrame(columns=COLUMNS, index=pd.DatetimeIndex([], tz="UTC"), dtype=float)
    h = hourly[COLUMNS]
    means = h.resample("D").mean()
    counts = h.resample("D").count()
    return means.where(counts >= MIN_HOURS).dropna(how="all")


def _merge(fresh: pd.DataFrame, held: pd.DataFrame) -> pd.DataFrame:
    """Fresh values win; held days fresh lacks are kept."""
    if held.empty:
        return fresh
    if fresh.empty:
        return held
    return fresh.combine_first(held)


def encode_daily(frame: pd.DataFrame) -> dict:
    if frame.empty:
        return {"t0": None, "step": 86400}
    full = frame.sort_index().reindex(pd.date_range(frame.index.min(), frame.index.max(), freq="D"))
    out: dict = {"t0": iso(full.index[0]), "step": 86400}
    for col in COLUMNS:
        out[col] = [None if pd.isna(v) else round(float(v), 1) for v in full[col]]
    return out


def decode_daily(obj: dict | None) -> pd.DataFrame:
    if not obj or not obj.get("t0"):
        return pd.DataFrame(columns=COLUMNS, index=pd.DatetimeIndex([], tz="UTC"), dtype=float)
    n = len(obj.get(COLUMNS[0]) or [])
    idx = pd.date_range(pd.Timestamp(obj["t0"]), periods=n, freq="D")
    frame = pd.DataFrame({c: pd.array(obj.get(c) or [None] * n, dtype="Float64").astype(float) for c in COLUMNS}, index=idx)
    return frame.dropna(how="all")


def ndbc_year(ndbc_id: str, year: int) -> pd.DataFrame | None:
    """One year of an NDBC standard meteorological archive (insitukit's NDBC client, which reads files of every era
    and turns NDBC's sentinels into NaN), as rows in the server's columns and units; None when NDBC has no file for
    that year."""
    df = ndbc.year(ndbc_id, year)
    if df is None:
        return None
    # The gross bounds the jobs have always applied: values at or above NDBC's sentinels are not measurements.
    missing = {"WSPD": 99, "GST": 99, "WDIR": 999, "PRES": 9999, "ATMP": 999}
    for col, bad in missing.items():
        if col in df.columns:
            df[col] = df[col].where(df[col] < bad)
        else:
            df[col] = np.nan
    return pd.DataFrame(
        {
            "time": df["time"],
            "air_temperature": df["ATMP"],
            "barometric_pressure": df["PRES"],
            "wind_gust": df["GST"] * MS_TO_KT,
            "wind_speed": df["WSPD"] * MS_TO_KT,
            "wind_direction": df["WDIR"],
        }
    )


def import_weather(store: Store, archive_dir: Path) -> None:
    """One-time: NDBC's yearly archives, then every saved download of each station's weather dataset (later
    downloads win), as daily means in ``v1/archive/<STATION>_MET.json``."""
    from .archive import read_snapshot, saved_downloads

    last_year = now_utc().year - 1
    for st in met_stations():
        sid, ds = st["id"], st["met"]["dataset"]
        ndbc_id = st["met"].get("ndbc")
        merged = pd.DataFrame()
        years: list[int] = []
        if ndbc_id:
            for year in range(FIRST_NDBC_YEAR, last_year + 1):
                df = ndbc_year(ndbc_id, year)
                if df is None:
                    continue
                years.append(year)
                merged = _merge(daily(met_hourly(df)), merged)
                log.info("%s NDBC %s %d: %d rows", sid, ndbc_id, year, len(df))
        files = saved_downloads(archive_dir, ds)
        for f in files:
            df = read_snapshot(f, keep=["time", *MET_COLUMNS])
            merged = _merge(daily(met_hourly(df)), merged)
        if merged.empty:
            log.warning("no weather history for %s", sid)
            continue
        obj = encode_daily(merged)
        obj.update(
            {
                "schema": SCHEMA,
                "dataset": ds,
                "ndbc": ndbc_id,
                "ndbc_years": years,
                "downloads": len(files),
                "first_download": files[0].parent.name if files else None,
                "last_download": files[-1].parent.name if files else None,
            }
        )
        store.write_json(f"v1/archive/{sid}_MET.json", obj, max_age=86400)


def history(store: Store) -> dict:
    """The full daily weather record per station: the archive, then the server, over the previous build."""
    end = now_utc()
    prev = store.read_json("v1/history-met.json") or {}
    prev_stations = prev.get("stations", {})
    stations: dict = {}
    meta: dict = {}
    for st in met_stations():
        sid, ds = st["id"], st["met"]["dataset"]
        archived = store.read_json(f"v1/archive/{sid}_MET.json")
        combined = decode_daily(archived)
        error = None
        try:
            df = merlin.fetch_years(ds, FIRST_SERVER_YEAR, end, MET_COLUMNS)
            combined = _merge(daily(met_hourly(df)), combined)
        except Exception as exc:  # keep everything we hold
            log.warning("weather history fetch failed for %s: %s", ds, exc)
            error = str(exc)[:200]
        combined = _merge(combined, decode_daily(prev_stations.get(sid)))  # never lose a day we held
        obj = encode_daily(combined)
        stations[sid] = obj
        meta[sid] = {
            "dataset": ds,
            "ndbc": (archived or {}).get("ndbc"),
            "ndbc_years": (archived or {}).get("ndbc_years", []),
            "saved_downloads": (archived or {}).get("downloads"),
            "record_start": obj.get("t0"),
            "days": int(combined.notna().any(axis=1).sum()),
            "checked_at": iso(end),
            "error": error,
        }
    return {"schema": SCHEMA, "generated_at": iso(end), "qc": QC_DESCRIPTION, "meta": meta, "stations": stations}
