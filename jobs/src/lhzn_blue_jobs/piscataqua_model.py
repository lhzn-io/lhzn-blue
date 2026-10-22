"""NECOFS surface currents over the Piscataqua box in the past, for the /piscataqua/ page: the model beside the buoy.

The rolling NECOFS forecast (``fields.currents``) reaches a day back. For the hours before it, SMAST keeps one history
file per day (``NECOFS_GOM7_<D>.nc`` holds the hours after D-1 00:00 through D 00:00, the model's hindcast). This
module keeps the last ``HISTORY_DAYS`` of those hours for the box in one binary file, adding the days it lacks on each
run (at most ``max_new_days``), and builds the model's surface current at the buoy's element across the history and
the forecast, for the page's flood and ebb plot.

``v1/fields/piscataqua-currents-history.bin``: a little-endian uint32 header length, a JSON header (t0, step,
hours, elements, scale), then per hour ``elements`` int8 east components and ``elements`` int8 north components, in
units of ``scale`` cm/s; -128 marks an hour the archive did not have.
"""

from __future__ import annotations

import json
import logging
import struct
from datetime import datetime

import numpy as np
import pandas as pd

from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)


def _iso(t) -> str:
    """ISO time in UTC; the archive times are naive UTC."""
    t = pd.Timestamp(t)
    return iso(t.tz_localize("UTC") if t.tzinfo is None else t)

HISTORY_REL = "v1/fields/piscataqua-currents-history.bin"
HISTORY_DAYS = 45
SCALE = 2  # cm/s per int8 step: +-254 cm/s, beyond the harbour's 2 m/s peaks
MISSING = -128
ARCHIVE = "http://www.smast.umassd.edu:8080/thredds/dodsC/models/fvcom/NECOFS/Archive/necofs_history/NECOFS_GOM7_{d}.nc"
BUOY = (-70.7079, 43.0687)


def _decode(blob: bytes | None) -> tuple[dict, dict[pd.Timestamp, tuple[np.ndarray, np.ndarray]]]:
    if not blob:
        return {}, {}
    (n,) = struct.unpack("<I", blob[:4])
    head = json.loads(blob[4 : 4 + n])
    body = np.frombuffer(blob[4 + n :], dtype=np.int8)
    e = head["elements"]
    t0 = pd.Timestamp(head["t0"]).tz_convert(None)  # naive UTC, as the archive times
    hours = {}
    for k in range(head["hours"]):
        u = body[(2 * k) * e : (2 * k + 1) * e]
        v = body[(2 * k + 1) * e : (2 * k + 2) * e]
        if u[0] != MISSING:
            hours[t0 + pd.Timedelta(hours=k)] = (u, v)
    return head, hours


def _encode(hours: dict[pd.Timestamp, tuple[np.ndarray, np.ndarray]], elements: int, mesh_check: list) -> bytes:
    t0 = min(hours)
    t1 = max(hours)
    n = int((t1 - t0) / pd.Timedelta(hours=1)) + 1
    body = np.full((n, 2, elements), MISSING, dtype=np.int8)
    for t, (u, v) in hours.items():
        k = int((t - t0) / pd.Timedelta(hours=1))
        body[k, 0] = u
        body[k, 1] = v
    head = {
        "schema": SCHEMA, "t0": _iso(t0), "step": 3600, "hours": n, "elements": elements, "scale": SCALE,
        "missing": MISSING, "mesh_check": mesh_check, "source": "NECOFS FVCOM GOM7 daily history (hindcast), UMass Dartmouth (SMAST)",
    }
    h = json.dumps(head, separators=(",", ":")).encode()
    return struct.pack("<I", len(h)) + h + body.tobytes()


def _q(a: np.ndarray) -> np.ndarray:
    """m/s to int8 steps of SCALE cm/s (NaN, a dry element, as 0)."""
    return np.clip(np.round(np.nan_to_num(a) * 100.0 / SCALE), -127, 127).astype(np.int8)


def _exists(url: str) -> bool:
    import requests

    try:
        return requests.get(url + ".dds", timeout=20).status_code == 200
    except requests.RequestException:
        return False


def update(store: Store, bbox: list[float], mesh: dict, end: datetime | None = None, max_new_days: int = 6) -> dict:
    """Add the archive days the history lacks (newest first, at most max_new_days); returns a summary."""
    from forcingkit.fetchers import necofs

    end = end or now_utc()
    elements = len(mesh["centres"])
    mesh_check = mesh["centres"][:3]
    head, hours = _decode(store.read_bytes(HISTORY_REL))
    if head and (head.get("elements") != elements or head.get("mesh_check") != mesh_check):
        log.warning("piscataqua history: mesh changed; starting again")
        hours = {}
    start = (pd.Timestamp(end).tz_convert("UTC").tz_localize(None) - pd.Timedelta(days=HISTORY_DAYS)).normalize()
    hours = {t: uv for t, uv in hours.items() if t >= start}
    added = []
    today = pd.Timestamp(end).tz_convert("UTC").tz_localize(None).normalize()
    for file_day in pd.date_range(start + pd.Timedelta(days=1), today, freq="D")[::-1]:
        first = file_day - pd.Timedelta(hours=23)  # the file holds (D-1 00:00, D 00:00]
        want = pd.date_range(first, file_day, freq="h")
        if all(t in hours for t in want):
            continue
        if len(added) >= max_new_days:
            break
        url = ARCHIVE.format(d=file_day.strftime("%Y_%m_%d"))
        if not _exists(url):
            continue  # not published yet (or gone): try again next run
        try:
            ds = necofs.read_surface(bbox, first, 24, dap_url=url)
        except Exception:
            log.exception("piscataqua history: %s not read", url)
            continue
        if ds.sizes["element"] != elements:
            log.warning("piscataqua history: %s has %d elements, the mesh %d; skipped", url, ds.sizes["element"], elements)
            continue
        for i, t in enumerate(pd.DatetimeIndex(ds["time"].values)):
            hours[pd.Timestamp(t)] = (_q(ds["u"].values[i]), _q(ds["v"].values[i]))
        added.append(file_day.strftime("%Y-%m-%d"))
    if hours:
        store.write_bytes(HISTORY_REL, _encode(hours, elements, mesh_check), max_age=3600)
    return {"hours": len(hours), "added_days": added, "from": _iso(min(hours)) if hours else None, "to": _iso(max(hours)) if hours else None}


def at_buoy(store: Store, mesh: dict, forecast: dict) -> dict:
    """The model's surface current at the buoy's element, hourly, across the history and the forecast (cm/s); the
    history's hindcast wins where the two overlap."""
    c = np.array(mesh["centres"], dtype=float)
    cos = np.cos(np.radians(BUOY[1]))
    k = int(np.argmin(((c[:, 0] - BUOY[0]) * cos) ** 2 + (c[:, 1] - BUOY[1]) ** 2))
    series: dict[pd.Timestamp, tuple[float, float]] = {}
    t0 = pd.Timestamp(forecast["t0"]).tz_convert("UTC").tz_localize(None)
    for i in range(forecast["steps"]):
        series[t0 + pd.Timedelta(seconds=i * forecast["step"])] = (forecast["u"][i][k], forecast["v"][i][k])
    _, hours = _decode(store.read_bytes(HISTORY_REL))
    for t, (u, v) in hours.items():
        series[t] = (int(u[k]) * SCALE, int(v[k]) * SCALE)
    if not series:
        return {}
    ts = sorted(series)
    full = pd.date_range(ts[0], ts[-1], freq="h")
    return {
        "element": k, "lon": round(float(c[k, 0]), 5), "lat": round(float(c[k, 1]), 5), "t0": _iso(full[0]), "step": 3600, "units": "cm/s",
        "u": [series[t][0] if t in series else None for t in full],
        "v": [series[t][1] if t in series else None for t in full],
    }
