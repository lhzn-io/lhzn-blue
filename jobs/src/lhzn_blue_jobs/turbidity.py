"""Turbidity at the buoys (optical backscatter sensors at 1 m), published with its reliability.

These sensors foul. In warm water a film of algae, and later barnacles, grows on the optical window within weeks;
the reading climbs steadily (from a 1 to 2 NTU baseline to tens of NTU by late summer) though the water has not
changed, and servicing (cleaning) drops it back to baseline in one step. Some stretches also stick at one value.
So every reading is checked and kept, with the result of the check, rather than dropped quietly:

- range: readings outside -2 to 1000 NTU are dropped (small negatives are a calibration offset near zero);
- stuck: a run of 8 or more identical readings (2 hours at 15-minute sampling) is dropped;
- fouling: a day whose 10th percentile exceeds 5 NTU is flagged suspect (kept, drawn faintly, and named). Clean
  open water in the Sound sits near 1 NTU between storms, and even a storm's resuspension leaves the day's quietest
  readings low; a fouled window lifts every reading, the quietest included.

Published layout (under ``<root>/v1/``):

- ``live.json`` (key ``turbidity``): per buoy, the last 100 days hourly (``turb_ntu``, the median of the hour's
  readings, and ``suspect``, 1 where the day is flagged), the latest reading, and the share of suspect hours in the
  last 30 days. Written by the live job.
- ``history-turbidity.json``: the full hourly record per buoy, rebuilt daily, never dropping an hour it held;
  loaded only by the Rivers view.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

import pandas as pd

from . import merlin
from .build import LIVE_FETCH_HOURS, MET_WINDOW_HOURS, SCHEMA, Store, _num, decode_frame, encode_frame, iso, load_stations, now_utc

log = logging.getLogger(__name__)

COLUMN = "turbidity_NTU"
RANGE = (-2.0, 1000.0)
STUCK_RUN = 8
FOULING_P10 = 5.0  # NTU: a day whose quietest tenth of readings sits above this is flagged
DECIMALS = {"turb_ntu": 2, "suspect": 0}
QC_DESCRIPTION = (
    f"Turbidity: readings outside {RANGE[0]:g} to {RANGE[1]:g} NTU and runs of {STUCK_RUN} or more identical readings "
    f"are dropped; a day whose 10th percentile is above {FOULING_P10:g} NTU is flagged as likely sensor fouling, kept and "
    "drawn faintly."
)


def turbidity_stations() -> list[tuple[dict, dict]]:
    return [(st, st["turbidity"]) for st in load_stations()["stations"] if st.get("turbidity", {}).get("dataset")]


def checked(df: pd.DataFrame) -> pd.DataFrame:
    """Range and stuck tests on the raw readings; returns time-indexed ``ntu`` with failures removed."""
    if df.empty or COLUMN not in df.columns:
        return pd.DataFrame({"ntu": pd.Series(dtype=float, index=pd.DatetimeIndex([], tz="UTC"))})
    s = pd.to_numeric(df.sort_values("time").drop_duplicates("time").set_index("time")[COLUMN], errors="coerce")
    s = s.where((s >= RANGE[0]) & (s <= RANGE[1]))
    # Stuck: runs of identical values (a new run starts wherever the value changes).
    run_id = (s != s.shift()).cumsum()
    run_len = s.groupby(run_id).transform("size")
    s = s.where(~((run_len >= STUCK_RUN) & s.notna()))
    return pd.DataFrame({"ntu": s.dropna()})


def hourly(df: pd.DataFrame) -> pd.DataFrame:
    """Hourly median of the checked readings, with the fouling flag of the reading's (UTC) day."""
    good = checked(df)
    if good.empty:
        return pd.DataFrame(columns=["turb_ntu", "suspect"], index=pd.DatetimeIndex([], tz="UTC"), dtype=float)
    p10 = good["ntu"].resample("D").quantile(0.1)
    flag = (p10 > FOULING_P10).astype(float)
    h = good["ntu"].resample("h").median().dropna()
    suspect = flag.reindex(h.index.floor("D")).to_numpy()
    return pd.DataFrame({"turb_ntu": h, "suspect": suspect}, index=h.index)


def last_observation(df: pd.DataFrame) -> dict | None:
    good = checked(df)
    if good.empty:
        return None
    t = good.index[-1]
    return {"time": iso(t), "turb_ntu": _num(good["ntu"].iloc[-1])}


def _merge(fresh: pd.DataFrame, held: pd.DataFrame) -> pd.DataFrame:
    if fresh.empty:
        return held
    if held.empty:
        return fresh
    return fresh.combine_first(held)


def _suspect_share(frame: pd.DataFrame, end: datetime) -> float | None:
    if frame.empty or "suspect" not in frame.columns:
        return None
    recent = frame[frame.index >= pd.Timestamp(end) - pd.Timedelta(days=30)]["suspect"].dropna()
    return None if recent.empty else round(float(recent.mean()), 2)


def live(prev: dict, prev_datasets: dict, out_datasets: dict, end: datetime) -> dict:
    """The last 100 days of turbidity per buoy, hourly, with the fouling flag and the latest reading."""
    out: dict = {}
    window_start = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=MET_WINDOW_HOURS)
    for st, cfg in turbidity_stations():
        ds = cfg["dataset"]
        before = prev.get(st["id"], {})
        window = decode_frame(before)
        last_obs = before.get("last_obs")
        status = dict(prev_datasets.get(ds, {}))
        # A day's flag needs the whole day: refetch from the start of the earliest day the short window touches.
        hours = LIVE_FETCH_HOURS + 24 if before.get("t0") else MET_WINDOW_HOURS
        start = (pd.Timestamp(end) - pd.Timedelta(hours=hours)).floor("D").to_pydatetime()
        try:
            df = merlin.fetch(ds, start, end + timedelta(hours=1), [COLUMN])
            window = _merge(hourly(df), window)
            last_obs = last_observation(df) or last_obs
            status.update({"last_ok": iso(end), "rows": int(len(df))})
            status.pop("last_error", None)
        except Exception as exc:  # keep the last good values; record the failure
            log.warning("live turbidity fetch failed for %s: %s", ds, exc)
            status.update({"last_error": f"{iso(end)} {exc.__class__.__name__}: {str(exc)[:200]}"})
        if not window.empty:
            window = window[window.index >= window_start]
        obj = encode_frame(window, DECIMALS)
        obj.update({"last_obs": last_obs, "dataset": ds, "suspect_30d": _suspect_share(window, end)})
        out[st["id"]] = obj
        out_datasets[ds] = status
    return out


def history(store: Store) -> dict:
    """The full hourly turbidity record per buoy, over the previous build."""
    end = now_utc()
    prev = (store.read_json("v1/history-turbidity.json") or {}).get("stations", {})
    stations: dict = {}
    meta: dict = {}
    for st, cfg in turbidity_stations():
        sid = st["id"]
        held = decode_frame(prev.get(sid))
        error = None
        try:
            df = merlin.fetch_years(cfg["dataset"], cfg.get("first_year", 2019), end, [COLUMN])
            held = _merge(hourly(df), held)
        except Exception as exc:  # keep what we hold
            log.warning("turbidity history fetch failed for %s: %s", cfg["dataset"], exc)
            error = str(exc)[:200]
        obj = encode_frame(held.sort_index(), DECIMALS) if not held.empty else {"t0": None, "step": 3600}
        stations[sid] = obj
        n = int(held["turb_ntu"].notna().sum()) if not held.empty else 0
        flagged = int((held["suspect"] == 1).sum()) if not held.empty else 0
        meta[sid] = {
            "dataset": cfg["dataset"],
            "depth_m": cfg.get("depth_m"),
            "record_start": obj.get("t0"),
            "hours": n,
            "suspect_share": round(flagged / n, 2) if n else None,
            "error": error,
        }
    return {"schema": SCHEMA, "generated_at": iso(end), "qc": QC_DESCRIPTION, "meta": meta, "stations": stations}
