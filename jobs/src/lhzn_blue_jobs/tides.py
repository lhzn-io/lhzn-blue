"""Build ``v1/shore-tides.json``: NOAA tide predictions, tidal datums and flood levels for the shore stations.

The water levels page compares the observed hourly level (``shore.json``) with these predictions. Rebuilt daily
by the history job; predictions do not change, so a day-old file is as good as a fresh one.

Per station (the stations in ``stations/shore.json``, west to east):

- ``pred``: hourly predicted water level, ft above MLLW, from 45 days back to 35 days ahead (``t0``, ``step`` 3600,
  ``ft``). A prediction is the instantaneous level at the top of the hour.
- ``hilo``: predicted high and low waters over the same span, ``[{t, ft, type}]`` with type ``H`` or ``L``.
- ``datums_ft``: MHHW, MHW, MSL, MLW and MLLW, ft above MLLW, on the station's current tidal epoch (``epoch``).
- ``flood_ft``: NWS and NOS minor, moderate and major flood thresholds, converted from the station datum to ft
  above MLLW by subtracting the MLLW datum value. A threshold NOAA does not publish is null.

A station whose requests fail keeps its previous entry, when there is one, and records ``last_error``.

``moon`` lists the primary moon phases over the same span, ``[{t, phase}]``, from the US Naval Observatory (one
request, paced like the CO-OPS ones). If that request fails the previous phases are kept, or none.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta

import pandas as pd
import requests

from . import coops
from .build import iso, now_utc
from .shore import load_shore

log = logging.getLogger(__name__)

SCHEMA = 1
DATA_URL = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
MD_URL = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{station}/{what}.json"
DAYS_BACK = 45
DAYS_AHEAD = 35
TIMEOUT = (10, 60)
RETRIES = 3
DATUMS = ("MHHW", "MHW", "MSL", "MLW", "MLLW")
FLOODS = ("nws_minor", "nws_moderate", "nws_major", "nos_minor", "nos_moderate", "nos_major")
# Distance along the Sound from Kings Point, km, approximate (along the axis, not the shoreline).
KM = {"KPTN": 0, "BRPT": 62, "NWHV": 90, "NLON": 160}
SOURCE = "NOAA CO-OPS tide predictions (datagetter, product predictions), datums and flood levels (mdapi)"
MOON_URL = "https://aa.usno.navy.mil/api/moon/phases/date"
MOON_SOURCE = "US Naval Observatory, Astronomical Applications API (moon/phases/date), times UT"
PHASES = {"new moon": "new", "first quarter": "first_quarter", "full moon": "full", "last quarter": "last_quarter"}

_session = requests.Session()
_session.headers["User-Agent"] = coops.USER_AGENT


def _get(url: str, params: dict | None = None) -> dict:
    """GET JSON one request at a time (paced with the other CO-OPS requests), retried with backoff."""
    delay = 5.0
    last: Exception | None = None
    for attempt in range(1, RETRIES + 1):
        coops.request_count += 1
        coops._pace()
        try:
            resp = _session.get(url, params=params, timeout=TIMEOUT)
            if resp.status_code == 200:
                body = resp.json()
                err = body.get("error") if isinstance(body, dict) else None
                if err:
                    raise coops.CoopsError(f"{(err.get('message') if isinstance(err, dict) else err)!s} ({params})")
                return body
            if resp.status_code < 500 and resp.status_code not in coops.THROTTLED:
                raise coops.CoopsError(f"HTTP {resp.status_code} ({url})")
            last = RuntimeError(f"HTTP {resp.status_code}")
        except coops.CoopsError:
            raise
        except (requests.RequestException, ValueError) as exc:
            last = exc
        log.warning("%s attempt %d failed: %s", url, attempt, last)
        if attempt < RETRIES:
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"giving up after {RETRIES} attempts: {url} {params}: {last}")


def _predictions(station: str, start: datetime, end: datetime, interval: str) -> list[dict]:
    params = {
        "product": "predictions",
        "station": station,
        "begin_date": start.strftime("%Y%m%d %H:%M"),
        "end_date": end.strftime("%Y%m%d %H:%M"),
        "interval": interval,
        "datum": "MLLW",
        "units": "english",
        "time_zone": "gmt",
        "format": "json",
        "application": coops.APPLICATION,
    }
    return _get(DATA_URL, params).get("predictions") or []


def _hourly(rows: list[dict]) -> dict:
    s = pd.Series({pd.Timestamp(r["t"], tz="UTC"): float(r["v"]) for r in rows}).sort_index()
    s = s[s.index == s.index.floor("h")]
    full = s.reindex(pd.date_range(s.index[0], s.index[-1], freq="h"))
    return {"t0": iso(full.index[0]), "step": 3600, "ft": [None if pd.isna(v) else round(float(v), 2) for v in full]}


def _datums(station: str) -> tuple[dict, dict, str | None]:
    body = _get(MD_URL.format(station=station, what="datums"), {"units": "english"})
    raw = {d["name"]: d["value"] for d in body.get("datums") or [] if isinstance(d.get("value"), (int, float))}
    if "MLLW" not in raw:
        raise ValueError(f"{station}: no MLLW datum")
    mllw = float(raw["MLLW"])
    datums = {k: round(float(raw[k]) - mllw, 2) for k in DATUMS if k in raw}
    flood = _get(MD_URL.format(station=station, what="floodlevels"), {"units": "english"})
    floods = {k: (round(float(flood[k]) - mllw, 2) if isinstance(flood.get(k), (int, float)) else None) for k in FLOODS}
    return datums, floods, body.get("epoch")


def station(st: dict, start: datetime, end: datetime) -> dict:
    noaa = st["coops_id"]
    hourly = _predictions(noaa, start, end, "h")
    hilo = _predictions(noaa, start, end, "hilo")
    datums, floods, epoch = _datums(noaa)
    if not hourly:
        raise ValueError(f"{noaa}: no hourly predictions")
    return {
        "noaa": noaa,
        "name": st["name"],
        "km": KM.get(st["id"]),
        "lat": st.get("lat"),
        "lon": st.get("lon"),
        "pred": _hourly(hourly),
        "hilo": [{"t": iso(pd.Timestamp(r["t"], tz="UTC")), "ft": round(float(r["v"]), 2), "type": r["type"]} for r in hilo],
        "datums_ft": datums,
        "flood_ft": floods,
        "epoch": epoch,
    }


def build(prev: dict | None = None, end: datetime | None = None) -> dict:
    """The object to publish as ``v1/shore-tides.json``."""
    now = end or now_utc()
    day = pd.Timestamp(now).tz_convert("UTC").floor("D").to_pydatetime()
    start, stop = day - timedelta(days=DAYS_BACK), day + timedelta(days=DAYS_AHEAD)
    prev_stations = (prev or {}).get("stations", {})
    stations: dict = {}
    for st in load_shore()["stations"]:
        try:
            stations[st["id"]] = station(st, start, stop) | {"last_ok": iso(now)}
        except Exception as exc:  # keep going; the page shows what the other stations have
            log.warning("%s tides failed: %s", st["id"], exc)
            before = dict(prev_stations.get(st["id"]) or {"noaa": st["coops_id"], "name": st["name"], "km": KM.get(st["id"])})
            before["last_error"] = f"{iso(now)} {exc.__class__.__name__}: {str(exc)[:200]}"
            stations[st["id"]] = before
    try:
        moon = moon_phases(start, stop)
    except Exception as exc:  # the phases are an annotation; the file is complete without them
        log.warning("moon phases failed: %s", exc)
        moon = [m for m in (prev or {}).get("moon", []) if iso(start) <= m["t"] <= iso(stop)]
    return {
        "schema": SCHEMA,
        "generated_at": iso(now),
        "source": SOURCE,
        "datum": "MLLW",
        "units": "ft",
        "stations": stations,
        "moon": moon,
        "moon_source": MOON_SOURCE,
    }


def moon_phases(start: datetime, end: datetime) -> list[dict]:
    """Primary moon phases in ``[start, end]`` from the US Naval Observatory, in one request: ``[{t, phase}]``.

    ``phase`` is ``new``, ``first_quarter``, ``full`` or ``last_quarter``; ``t`` is the instant (UT).
    """
    days = (end - start).days
    count = days // 7 + 3  # four phases per 29.5 days; a margin so the span is always covered
    body = _get(MOON_URL, {"date": start.strftime("%Y-%m-%d"), "nump": count})
    out = []
    for p in body.get("phasedata") or []:
        name = PHASES.get(str(p.get("phase", "")).lower())
        if not name:
            continue
        hh, mm = (int(x) for x in p["time"].split(":"))
        t = pd.Timestamp(year=int(p["year"]), month=int(p["month"]), day=int(p["day"]), hour=hh, minute=mm, tz="UTC")
        if pd.Timestamp(start) <= t <= pd.Timestamp(end):
            out.append({"t": iso(t), "phase": name})
    return out
