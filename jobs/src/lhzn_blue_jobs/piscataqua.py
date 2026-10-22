"""The Piscataqua River mouth: the UNH G-2000 buoy's current profiler, with NOAA tide and tidal current data nearby.

Writes ``v1/piscataqua.json`` for the (unlisted) /piscataqua/ page:

- ``buoy``: the last 30 days of the buoy's Nortek Aquapro current profiler (the logger table ``ZCelEngData``, one
  record every 10 minutes, 20 cells), read from the end of the logger file the buoy's shore PC uploads to Google
  Cloud Storage (``LHZN_BLUE_AQUAFORT``). Only the file's tail is downloaded. Speeds in cm/s and directions in
  degrees, as logged; each record carries a quality flag (QARTOD convention: 1 pass, 3 suspect, 4 fail).
- ``water_level``: NOAA CO-OPS 8419870 Seavey Island, observed water level (6-minute, metres above MLLW).
- ``tide``: NOAA CO-OPS 8423898 Fort Point, tide predictions (6-minute) and the highs and lows.
- ``current``: NOAA CO-OPS PIR0701 Portsmouth Harbor Entrance, tidal current predictions (30-minute, cm/s along
  the flood axis, flood positive) and the slack, flood and ebb times.

The record window is the buoy's last 30 days (whenever they were), and the NOAA series span from the start of
that window, at most 45 days back, to 2 days ahead. Any part that cannot be fetched keeps the previous file's
copy, so a NOAA outage or a missing logger file never blanks the rest of the page.
"""

from __future__ import annotations

import csv
import io
import logging
import math
import os
from datetime import datetime, timedelta, timezone

import pandas as pd

from . import coops
from .build import iso, now_utc

log = logging.getLogger(__name__)

SCHEMA = 1
SOURCE = os.environ.get("LHZN_BLUE_AQUAFORT", "gs://unh-aquafort-data/UNH-G2000B_ZCelEngData.dat")
TAIL_BYTES = 3_200_000  # about 40 days of 10-minute records (about 520 bytes each)
HEAD_BYTES = 4096
WINDOW_DAYS = 30
MAX_BACK_DAYS = 45
AHEAD_DAYS = 2
CELLS = 20
TILT_SUSPECT = 20.0  # degrees of pitch and roll combined
SPEED_FAIL = 300.0  # cm/s; the entrance's predicted maximum is about 60 cm/s at the surface

BUOY = {
    "name": "UNH G-2000 buoy",
    "lat": 43.0687,
    "lon": -70.7079,
    "position_as_of": "2024-11-21",
    "owner": "University of New Hampshire",
    "instrument": "Nortek Aquapro current profiler, 20 cells, every 10 minutes",
}
WL = {"id": "8419870", "name": "Seavey Island, ME", "lat": 43.0797, "lon": -70.7411}
TIDE = {"id": "8423898", "name": "Fort Point, NH", "lat": 43.0717, "lon": -70.7117}
CURRENT = {"id": "PIR0701", "name": "Portsmouth Harbor Entrance", "lat": 43.0624, "lon": -70.7053}


# ---------------------------------------------------------------------------------------------
# The buoy


def _read_tail(uri: str) -> tuple[list[str], str, str]:
    """The logger file's column names, the text of its last TAIL_BYTES, and the object's update time."""
    if uri.startswith("gs://"):
        from google.cloud import storage

        bucket, _, name = uri[5:].partition("/")
        blob = storage.Client().bucket(bucket).get_blob(name)
        if blob is None:
            raise FileNotFoundError(uri)
        head = blob.download_as_bytes(start=0, end=HEAD_BYTES - 1).decode("utf-8", "replace")
        start = max(0, blob.size - TAIL_BYTES)
        tail = blob.download_as_bytes(start=start).decode("utf-8", "replace")
        updated = iso(blob.updated)
    else:  # a local copy, for development
        with open(uri, "rb") as fh:
            head = fh.read(HEAD_BYTES).decode("utf-8", "replace")
            fh.seek(0, 2)
            size = fh.tell()
            start = max(0, size - TAIL_BYTES)
            fh.seek(start)
            tail = fh.read().decode("utf-8", "replace")
        updated = iso(datetime.fromtimestamp(os.path.getmtime(uri), timezone.utc))
    if start:
        tail = tail.split("\n", 1)[1] if "\n" in tail else ""  # drop the partial first line
    names = next(csv.reader(io.StringIO(head.splitlines()[1])))
    return names, tail, updated


def _num(x: str) -> float:
    try:
        v = float(x)
    except ValueError:
        return math.nan
    return v if math.isfinite(v) else math.nan


def parse(names: list[str], text: str) -> pd.DataFrame:
    """Rows of the logger table as a frame indexed by UTC time (the logger keeps UTC)."""
    rows = [r for r in csv.reader(io.StringIO(text)) if len(r) == len(names) and r[0][:2] == "20"]
    df = pd.DataFrame(rows, columns=names)
    df.index = pd.to_datetime(df.pop("TIMESTAMP"), utc=True, errors="coerce")
    df = df[df.index.notna()]
    for c in df.columns:
        if c != "ZCelDateStr":
            df[c] = df[c].map(_num)
    return df[~df.index.duplicated(keep="last")].sort_index()


def flags(df: pd.DataFrame) -> pd.Series:
    """One flag per record: 4 when the instrument reports an error or a speed is impossible, 3 when it is tilted."""
    f = pd.Series(1, index=df.index)
    spd = df[[f"CurrSpd{i}" for i in range(1, CELLS + 1)]] * 100
    tilt = (df["ZCel_Pitch"] ** 2 + df["ZCel_Roll"] ** 2) ** 0.5
    f[tilt > TILT_SUSPECT] = 3
    f[(df["ZCel_ErrCd"].fillna(0) != 0) | (spd > SPEED_FAIL).any(axis=1) | spd.isna().all(axis=1)] = 4
    return f


def buoy_part(uri: str = SOURCE) -> dict:
    names, text, updated = _read_tail(uri)
    df = parse(names, text)
    if df.empty:
        raise ValueError(f"no records in the tail of {uri}")
    last = df.index[-1]
    df = df[df.index > last - pd.Timedelta(days=WINDOW_DAYS)]
    fl = flags(df)
    t0 = df.index[0]

    def cells(prefix: str, scale: float) -> list[list[int | None]]:
        block = df[[f"{prefix}{i}" for i in range(1, CELLS + 1)]].to_numpy() * scale
        return [[None if math.isnan(v) else int(round(v)) for v in row] for row in block]

    def col(name: str, digits: int) -> list[float | None]:
        return [None if math.isnan(v) else round(float(v), digits) for v in df[name]]

    return {
        **BUOY,
        "file_updated": updated,
        "last": iso(last),
        "t0": iso(t0),
        "t": [int((t - t0).total_seconds() // 60) for t in df.index],  # minutes after t0
        "spd": cells("CurrSpd", 100.0),  # cm/s, cell 1 nearest the surface
        "dir": cells("CurrDir", 1.0),  # degrees as logged
        "temp": col("ZCel_WTmp", 2),
        "pressure": col("ZCel_Press", 3),
        "heading": col("ZCel_Hdng", 1),
        "pitch": col("ZCel_Pitch", 1),
        "roll": col("ZCel_Roll", 1),
        "flag": [int(v) for v in fl],
    }


# ---------------------------------------------------------------------------------------------
# NOAA


def _grid(s: pd.Series, start: pd.Timestamp, step_s: int, digits: int) -> dict:
    s = s.dropna()
    s = s[s.index >= start]
    if s.empty:
        return {"t0": iso(start), "step": step_s, "v": []}
    idx = pd.date_range(start.ceil(f"{step_s}s"), s.index[-1], freq=f"{step_s}s")
    full = s.reindex(idx)
    return {"t0": iso(idx[0]), "step": step_s, "v": [None if pd.isna(v) else round(float(v), digits) for v in full]}


def _windows(start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    return coops.spans(start, end, hourly=False)


def water_level_part(start: datetime, end: datetime) -> dict:
    df = coops.fetch("water_level", WL["id"], start, end)
    s = pd.Series(df["water_level"].to_numpy(), index=df["time"])
    return {**WL, "datum": "MLLW", "units": "m", **_grid(s, pd.Timestamp(start), 360, 3)}


def tide_part(start: datetime, end: datetime) -> dict:
    vals: dict[pd.Timestamp, float] = {}
    for lo, hi in _windows(start, end):
        body = coops._get({"product": "predictions", "station": TIDE["id"], "datum": "MLLW", "interval": "6",
                           "begin_date": coops._stamp(lo), "end_date": coops._stamp(hi - timedelta(minutes=1))}) or {}
        for r in body.get("predictions") or []:
            vals[pd.Timestamp(r["t"], tz="UTC")] = float(r["v"])
    s = pd.Series(vals).sort_index()
    events = coops.tide_events(TIDE["id"], start, end)
    return {
        **TIDE, "datum": "MLLW", "units": "m", **_grid(s, pd.Timestamp(start), 360, 3),
        "hilo": [{"t": iso(e["time"]), "m": round(e["m"], 3), "type": e["type"]} for e in events],
    }


def current_part(start: datetime, end: datetime) -> dict:
    vals: dict[pd.Timestamp, float] = {}
    events: list[dict] = []
    meta: dict = {}
    for lo, hi in _windows(start, end):
        span = {"station": CURRENT["id"], "begin_date": coops._stamp(lo), "end_date": coops._stamp(hi - timedelta(minutes=1))}
        body = coops._get({"product": "currents_predictions", "interval": "30", **span}) or {}
        for r in (body.get("current_predictions") or {}).get("cp") or []:
            vals[pd.Timestamp(r["Time"], tz="UTC")] = float(r["Velocity_Major"])
            meta = {"flood_dir": r.get("meanFloodDir"), "ebb_dir": r.get("meanEbbDir"), "depth_m": float(r.get("Depth") or "nan")}
        body = coops._get({"product": "currents_predictions", "interval": "MAX_SLACK", **span}) or {}
        for r in (body.get("current_predictions") or {}).get("cp") or []:
            events.append({"t": iso(pd.Timestamp(r["Time"], tz="UTC")), "type": r.get("Type"), "v": float(r["Velocity_Major"])})
    s = pd.Series(vals).sort_index()
    return {**CURRENT, "units": "cm/s", "positive": "flood", **meta, **_grid(s, pd.Timestamp(start), 1800, 1), "events": events}


# ---------------------------------------------------------------------------------------------


def build(prev: dict | None = None, now: datetime | None = None, uri: str = SOURCE) -> dict:
    """The page's file; a part that fails keeps the previous file's copy (or is left out)."""
    now = now or now_utc()
    prev = prev or {}
    out: dict = {"schema": SCHEMA, "generated_at": iso(now)}
    try:
        out["buoy"] = buoy_part(uri)
    except Exception:
        log.exception("buoy profiler not refreshed")
        if prev.get("buoy"):
            out["buoy"] = prev["buoy"]
    back = now - timedelta(days=MAX_BACK_DAYS)
    start = now - timedelta(days=7)
    if out.get("buoy"):
        start = min(start, pd.Timestamp(out["buoy"]["t0"]).to_pydatetime())
    start = max(start, back).replace(minute=0, second=0, microsecond=0)
    end = now + timedelta(days=AHEAD_DAYS)
    try:  # new and full moons mark the spring tides on the page's daily strips
        from .tides import moon_phases

        out["moon"] = moon_phases(start - timedelta(days=2), end)
    except Exception:
        log.exception("moon phases not refreshed")
        if prev.get("moon"):
            out["moon"] = prev["moon"]
    for key, part, until in (("water_level", water_level_part, now), ("tide", tide_part, end), ("current", current_part, end)):
        try:
            out[key] = part(start, until)
        except Exception:
            log.exception("%s not refreshed", key)
            if prev.get(key):
                out[key] = prev[key]
    return out


def publish(store) -> None:
    store.write_json("v1/piscataqua.json", build(store.read_json("v1/piscataqua.json")), max_age=300)
