"""Build the published JSON for shore stations (NOAA CO-OPS water level stations with sensors).

The stations are listed in ``stations/shore.json``. Everything is binned in UTC.

Published layout (under ``<root>/v1/``):

- ``shore.json``: per station, the last 100 days hourly (water and air temperature in F, wind and gust
  in knots, speed-weighted mean direction, pressure in mbar, water level in feet above MLLW), the latest
  6-minute readings, and high and low tide predictions for the next 48 hours plus the most recent past
  one. Refreshed hourly; each run fetches only the last 72 hours and merges them over the held window.
  An hourly value is the mean of the 6-minute readings that passed QC in ``[hour, hour + 1)``; gust is
  the hourly maximum.
- ``shore-history.json``: water temperature only, hourly in F, the full record of every station.
  CO-OPS hourly data is the reading at the top of each hour, not an hourly mean. Rebuilt daily; once
  the full record is held, a run refetches only the last 60 days and never drops an hour it held.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import coops
from .build import c_to_f, decode, decode_frame, encode, encode_frame, iso, now_utc

log = logging.getLogger(__name__)

SCHEMA = 1
WINDOW_HOURS = 100 * 24
FETCH_HOURS = 72
HISTORY_REFETCH_DAYS = 60
TIDE_AHEAD_HOURS = 48
DATUM = "MLLW"
MS_TO_KT = 1.943844
M_TO_FT = 1 / 0.3048
COLUMNS = ["water_f", "air_f", "wind_kt", "gust_kt", "dir_deg", "pressure_mb", "level_ft"]
# 6-minute readings in working units (temperatures stay in C until the hourly step).
PRODUCTS = {
    "water_temperature": {"water_temperature": "water_c"},
    "air_temperature": {"air_temperature": "air_c"},
    "wind": {"wind_speed": "wind_kt", "wind_gust": "gust_kt", "wind_direction": "dir_deg"},
    "air_pressure": {"air_pressure": "pressure_mb"},
    "water_level": {"water_level": "level_ft"},
}
SCALE = {"wind_kt": MS_TO_KT, "gust_kt": MS_TO_KT, "level_ft": M_TO_FT}
# Gross-range QC (alpha), in working units. Values outside are dropped before averaging.
RANGES = {
    "water_c": (-2.0, 35.0),
    "air_c": (-30.0, 45.0),
    "wind_kt": (0.0, 100.0),
    "gust_kt": (0.0, 150.0),
    "dir_deg": (0.0, 360.0),
    "pressure_mb": (900.0, 1080.0),
    "level_ft": (-10.0, 15.0),
}
# Spike test on water temperature only, as in build.qc: a reading more than 1.5 C from the median of
# the readings around it is dropped. 31 readings at 6-minute sampling span about 3 hours, the same
# span build.qc uses at 15 minutes, so excursions shorter than about 1.5 hours are removed.
SPIKE_WINDOW = 31
SPIKE_MIN_PERIODS = 11
SPIKE_LIMIT_C = 1.5
QC_DESCRIPTION = (
    "Gross-range checks (water temperature -2 to 35 C, air temperature -30 to 45 C, wind 0 to 100 kt, gust 0 to "
    "150 kt, pressure 900 to 1080 mbar, water level -10 to 15 ft MLLW). The live window also drops a 6-minute water "
    "temperature more than 1.5 C from the median of the 31 readings around it (about 3 hours). Readings CO-OPS "
    "withholds as failing its own checks arrive empty and are skipped."
)
HISTORY_QC_DESCRIPTION = (
    "Gross-range check (-2 to 35 C) on the hourly readings. Readings CO-OPS withholds as failing its own checks "
    "arrive empty and are skipped. No spike test: at hourly sampling it would remove real tidal swings in harbours."
)
SHORE_FILE = Path(
    os.environ.get("LHZN_BLUE_SHORE_STATIONS", Path(__file__).resolve().parents[3] / "stations" / "shore.json")
)


def load_shore() -> dict:
    return json.loads(SHORE_FILE.read_text())


def _hour(ts) -> pd.Timestamp:
    return pd.Timestamp(ts).tz_convert("UTC").floor("h")


def _round(v, digits: int = 1) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if np.isnan(f) else round(f, digits)


# ---------------------------------------------------------------------------------------------
# 6-minute readings


def readings(st: dict, start: datetime, end: datetime) -> tuple[pd.DataFrame, list[str]]:
    """QC'd 6-minute readings for one station in working units, plus a message per product that failed.

    A product the station does not list is not requested; one that returns no data gives empty columns.
    """
    cols = [c for m in PRODUCTS.values() for c in m.values()]
    merged = pd.DataFrame({"time": pd.Series(dtype="datetime64[ns, UTC]")})
    errors = []
    for product, names in PRODUCTS.items():
        if product not in st["products"]:
            continue
        try:
            df = coops.fetch(product, st["coops_id"], start, end, datum=DATUM)
        except Exception as exc:  # keep going; the caller keeps the previous values for this product
            log.warning("%s %s fetch failed: %s", st["id"], product, exc)
            errors.append(f"{product}: {exc.__class__.__name__}: {str(exc)[:160]}")
            continue
        df = df.rename(columns=names)[["time", *names.values()]]
        merged = merged.merge(df, on="time", how="outer")
    for col in cols:
        if col not in merged.columns:
            merged[col] = np.nan
        merged[col] = pd.to_numeric(merged[col], errors="coerce") * SCALE.get(col, 1.0)
    return qc(merged[["time", *cols]]), errors


def qc(df: pd.DataFrame) -> pd.DataFrame:
    """Gross-range test on every column, then the rolling-median spike test on water temperature."""
    df = df.sort_values("time").drop_duplicates("time").reset_index(drop=True)
    for col, (lo, hi) in RANGES.items():
        if col in df.columns:
            df[col] = df[col].where((df[col] >= lo) & (df[col] <= hi))
    if "water_c" in df.columns and not df.empty:
        x = df["water_c"]
        med = x.rolling(SPIKE_WINDOW, center=True, min_periods=SPIKE_MIN_PERIODS).median()
        df["water_c"] = x.where(~((x - med).abs() > SPIKE_LIMIT_C))
    return df


def hourly(df: pd.DataFrame) -> pd.DataFrame:
    """Hourly means (temperatures in F), peak gust, and speed-weighted mean wind direction."""
    if df.empty:
        return pd.DataFrame(columns=COLUMNS, index=pd.DatetimeIndex([], tz="UTC"), dtype=float)
    df = df.set_index("time")
    rad = np.deg2rad(df["dir_deg"])
    w = df["wind_kt"].fillna(0)
    east = (w * np.sin(rad)).resample("h").sum(min_count=1)
    north = (w * np.cos(rad)).resample("h").sum(min_count=1)
    direction = (np.rad2deg(np.arctan2(east, north)) + 360) % 360
    out = pd.DataFrame(
        {
            "water_f": c_to_f(df["water_c"].resample("h").mean()),
            "air_f": c_to_f(df["air_c"].resample("h").mean()),
            "wind_kt": df["wind_kt"].resample("h").mean(),
            "gust_kt": df["gust_kt"].resample("h").max(),
            # A calm hour has no direction.
            "dir_deg": direction.where(np.hypot(east, north) > 0),
            "pressure_mb": df["pressure_mb"].resample("h").mean(),
            "level_ft": df["level_ft"].resample("h").mean(),
        }
    )
    return out.dropna(how="all")


def last_observation(df: pd.DataFrame) -> dict | None:
    """The latest 6-minute reading time, with each variable's latest value no more than an hour older."""
    good = df.dropna(how="all", subset=[c for c in df.columns if c != "time"])
    if good.empty:
        return None
    latest = good["time"].max()
    recent = good[good["time"] >= latest - pd.Timedelta(hours=1)]

    def last(col: str):
        s = recent[col].dropna()
        return s.iloc[-1] if not s.empty else None

    water, air = last("water_c"), last("air_c")
    return {
        "time": iso(latest),
        "water_f": _round(water * 9 / 5 + 32) if water is not None else None,
        "air_f": _round(air * 9 / 5 + 32) if air is not None else None,
        "wind_kt": _round(last("wind_kt")),
        "gust_kt": _round(last("gust_kt")),
        "dir_deg": _round(last("dir_deg"), 0),
        "pressure_mb": _round(last("pressure_mb")),
        "level_ft": _round(last("level_ft"), 2),
    }


def tides(st: dict, end: datetime) -> list[dict]:
    """High and low tides for the next 48 hours, plus the most recent one before ``end``."""
    now = pd.Timestamp(end)
    events = coops.tide_events(st["coops_id"], end - timedelta(hours=24), end + timedelta(hours=TIDE_AHEAD_HOURS), DATUM)
    past = [e for e in events if e["time"] <= now][-1:]
    ahead = [e for e in events if now < e["time"] <= now + pd.Timedelta(hours=TIDE_AHEAD_HOURS)]
    return [{"t": iso(e["time"]), "ft": round(e["m"] * M_TO_FT, 2), "type": e["type"]} for e in past + ahead]


def _trim_tides(events: list[dict], end: datetime) -> list[dict]:
    """Previous predictions still relevant at ``end`` (used when the prediction request fails)."""
    now = pd.Timestamp(end)
    past = [e for e in events if pd.Timestamp(e["t"]) <= now][-1:]
    return past + [e for e in events if pd.Timestamp(e["t"]) > now]


# ---------------------------------------------------------------------------------------------
# Jobs


def live(prev: dict | None, end: datetime | None = None, full: bool = False) -> dict:
    """The object to publish as ``v1/shore.json``.

    ``prev`` is the previously published object (or None). Each station's window is merged with the
    fresh readings (fresh values win) and trimmed to 100 days; a failed request keeps the previous
    values and records ``last_error``. ``full`` refetches the whole window (use after a QC change).
    """
    end = end or now_utc()
    prev = {} if full else (prev or {})
    prev_stations = prev.get("stations", {})
    prev_datasets = prev.get("datasets", {})
    window_start = _hour(end) - pd.Timedelta(hours=WINDOW_HOURS)
    out_stations: dict = {}
    out_datasets: dict = {}
    for st in load_shore()["stations"]:
        before = prev_stations.get(st["id"], {})
        window = decode_frame({k: before[k] for k in ("t0", "step", *COLUMNS) if k in before})
        if window.empty:
            fetch_start = window_start
        else:
            # The last 72 hours, reaching back further if earlier runs were missed.
            fetch_start = max(window_start, min(pd.Timestamp(end) - pd.Timedelta(hours=FETCH_HOURS), window.index[-1]))
        status = dict(prev_datasets.get(st["coops_id"], {}))
        df, errors = readings(st, fetch_start.to_pydatetime(), end + timedelta(hours=1))
        fresh = hourly(df)
        window = fresh.combine_first(window) if not window.empty else fresh
        window = window.reindex(columns=COLUMNS)
        window = window[window.index >= window_start]
        last_obs = last_observation(df) or before.get("last_obs")
        try:
            tide_list = tides(st, end)
        except Exception as exc:  # predictions do not change; keep the ones we hold
            log.warning("%s tide predictions failed: %s", st["id"], exc)
            errors.append(f"predictions: {exc.__class__.__name__}: {str(exc)[:160]}")
            tide_list = _trim_tides(before.get("tides") or [], end)
        status["rows"] = int(len(df))
        if errors:
            status["last_error"] = f"{iso(end)} " + "; ".join(errors)
        else:
            status["last_ok"] = iso(end)
            status.pop("last_error", None)
        obj = encode_frame(window)
        obj.update({"last_obs": last_obs, "tides": tide_list, "datum": DATUM, "coops_id": st["coops_id"]})
        out_stations[st["id"]] = obj
        out_datasets[st["coops_id"]] = status
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "stations": out_stations,
        "datasets": out_datasets,
        "qc": QC_DESCRIPTION,
    }


def water_hourly(df: pd.DataFrame) -> pd.Series:
    """Hourly water temperature in C from CO-OPS ``interval=h`` readings, after the gross-range check."""
    if df.empty:
        return pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))
    lo, hi = RANGES["water_c"]
    s = df.set_index("time")["water_temperature"]
    s = s.where((s >= lo) & (s <= hi)).dropna()
    s.index = s.index.floor("h")
    return s[~s.index.duplicated(keep="last")].sort_index()


def history(prev: dict | None, end: datetime | None = None, first_year: int | None = None) -> dict:
    """The object to publish as ``v1/shore-history.json``: hourly water temperature, full record.

    The first build fetches from each station's ``record_start_year`` (or ``first_year``) in calendar-year
    requests. Later builds, once the record from that year is held, refetch the last 60 days only (or from
    the last held hour, if older). Fresh values win; an hour already held is never dropped.
    """
    end = end or now_utc()
    prev = prev or {}
    prev_series = prev.get("series", {})
    prev_meta = {s["id"]: s for s in prev.get("meta", {}).get("stations", [])}
    meta_stations = []
    all_series: dict = {}
    for st in load_shore()["stations"]:
        start_year = first_year or st["record_start_year"]
        before = decode(prev_series.get(st["id"]))
        before_meta = prev_meta.get(st["id"]) or {}
        held_from = before_meta.get("fetched_from_year")
        warm = not before.empty and held_from is not None and held_from <= start_year
        if warm:
            fetch_start = min(_hour(end) - pd.Timedelta(days=HISTORY_REFETCH_DAYS), before.index[-1])
        else:
            fetch_start = pd.Timestamp(datetime(start_year, 1, 1, tzinfo=timezone.utc))
        # One request per calendar year. A failed year is skipped and the rest are kept; the full fetch
        # is then repeated next run (fetched_from_year is only set once every year succeeded).
        parts: list[pd.Series] = []
        errors = []
        stop = end + timedelta(hours=1)
        for lo, hi in coops.spans(fetch_start.to_pydatetime(), stop, hourly=True):
            try:
                parts.append(water_hourly(coops.fetch("water_temperature", st["coops_id"], lo, hi, interval="h")))
            except Exception as exc:
                log.warning("%s history fetch failed for %d: %s", st["id"], lo.year, exc)
                errors.append(f"{lo.year}: {exc.__class__.__name__}: {str(exc)[:160]}")
        parts = [p for p in parts if not p.empty]
        fresh = pd.concat(parts).sort_index() if parts else pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))
        fresh = fresh[~fresh.index.duplicated(keep="last")]
        fetched_from = held_from if (warm or errors) else start_year
        error = f"{iso(end)} " + "; ".join(errors)[:400] if errors else None
        # Never lose an hour we already hold: fresh values win, everything else is kept.
        if fresh.empty:
            combined = before
        elif before.empty:
            combined = fresh
        else:
            combined = fresh.combine_first(before)
        obj = encode(combined.sort_index(), unit="degF")
        obj["station"] = st["id"]
        all_series[st["id"]] = obj
        meta_stations.append(
            {k: st[k] for k in ("id", "name", "operator", "lat", "lon", "info_url", "coops_id")}
            | {
                "note": st.get("note"),
                "record_start": obj["t0"],
                "last_hour": iso(combined.index[-1]) if not combined.empty else None,
                "hours": len(obj["values"]),
                "fetched_from_year": fetched_from,
                "last_error": error,
            }
        )
    meta = {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "stations": meta_stations,
        "qc": HISTORY_QC_DESCRIPTION,
        "server": coops.BASE_URL,
    }
    return {"schema": SCHEMA, "generated_at": iso(end), "meta": meta, "series": all_series}
