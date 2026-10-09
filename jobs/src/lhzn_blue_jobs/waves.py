"""Waves at the buoys: significant and maximum wave height, dominant and average period.

The server's wave datasets (``<STATION>_WAVE``) have been unpublished for long stretches, so every hourly
run asks for them: a dataset that returns is picked up within the hour, and the page states whether each
one is published now from that check rather than from a fixed flag. Our own saved downloads of the
datasets hold the record from before the outage.

Published layout (under ``<root>/v1/``):

- ``archive/<STATION>_WAVE.json``: hourly waves merged from every saved download of the dataset (each
  download covers about a year, so together they reach further back than any one of them). Converted
  once by ``import-waves``; read by the history build, not served to the page.
- ``history-waves.json``: the full hourly record per station, with its status (published now or not,
  last reading, record start); rebuilt daily, never dropping an hour it held. Loaded only when a reader
  switches to Wind and waves.
- ``live.json`` (key ``waves``): the last 100 days per station plus the latest raw reading and the
  hourly publication check; written by the live job.

An hourly value is the mean of the readings in ``[hour, hour + 1)`` (20-minute sampling), except maximum
wave height, which is the hourly maximum. Heights are in metres, periods in seconds.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from . import merlin
from .build import (
    LIVE_FETCH_HOURS,
    MET_WINDOW_HOURS,
    SCHEMA,
    Store,
    _num,
    decode_frame,
    encode_frame,
    iso,
    load_stations,
    now_utc,
)

log = logging.getLogger(__name__)

COLUMNS = {
    "significant_wave_height": "hs_m",
    "maximum_wave_height": "hmax_m",
    "dominant_wave_period": "tp_s",
    "average_wave_period": "ta_s",
}
DECIMALS = {"hs_m": 2, "hmax_m": 2, "tp_s": 1, "ta_s": 1}
# Gross-range checks (alpha). Long Island Sound's largest saved significant height is 2.3 m (Central Sound).
RANGES = {
    "significant_wave_height": (0.0, 10.0),
    "maximum_wave_height": (0.0, 20.0),
    "dominant_wave_period": (1.0, 25.0),
    "average_wave_period": (1.0, 25.0),
}
QC_DESCRIPTION = (
    "Waves: gross-range checks only (significant height 0 to 10 m, maximum height 0 to 20 m, periods 1 to 25 s); "
    "a spike test would remove real storm peaks."
)
FIRST_YEAR = 2013


def wave_stations() -> list[tuple[dict, str]]:
    """Stations with a wave sensor, and the dataset that publishes it."""
    out = []
    for st in load_stations()["stations"]:
        w = st.get("waves") or {}
        if w.get("sensor") and w.get("dataset"):
            out.append((st, w["dataset"]))
    return out


def hourly(df: pd.DataFrame) -> pd.DataFrame:
    """Hourly waves after range checks: mean heights and periods, and the hourly maximum wave."""
    cols = list(COLUMNS.values())
    if df.empty:
        return pd.DataFrame(columns=cols, index=pd.DatetimeIndex([], tz="UTC"), dtype=float)
    df = df.sort_values("time").drop_duplicates("time").set_index("time")
    for col, (lo, hi) in RANGES.items():
        x = pd.to_numeric(df[col], errors="coerce") if col in df.columns else pd.Series(float("nan"), index=df.index)
        df[col] = x.where((x >= lo) & (x <= hi))
    out = pd.DataFrame(
        {
            "hs_m": df["significant_wave_height"].resample("h").mean(),
            "hmax_m": df["maximum_wave_height"].resample("h").max(),
            "tp_s": df["dominant_wave_period"].resample("h").mean(),
            "ta_s": df["average_wave_period"].resample("h").mean(),
        }
    )
    return out.dropna(how="all")


def last_observation(df: pd.DataFrame) -> dict | None:
    good = df.dropna(subset=["significant_wave_height"]) if "significant_wave_height" in df.columns else df.iloc[0:0]
    if good.empty:
        return None
    row = good.sort_values("time").iloc[-1]
    return {"time": iso(row["time"])} | {short: _num(row.get(col)) for col, short in COLUMNS.items()}


def _merge(fresh: pd.DataFrame, held: pd.DataFrame) -> pd.DataFrame:
    """Fresh values win; hours only in ``held`` are kept."""
    if fresh.empty:
        return held
    if held.empty:
        return fresh
    return fresh.combine_first(held)


def import_waves(store: Store, archive_dir: Path) -> None:
    """One-time: merge every saved download of each wave dataset into one hourly record.

    Downloads overlap; where two disagree, the later download wins (the server may have revised values).
    """
    from .archive import read_snapshot

    for st, ds in wave_stations():
        files = sorted(archive_dir.glob(f"*/{ds}.h5"))  # folder names are download times, so this is oldest first
        if not files:
            log.warning("no saved downloads of %s under %s", ds, archive_dir)
            continue
        merged = pd.DataFrame()
        raw_last = None
        for f in files:
            df = read_snapshot(f, keep=["time", *COLUMNS])
            merged = _merge(hourly(df), merged)
            raw_last = last_observation(df) or raw_last
        obj = encode_frame(merged.sort_index(), DECIMALS)
        obj.update(
            {
                "schema": SCHEMA,
                "dataset": ds,
                "downloads": len(files),
                "first_download": files[0].parent.name,
                "last_download": files[-1].parent.name,
                "last_obs": raw_last,
            }
        )
        store.write_json(f"v1/archive/{st['id']}_WAVE.json", obj, max_age=86400)


def _fetch(ds: str, start: datetime, end: datetime) -> pd.DataFrame:
    return merlin.fetch(ds, start, end, list(COLUMNS))


def live(prev: dict, prev_datasets: dict, out_datasets: dict, end: datetime, store: Store | None = None) -> dict:
    """The last 100 days of waves per station, and whether the server publishes the dataset this hour.

    A station's last reading starts from our saved downloads (its archive file) the first time, so an
    offline dataset still has a date; after that it carries forward in live.json.
    """
    out: dict = {}
    window_start = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=MET_WINDOW_HOURS)
    for st, ds in wave_stations():
        before = prev.get(st["id"], {})
        window = decode_frame(before)
        last_obs = before.get("last_obs")
        if last_obs is None and store is not None:
            last_obs = (store.read_json(f"v1/archive/{st['id']}_WAVE.json") or {}).get("last_obs")
        published = before.get("published", False)
        status = dict(prev_datasets.get(ds, {}))
        fetch_hours = LIVE_FETCH_HOURS if before.get("t0") else MET_WINDOW_HOURS
        try:
            df = _fetch(ds, end - timedelta(hours=fetch_hours), end + timedelta(hours=1))
            window = _merge(hourly(df), window)
            last_obs = last_observation(df) or last_obs
            published = True
            status.update({"last_ok": iso(end), "rows": int(len(df))})
            status.pop("last_error", None)
        except merlin.DatasetMissing:
            published = False
            status.update({"last_ok": iso(end), "published": False})
        except Exception as exc:  # server trouble: keep the last good values and the last known status
            log.warning("live wave fetch failed for %s: %s", ds, exc)
            status.update({"last_error": f"{iso(end)} {exc.__class__.__name__}: {str(exc)[:200]}"})
        if not window.empty:
            window = window[window.index >= window_start]
        obj = encode_frame(window, DECIMALS)
        obj.update({"last_obs": last_obs, "published": published, "checked_at": iso(end), "dataset": ds})
        out[st["id"]] = obj
        out_datasets[ds] = status
    return out


def history(store: Store) -> dict:
    """The full hourly wave record per station: saved downloads, then the server, over the previous build."""
    end = now_utc()
    prev = store.read_json("v1/history-waves.json") or {}
    prev_stations = prev.get("stations", {})
    prev_meta = prev.get("meta", {})
    stations: dict = {}
    meta: dict = {}
    for st, ds in wave_stations():
        sid = st["id"]
        archived = store.read_json(f"v1/archive/{sid}_WAVE.json")
        combined = decode_frame(archived)
        last_obs = (archived or {}).get("last_obs")
        published = False
        error = None
        try:
            df = merlin.fetch_years(ds, FIRST_YEAR, end, list(COLUMNS))
            combined = _merge(hourly(df), combined)
            last_obs = last_observation(df) or last_obs
            published = True
        except merlin.DatasetMissing:
            log.info("%s is not published on the server", ds)
        except Exception as exc:  # keep everything we hold
            log.warning("wave history fetch failed for %s: %s", ds, exc)
            error = str(exc)[:200]
            published = (prev_meta.get(sid) or {}).get("published", False)
        # Never lose an hour we already hold.
        combined = _merge(combined, decode_frame(prev_stations.get(sid)))
        last_obs = last_obs or (prev_meta.get(sid) or {}).get("last_obs")
        obj = encode_frame(combined.sort_index(), DECIMALS) if not combined.empty else {"t0": None, "step": 3600}
        stations[sid] = obj
        meta[sid] = {
            "dataset": ds,
            "published": published,
            "checked_at": iso(end),
            "record_start": obj.get("t0"),
            "last_obs": last_obs,
            "saved_downloads": (archived or {}).get("downloads"),
            "error": error,
        }
    return {"schema": SCHEMA, "generated_at": iso(end), "qc": QC_DESCRIPTION, "meta": meta, "stations": stations}
