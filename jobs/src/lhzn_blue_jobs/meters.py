"""NOAA PORTS current meters on the Sound's page (``meters`` in ``stations/shore.json``): every bin, hourly.

A side-looking meter on a pier (nl0101 at Groton, in the Thames River) measures across the channel in bins at set
distances from the pier. Each bin's 6-minute readings (speed and the direction the water moves toward) are resolved
onto the meter's flood direction and across it, and each part averaged by the hour, in knots: ``kt`` along the flood
direction (positive flood, negative ebb) and ``x_kt`` across it (positive 90 degrees clockwise of the flood). The two
give the hour's mean speed and direction. The last 30 days are kept; each run fetches the last few hours of each bin
(more after missed runs) and merges them over the held window, fresh values winning. A failed bin keeps its previous
values and records the error.

Published inside ``v1/shore.json`` as its ``meters`` part (the file the live job already writes every hour), so a
meter costs no Workers KV writes of its own. NOAA's prediction and the NECOFS model at the meter come from
``v1/current-phase.json`` (phase.py), which already pairs the two at its reference points.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from . import coops
from .build import iso

log = logging.getLogger(__name__)

WINDOW_HOURS = 30 * 24
FETCH_HOURS = 6
CMS_TO_KT = 0.01943844
MAX_CMS = 400.0  # above any tidal current in the Thames at Groton: a reading this fast is a bad ping
PARTS = ("kt", "x_kt")  # along the flood direction, and across it


def _hour(ts) -> pd.Timestamp:
    return pd.Timestamp(ts).tz_convert("UTC").floor("h")


def _frame(obj: dict | None) -> pd.DataFrame:
    """A held bin ({t0, step, kt, x_kt}) as an hourly frame (a bin from before ``x_kt`` reads it as missing)."""
    if not obj or not obj.get("t0"):
        return pd.DataFrame(columns=list(PARTS), dtype=float)
    idx = pd.date_range(pd.Timestamp(obj["t0"]), periods=len(obj["kt"]), freq=pd.Timedelta(seconds=obj["step"]))
    cols = {p: [np.nan if v is None else v for v in (obj.get(p) or [None] * len(idx))] for p in PARTS}
    return pd.DataFrame(cols, index=idx, dtype=float).dropna(how="all")


def parts_hourly(rows: list[dict], flood_dir: float) -> tuple[pd.DataFrame, dict | None]:
    """6-minute readings ({t, s cm/s, d toward}) as hourly means along and across the flood direction, in knots; and
    the last reading that passed the range check."""
    if not rows:
        return pd.DataFrame(columns=list(PARTS), dtype=float), None
    df = pd.DataFrame(rows)
    df.index = pd.to_datetime(df["t"], utc=True)
    s = pd.to_numeric(df["s"], errors="coerce").where(lambda v: v.between(0, MAX_CMS))
    d = pd.to_numeric(df["d"], errors="coerce")
    rel = np.deg2rad(d - flood_dir)
    parts = pd.DataFrame({"kt": s * np.cos(rel) * CMS_TO_KT, "x_kt": s * np.sin(rel) * CMS_TO_KT})
    hourly = parts.resample("h").mean().dropna(how="all").round(2)
    good = pd.DataFrame({"s": s, "d": d, "a": parts["kt"]}).dropna()
    last = None
    if not good.empty:
        r = good.iloc[-1]
        last = {"time": iso(good.index[-1]), "spd_kt": round(float(r["s"]) * CMS_TO_KT, 2), "dir_deg": int(r["d"]),
                "along_kt": round(float(r["a"]), 2)}
    return hourly, last


def _encode(f: pd.DataFrame, start: pd.Timestamp, end: pd.Timestamp) -> dict:
    f = f[(f.index >= start) & (f.index <= end)]
    if f.empty:
        return {"t0": None, "step": 3600, **{p: [] for p in PARTS}}
    idx = pd.date_range(f.index[0], f.index[-1], freq="h")
    f = f.reindex(idx)
    return {"t0": iso(idx[0]), "step": 3600, **{p: [None if math.isnan(v) else float(v) for v in f[p].to_numpy()] for p in PARTS}}


def live(prev: dict | None, end: datetime, meters: list[dict]) -> dict:
    """The ``meters`` part of ``v1/shore.json``: per meter, each bin's last 30 days hourly along and across the flood
    direction, the latest reading at the real-time bin, and the fetch status."""
    prev = prev or {}
    window_start = _hour(end) - pd.Timedelta(hours=WINDOW_HOURS)
    stop = _hour(end) + pd.Timedelta(hours=1)
    out = {}
    for m in meters:
        before = prev.get(m["id"], {})
        bins_out, errors, rows = {}, [], 0
        last_obs = before.get("last_obs")
        for n in range(1, len(m["bins_m"]) + 1):
            held = _frame((before.get("bins") or {}).get(str(n)))
            # A bin held from before the across part was kept refetches its whole window once.
            if held.empty or held["x_kt"].isna().all():
                start = window_start
            else:
                start = max(window_start, min(pd.Timestamp(end) - pd.Timedelta(hours=FETCH_HOURS), held.index[-1]))
            try:
                vals = []
                for lo, hi in coops.spans(start.to_pydatetime(), end + timedelta(minutes=1), hourly=False):
                    body = coops._get({"product": "currents", "station": m["coops_id"], "bin": n,
                                       "begin_date": coops._stamp(lo), "end_date": coops._stamp(hi - timedelta(minutes=1))}) or {}
                    vals += body.get("data") or []
                rows += len(vals)
                fresh, last = parts_hourly(vals, m["flood_dir"])
                held = fresh.combine_first(held) if not held.empty else fresh
                if n == m["realtime_bin"] and last:
                    last_obs = last
            except Exception as exc:  # keep the held window; record the failure
                log.warning("%s bin %d fetch failed: %s", m["coops_id"], n, exc)
                errors.append(f"bin {n}: {exc.__class__.__name__}: {str(exc)[:120]}")
            bins_out[str(n)] = _encode(held, window_start, stop)
        status = dict(before.get("status") or {})
        status["rows"] = rows
        if errors:
            status["last_error"] = f"{iso(end)} " + "; ".join(errors)
        else:
            status["last_ok"] = iso(end)
            status.pop("last_error", None)
        out[m["id"]] = {
            "coops_id": m["coops_id"],
            "flood_dir": m["flood_dir"],
            "realtime_bin": m["realtime_bin"],
            "bins_m": m["bins_m"],
            "beam_dir": m.get("beam_dir"),
            "bins": bins_out,
            "last_obs": last_obs,
            "status": status,
        }
    return out
