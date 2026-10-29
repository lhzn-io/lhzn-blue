"""The tidal current's phase at reference points along the Sound, for the strip under the page's time bar, and at the
Groton current meter (its station page compares both with the meter's measurements).

Each point pairs NOAA's tidal current predictions (CO-OPS harmonic stations, the bin nearest the surface) with the
NECOFS FVCOM surface current at the nearest model element, projected onto the station's flood direction so both read
in knots along the same axis: positive is flood, negative ebb. Flood runs west through the Race and the central Sound
but east at Throgs Neck, so each point carries its own axis.

- NOAA: 30-minute predictions and the slack and maximum events, from DAYS_BACK days back to DAYS_AHEAD ahead,
  refreshed when the file's NOAA part is older than NOAA_REFRESH_HOURS (the predictions are fixed in advance).
- NECOFS: from the page's ``v1/fields/currents.json`` (24 h back to 72 h ahead, every 2 h); hours older than that are
  kept from the previous file, so the strip's past reaches back as far as the time bar.

Published as ``v1/current-phase.json``. Each point has a fixed scale (``scale_kt``) so the strip never rescales.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta, timezone

import requests

from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

KEY = "v1/current-phase.json"
UA = {"User-Agent": "longhorizon.blue ingest (https://longhorizon.blue; dfry@lhzn.io)"}
API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
DAYS_BACK, DAYS_AHEAD = 15, 4  # the Wind view's time bar reaches two weeks back
NOAA_REFRESH_HOURS = 12
MAX_ELEMENT_KM = 3.0
# id, name, NOAA station, shallowest bin, position, fixed strip scale in knots (above spring maxima at that bin)
POINTS = [
    ("race", "The Race", "LIS1001", 13, (-72.0625, 41.2282), 4.0),
    ("central", "Central Sound (Branford Reef, 5 mi S)", "LIS1021", 20, (-72.8280, 41.1444), 1.2),
    ("exrx", "Execution Rocks", "LIS1036", 14, (-73.7334, 40.8732), 0.8),
    ("throgs", "Throgs Neck", "LIS1038", 15, (-73.7921, 40.8010), 2.0),
    # The PORTS meter's real-time bin (38 m out from the pier), the only bin NOAA predicts there.
    ("groton", "Groton (Thames River)", "nl0101", 9, (-72.0923, 41.3918), 1.0),
]


def _noaa(station: str, binno: int, interval: str, begin: datetime, end: datetime) -> list[dict]:
    params = {
        "product": "currents_predictions", "application": "longhorizon.blue", "station": station, "bin": binno,
        "time_zone": "gmt", "units": "english", "format": "json", "interval": interval,
        "begin_date": f"{begin:%Y%m%d}", "end_date": f"{end:%Y%m%d}",
    }
    r = requests.get(API, params=params, headers=UA, timeout=60)
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise ValueError(f"{station}: {body['error']}")
    return body.get("current_predictions", {}).get("cp", [])


def _t(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)


def noaa_part(station: str, binno: int, end: datetime) -> dict:
    begin = (end - timedelta(days=DAYS_BACK)).replace(hour=0, minute=0, second=0, microsecond=0)
    stop = end + timedelta(days=DAYS_AHEAD)
    curve = _noaa(station, binno, "30", begin, stop)
    events = _noaa(station, binno, "MAX_SLACK", begin, stop)
    first = curve[0]
    return {
        "station": station,
        "bin": binno,
        "depth_ft": float(first.get("Depth") or "nan"),
        "flood_dir": int(first["meanFloodDir"]),
        "ebb_dir": int(first["meanEbbDir"]),
        "t0": iso(_t(first["Time"])),
        "step": 1800,
        "kt": [round(float(c["Velocity_Major"]), 2) for c in curve],
        "events": [{"t": iso(_t(e["Time"])), "type": e["Type"], "kt": round(float(e["Velocity_Major"]), 2)} for e in events],
        "fetched": iso(end),
    }


def necofs_part(currents: dict, mesh: dict, lon: float, lat: float, flood_dir: int, prev: dict | None) -> dict | None:
    """The nearest element's surface current along the flood axis, in knots, every currents step; with the previous
    file's older steps kept."""
    cos = math.cos(math.radians(lat))
    best, d2 = -1, math.inf
    for i, (x, y) in enumerate(mesh["centres"]):
        d = ((x - lon) * cos) ** 2 + (y - lat) ** 2
        if d < d2:
            best, d2 = i, d
    km = math.sqrt(d2) * 111.2
    if best < 0 or km > MAX_ELEMENT_KM:
        return None
    fx, fy = math.sin(math.radians(flood_dir)), math.cos(math.radians(flood_dir))
    t0 = datetime.strptime(currents["t0"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    step = int(currents["step"])
    vals: dict[datetime, float] = {}
    if prev and prev.get("t0") and prev.get("step") == step:
        p0 = datetime.strptime(prev["t0"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        for k, v in enumerate(prev.get("kt", [])):
            if v is not None:
                vals[p0 + timedelta(seconds=k * step)] = v
    for k in range(int(currents["steps"])):
        u, v = currents["u"][k][best], currents["v"][k][best]  # cm/s
        vals[t0 + timedelta(seconds=k * step)] = round((u * fx + v * fy) / 100 * 1.943844, 2)
    cutoff = now_utc() - timedelta(days=DAYS_BACK)
    times = sorted(t for t in vals if t >= cutoff)
    if not times:
        return None
    start = times[0]
    n = int((times[-1] - start).total_seconds() // step) + 1
    return {
        "t0": iso(start),
        "step": step,
        "kt": [vals.get(start + timedelta(seconds=k * step)) for k in range(n)],
        "element_km": round(km, 2),
        "run": currents.get("generated_at"),
    }


def publish(store: Store) -> list[str]:
    """Refresh the phase file: NOAA when due, NECOFS from the current currents file. Returns the points written."""
    end = now_utc()
    prev = store.read_json(KEY) or {}
    prev_points = {p["id"]: p for p in prev.get("points", [])}
    currents, mesh = store.read_json("v1/fields/currents.json"), store.read_json("v1/fields/currents-mesh.json")
    out = []
    for pid, name, station, binno, (lon, lat), scale in POINTS:
        before = prev_points.get(pid, {})
        noaa = before.get("noaa")
        fetched = datetime.strptime(noaa["fetched"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) if noaa else None
        if noaa is None or fetched is None or end - fetched > timedelta(hours=NOAA_REFRESH_HOURS):
            try:
                noaa = noaa_part(station, binno, end)
            except Exception as exc:  # keep the last predictions; they stay valid
                log.warning("NOAA predictions for %s not refreshed: %s", station, exc)
        necofs = before.get("necofs")
        if currents and mesh and noaa:
            necofs = necofs_part(currents, mesh, lon, lat, noaa["flood_dir"], necofs) or necofs
        out.append({"id": pid, "name": name, "lon": lon, "lat": lat, "scale_kt": scale, "noaa": noaa, "necofs": necofs})
    store.write_json(KEY, {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": "NOAA CO-OPS tidal current predictions (harmonic stations, bin nearest the surface); NECOFS FVCOM "
        "surface current at the nearest element, along the station's flood direction",
        "units": {"kt": "knots along the flood direction (positive flood, negative ebb)"},
        "points": out,
    }, max_age=1800)
    return [p["id"] for p in out]
