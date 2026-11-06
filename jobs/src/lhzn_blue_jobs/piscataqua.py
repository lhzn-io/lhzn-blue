"""NOAA's tidal current predictions at a CO-OPS current station, for the Piscataqua Region page (region.py): 30-minute
values in cm/s along the flood axis (flood positive), with the slack, flood and ebb times."""

from __future__ import annotations

from datetime import datetime

import pandas as pd

from insitukit import coops

from .build import iso

CURRENT = {"id": "PIR0701", "name": "Portsmouth Harbor Entrance", "lat": 43.0624, "lon": -70.7053}


def _grid(s: pd.Series, start: pd.Timestamp, step_s: int, digits: int) -> dict:
    s = s.dropna()
    s = s[s.index >= start]
    if s.empty:
        return {"t0": iso(start), "step": step_s, "v": []}
    idx = pd.date_range(start.ceil(f"{step_s}s"), s.index[-1], freq=f"{step_s}s")
    full = s.reindex(idx)
    return {"t0": iso(idx[0]), "step": step_s, "v": [None if pd.isna(v) else round(float(v), digits) for v in full]}


def current_part(start: datetime, end: datetime, station: dict = CURRENT) -> dict:
    """NOAA's tidal current predictions for ``station`` (PIR0701 by default; the region page passes its own)."""
    # insitukit gives m/s; this file keeps NOAA's cm/s (rounded back to the 0.1 cm/s NOAA publishes).
    pred = coops.current_predictions(station["id"], start, end, interval=30)
    s = pd.Series((pred["velocity_major"] * 100).round(4).to_numpy(), index=pred["time"])
    meta: dict = {}
    if not pred.empty:
        a = pred.attrs
        meta = {"flood_dir": _whole(a.get("flood_dir_deg")), "ebb_dir": _whole(a.get("ebb_dir_deg")),
                "depth_m": float("nan") if a.get("depth_m") is None else a["depth_m"]}
    ev = coops.current_predictions(station["id"], start, end, interval="MAX_SLACK")
    events = [{"t": iso(t), "type": k, "v": round(float(v) * 100, 4)}
              for t, k, v in zip(ev["time"], ev["type"], ev["velocity_major"])]
    return {**station, "units": "cm/s", "positive": "flood", **meta, **_grid(s, pd.Timestamp(start), 1800, 1), "events": events}


def _whole(x: float | None) -> int | float | None:
    """A direction as NOAA writes it: whole degrees as an integer."""
    return int(x) if x is not None and float(x).is_integer() else x
