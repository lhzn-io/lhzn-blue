"""The Piscataqua Region waterway (/piscataqua-region/): Great Bay to the Isles of Shoals.

Its stations live in one registry (stations/piscataqua-region.json) and its output under one prefix
(v1/piscataqua-region/), so the Sound's files are never touched. To keep Workers KV writes few (the free plan allows
1,000 a day), everything observed goes into one file written hourly:

- region-live, hourly: v1/piscataqua-region/live.json. NOAA shore stations (shore.live), the PORTS current meter,
  NOAA current predictions, NERACOOS tide gauges (Hohonu, Onset) and UNH buoys, USGS rivers (rivers.live) and the
  Pease airport (asos.live). Each part keeps the previous file's copy when its source fails.
- region-daily: v1/piscataqua-region/history.json (the rivers' daily record and day-of-year percentiles), then the
  NECOFS surface currents over the box, hourly, and the MUR SST raster with its 90-day history.
- region-wind, every third hour: the HRRR 10 m wind over the box (no history file).

About 37 writes a day in all.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from . import asos, coops, fields, hrrr_grid, piscataqua, rivers, shore
from .build import Store, decode_frame, encode_frame, iso, now_utc
from .erddap import NERACOOS_URL, Erddap

log = logging.getLogger(__name__)

SCHEMA = 1
REGISTRY = Path(
    os.environ.get("LHZN_BLUE_REGION", Path(__file__).resolve().parents[3] / "stations" / "piscataqua-region.json")
)
WINDOW_DAYS = 30  # tide gauges, buoys and the current meter: hourly, the last 30 days
FETCH_HOURS = 6  # each run asks for the last 6 hours (more if a run was missed, up to the window)
PREDICTION_BACK_H, PREDICTION_AHEAD_H = 24, 48
M_TO_FT = 1 / 0.3048
MS_TO_KT = shore.MS_TO_KT
BAD_FLAGS = (3, 4)  # QARTOD suspect and fail; 1 pass, 2 not evaluated and 9 missing are kept
# Buoy variables: the dataset's column, ours, and its QARTOD aggregate flag where the dataset has one.
BUOY_VARS = [
    ("temperature", "water_c", "temperature_QARTOD_agg"),
    ("salinity", "salinity", "salinity_QARTOD_agg"),
    ("oxygen", "oxygen", "oxygen_QARTOD_agg"),
    ("chlorophyll", "chl", "chlorophyll_QARTOD_agg"),
    ("turbidity", "turb", "turbidity_QARTOD_agg"),
    ("wspd", "wind_kt", "wspd_QARTOD_agg"),
    ("wgust", "gust_kt", "wgust_QARTOD_agg"),
    ("wdir", "dir_deg", "wdir_QARTOD_agg"),
    ("airtemp", "air_c", "airtemp_QARTOD_agg"),
    ("atmospheric_pressure", "pressure_mb", None),
]
WATER_QUALITY = ["salinity", "oxygen", "chl", "turb"]  # hourly means, beside shore.hourly's temperature and met
RANGES = {"salinity": (0.0, 40.0), "oxygen": (0.0, 600.0), "chl": (0.0, 200.0), "turb": (0.0, 1000.0)}


def load() -> dict:
    return json.loads(REGISTRY.read_text())


def key(reg: dict, rel: str) -> str:
    """An output name under the waterway's prefix: key(reg, "live.json") is v1/piscataqua-region/live.json."""
    return reg["waterway"]["prefix"] + rel


def _status(prev: dict, end: datetime, error: str | None, rows: int | None = None) -> dict:
    status = dict(prev or {})
    if error:
        status["last_error"] = f"{iso(end)} {error[:200]}"
    else:
        status["last_ok"] = iso(end)
        status.pop("last_error", None)
    if rows is not None:
        status["rows"] = rows
    return status


def _fetch_start(held: pd.DataFrame, end: datetime) -> datetime:
    window_start = pd.Timestamp(end).floor("h") - pd.Timedelta(days=WINDOW_DAYS)
    if held.empty:
        return window_start.to_pydatetime()
    return max(window_start, min(pd.Timestamp(end) - pd.Timedelta(hours=FETCH_HOURS), held.index[-1])).to_pydatetime()


def _merge(fresh: pd.DataFrame, held: pd.DataFrame, end: datetime) -> pd.DataFrame:
    out = fresh.combine_first(held) if not held.empty else fresh
    return out[out.index >= pd.Timestamp(end).floor("h") - pd.Timedelta(days=WINDOW_DAYS)]


def _held(before: dict, columns: list[str]) -> pd.DataFrame:
    """The previous window's hourly columns (only the named ones: the object also holds lists that are not hours)."""
    return decode_frame({k: before[k] for k in ("t0", "step", *columns) if k in before})


# ---------------------------------------------------------------------------------------------
# NERACOOS: tide gauges and buoys


def levels(prev: dict, end: datetime, reg: dict, server: Erddap) -> dict:
    """Water level per gauge, hourly means in feet (above MLLW where the gauge publishes it, else NAVD88)."""
    out = {}
    for g in reg["levels"]:
        before = prev.get(g["id"], {})
        held = _held(before, ["level_ft", "water_f"])
        qc_col = g.get("qc_column") or ("qartod_aggregate" if g["dataset"].startswith("ONSET") else "qartod_qc_rollup")
        cols = [g["column"], qc_col] + ([g["water_temp_column"]] if g.get("water_temp_column") else [])
        last_obs, error, rows = before.get("last_obs"), None, None
        try:
            df = server.fetch(g["dataset"], _fetch_start(held, end), end + timedelta(minutes=1), cols)
            rows = len(df)
            df = df[~df[qc_col].isin(BAD_FLAGS)].set_index("time")
            fresh = pd.DataFrame({"level_ft": df[g["column"]] * M_TO_FT})
            if g.get("water_temp_column"):
                fresh["water_f"] = df[g["water_temp_column"]].where(df[g["water_temp_column"]].between(-2, 35)) * 9 / 5 + 32
            fresh = fresh.resample("h").mean().dropna(how="all")
            held = _merge(fresh, held, end)
            good = df.dropna(subset=[g["column"]])
            if not good.empty:
                last_obs = {"time": iso(good.index[-1]), "level_ft": round(float(good[g["column"]].iloc[-1] * M_TO_FT), 2)}
        except Exception as exc:  # keep the window we hold
            log.warning("%s level fetch failed: %s", g["id"], exc)
            error = f"{exc.__class__.__name__}: {exc}"
        obj = encode_frame(held, {"level_ft": 2, "water_f": 1})
        obj.update({"datum": g["datum"], "last_obs": last_obs, "status": _status(before.get("status"), end, error, rows)})
        out[g["id"]] = obj
    return out


def _wq_hourly(df: pd.DataFrame) -> pd.DataFrame:
    out = {}
    for col in WATER_QUALITY:
        lo, hi = RANGES[col]
        out[col] = df[col].where(df[col].between(lo, hi)).resample("h").mean()
    return pd.DataFrame(out)


def buoys(prev: dict, end: datetime, reg: dict, server: Erddap) -> dict:
    """UNH buoys: water temperature, salinity, oxygen, chlorophyll, turbidity and the buoy's own weather, hourly."""
    out = {}
    met_cols = shore.COLUMNS
    for b in reg["buoys"]:
        before = prev.get(b["id"], {})
        held = _held(before, [*met_cols, *WATER_QUALITY])
        last_obs, error, rows = before.get("last_obs"), None, None
        try:
            want = [src for src, _, _ in BUOY_VARS] + [flag for _, _, flag in BUOY_VARS if flag]
            df = server.fetch(b["dataset"], _fetch_start(held, end), end + timedelta(minutes=1), want)
            rows = len(df)
            for src, _, flag in BUOY_VARS:  # QARTOD: drop suspect and failed values, variable by variable
                if flag and flag in df:
                    df.loc[df[flag].isin(BAD_FLAGS), src] = np.nan
            work = pd.DataFrame({"time": df["time"]})
            for src, ours, _ in BUOY_VARS:
                work[ours] = df[src]
            work["wind_kt"] *= MS_TO_KT
            work["gust_kt"] *= MS_TO_KT
            if b.get("pressure_unit") == "bar":  # the Coastal Marine Lab reports bar; the Great Bay buoy mbar
                work["pressure_mb"] *= 1000.0
            work["level_ft"] = np.nan
            work = shore.qc(work[["time", "water_c", "air_c", "wind_kt", "gust_kt", "dir_deg", "pressure_mb", "level_ft"]].join(work[WATER_QUALITY]))
            fresh = shore.hourly(work[["time", "water_c", "air_c", "wind_kt", "gust_kt", "dir_deg", "pressure_mb", "level_ft"]])
            fresh = fresh.drop(columns=["level_ft"]).join(_wq_hourly(work.set_index("time")), how="outer").dropna(how="all")
            held = _merge(fresh, held, end)
            obs = shore.last_observation(work)
            if obs:
                latest = work.dropna(subset=["water_c"]).tail(1)
                wq = {c: (None if latest.empty or pd.isna(latest[c].iloc[0]) else round(float(latest[c].iloc[0]), 2)) for c in WATER_QUALITY}
                last_obs = {k: obs[k] for k in ("time", "water_f", "air_f", "wind_kt", "gust_kt", "dir_deg", "pressure_mb")} | wq
        except Exception as exc:
            log.warning("%s buoy fetch failed: %s", b["id"], exc)
            error = f"{exc.__class__.__name__}: {exc}"
        obj = encode_frame(held.reindex(columns=[c for c in [*met_cols, *WATER_QUALITY] if c != "level_ft"]),
                           {"salinity": 2, "oxygen": 1, "chl": 2, "turb": 1})
        obj.update({"depth_m": b["depth_m"], "oxygen_unit": b["oxygen_unit"], "last_obs": last_obs,
                    "status": _status(before.get("status"), end, error, rows)})
        out[b["id"]] = obj
    return out


# ---------------------------------------------------------------------------------------------
# NOAA currents: the PORTS meter and the predictions


def current_meters(prev: dict, end: datetime, reg: dict) -> dict:
    """The PORTS current meter: speed (cm/s) and direction toward, hourly means by components."""
    out = {}
    for m in reg["currents"]["meters"]:
        before = prev.get(m["id"], {})
        held = _held(before, ["spd_cms", "dir_deg"])
        last_obs, error, rows = before.get("last_obs"), None, 0
        try:
            vals = []
            for lo, hi in coops.spans(_fetch_start(held, end), end + timedelta(minutes=1), hourly=False):
                body = coops._get({"product": "currents", "station": m["coops_id"], "begin_date": coops._stamp(lo),
                                   "end_date": coops._stamp(hi - timedelta(minutes=1))}) or {}
                vals += body.get("data") or []
            rows = len(vals)
            if vals:
                df = pd.DataFrame(vals)
                df["time"] = pd.to_datetime(df["t"], utc=True)
                df = df.set_index("time")
                s = pd.to_numeric(df["s"], errors="coerce").where(lambda v: v.between(0, 400))
                d = np.deg2rad(pd.to_numeric(df["d"], errors="coerce"))
                east, north = (s * np.sin(d)).resample("h").mean(), (s * np.cos(d)).resample("h").mean()
                fresh = pd.DataFrame({"spd_cms": np.hypot(east, north), "dir_deg": (np.rad2deg(np.arctan2(east, north)) + 360) % 360}).dropna(how="all")
                held = _merge(fresh, held, end)
                good = pd.DataFrame({"s": s, "d": pd.to_numeric(df["d"], errors="coerce")}).dropna()
                if not good.empty:
                    last_obs = {"time": iso(good.index[-1]), "spd_cms": round(float(good["s"].iloc[-1]), 1), "dir_deg": int(good["d"].iloc[-1])}
        except Exception as exc:
            log.warning("%s current meter fetch failed: %s", m["id"], exc)
            error = f"{exc.__class__.__name__}: {exc}"
        obj = encode_frame(held, {"spd_cms": 1, "dir_deg": 0})
        obj.update({"last_obs": last_obs, "status": _status(before.get("status"), end, error, rows)})
        out[m["id"]] = obj
    return out


def current_predictions(prev: dict, end: datetime, reg: dict) -> dict:
    """NOAA's predicted tidal current at each station, a day back to two ahead (piscataqua.current_part)."""
    out = {}
    start, stop = end - timedelta(hours=PREDICTION_BACK_H), end + timedelta(hours=PREDICTION_AHEAD_H)
    for p in reg["currents"]["predictions"]:
        try:
            out[p["id"]] = piscataqua.current_part(start, stop, p)
        except Exception as exc:  # predictions do not change: keep the previous ones
            log.warning("%s current predictions failed: %s", p["id"], exc)
            if p["id"] in prev:
                out[p["id"]] = prev[p["id"]]
    return out


# ---------------------------------------------------------------------------------------------
# The jobs


def live(store: Store, end: datetime | None = None) -> list[str]:
    """Refresh live.json: every part fetched, each keeping its previous copy on failure. Returns the failures."""
    end = end or now_utc()
    reg = load()
    rel = key(reg, "live.json")
    prev = store.read_json(rel) or {}
    server = Erddap(NERACOOS_URL, budget=80)
    failed, doc = [], {"schema": SCHEMA, "waterway": reg["waterway"]["id"], "generated_at": iso(end)}
    parts = {
        "shore": lambda: shore.live(prev.get("shore"), end, registry=reg["shore"]),
        "current_meters": lambda: current_meters(prev.get("current_meters") or {}, end, reg),
        "current_predictions": lambda: current_predictions(prev.get("current_predictions") or {}, end, reg),
        "levels": lambda: levels(prev.get("levels") or {}, end, reg, server),
        "buoys": lambda: buoys(prev.get("buoys") or {}, end, reg, server),
        "rivers": lambda: rivers.live(prev.get("rivers"), end, registry=reg["rivers"]),
        "asos": lambda: asos.live(prev.get("asos"), end, registry=reg["asos"]),
    }
    for name, run in parts.items():
        try:
            doc[name] = run()
        except Exception:
            log.exception("region %s not refreshed", name)
            failed.append(name)
            if name in prev:
                doc[name] = prev[name]
    log.info("region live: %s", server.summary())
    store.write_json(rel, doc, max_age=300)
    return failed


def daily(store: Store, end: datetime | None = None) -> list[str]:
    """Refresh history.json: the rivers' daily record since 1990 and their day-of-year percentiles."""
    reg = load()
    rel = key(reg, "history.json")
    prev = store.read_json(rel) or {}
    try:
        doc = {"schema": SCHEMA, "waterway": reg["waterway"]["id"], "generated_at": iso(end or now_utc()),
               "rivers": rivers.history(prev.get("rivers"), end, registry=reg["rivers"])}
    except Exception:
        log.exception("region history not refreshed")
        return ["history"]
    store.write_json(rel, doc, max_age=3600)
    return []


def publish_fields(store: Store, end: datetime | None = None) -> list[str]:
    """The NECOFS currents over the box (hourly) and the SST raster and its 90-day history, cut to the model's water."""
    end = end or now_utc()
    reg = load()
    bbox = reg["waterway"]["bbox"]
    failed, water = [], None
    try:
        mesh, data = fields.currents(end, bbox, step_hours=1)
        store.write_json(key(reg, "fields/currents-mesh.json"), mesh, max_age=86400)
        store.write_json(key(reg, "fields/currents.json"), data, max_age=3600)
        water = mesh
    except Exception:
        log.exception("region currents not refreshed")
        failed.append("currents")
        water = store.read_json(key(reg, "fields/currents-mesh.json"))
        if water is None or water.get("bbox") != bbox:
            water = None
    try:
        store.write_json(key(reg, "fields/sst.json"), fields.raster("sst", end, water, bbox), max_age=3600)
    except Exception:
        log.exception("region sst not refreshed")
        failed.append("sst")
    rel = key(reg, "fields/sst-90d.bin")
    try:
        blob, summary = fields.history("sst", store.read_bytes(rel), end, water, bbox)
        store.write_bytes(rel, blob, max_age=3600)
        log.info("region sst history: %s", summary)
    except Exception:
        log.exception("region sst history not refreshed")
        failed.append("sst-90d")
    return failed


def publish_wind(store: Store) -> list[str]:
    """The HRRR 10 m wind over the box (with a margin for the map's wider views); no history file."""
    reg = load()
    x0, y0, x1, y1 = reg["waterway"]["bbox"]
    box = (x0 - 0.15, y0 - 0.1, x1 + 0.15, y1 + 0.1)
    try:
        hrrr_grid.publish(store, key(reg, "fields/hrrr-wind.json"), box, with_history=False)
    except Exception:
        log.exception("region HRRR wind not refreshed")
        return ["hrrr-wind"]
    return []
