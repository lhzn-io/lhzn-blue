"""NWS marine advisories and warnings for the Sound's forecast zones, from 2005, with the zone each station is in.

The record is the Iowa Environmental Mesonet's archive of NWS VTEC events (``json/vtec_events_byugc.php``), one
request per zone. NWS New York (OKX) issues them for three zones on the Sound:

- ANZ335, west of New Haven CT / Port Jefferson NY (one zone throughout);
- ANZ331, east of there to the mouth of the Connecticut River, and ANZ332, east of the mouth; until March 2021 these
  two were one zone, ANZ330, whose events stand for both before the split.

An event is listed once per product that touched it (issue, extensions, cancellation), so rows that share an event
(office, VTEC year, phenomenon, significance, event number, zone) are merged into one interval, from the earliest
start to the latest end. Watches and statements are left out; warnings and advisories are kept.

Each station takes the zone whose outline contains it, or the nearest one (harbour gauges sit inside the coastline,
outside every marine zone), from the zone outlines on api.weather.gov.

Writes ``v1/advisories.json``. The full record is fetched when there is no previous file; otherwise each run refetches
from January 1 of the previous year and keeps the earlier events as they were.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from datetime import datetime
from pathlib import Path

import requests

from .build import SCHEMA, Store, iso, load_stations, now_utc

log = logging.getLogger(__name__)

KV_KEY = "v1/advisories.json"
IEM = "https://mesonet.agron.iastate.edu/json/vtec_events_byugc.php"
NWS_ZONE = "https://api.weather.gov/zones/marine/{}"
UA = {"User-Agent": "longhorizon.blue ingest (https://longhorizon.blue; dfry@lhzn.io)"}
START = "2005-01-01"
MAX_ROW_DAYS = 5  # a single product valid this long is an archive artefact (the longest real ones run about 3 days)
ZONES = ["ANZ335", "ANZ331", "ANZ332"]
SPLIT = {"ANZ330": {"until": "2021-04-01T00:00Z", "into": ["ANZ331", "ANZ332"],
                    "name": "Long Island Sound East of New Haven CT/Port Jefferson NY"}}
# The kinds kept (VTEC phenomenon.significance), most severe first.
KINDS = {
    "HF.W": "Hurricane Force Wind Warning",
    "HU.W": "Hurricane Warning",
    "TR.W": "Tropical Storm Warning",
    "SR.W": "Storm Warning",
    "GL.W": "Gale Warning",
    "SE.W": "Hazardous Seas Warning",
    "SC.Y": "Small Craft Advisory",
    "MA.W": "Special Marine Warning",
    "MF.Y": "Dense Fog Advisory",
    "UP.Y": "Freezing Spray Advisory",
    "LO.Y": "Low Water Advisory",
}
SHORE_FILE = Path(
    os.environ.get("LHZN_BLUE_SHORE_STATIONS", Path(__file__).resolve().parents[3] / "stations" / "shore.json")
)
USGS_FILE = Path(
    os.environ.get("LHZN_BLUE_USGS_TIDAL", Path(__file__).resolve().parents[3] / "stations" / "usgs-tidal.json")
)


def _stations() -> dict[str, tuple[float, float]]:
    pts = {s["id"]: (s["lon"], s["lat"]) for s in load_stations()["stations"]}
    pts |= {s["id"]: (s["lon"], s["lat"]) for s in json.loads(SHORE_FILE.read_text())["stations"]}
    pts |= {g["id"]: (g["lon"], g["lat"]) for g in json.loads(USGS_FILE.read_text())["gauges"]}
    return pts


def _zone(z: str) -> tuple[str, list[list[tuple[float, float]]]]:
    """A zone's name and outer rings, from api.weather.gov."""
    r = requests.get(NWS_ZONE.format(z), headers={**UA, "Accept": "application/geo+json"}, timeout=60)
    r.raise_for_status()
    j = r.json()
    g = j["geometry"]
    polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
    return j["properties"]["name"], [[tuple(p) for p in poly[0]] for poly in polys]


def _inside(x: float, y: float, ring: list[tuple[float, float]]) -> bool:
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def _km_to_ring(x: float, y: float, ring: list[tuple[float, float]]) -> float:
    """Distance (km) from a point to the nearest vertex or edge of a ring, in a local flat frame."""
    kx = 111.2 * math.cos(math.radians(y))
    best = math.inf
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        ax, ay, bx, by = (x1 - x) * kx, (y1 - y) * 111.2, (x2 - x) * kx, (y2 - y) * 111.2
        dx, dy = bx - ax, by - ay
        t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def zones_and_stations() -> dict:
    """{zone: {name, stations: [ids]}}: each station in the zone containing it, else the nearest."""
    outlines = {z: _zone(z) for z in ZONES}
    out: dict = {z: {"name": name, "stations": []} for z, (name, _) in outlines.items()}
    for sid, (x, y) in _stations().items():
        inside = [z for z, (_, rings) in outlines.items() if any(_inside(x, y, r) for r in rings)]
        z = inside[0] if inside else min(outlines, key=lambda z: min(_km_to_ring(x, y, r) for r in outlines[z][1]))
        out[z]["stations"].append(sid)
    return out


def _fetch(zone: str, sdate: str, edate: str) -> list[dict]:
    r = requests.get(IEM, params={"ugc": zone, "sdate": sdate, "edate": edate}, headers=UA, timeout=120)
    r.raise_for_status()
    return r.json().get("events", [])


def _minute(t: str) -> str:
    return datetime.fromisoformat(t.replace("Z", "+00:00")).strftime("%Y-%m-%dT%H:%MZ")


def merge(rows: list[dict], excluded: list | None = None) -> list[list[str]]:
    """Rows merged per event: [[kind, start, end, event key], ...] sorted by start. Rows sharing an event number
    are one event only where their intervals overlap or touch: the archive has event numbers reused within a year,
    which merged blindly would make a single advisory run for months. A reused number gets a suffix (".b", ".c")."""
    by_key: dict[tuple, list[tuple[str, str]]] = {}
    for e in rows:
        kind = f"{e['phenomena']}.{e['significance']}"
        if kind not in KINDS or not e.get("issue") or not e.get("expire"):
            continue
        year = e["url"].split("year=")[1][:4] if "year=" in (e.get("url") or "") else e["issue"][:4]
        s, t = _minute(e["issue"]), _minute(e["expire"])
        if t <= s:
            continue
        if (datetime.fromisoformat(t[:-1]) - datetime.fromisoformat(s[:-1])).days >= MAX_ROW_DAYS:
            # One product valid for weeks: the archive stretched an event to a later reissue of its number
            # (e.g. 2012-11-08 to 12-06). Its true end is unknown, so the row is left out and listed.
            if excluded is not None:
                excluded.append([kind, s, t, f"{e['wfo']}.{year}.{kind}.{int(e['eventid']):04d}"])
            continue
        by_key.setdefault((e["wfo"], year, kind, int(e["eventid"])), []).append((s, t))
    out: list[list[str]] = []
    for (wfo, year, kind, num), spans in by_key.items():
        spans.sort()
        groups: list[list[str]] = []
        for s, t in spans:
            if groups and s <= groups[-1][1]:  # an extension or update: overlaps the event so far
                groups[-1][1] = max(groups[-1][1], t)
            else:
                groups.append([s, t])
        for i, (s, t) in enumerate(groups):
            out.append([kind, s, t, f"{wfo}.{year}.{kind}.{num:04d}" + (f".{chr(97 + i)}" if i else "")])
    return sorted(out, key=lambda g: (g[1], g[0]))


NOW_KEY = "v1/advisories-now.json"
NWS_ACTIVE = "https://api.weather.gov/alerts/active"
# Plain names for the page's banner, west to east.
ZONE_LABELS = {"ANZ335": "western Sound", "ANZ331": "central Sound", "ANZ332": "eastern Sound"}


IEM_EVENT = "https://mesonet.agron.iastate.edu/json/vtec_event.py"
VTEC = re.compile(r"/O\.[A-Z]{3}\.K([A-Z]{3})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.")


def _event_times(vtec: str, sent: str, zones: list[str]) -> dict:
    """When the event was first issued for these zones, and each zone's span, from IEM's record of the event (NWS's
    active alert carries only its latest update). Empty when the record is unavailable: the banner then shows the
    update time alone."""
    m = VTEC.match(vtec)
    if not m:
        return {}
    wfo, ph, sig, etn = m.groups()
    year = int(sent[:4]) if sent[:4].isdigit() else now_utc().year
    try:
        r = requests.get(IEM_EVENT, params={"wfo": wfo, "year": year, "phenomena": ph, "significance": sig, "etn": int(etn)},
                         headers=UA, timeout=30)
        r.raise_for_status()
        rows = [u for u in r.json().get("ugcs", []) if u.get("ugc") in zones]
    except Exception as exc:  # the banner still works on NWS's own times
        log.warning("advisories: IEM event %s.%s.%s.%s unavailable (%s)", wfo, ph, sig, etn, exc)
        return {}
    if not rows:
        return {}
    z = lambda t: t.replace("Z", "+00:00") if t else None  # noqa: E731
    per = {u["ugc"]: {"issued": z(u.get("utc_product_issue")), "from": z(u.get("utc_issue")), "until": z(u.get("utc_expire"))} for u in rows}
    return {"issued": min(v["issued"] for v in per.values() if v["issued"]), "by_zone": per}


def now() -> dict:
    """The warnings and advisories in force now for the Sound's zones, from NWS (api.weather.gov), for the page's
    banner. Refreshed by the hourly live job; the daily record (`publish`) comes from the IEM archive."""
    r = requests.get(NWS_ACTIVE, params={"zone": ",".join(ZONES)}, headers={**UA, "Accept": "application/geo+json"}, timeout=60)
    r.raise_for_status()
    names = set(KINDS.values())
    alerts = []
    for f in r.json().get("features", []):
        p = f.get("properties", {})
        if p.get("status") != "Actual" or p.get("event") not in names or p.get("messageType") == "Cancel":
            continue
        zones = [z for z in ZONES if z in (p.get("geocode", {}).get("UGC") or [])]
        if not zones:
            continue
        vtec = (p.get("parameters", {}).get("VTEC") or [""])[0]
        kind = next((k for k, v in KINDS.items() if v == p["event"]), "")
        alert = {
            "event": p["event"],
            "kind": kind,
            "zones": zones,
            "ends": p.get("ends") or p.get("expires"),
            "updated": p.get("sent") or p.get("effective"),  # this message: the latest update, not the first issue
            "vtec": vtec,
        }
        alert.update(_event_times(vtec, p.get("sent") or "", zones))
        alerts.append(alert)
    return {
        "schema": SCHEMA,
        "generated_at": iso(now_utc()),
        "source": "NWS New York (OKX), active alerts from api.weather.gov",
        "zones": ZONE_LABELS,
        "alerts": alerts,
    }


def publish(store: Store) -> dict:
    end = now_utc()
    prev = store.read_json(KV_KEY)
    edate = end.strftime("%Y-%m-%d")
    since = START if not prev else f"{end.year - 1}-01-01"
    events: dict[str, list] = {z: list(evs) for z, evs in (prev or {}).get("events", {}).items()}
    excluded: dict[str, list] = {z: list(evs) for z, evs in (prev or {}).get("excluded", {}).items()}
    for z in ZONES + list(SPLIT):
        if z in SPLIT and prev:  # the retired zone's record is complete
            continue
        rows = _fetch(z, since, edate)
        dropped: list = []
        merged = merge(rows, dropped)
        excluded[z] = sorted({e[3] + e[1]: e for e in excluded.get(z, []) + dropped}.values(), key=lambda e: e[1])
        # Union with what we held, per event: an event refetched in part (extended after `since`) keeps its start.
        by: dict[str, list] = {}
        for e in events.get(z, []) + merged:
            if e[3] in by:
                g = by[e[3]]
                g[1], g[2] = min(g[1], e[1]), max(g[2], e[2])
            else:
                by[e[3]] = list(e)
        events[z] = sorted(by.values(), key=lambda e: (e[1], e[0]))
        log.info("advisories %s: %d rows, %d events", z, len(rows), len(merged))
    try:
        zones = zones_and_stations()
    except Exception as exc:  # keep the last known zones
        if not prev:
            raise
        log.warning("advisories: zone outlines unavailable (%s); keeping the previous", exc)
        zones = prev["zones"]
    out = {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "source": "NWS New York (OKX) marine warnings and advisories, from the Iowa Environmental Mesonet VTEC archive; "
        "zones from api.weather.gov",
        "kinds": KINDS,
        "zones": zones,
        "retired": SPLIT,
        "events": dict(events),
        "excluded": {z: e for z, e in excluded.items() if e},  # archive rows left out (see merge), for the record
    }
    store.write_json(KV_KEY, out, max_age=3600)
    return out
