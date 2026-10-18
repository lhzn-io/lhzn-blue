"""Coastal airport weather (NWS ASOS) on the Connecticut shore, read through the Iowa Environmental Mesonet.

No NOAA anemometer stands on the Connecticut shore between Kings Point and Bridgeport, and the tide gauges' sensors
sit low and sheltered; the airports at Stratford (KBDR) and New Haven (KHVN) are on the water's edge with the
standard 10 m mast. They carry wind, gusts, direction, air temperature and pressure (no water), listed in
``stations/asos.json``.

Reports are METARs: the routine one at about 52 minutes past each hour, plus specials when the weather changes. A
report is counted in the hour it is nearest (10 minutes are added before the hours are cut), then the hours are
built as for the shore stations (means, peak gust, speed-weighted direction) after the same gross-range check.

Published as ``v1/asos.json``: per station the last WINDOW_DAYS of hourly values (``encode_frame``: air_f, wind_kt,
gust_kt, dir_deg, pressure_mb), the latest report (``last_obs``) and a status per station. Each run fetches the last
FETCH_HOURS (the whole window when a station has none yet) and merges it in; a failed request keeps what was held.
"""

from __future__ import annotations

import io
import json
import logging
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from . import shore
from .build import SCHEMA, Store, decode_frame, encode_frame, iso, now_utc

log = logging.getLogger(__name__)

KEY = "v1/asos.json"
STATIONS_FILE = Path(os.environ.get("LHZN_BLUE_ASOS", Path(__file__).resolve().parents[3] / "stations" / "asos.json"))
IEM = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
UA = {"User-Agent": "longhorizon.blue ingest (https://longhorizon.blue; dfry@lhzn.io)"}
WINDOW_DAYS = 100
FETCH_HOURS = 72
REPORT_SHIFT = pd.Timedelta(minutes=10)  # the routine report at :52 belongs to the next hour
COLUMNS = ["air_f", "wind_kt", "gust_kt", "dir_deg", "pressure_mb"]
INHG_TO_MB = 33.8639
SPACING_S = 2.0


def load() -> dict:
    return json.loads(STATIONS_FILE.read_text())


def fetch(iem_id: str, start: datetime, end: datetime) -> pd.DataFrame:
    """The station's reports between start and end, in the shore stations' working columns (temperature in C)."""
    params = [("station", iem_id), ("tz", "Etc/UTC"), ("format", "onlycomma"), ("latlon", "no"), ("missing", "M"),
              ("trace", "T"), ("direct", "no"), ("report_type", "3"), ("report_type", "4")]
    params += [("data", d) for d in ("tmpf", "sknt", "gust", "drct", "mslp", "alti")]
    params += [("year1", start.year), ("month1", start.month), ("day1", start.day), ("hour1", start.hour), ("minute1", 0),
               ("year2", end.year), ("month2", end.month), ("day2", end.day), ("hour2", end.hour), ("minute2", 59)]
    time.sleep(SPACING_S)
    r = requests.get(IEM, params=params, headers=UA, timeout=120)
    r.raise_for_status()
    raw = pd.read_csv(io.StringIO(r.text), na_values=["M", "T"])
    if raw.empty:
        return pd.DataFrame(columns=["time", "water_c", "air_c", "wind_kt", "gust_kt", "dir_deg", "pressure_mb", "level_ft"])
    num = lambda c: pd.to_numeric(raw[c], errors="coerce") if c in raw else np.nan  # noqa: E731
    pressure = num("mslp")
    pressure = pressure.where(pressure.notna(), num("alti") * INHG_TO_MB)  # sea-level pressure, or the altimeter setting
    df = pd.DataFrame({
        "time": pd.to_datetime(raw["valid"], utc=True) + REPORT_SHIFT,
        "water_c": np.nan,
        "air_c": (num("tmpf") - 32) * 5 / 9,
        "wind_kt": num("sknt"),
        "gust_kt": num("gust"),
        "dir_deg": num("drct"),
        "pressure_mb": pressure,
        "level_ft": np.nan,
    })
    return shore.qc(df)


def live(prev: dict | None, end: datetime | None = None) -> dict:
    end = end or now_utc()
    prev_stations = (prev or {}).get("stations", {})
    window_start = pd.Timestamp(end).floor("h") - pd.Timedelta(days=WINDOW_DAYS)
    out = {}
    for st in load()["stations"]:
        before = prev_stations.get(st["id"], {})
        window = decode_frame({k: before[k] for k in ("t0", "step", *COLUMNS) if k in before})
        start = window_start if window.empty else max(window_start, pd.Timestamp(end) - pd.Timedelta(hours=FETCH_HOURS))
        status = dict(before.get("status") or {})
        last_obs = before.get("last_obs")
        try:
            df = fetch(st["iem_id"], start.to_pydatetime(), end + timedelta(hours=1))
            fresh = shore.hourly(df).reindex(columns=COLUMNS)
            window = fresh.combine_first(window) if not window.empty else fresh
            obs = shore.last_observation(df)
            if obs:
                obs["time"] = iso(pd.Timestamp(obs["time"]) - REPORT_SHIFT)  # the report's own time
                last_obs = {k: obs[k] for k in ("time", "air_f", "wind_kt", "gust_kt", "dir_deg", "pressure_mb")}
            status.update(last_ok=iso(end), rows=int(len(df)))
            status.pop("last_error", None)
        except Exception as exc:  # keep the window we hold
            log.warning("%s ASOS fetch failed: %s", st["id"], exc)
            status["last_error"] = f"{iso(end)} {exc.__class__.__name__}: {str(exc)[:160]}"
        window = window.reindex(columns=COLUMNS)
        window = window[window.index >= window_start]
        obj = encode_frame(window)
        obj.update({"last_obs": last_obs, "status": status})
        out[st["id"]] = obj
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": "NWS ASOS reports (METAR), through the Iowa Environmental Mesonet",
        "stations": out,
    }


def publish(store: Store) -> list[str]:
    doc = live(store.read_json(KEY))
    store.write_json(KEY, doc, max_age=300)
    return [k for k, v in doc["stations"].items() if (v.get("status") or {}).get("last_ok")]
