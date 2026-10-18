"""Charted rips with NOAA's tidal current predictions, for the page's comfort index.

The water turbulence NOAA charts in Long Island Sound (tide rips, overfalls, eddies and breakers; the WATTUR features
of its electronic navigational charts, extracted once into ``stations/rips-lis.json``) forms when the tide runs over
a reef, shoal or point, whatever the current's absolute speed: off Shippan Point the ebb peaks near 0.3 kt and the
rips still stand up. So each rip is paired with the nearest NOAA tidal current prediction station within
MAX_STATION_KM (the stations sit at the same reefs and points), and the page reads, from that station's slack and
maximum events, whether the tide is running there: past the first sixth of the half-cycle from slack, short of the
last.

- Harmonic stations: the shallowest bin (from the station's bins); subordinate stations have no bins and are asked
  without one. Events (slack, flood, ebb, with the signed speed in knots) from DAYS_BACK days back to DAYS_AHEAD ahead.
- Predictions are fixed in advance, so they are refreshed when older than REFRESH_HOURS; a failed refresh keeps the
  last ones.

Published as ``v1/fields/rips.json``: a GeoJSON FeatureCollection; each feature's properties carry the kind, a
representative point (``at``), the station (id, name, km) and its events (``[time, knots, "s"|"f"|"e"]``), or no
station when none is near.
"""

from __future__ import annotations

import json
import logging
import math
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

KEY = "v1/fields/rips.json"
RIPS_FILE = Path(os.environ.get("LHZN_BLUE_RIPS", Path(__file__).resolve().parents[3] / "stations" / "rips-lis.json"))
UA = {"User-Agent": "longhorizon.blue ingest (https://longhorizon.blue; dfry@lhzn.io)"}
MDAPI = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi"
API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
MAX_STATION_KM = 5.0
DAYS_BACK, DAYS_AHEAD = 2, 4
REFRESH_HOURS = 12
SPACING_S = 0.5


def _km(lon: float, lat: float, lon2: float, lat2: float) -> float:
    return math.hypot((lon2 - lon) * math.cos(math.radians(lat)), lat2 - lat) * 111.2


def _get(url: str, params: dict | None = None) -> dict:
    time.sleep(SPACING_S)
    r = requests.get(url, params=params, headers=UA, timeout=60)
    r.raise_for_status()
    return r.json()


def stations() -> dict[str, dict]:
    """NOAA's current prediction stations, one entry per station."""
    out: dict[str, dict] = {}
    for s in _get(f"{MDAPI}/stations.json", {"type": "currentpredictions"})["stations"]:
        out.setdefault(s["id"], {"id": s["id"], "name": s["name"], "lon": float(s["lng"]), "lat": float(s["lat"]), "type": s.get("type")})
    return out


def shallowest_bin(station: str) -> int | None:
    bins = _get(f"{MDAPI}/stations/{station}/bins.json").get("bins") or []
    bins = [b for b in bins if b.get("depth") is not None]
    return min(bins, key=lambda b: b["depth"])["num"] if bins else None


def events(station: str, binno: int | None, end: datetime) -> list[list]:
    begin = (end - timedelta(days=DAYS_BACK)).replace(hour=0, minute=0, second=0, microsecond=0)
    stop = end + timedelta(days=DAYS_AHEAD)
    params = {
        "product": "currents_predictions", "application": "longhorizon.blue", "station": station, "time_zone": "gmt",
        "units": "english", "format": "json", "interval": "MAX_SLACK", "begin_date": f"{begin:%Y%m%d}", "end_date": f"{stop:%Y%m%d}",
    }
    if binno is not None:
        params["bin"] = binno
    body = _get(API, params)
    if "error" in body:
        raise ValueError(f"{station}: {body['error']}")
    cp = body.get("current_predictions", {}).get("cp", [])
    # [time, signed knots (flood positive), "s" slack / "f" flood / "e" ebb]
    return [[iso(datetime.strptime(e["Time"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)), round(float(e["Velocity_Major"]), 2), str(e.get("Type", "?"))[:1].lower()] for e in cp]


def build(end: datetime, prev: dict | None, charted: dict | None = None) -> dict:
    charted = charted if charted is not None else json.loads(RIPS_FILE.read_text())
    prev_by_station = {}
    for f in (prev or {}).get("features", []):
        st = f["properties"].get("station")
        if st and st.get("events"):
            prev_by_station[st["id"]] = st
    fetched = (prev or {}).get("fetched")
    due = not fetched or end - datetime.strptime(fetched, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) > timedelta(hours=REFRESH_HOURS)
    all_st = stations() if due or not prev_by_station else None
    fresh: dict[str, dict] = {}
    features = []
    for f in charted["features"]:
        lon, lat = f["properties"]["at"]
        st = None
        if all_st is not None:
            best = min(all_st.values(), key=lambda s: _km(lon, lat, s["lon"], s["lat"]))
            km = _km(lon, lat, best["lon"], best["lat"])
            if km <= MAX_STATION_KM:
                st = fresh.get(best["id"])
                if st is None:
                    try:
                        binno = shallowest_bin(best["id"]) if best["type"] == "H" else None
                        st = {"id": best["id"], "name": best["name"], "bin": binno, "events": events(best["id"], binno, end)}
                    except Exception as exc:  # keep the last predictions; they stay valid
                        log.warning("NOAA predictions for %s not refreshed: %s", best["id"], exc)
                        st = prev_by_station.get(best["id"])
                    if st is not None:
                        fresh[best["id"]] = st
                if st is not None:
                    st = {**st, "km": round(km, 2)}
        else:
            old = next((g for g in prev["features"] if g["properties"]["at"] == [lon, lat]), None)
            st = old["properties"].get("station") if old else None
        features.append({"type": "Feature", "geometry": f["geometry"], "properties": {"kind": f["properties"]["kind"], "at": [lon, lat], "station": st}})
    return {
        "schema": SCHEMA, "type": "FeatureCollection", "source": charted.get("source", ""),
        "predictions": "NOAA CO-OPS tidal current predictions (slack and maximum events)",
        "fetched": iso(end) if all_st is not None else fetched, "generated_at": iso(end), "features": features,
    }


def publish(store: Store) -> list[str]:
    end = now_utc()
    doc = build(end, store.read_json(KEY))
    store.write_json(KEY, doc, max_age=3600)
    return [f["properties"]["station"]["id"] for f in doc["features"] if f["properties"]["station"]]
