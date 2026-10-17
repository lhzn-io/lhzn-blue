"""USGS tidal gauges on the Sound (``stations/usgs-tidal.json``): water level and water quality, with tide predictions
fitted to each gauge's own record.

Published layout (under ``<root>/v1/``):

- ``usgs-tidal.json``: per gauge, the last 100 days as hourly means of the instantaneous readings: water level in
  feet above MLLW (USGS publishes NAVD88; the offset is NOAA VDatum's at the gauge), and where measured water
  temperature, salinity, dissolved oxygen, pH, turbidity and chlorophyll. With the level: our hourly tide
  prediction from 100 days back to 35 days ahead, its highs and lows, the gauge's datums and NWS flood levels.
  Refreshed hourly; each run fetches the last 3 days and merges them over the held window.
- ``archive/usgs-tidal-pred.json``: the predictions themselves, made monthly. For each gauge with a level, a
  harmonic fit (UTide, ordinary least squares, the constituents a year resolves) to the last 365 days of hourly
  levels, without the annual and semi-annual terms (one year would teach the fit that year's seasonal anomaly);
  the long-term SA and SSA of the nearest NOAA gauge, from NOAA's harmonic constants, are added instead. A fit's mean is the year's mean level, which stands above the 1983 to 2001 epoch that NOAA predicts on
  (sea level has risen, and a year has its own anomaly); the predictions are lowered by that regional offset, as
  measured at NOAA's four gauges over the same year (observed minus NOAA's predicted), so they sit on NOAA's footing
  and a departure from them means what a departure from NOAA's does. Each gauge keeps its own mean otherwise: a
  pond behind an inlet or a river mouth stands higher than the open Sound. Saved as an hourly series from 100 days
  before the fit to 400 days after, so the hourly runs only slice it. No linear trend is fitted (a year's trend,
  extrapolated, drifts the predictions). Checked by applying the same method at NOAA's own gauges: over the next
  35 days, within 0.01 to 0.09 ft of NOAA's predictions on average, 0.15 to 0.20 ft RMS.

Values are provisional until USGS approves them.
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
from .build import decode_frame, encode_frame, iso, now_utc
from .rivers import continuous

log = logging.getLogger(__name__)

GAUGES_FILE = Path(
    os.environ.get("LHZN_BLUE_USGS_TIDAL", Path(__file__).resolve().parents[3] / "stations" / "usgs-tidal.json")
)
WINDOW_DAYS = 100
FETCH_DAYS = 3
AHEAD_DAYS = 35
FIT_DAYS = 365
FIT_EVERY = timedelta(days=30)
PRED_AFTER_DAYS = 400
CHUNK_DAYS = 30  # rivers.continuous reads on page by page where a series is logged every few minutes
SHORE_FILE = Path(
    os.environ.get("LHZN_BLUE_SHORE_STATIONS", Path(__file__).resolve().parents[3] / "stations" / "shore.json")
)
M_FT = 3.28084
DECIMALS = {"level_ft": 2, "temperature_c": 2, "salinity": 2, "oxygen_mg_l": 2, "ph": 2, "turbidity_fnu": 1,
            "chlorophyll_ug_l": 1, "fchl_rfu": 2}


def load_gauges() -> list[dict]:
    return sorted(json.loads(GAUGES_FILE.read_text())["gauges"], key=lambda g: g["lon"])


def _hourly(usgs_id: str, codes, start: datetime, end: datetime) -> pd.Series:
    """Hourly means of the instantaneous values for the first parameter code that has data."""
    for code in [codes] if isinstance(codes, str) else codes:
        s = continuous(usgs_id, code, start, end, chunk_days=CHUNK_DAYS)
        if not s.empty:
            return s.resample("h").mean().dropna()
    return pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))


def _frame(g: dict, start: datetime, end: datetime) -> pd.DataFrame:
    cols = {}
    for key, codes in g["parameters"].items():
        s = _hourly(g["usgs_id"], codes, start, end)
        if key == "level":
            key, s = "level_ft", s + g["navd88_above_mllw_ft"]  # NAVD88 to MLLW
        if not s.empty:
            cols[key] = s
    return pd.DataFrame(cols).sort_index() if cols else pd.DataFrame()


# ---------------------------------------------------------------------------------------------
# Predictions (monthly)


def fit_due(pred: dict | None, now: datetime | None = None) -> bool:
    if not pred or "fitted_at" not in pred:
        return True
    return (now or now_utc()) - datetime.fromisoformat(pred["fitted_at"].replace("Z", "+00:00")) >= FIT_EVERY


def regional_offset(start: datetime, end: datetime) -> dict:
    """How far this year's water stands above NOAA's predictions (epoch 1983 to 2001), in feet: per NOAA gauge, the
    mean of observed minus predicted hourly heights over ``[start, end)``, and their mean."""
    per = {}
    for s in json.loads(SHORE_FILE.read_text())["stations"]:
        obs = coops.fetch("hourly_height", s["coops_id"], start, end).set_index("time").iloc[:, 0].dropna()
        preds = {}
        for lo, hi in coops.spans(start, end, hourly=False):
            body = coops._get({"product": "predictions", "station": s["coops_id"], "begin_date": coops._stamp(lo),
                               "end_date": coops._stamp(hi - timedelta(minutes=1)), "interval": "h", "datum": "MLLW"}) or {}
            for row in body.get("predictions") or []:
                try:
                    preds[pd.Timestamp(row["t"], tz="UTC")] = float(row["v"])
                except (KeyError, TypeError, ValueError):
                    continue
        both = pd.concat({"obs": obs, "pred": pd.Series(preds)}, axis=1).dropna()
        if len(both) > 24 * 60:
            per[s["id"]] = round(float((both["obs"] - both["pred"]).mean() * M_FT), 3)
    if not per:
        raise RuntimeError("no NOAA gauge gave a regional offset")
    return {"per_gauge_ft": per, "mean_ft": round(float(np.mean(list(per.values()))), 3)}


HARCON = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{}/harcon.json?units=english"


def _sun_longitude(t: pd.DatetimeIndex) -> np.ndarray:
    """The sun's mean longitude h (degrees), the argument of SA (h) and SSA (2h)."""
    days = (t - pd.Timestamp("2000-01-01T12:00:00Z")).total_seconds().to_numpy() / 86400.0
    return (280.46646 + 0.98564736 * days) % 360.0


def seasonal(noaa_id: str, t: pd.DatetimeIndex) -> np.ndarray:
    """NOAA's long-term annual and semi-annual tide (SA, SSA) at a NOAA gauge, in feet, at times ``t``."""
    import requests

    resp = requests.get(HARCON.format(noaa_id), timeout=60, headers={"User-Agent": "lhzn-blue-ingest/0.2 (+https://longhorizon.blue)"})
    resp.raise_for_status()
    con = {c["name"]: c for c in resp.json().get("HarmonicConstituents", [])}
    h = _sun_longitude(t)
    out = np.zeros(len(t))
    for name, mult in (("SA", 1), ("SSA", 2)):
        c = con.get(name)
        if c:
            out += float(c["amplitude"]) * np.cos(np.radians(mult * h - float(c["phase_GMT"])))
    return out


def _nearest_noaa(g: dict) -> dict:
    stations = json.loads(SHORE_FILE.read_text())["stations"]
    return min(stations, key=lambda s: (s["lat"] - g["lat"]) ** 2 + ((s["lon"] - g["lon"]) * 0.75) ** 2)


def fit(now: datetime | None = None) -> dict:
    """A harmonic fit per gauge with a level, saved as hourly predictions (see the module docstring)."""
    import utide  # the fit only

    now = (now or now_utc()).replace(minute=0, second=0, microsecond=0)
    offset = regional_offset(now - timedelta(days=FIT_DAYS), now)
    log.info("regional offset above NOAA's predictions: %s", offset)
    out: dict = {"fitted_at": iso(now), "regional_offset": offset, "stations": {}}
    for g in load_gauges():
        if "level" not in g["parameters"]:
            continue
        obs = _hourly(g["usgs_id"], g["parameters"]["level"], now - timedelta(days=FIT_DAYS), now) + g["navd88_above_mllw_ft"]
        if len(obs) < 24 * 60:
            log.warning("%s: %d hours of level, too few to fit; no predictions", g["id"], len(obs))
            continue
        lat = g["lat"]
        # An hourly mean stands for the middle of its hour: fitted at the hour's start it would teach a tide 30 min early.
        mid = (obs.index + pd.Timedelta(minutes=30)).to_pydatetime()
        # SA and SSA are left out of the fit (one year would teach it that year's seasonal anomaly); NOAA's long-term
        # values at the nearest NOAA gauge are added below.
        # No linear trend: a year's trend, extrapolated beyond the year, drifts the predictions (tested at NOAA's own
        # gauges: +0.3 to +0.5 ft over the next 35 days with it, within 0.1 ft without).
        auto = utide.solve(mid, obs.values, lat=lat, method="ols", conf_int="none", trend=False, verbose=False)
        names = [n for n in auto["name"] if n not in ("SA", "SSA")]
        coef = utide.solve(mid, obs.values, lat=lat, method="ols", conf_int="none", constit=names, trend=False, verbose=False)
        near = _nearest_noaa(g)
        resid = obs.values - utide.reconstruct(mid, coef, verbose=False).h - seasonal(near["coops_id"], obs.index + pd.Timedelta(minutes=30))
        t = pd.date_range(now - timedelta(days=WINDOW_DAYS), now + timedelta(days=PRED_AFTER_DAYS), freq="h", tz="UTC")
        h = utide.reconstruct(t.to_pydatetime(), coef, verbose=False).h + seasonal(near["coops_id"], t) - offset["mean_ft"]
        out["stations"][g["id"]] = {
            "t0": iso(t[0]),
            "step": 3600,
            "ft": [round(float(v), 2) for v in h],
            "fit": {
                "hours": int(len(obs)),
                "from": iso(obs.index[0]),
                "to": iso(obs.index[-1]),
                "constituents": int(len(coef["name"])),
                "seasonal_from": near["id"],
                "residual_rms_ft": round(float(np.sqrt(np.nanmean(resid**2))), 3),
                "year_mean_ft": round(float(coef["mean"]), 3),
                "lowered_by_ft": offset["mean_ft"],
            },
        }
        log.info("%s: fitted %d hours, %d constituents", g["id"], len(obs), len(coef["name"]))
    return out


def _hilo(t: pd.DatetimeIndex, h: np.ndarray) -> list[dict]:
    """Highs and lows of an hourly prediction, each refined by a parabola through its hour and the two beside it."""
    out = []
    for i in range(1, len(h) - 1):
        a, b, c = h[i - 1], h[i], h[i + 1]
        kind = "H" if b > a and b >= c else "L" if b < a and b <= c else None
        if not kind:
            continue
        den = a - 2 * b + c
        dx = 0.5 * (a - c) / den if den else 0.0
        out.append({"t": iso(t[i] + pd.Timedelta(hours=float(dx))), "ft": round(float(b - 0.25 * (a - c) * dx), 2), "type": kind})
    return out


# ---------------------------------------------------------------------------------------------
# Hourly refresh


def live(prev: dict | None, pred: dict | None, now: datetime | None = None) -> dict:
    now = now or now_utc()
    start_window = now - timedelta(days=WINDOW_DAYS)
    stations: dict = {}
    for g in load_gauges():
        held = decode_frame((prev or {}).get("stations", {}).get(g["id"], {}).get("series"))
        fresh = held.empty or held.index[-1] < now - timedelta(days=FETCH_DAYS)
        start = start_window if fresh else now - timedelta(days=FETCH_DAYS)
        try:
            new = _frame(g, start, now)
        except Exception:  # one gauge failing does not stop the others
            log.exception("%s: not refreshed", g["id"])
            new = pd.DataFrame()
        frame = new.combine_first(held) if not held.empty else new
        if not frame.empty:
            frame = frame[frame.index >= pd.Timestamp(start_window)]
        entry: dict = {k: g[k] for k in ("name", "short", "usgs_id", "lat", "lon", "side") if k in g}
        if g.get("caveat"):
            entry["caveat"] = g["caveat"]
        entry["series"] = encode_frame(frame, DECIMALS) if not frame.empty else {"t0": None, "step": 3600}
        entry["last"] = {
            col: {"time": iso(frame[col].dropna().index[-1]), "value": round(float(frame[col].dropna().iloc[-1]), DECIMALS.get(col, 2))}
            for col in frame.columns if frame[col].notna().any()
        } if not frame.empty else {}
        p = (pred or {}).get("stations", {}).get(g["id"])
        if p:
            pt = pd.date_range(p["t0"], periods=len(p["ft"]), freq="h")
            ps = pd.Series(p["ft"], index=pt)
            ps = ps[(ps.index >= pd.Timestamp(start_window)) & (ps.index <= pd.Timestamp(now + timedelta(days=AHEAD_DAYS)))]
            entry["tides"] = {
                "pred": {"t0": iso(ps.index[0]), "step": 3600, "ft": [round(float(v), 2) for v in ps]},
                "hilo": _hilo(ps.index, ps.values),
                "datums_ft": {"MLLW": 0.0, "MSL": g["msl_above_mllw_ft"], "MHHW": g["mhhw_above_mllw_ft"], "NAVD88": g["navd88_above_mllw_ft"]},
                "flood_ft": g.get("flood_ft", {}),
                "fit": p["fit"],
                "fitted_at": pred["fitted_at"],
            }
        stations[g["id"]] = entry
    return {
        "generated_at": iso(now),
        "source": "USGS Water Data (provisional); levels to MLLW by NOAA VDatum; predictions fitted here (UTide)",
        "stations": stations,
    }
