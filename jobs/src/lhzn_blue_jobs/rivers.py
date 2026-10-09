"""River discharge into Long Island Sound from USGS stream gauges (the Water Data APIs, v1).

The gauges are listed in ``stations/rivers.json``. An API key (``USGS_API_KEY``, free from api.data.gov) is
used when set; without one the requests still work at a lower rate limit.

Published layout (under ``<root>/v1/``):

- ``rivers.json``: per gauge, the last 100 days of discharge as hourly means of the 15-minute readings
  (cubic feet per second), with the latest reading; the Connecticut at Thompsonville also carries river
  turbidity (FNU, from a sensor USGS services and reviews). Refreshed hourly; each run fetches the last 3
  days and merges them over the held window.
- ``rivers-history.json``: per gauge, daily mean discharge from 1990 (USGS daily values, approved or
  provisional), and the day-of-year percentiles of daily flow that USGS computes from each gauge's full
  approved record, so a reading can be placed against normal for its date. Rebuilt daily: the last 60 days
  are refetched (provisional values are revised), anything older is kept, and the percentiles are
  refetched monthly.

Values are provisional until USGS approves them, typically months later.
"""

from __future__ import annotations

import io
import json
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

from .build import SCHEMA, _num, decode_frame, encode_frame, iso, now_utc

log = logging.getLogger(__name__)

API = "https://api.waterdata.usgs.gov/ogcapi/v1/collections"
NORMALS_API = "https://api.waterdata.usgs.gov/statistics/v0/observationNormals"
USER_AGENT = "lhzn-blue-ingest/0.1 (+https://longhorizon.blue)"
RIVERS_FILE = Path(
    os.environ.get("LHZN_BLUE_RIVERS", Path(__file__).resolve().parents[3] / "stations" / "rivers.json")
)
DISCHARGE = "00060"  # cubic feet per second
TURBIDITY = "63680"  # formazin nephelometric units
WINDOW_DAYS = 100
FETCH_DAYS = 3
CHUNK_DAYS = 30
FIRST_YEAR = 1990
REFETCH_DAYS = 60
NORMALS_MAX_AGE = timedelta(days=30)
PERCENTILES = ["5", "10", "25", "50", "75", "90", "95"]
QC_DESCRIPTION = (
    "Rivers: USGS values as published (provisional until approved); negative discharge and readings USGS marks "
    "as missing are left out."
)

_session = requests.Session()
_session.headers["User-Agent"] = USER_AGENT
if os.environ.get("USGS_API_KEY"):
    _session.headers["X-Api-Key"] = os.environ["USGS_API_KEY"].strip()


def load_gauges() -> list[dict]:
    return sorted(json.loads(RIVERS_FILE.read_text())["gauges"], key=lambda g: g["lon"])


def _get(url: str, params: dict, retries: int = 4) -> requests.Response:
    delay = 5.0
    for attempt in range(1, retries + 1):
        try:
            resp = _session.get(url, params=params, timeout=120)
        except requests.RequestException as exc:
            log.warning("USGS request failed (%s), attempt %d", exc.__class__.__name__, attempt)
        else:
            if resp.status_code == 200:
                return resp
            log.warning("USGS HTTP %d, attempt %d: %s", resp.status_code, attempt, resp.url)
            if resp.status_code not in (429, 500, 502, 503, 504):
                resp.raise_for_status()
        if attempt < retries:
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"USGS: giving up after {retries} attempts: {url}")


def _csv(resp: requests.Response) -> pd.DataFrame:
    text = resp.text.strip()
    if not text or "\n" not in text:
        return pd.DataFrame(columns=["time", "value"])
    return pd.read_csv(io.StringIO(text))


def continuous(usgs_id: str, parameter: str, start: datetime, end: datetime) -> pd.Series:
    """Instantaneous values (15-minute) for ``start <= time < end``, in chunks of 30 days."""
    parts = []
    a = start
    while a < end:
        b = min(a + timedelta(days=CHUNK_DAYS), end)
        df = _csv(
            _get(
                f"{API}/continuous/items",
                {
                    "f": "csv",
                    "monitoring_location_id": f"USGS-{usgs_id}",
                    "parameter_code": parameter,
                    "time": f"{iso(a)}/{iso(b)}",
                    "properties": "time,value",
                    "limit": 10000,
                },
            )
        )
        if len(df) >= 10000:
            log.warning("USGS %s %s: page limit reached for %s/%s", usgs_id, parameter, iso(a), iso(b))
        if not df.empty:
            parts.append(pd.Series(pd.to_numeric(df["value"], errors="coerce").values, index=pd.to_datetime(df["time"], utc=True)))
        a = b
    if not parts:
        return pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))
    s = pd.concat(parts).sort_index()
    s = s[~s.index.duplicated(keep="last")].dropna()
    return s[s >= 0] if parameter == DISCHARGE else s


def daily(usgs_id: str, start: date) -> pd.Series:
    """Daily mean discharge from ``start``, indexed by date (UTC midnight)."""
    df = _csv(
        _get(
            f"{API}/daily/items",
            {
                "f": "csv",
                "monitoring_location_id": f"USGS-{usgs_id}",
                "parameter_code": DISCHARGE,
                "statistic_id": "00003",
                "time": f"{start.isoformat()}/..",
                "properties": "time,value",
                "limit": 50000,
            },
        )
    )
    if df.empty:
        return pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))
    s = pd.Series(pd.to_numeric(df["value"], errors="coerce").values, index=pd.to_datetime(df["time"], utc=True)).sort_index()
    s = s[~s.index.duplicated(keep="last")].dropna()
    return s[s >= 0]


def normals(usgs_id: str) -> dict:
    """Day-of-year percentiles of daily mean discharge, one array per percentile over a leap year's 366 days."""
    resp = _get(
        NORMALS_API,
        {
            "monitoring_location_id": f"USGS-{usgs_id}",
            "parameter_code": DISCHARGE,
            "start_date": "01-01",
            "end_date": "12-31",
            "computation_type": "percentile",
        },
    )
    feats = resp.json().get("features") or []
    days = pd.date_range("2024-01-01", "2024-12-31", freq="D").strftime("%m-%d").tolist()
    out: dict = {f"p{p}": [None] * len(days) for p in PERCENTILES}
    count = None
    for f in feats:
        for series in f["properties"].get("data", []):
            if series.get("parameter_code") != DISCHARGE or series.get("parent_statistic_id") != "00003":
                continue
            for v in series.get("values", []):
                if v.get("time_of_year") not in days:
                    continue
                i = days.index(v["time_of_year"])
                for p, x in zip(v.get("percentiles", []), v.get("values", [])):
                    if f"p{p}" in out:
                        out[f"p{p}"][i] = _num(x)
                count = v.get("sample_count", count)
    return out | {"days": "01-01 to 12-31 (366, Feb 29 included)", "sample_count": count, "computed": iso(now_utc())}


def _hourly(s: pd.Series) -> pd.Series:
    return s.resample("h").mean().dropna() if not s.empty else s


def live(prev: dict | None, end: datetime | None = None) -> dict:
    """The last 100 days per gauge, hourly, with the latest reading."""
    end = end or now_utc()
    prev = prev or {}
    window_start = pd.Timestamp(end).floor("h") - pd.Timedelta(days=WINDOW_DAYS)
    gauges: dict = {}
    datasets: dict = {}
    for g in load_gauges():
        before = (prev.get("gauges") or {}).get(g["id"], {})
        held = decode_frame(before)
        last_obs = before.get("last_obs")
        status = dict((prev.get("datasets") or {}).get(g["usgs_id"], {}))
        start = end - timedelta(days=FETCH_DAYS if before.get("t0") else WINDOW_DAYS)
        try:
            cols = {"flow_cfs": continuous(g["usgs_id"], DISCHARGE, start, end)}
            if g.get("turbidity"):
                cols["turb_fnu"] = continuous(g["usgs_id"], TURBIDITY, start, end)
            fresh = pd.DataFrame({k: _hourly(v) for k, v in cols.items()})
            if not fresh.empty:
                held = fresh.combine_first(held) if not held.empty else fresh
            flow = cols["flow_cfs"]
            if not flow.empty:
                t = flow.index[-1]
                turb = cols.get("turb_fnu")
                last_obs = {
                    "time": iso(t),
                    "flow_cfs": _num(flow.iloc[-1]),
                    "turb_fnu": _num(turb.iloc[-1]) if turb is not None and not turb.empty else None,
                }
            status.update({"last_ok": iso(end), "rows": int(len(flow))})
            status.pop("last_error", None)
        except Exception as exc:  # keep the last good values; record the failure
            log.warning("river fetch failed for %s: %s", g["usgs_id"], exc)
            status.update({"last_error": f"{iso(end)} {exc.__class__.__name__}: {str(exc)[:200]}"})
        if not held.empty:
            held = held[held.index >= window_start]
        obj = encode_frame(held, {"flow_cfs": 0, "turb_fnu": 1})
        obj.update({"last_obs": last_obs, "usgs_id": g["usgs_id"]})
        gauges[g["id"]] = obj
        datasets[g["usgs_id"]] = status
    return {"schema": SCHEMA, "generated_at": iso(end), "gauges": gauges, "datasets": datasets}


def _encode_daily(s: pd.Series) -> dict:
    if s.empty:
        return {"t0": None, "step": 86400, "flow_cfs": []}
    full = s.reindex(pd.date_range(s.index[0], s.index[-1], freq="D"))
    return {"t0": iso(full.index[0]), "step": 86400, "flow_cfs": [None if pd.isna(v) else round(float(v)) for v in full]}


def _decode_daily(obj: dict | None) -> pd.Series:
    if not obj or not obj.get("t0") or not obj.get("flow_cfs"):
        return pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))
    idx = pd.date_range(pd.Timestamp(obj["t0"]), periods=len(obj["flow_cfs"]), freq="D")
    return pd.Series([float("nan") if v is None else v for v in obj["flow_cfs"]], index=idx, dtype=float).dropna()


def history(prev: dict | None, end: datetime | None = None) -> dict:
    """Daily mean discharge per gauge from 1990 and the day-of-year percentiles; never drops a day it held."""
    end = end or now_utc()
    prev = prev or {}
    daily_out: dict = {}
    normals_out: dict = {}
    meta: list = []
    for g in load_gauges():
        sid = g["id"]
        held = _decode_daily((prev.get("daily") or {}).get(sid))
        start = (end - timedelta(days=REFETCH_DAYS)).date() if not held.empty else date(FIRST_YEAR, 1, 1)
        error = None
        try:
            fresh = daily(g["usgs_id"], start)
            held = fresh.combine_first(held) if not held.empty else fresh
        except Exception as exc:  # keep what we hold
            log.warning("daily flow fetch failed for %s: %s", g["usgs_id"], exc)
            error = str(exc)[:200]
        daily_out[sid] = _encode_daily(held.sort_index())
        norm = (prev.get("normals") or {}).get(sid)
        stale = not norm or now_utc() - pd.Timestamp(norm.get("computed", "2000-01-01T00:00:00Z")) > NORMALS_MAX_AGE
        if stale:
            try:
                norm = normals(g["usgs_id"])
            except Exception as exc:
                log.warning("normals fetch failed for %s: %s", g["usgs_id"], exc)
                error = error or str(exc)[:200]
        normals_out[sid] = norm
        meta.append(g | {"record_start": daily_out[sid]["t0"], "error": error})
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "meta": {"gauges": meta, "qc": QC_DESCRIPTION, "source": "USGS Water Data APIs"},
        "daily": daily_out,
        "normals": normals_out,
    }
