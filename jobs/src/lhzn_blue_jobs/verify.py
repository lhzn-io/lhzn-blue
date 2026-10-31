"""HRRR and GFS against the buoys: running verification statistics for the page, one set per model.

Each archived HRRR forecast at a buoy (issue time, valid time, lead) is paired with the buoy's hourly observation
for the hour that starts at the valid time: the same hourly means the page shows (wind and air temperature means,
pressure mean, speed-weighted direction turned to true north). Errors are forecast minus observed:

- wind speed (kt) at 10 m: the buoy's speed raised from the anemometer's height (ANEMOMETER_M, assumed until the
  LISICOS buoy configuration confirms it) with a neutral log profile over open water (roughness Z0_M);
- direction, where the observed wind is DIR_MIN_KT or more: degrees clockwise, -180 to 180;
- air temperature (C), HRRR's 2 m against the buoy's sensor;
- sea-level pressure (mb), HRRR's MSLMA against the buoy's barometer.

Statistics are running sums (count, sum, sum of squares, sum of absolute values, and a histogram of the speed
error), so each run adds only the hours it has not seen and never rereads the archive. They are kept per lead
for all buoys and per buoy; per band of leads by forecast speed, observed speed, month, stability and wind
sector; and per day for the last DAYS_KEPT days.

Binned by forecast speed, the errors answer a reader's question (HRRR says 20 kt: what happens?). Binned by observed
speed they also show the forecast's damping of extremes, but part of that is regression to the mean, which any
imperfect forecast shows when sorted by what happened. Stability classes use HRRR's air temperature minus the
buoy's surface water temperature, both known when the forecast is read, for the same reason.

- ``v1/archive/forecast-verification-sums.json``: the sums and the last valid time added (not served).
  Seeded once by ``import-verification`` from the forecast archive and our saved copies of the buoys' weather
  datasets; then the history job adds each day from the forecast job's page file and the live weather window.
- ``v1/forecast-verification.json``: statistics derived from the sums, for the page.

GFS (``gfs``) is scored the same way at its own leads (6 to 168 h) and bands, from its own archive (``gfs/`` in the
forecast archive, seeded with ``import-verification --model gfs``) and page file, into
``v1/archive/forecast-verification-gfs-sums.json`` and ``v1/forecast-verification-gfs.json``. GFS carries wind only
here, so its air, pressure and stability groups stay empty.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from . import forecast, gfs
from .build import SCHEMA, Store, decode, decode_frame, iso, load_stations, met_hourly, now_utc

log = logging.getLogger(__name__)

SUMS_KEY = "v1/archive/forecast-verification-sums.json"
PUBLIC_KEY = "v1/forecast-verification.json"
LEADS = forecast.BACKFILL_LEADS  # the leads the archive holds for every cycle since 2024
BANDS = {"1-3": (1, 3), "6-12": (6, 12), "18-24": (18, 24), "36-48": (36, 48)}
SPEED_BINS = [0, 5, 10, 15, 20, 25, 100]  # speed at 10 m, kt (forecast, or observed raised to 10 m)
STABILITY_BINS = [-30, -4, -1, 1, 4, 30]  # HRRR air minus buoy water temperature, C: unstable (negative) to stable
BINNED_BY = ("fspeed", "speed", "month", "stability", "sector")
SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
HIST_HALF = 16  # speed error histogram: 1 kt bins from -16 to 16, the ends holding everything beyond
ANEMOMETER_M = 3.8
Z0_M = 0.0002
HEIGHT_FACTOR = float(np.log(10 / Z0_M) / np.log(ANEMOMETER_M / Z0_M))
DIR_MIN_KT = 6.0
MS_TO_KT = 1.943844
LAG_HOURS = 3  # hours this recent are left for the next run: the server publishes readings 70 to 80 minutes late
DAYS_KEPT = 120
FIELDS = ("u10", "v10", "t2m", "mslp")


@dataclass(frozen=True)
class Model:
    """One model's verification: where its forecasts and sums live, its leads and bands, and the fields it has."""

    name: str
    page_key: str
    sums_key: str
    public_key: str
    leads: tuple[int, ...]
    bands: dict
    recent_bands: tuple[str, ...]
    fields: tuple[str, ...]
    archive_dir: str  # its cycles under the forecast archive ("" for HRRR's, at the top)
    source: str


HRRR = Model("hrrr", forecast.KV_KEY, SUMS_KEY, PUBLIC_KEY, tuple(LEADS), BANDS, ("1-3", "18-24"), FIELDS, "",
             "NOAA HRRR at the buoys (our archive, through forcingkit) against the buoys' hourly observations")
GFS = Model("gfs", gfs.KV_KEY, "v1/archive/forecast-verification-gfs-sums.json", "v1/forecast-verification-gfs.json",
            tuple(gfs.VERIFY_LEADS), {"6-24": (6, 24), "36-72": (36, 72), "96-168": (96, 168)}, ("6-24", "96-168"),
            ("u10", "v10"), "gfs", "NOAA GFS 0.25 degree at the buoys (our archive) against the buoys' hourly observations")
MODELS = {m.name: m for m in (HRRR, GFS)}


def buoys() -> list[dict]:
    return [st for st in load_stations()["stations"] if (st.get("met") or {}).get("dataset")]


# ---------------------------------------------------------------------------------------------
# Forecasts and observations as frames


def forecasts_from_page(page: dict | None, fields: tuple[str, ...] = FIELDS) -> pd.DataFrame:
    """The forecast job's page file as rows: issue_time, valid_time, lead_h, point, and one column per field."""
    rows = []
    for key, entry in (page or {}).get("cycles", {}).items():
        issue = pd.Timestamp(key.replace("Z", ""), tz="UTC")
        for point, series in entry["points"].items():
            for i, lead in enumerate(entry["leads"]):
                row = {"issue_time": issue, "lead_h": lead, "point": point}
                row.update({f: (series.get(f) or [None] * len(entry["leads"]))[i] for f in fields})
                rows.append(row)
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["valid_time"] = df["issue_time"] + pd.to_timedelta(df["lead_h"], unit="h")
    return df


def forecasts_from_archive(root: Path, model: Model | None = None) -> pd.DataFrame:
    """A model's archived cycles from a local copy of the forecast archive, in the same shape. HRRR's are at the
    top; another model's under its own folder, which HRRR's reading leaves out."""
    model = model or HRRR
    base = root / model.archive_dir if model.archive_dir else root
    others = {m.archive_dir for m in MODELS.values() if m.archive_dir}
    files = [f for f in sorted(base.rglob("cycle=*.csv.gz")) if model.archive_dir or f.relative_to(root).parts[0] not in others]
    df = pd.concat([pd.read_csv(f) for f in files])
    df = df[df["field"].isin(model.fields)]
    for c in ("issue_time", "valid_time"):
        df[c] = pd.to_datetime(df[c].str.replace("Z", ""), utc=True)
    return df.pivot_table(index=["issue_time", "valid_time", "lead_h", "point"], columns="field", values="value").reset_index()


def water_c(store: Store, live: dict | None, station: str) -> pd.Series:
    """Hourly surface water temperature (C): the history file, then the live window; empty without a surface sensor."""
    key = f"{station}_SFC"
    hist = decode((store.read_json("v1/history.json") or {}).get("series", {}).get(key))
    recent = decode((live or {}).get("series", {}).get(key))
    return recent.combine_first(hist) if not hist.empty else recent


def observations(store: Store, live: dict | None, saved_met: Path | None = None) -> dict[str, pd.DataFrame]:
    """Per buoy, hourly wind_kt, dir_deg (true), air_f, pressure_mb and water_c: our saved copies of the server's
    weather datasets (for the seed), under the live window."""
    out = {}
    for st in buoys():
        frame = decode_frame((live or {}).get("met", {}).get(st["id"]))
        if saved_met is not None:
            path = saved_met / f"{st['met']['dataset']}.csv.gz"
            if path.exists():
                raw = pd.read_csv(path, skiprows=[1])
                raw["time"] = pd.to_datetime(raw["time"], utc=True)
                saved = met_hourly(raw, float(st["met"].get("dir_offset_deg", 0.0)))
                frame = frame.combine_first(saved) if not frame.empty else saved
        if frame.empty:
            continue
        frame = frame.copy()
        frame["water_c"] = water_c(store, live, st["id"]).reindex(frame.index)
        out[st["id"]] = frame
    return out


# ---------------------------------------------------------------------------------------------
# Pairs and running sums


def _angdiff(a, b):
    return (a - b + 180) % 360 - 180


def pairs(fc: pd.DataFrame, obs: dict[str, pd.DataFrame], bands: dict | None = None) -> pd.DataFrame:
    """Forecast rows joined to the observation for their valid hour, with the errors and the bin labels (in the
    model's lead bands; HRRR's by default)."""
    parts = [fc[fc["point"] == b].merge(o, left_on="valid_time", right_index=True, how="inner") for b, o in obs.items()]
    d = pd.concat(parts) if parts else pd.DataFrame()
    if d.empty:
        return d
    for f in FIELDS:  # a model without air or pressure (GFS here): those errors are missing
        if f not in d:
            d[f] = np.nan
    d["f_spd"] = np.hypot(d["u10"], d["v10"]) * MS_TO_KT
    d["f_dir"] = np.degrees(np.arctan2(-d["u10"], -d["v10"])) % 360  # the direction the wind comes from
    d["o_spd10"] = d["wind_kt"] * HEIGHT_FACTOR
    d["e_spd"] = d["f_spd"] - d["o_spd10"]
    d["e_dir"] = np.where(d["wind_kt"] >= DIR_MIN_KT, _angdiff(d["f_dir"], d["dir_deg"]), np.nan)
    air_c = (d["air_f"] - 32) * 5 / 9
    d["e_t"] = (d["t2m"] - 273.15) - air_c
    d["e_p"] = d["mslp"] / 100 - d["pressure_mb"]
    d["band"] = None
    for name, (lo, hi) in (bands or BANDS).items():
        d.loc[d["lead_h"].between(lo, hi), "band"] = name
    labels = [f"{a}-{b}" if b < 100 else f"{a}+" for a, b in zip(SPEED_BINS[:-1], SPEED_BINS[1:])]
    d["fspeed"] = pd.cut(d["f_spd"], SPEED_BINS, labels=labels, right=False).astype(object)
    d["speed"] = pd.cut(d["o_spd10"], SPEED_BINS, labels=labels, right=False).astype(object)
    d["month"] = d["valid_time"].dt.month.astype(str)
    stab = ["unstable", "slightly unstable", "near neutral", "slightly stable", "stable"]
    d["stability"] = pd.cut((d["t2m"] - 273.15) - d["water_c"], STABILITY_BINS, labels=stab).astype(object)
    d["sector"] = np.where(d["wind_kt"] >= DIR_MIN_KT, np.array(SECTORS)[((d["dir_deg"] + 22.5) // 45 % 8).fillna(0).astype(int)], None)
    d["day"] = d["valid_time"].dt.strftime("%Y-%m-%d")
    return d


def _empty(hist: bool) -> dict:
    acc = {k: 0.0 for k in ("n", "se", "se2", "sae", "sf", "so", "nd", "sde", "sade", "nt", "ste", "sate", "np", "spe", "sape")}
    if hist:
        acc["hist"] = [0] * (2 * HIST_HALF + 1)
    return acc


def _add(acc: dict, g: pd.DataFrame) -> None:
    e = g["e_spd"].dropna()
    acc["n"] += len(e)
    acc["se"] += float(e.sum())
    acc["se2"] += float((e**2).sum())
    acc["sae"] += float(e.abs().sum())
    acc["sf"] += float(g.loc[e.index, "f_spd"].sum())
    acc["so"] += float(g.loc[e.index, "wind_kt"].sum())
    for err, n, s, sa in (("e_dir", "nd", "sde", "sade"), ("e_t", "nt", "ste", "sate"), ("e_p", "np", "spe", "sape")):
        x = g[err].dropna()
        acc[n] += len(x)
        acc[s] += float(x.sum())
        acc[sa] += float(x.abs().sum())
    if "hist" in acc and len(e):
        idx = np.clip(np.round(e.to_numpy()) + HIST_HALF, 0, 2 * HIST_HALF).astype(int)
        acc["hist"] = (np.array(acc["hist"]) + np.bincount(idx, minlength=2 * HIST_HALF + 1)).tolist()


def accumulate(groups: dict, d: pd.DataFrame) -> None:
    """Add the pairs to the running sums, in place."""
    if d.empty:
        return
    keyed = [
        (lambda r: f"lead/{r}", ["lead_h"], True),
        (lambda r: f"lead/{r[0]}/{r[1]}", ["lead_h", "point"], True),
    ]
    for by in BINNED_BY:
        keyed.append((lambda r, by=by: f"{r[0]}/{by}/{r[1]}", ["band", by], False))
    keyed.append((lambda r: f"day/{r[0]}/{r[1]}/{r[2]}", ["day", "band", "point"], False))
    for name, cols, hist in keyed:
        for key, g in d.dropna(subset=cols).groupby(cols if len(cols) > 1 else cols[0]):
            label = name(key)
            _add(groups.setdefault(label, _empty(hist)), g)


def _prune_days(groups: dict, end: datetime) -> None:
    cutoff = (pd.Timestamp(end) - pd.Timedelta(days=DAYS_KEPT)).strftime("%Y-%m-%d")
    for k in [k for k in groups if k.startswith("day/") and k.split("/")[1] < cutoff]:
        del groups[k]


def _round(groups: dict) -> dict:
    return {k: {f: (v if isinstance(v, list) else round(v, 3)) for f, v in acc.items()} for k, acc in groups.items()}


# ---------------------------------------------------------------------------------------------
# Statistics for the page


def stats(acc: dict) -> dict:
    def r(v):
        return None if v is None or not np.isfinite(v) else round(float(v), 2)

    n, nd, nt, np_ = acc["n"], acc["nd"], acc["nt"], acc["np"]
    out = {
        "n": int(n),
        "bias": r(acc["se"] / n) if n else None,
        "mae": r(acc["sae"] / n) if n else None,
        "rmse": r(np.sqrt(acc["se2"] / n)) if n else None,
        "forecast_mean": r(acc["sf"] / n) if n else None,
        "observed_mean_at_sensor": r(acc["so"] / n) if n else None,
        "dir_n": int(nd),
        "dir_bias": r(acc["sde"] / nd) if nd else None,
        "dir_mae": r(acc["sade"] / nd) if nd else None,
        "air_n": int(nt),
        "air_bias": r(acc["ste"] / nt) if nt else None,
        "air_mae": r(acc["sate"] / nt) if nt else None,
        "pressure_n": int(np_),
        "pressure_bias": r(acc["spe"] / np_) if np_ else None,
        "pressure_mae": r(acc["sape"] / np_) if np_ else None,
    }
    if "hist" in acc:
        out["hist"] = acc["hist"]
    return out


def public(sums: dict, end: datetime, model: Model | None = None) -> dict:
    model = model or HRRR
    g = sums["groups"]
    by_lead: dict = {}
    for lead in model.leads:
        if f"lead/{lead}" not in g:
            continue
        by_lead[str(lead)] = {
            "all": stats(g[f"lead/{lead}"]),
            "buoys": {b["id"]: stats(g[k]) for b in buoys() if (k := f"lead/{lead}/{b['id']}") in g},
        }
    bins = {
        band: {by: {k.split("/", 2)[2]: stats(v) for k, v in g.items() if k.startswith(f"{band}/{by}/")} for by in BINNED_BY}
        for band in model.bands
    }
    days = sorted({k.split("/")[1] for k in g if k.startswith("day/")})[-30:]
    recent = {
        band: {b["id"]: [stats(g[k]) if (k := f"day/{day}/{band}/{b['id']}") in g else None for day in days] for b in buoys()}
        for band in model.recent_bands
    }
    return {
        "schema": SCHEMA,
        "generated_at": iso(end),
        "first_valid": sums.get("first_valid"),
        "through": sums["through"],
        "model": model.name,
        "source": model.source,
        "method": {
            "observed": "the buoy's hourly mean for the hour starting at the forecast's valid time",
            "speed_at_10m": f"buoy speed x {HEIGHT_FACTOR:.3f}: from an anemometer at {ANEMOMETER_M} m (assumed), "
            f"neutral log profile, roughness {Z0_M} m",
            "direction": f"forecast minus observed, degrees clockwise; observed wind {DIR_MIN_KT:g} kt or more; "
            "buoy directions turned to true north",
            "hist_edges_kt": [-HIST_HALF, HIST_HALF],
            "bins": "fspeed: by forecast speed; speed: by observed speed at 10 m (includes regression to the mean); "
            "stability: HRRR air minus buoy surface water temperature (HRRR only); sector: observed direction",
        },
        "units": {"speed": "kt", "direction": "deg", "air": "C", "pressure": "mb"},
        "leads": [int(k) for k in by_lead],
        "by_lead": by_lead,
        "bins": bins,
        "recent": {"days": days, "bands": recent},
    }


# ---------------------------------------------------------------------------------------------
# Entry points


def seed(store: Store, archive: Path, saved_met: Path, model: Model | None = None) -> dict:
    """Build a model's sums from scratch: a local copy of the forecast archive and our saved weather datasets (with
    the live window for the latest weeks). Run once by hand (``import-verification [--model gfs]``)."""
    model = model or HRRR
    end = now_utc()
    limit = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=LAG_HOURS)
    live = store.read_json("v1/live.json")
    fc = forecasts_from_archive(archive, model)
    fc = fc[fc["lead_h"].isin(model.leads) & (fc["valid_time"] <= limit)]
    d = pairs(fc, observations(store, live, saved_met), model.bands)
    groups: dict = {}
    accumulate(groups, d)
    _prune_days(groups, end)
    sums = {"schema": SCHEMA, "first_valid": iso(d["valid_time"].min()), "through": iso(limit), "groups": _round(groups)}
    store.write_json(model.sums_key, sums, max_age=86400)
    log.info("%s verification seeded: %d pairs, %s to %s", model.name, len(d), sums["first_valid"], sums["through"])
    return sums


def update(store: Store, model: Model | None = None) -> dict | None:
    """Add the hours since the last run (forecasts from the model's page file, observations from the live window),
    then publish the statistics. HRRR's page file keeps forecast.KEEP_HOURS of cycles, enough for a 48 h lead of an
    hour a day back, and GFS's its verification leads for gfs.KEEP_DAYS; a run missed for longer loses the longest
    leads of the hours in between."""
    model = model or HRRR
    sums = store.read_json(model.sums_key)
    if not sums:
        log.warning("no %s verification sums: run import-verification first", model.name)
        return None
    end = now_utc()
    start = pd.Timestamp(sums["through"])
    limit = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=LAG_HOURS)
    if limit > start:
        live = store.read_json("v1/live.json")
        fc = forecasts_from_page(store.read_json(model.page_key), model.fields)
        if not fc.empty:
            fc = fc[fc["lead_h"].isin(model.leads) & (fc["valid_time"] > start) & (fc["valid_time"] <= limit)]
        d = pairs(fc, observations(store, live), model.bands) if not fc.empty else pd.DataFrame()
        groups = sums["groups"]
        accumulate(groups, d)
        _prune_days(groups, end)
        sums.update({"through": iso(limit), "groups": _round(groups)})
        store.write_json(model.sums_key, sums, max_age=86400)
        log.info("%s verification: %d new pairs through %s", model.name, len(d), sums["through"])
    out = public(sums, end, model)
    store.write_json(model.public_key, out, max_age=3600)
    return out

