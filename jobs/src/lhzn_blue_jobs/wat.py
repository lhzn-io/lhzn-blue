"""Wind against tide: where the tidal current runs against the waves and steepens them, for the map.

The waves are the NWS NWPS forecast (significant height, peak period and the direction the waves travel, on the
model's 1.8 km cells; see nwps.py). These runs carry no currents (their current field is zero), so their waves include
no wave-current interaction. The current is the NECOFS FVCOM surface layer (see fields.py), averaged over the
elements inside each NWPS cell, so a narrow jet is not missed or picked out by a single point.

For each cell and hour, with k the direction the waves travel and T their peak period:

- u_par = current . k (negative: the current opposes the waves), c0 = g T / (2 pi) (deep-water phase speed), and
  r = u_par / c0;
- for -0.25 < r < 0, linear wave action conservation for waves entering an opposing current from still water
  (Longuet-Higgins and Stewart 1961) gives the phase-speed ratio c = (1 + sqrt(1 + 4r)) / 2, the wavelength ratio c^2,
  the height ratio 1 / sqrt(c (c + 2r)), and the steepness ratio S = height ratio / wavelength ratio;
- at r <= -0.25 the current stops the waves (blocking): they break at the current front;
- the steepness the waves reach is S Hs / L0, with L0 = g T^2 / (2 pi).

Levels (heuristic, to be tuned against buoy spectra and our own boat's motion):

- 0: no meaningful interaction (current under MIN_CURRENT, waves under MIN_HS, or r above -0.05);
- 1: the current steepens the waves (S >= 1.2);
- 2: steep, short seas likely (S >= 1.6, or S >= 1.2 with a steepness of 1/25 or more);
- 3: breaking seas likely (r <= -0.20, or S >= 1.6 with a steepness of 1/15 or more);
- 4: blocking (r <= -0.25).

Every level needs the current to steepen the waves (S >= 1.2): wind sea in the Sound is often steep in slack water
(0.4 m at 2.2 s is about 1/19), and the layer shows what the current adds. Levels 3 and 4 also need waves of
STRONG_HS or more; smaller waves stop at level 2.

Deep-water dispersion throughout; in water shallower than half a wavelength the waves are already shorter, so the
index is a first-order indicator, not a wave model. Shoals, rips and overfalls finer than the grids are not in it.

Published as ``v1/fields/wind-against-tide.json``: the NWPS grid (regular lon-lat), the cells that reach level 1 or
more in any frame (``cells``, indices into the grid, with an arrow level each for thinning by zoom), and one frame per
currents step with, for those cells only: level, S in tenths, the current east and north in cm/s, the wave height in
cm, the peak period in tenths of a second and the direction the waves travel in degrees.
"""

from __future__ import annotations

import logging
import math
from datetime import datetime, timedelta

import numpy as np

from .build import SCHEMA, iso

log = logging.getLogger(__name__)

KEY = "v1/fields/wind-against-tide.json"
G = 9.81
MIN_CURRENT = 0.3  # m/s
MIN_HS = 0.2  # m
STRONG_HS = 0.4  # m: below this, steepened chop is at most level 2 (breaking 1 ft chop is not a breaking sea)
NEAREST_KM = 1.5  # a cell with no element centre inside takes the nearest element this close
BACK, AHEAD = 24, 72  # hours of frames kept around now
VERSION = 1


def steepening(r: np.ndarray) -> np.ndarray:
    """The steepness ratio S for waves entering an opposing current from still water (1 for r >= 0, NaN at blocking)."""
    r = np.asarray(r, dtype=np.float64)
    out = np.ones_like(r)
    opp = (r < 0) & (r > -0.25)
    c = (1.0 + np.sqrt(1.0 + 4.0 * r[opp])) / 2.0
    out[opp] = (1.0 / np.sqrt(c * (c + 2.0 * r[opp]))) / c**2
    out[r <= -0.25] = np.nan
    return out


def levels(hs: np.ndarray, tp: np.ndarray, to_deg: np.ndarray, u: np.ndarray, v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Level (0 to 4) and steepness ratio S per cell. Inputs in m, s, degrees (the direction the waves travel) and
    m/s; NaN anywhere gives level 0."""
    kx, ky = np.sin(np.deg2rad(to_deg)), np.cos(np.deg2rad(to_deg))
    with np.errstate(invalid="ignore", divide="ignore"):
        c0 = G * tp / (2 * math.pi)
        r = (u * kx + v * ky) / c0
        s = steepening(r)
        steep = s * hs / (G * tp**2 / (2 * math.pi))
        speed = np.hypot(u, v)
        lv = np.zeros(hs.shape, dtype=np.int8)
        lv[s >= 1.2] = 1
        lv[(s >= 1.6) | ((s >= 1.2) & (steep >= 1 / 25))] = 2
        lv[(r <= -0.20) | ((s >= 1.6) & (steep >= 1 / 15))] = 3
        lv[r <= -0.25] = 4
        lv[(lv > 2) & ~(hs >= STRONG_HS)] = 2
        quiet = ~np.isfinite(r) | ~np.isfinite(hs) | (speed < MIN_CURRENT) | (hs < MIN_HS) | (r > -0.05)
    lv[quiet] = 0
    return lv, s


def cell_currents(grid: dict, mesh: dict) -> tuple[np.ndarray, np.ndarray]:
    """For each element centre in the currents mesh, the flat index of the NWPS cell it averages into (-1: none), and
    for each cell with no centre inside, the nearest element within NEAREST_KM (-1: none). Returns (owner per
    element, stand-in element per cell)."""
    lon0, lat0, dlon, dlat, nx, ny = (grid[k] for k in ("lon0", "lat0", "dlon", "dlat", "nx", "ny"))
    xy = np.asarray(mesh["centres"], dtype=np.float64)
    i = np.round((xy[:, 0] - lon0) / dlon).astype(int)
    j = np.round((xy[:, 1] - lat0) / dlat).astype(int)
    inside = (i >= 0) & (i < nx) & (j >= 0) & (j < ny)
    owner = np.where(inside, j * nx + i, -1)
    standin = np.full(nx * ny, -1, dtype=np.int64)
    has = np.zeros(nx * ny, dtype=bool)
    has[owner[owner >= 0]] = True
    from scipy.spatial import cKDTree

    coslat = math.cos(math.radians(lat0 + dlat * ny / 2))
    tree = cKDTree(np.c_[xy[:, 0] * coslat, xy[:, 1]])
    lon2, lat2 = np.meshgrid(lon0 + dlon * np.arange(nx), lat0 + dlat * np.arange(ny))
    empty = np.where(~has)[0]
    d, k = tree.query(np.c_[lon2.ravel()[empty] * coslat, lat2.ravel()[empty]])
    near = d * 111.2 <= NEAREST_KM
    standin[empty[near]] = k[near]
    return owner, standin


def current_on_cells(u: np.ndarray, v: np.ndarray, owner: np.ndarray, standin: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """Average the elements' u, v (m/s) over each cell; cells with none take their stand-in element; else NaN."""
    ok = owner >= 0
    cnt = np.bincount(owner[ok], minlength=n).astype(np.float64)
    su = np.bincount(owner[ok], weights=u[ok], minlength=n)
    sv = np.bincount(owner[ok], weights=v[ok], minlength=n)
    with np.errstate(invalid="ignore", divide="ignore"):
        cu, cv = su / cnt, sv / cnt
    s = standin >= 0
    cu[s], cv[s] = u[standin[s]], v[standin[s]]
    return cu, cv


def regular(lat: np.ndarray, lon: np.ndarray) -> dict:
    """The NWPS grid as a regular lon-lat grid (south-west cell centre, spacing, size); raises if it is not one."""
    dlon, dlat = float(np.mean(np.diff(lon))), float(np.mean(np.diff(lat)))
    if np.max(np.abs(np.diff(lon) - dlon)) > 1e-4 or np.max(np.abs(np.diff(lat) - dlat)) > 1e-4:
        raise ValueError("NWPS grid is not regular")
    return {"lon0": round(float(lon[0]), 5), "lat0": round(float(lat[0]), 5), "dlon": round(dlon, 6), "dlat": round(dlat, 6), "nx": int(lon.size), "ny": int(lat.size)}


def build(prev: dict | None, runs: dict[str, dict], currents: dict, mesh: dict, end: datetime) -> dict | None:
    """The map file. ``runs``: {issue key: nwps.read_points output with "grid"}; each currents step takes the newest
    run covering its hour; frames from the previous file are kept for hours no run here covers."""
    from .fields import arrow_levels

    runs = {k: r for k, r in runs.items() if r.get("grid") and "tp" in r["grid"]}
    if not runs:
        return None
    newest = max(runs)
    g0 = runs[newest]["grid"]
    grid = regular(g0["lat"], g0["lon"])
    n = grid["nx"] * grid["ny"]
    if prev and (prev.get("version") != VERSION or prev.get("grid") != grid):
        prev = None
    owner, standin = cell_currents(grid, mesh)
    now = end.replace(tzinfo=None, minute=0, second=0, microsecond=0)
    lo, hi = now - timedelta(hours=BACK), now + timedelta(hours=AHEAD)
    t0 = datetime.strptime(currents["t0"], "%Y-%m-%dT%H:%M:%SZ")
    frames: dict[str, dict] = {}
    for f in (prev or {}).get("frames", []):  # cell indices into the grid, so they survive a new cell list
        frames[f["valid_time"]] = f
    for k in range(int(currents["steps"])):
        valid = t0 + timedelta(seconds=k * int(currents["step"]))
        if not lo <= valid <= hi:
            continue
        key = next((rk for rk in sorted(runs, reverse=True)
                    if 0 <= (valid - datetime.strptime(rk, "%Y-%m-%dT%HZ")).total_seconds() / 3600 < len(runs[rk]["steps"])), None)
        if key is None:
            continue
        vkey = f"{valid:%Y-%m-%dT%H:%MZ}"
        have = frames.get(vkey)
        if have and have["cycle"] > key:
            continue
        lead = int((valid - datetime.strptime(key, "%Y-%m-%dT%HZ")).total_seconds() // 3600)
        step = runs[key]["steps"].index(lead) if lead in runs[key]["steps"] else None
        if step is None:
            continue
        g = runs[key]["grid"]
        hs = g["hs"][step].astype(np.float64).ravel()
        tp = g["tp"][step].astype(np.float64).ravel()
        to = (g["dir"][step].astype(np.float64).ravel() + 180.0) % 360.0
        u = np.asarray(currents["u"][k], dtype=np.float64) / 100.0
        v = np.asarray(currents["v"][k], dtype=np.float64) / 100.0
        cu, cv = current_on_cells(u, v, owner, standin, n)
        lv, s = levels(hs, tp, to, cu, cv)
        idx = np.where(lv > 0)[0]
        frames[vkey] = {
            "valid_time": vkey,
            "cycle": key,
            "lead": lead,
            "currents_run": currents["generated_at"],
            "i": idx.tolist(),
            "lv": lv[idx].astype(int).tolist(),
            "s": [255 if not math.isfinite(x) else min(254, int(round(x * 10))) for x in s[idx]],
            "u": np.round(cu[idx] * 100).astype(int).tolist(),
            "v": np.round(cv[idx] * 100).astype(int).tolist(),
            "hs": np.round(hs[idx] * 100).astype(int).tolist(),
            "tp": np.round(tp[idx] * 10).astype(int).tolist(),
            "to": np.round(to[idx]).astype(int).tolist(),
        }
    kept = sorted((f for f in frames.values() if lo <= datetime.strptime(f["valid_time"], "%Y-%m-%dT%H:%MZ") <= hi), key=lambda f: f["valid_time"])
    if not kept:
        return None
    cells = sorted({i for f in kept for i in f["i"]})
    ca = np.asarray(cells, dtype=np.int64)
    lon = grid["lon0"] + grid["dlon"] * (ca % grid["nx"])
    lat = grid["lat0"] + grid["dlat"] * (ca // grid["nx"])
    counts = {lvl: sum(f["lv"].count(lvl) for f in kept) for lvl in (1, 2, 3, 4)}
    log.info("wind against tide: %d frames, %d cells ever active, cell-frames by level %s", len(kept), len(cells), counts)
    return {
        "schema": SCHEMA,
        "kind": "wind-against-tide",
        "version": VERSION,
        "label": "model-derived index",
        "source": "NWS NWPS waves (SWAN, WFO New York grid CG1, 1.8 km) with NECOFS FVCOM surface currents "
        "(UMass Dartmouth, SMAST), averaged over each NWPS cell",
        "attribution": "NWS NWPS (NOAA NOMADS); NECOFS FVCOM (UMass Dartmouth SMAST)",
        "method": "r = current along the wave direction / deep-water phase speed (g T / 2 pi); steepness ratio S from "
        "wave action conservation (Longuet-Higgins and Stewart 1961); blocking at r <= -0.25",
        "levels": {
            "1": "the current steepens the waves",
            "2": "steep, short seas likely",
            "3": "breaking seas likely",
            "4": "blocking: waves break at the current front",
        },
        "thresholds": {"min_current_ms": MIN_CURRENT, "min_hs_m": MIN_HS},
        "units": {"s": "tenths (255: blocking)", "u": "cm/s", "v": "cm/s", "hs": "cm", "tp": "tenths of a second", "to": "deg true, toward"},
        "generated_at": iso(end),
        "grid": grid,
        "cells": cells,
        "arrow_level": arrow_levels(lon, lat).astype(int).tolist() if cells else [],
        "frames": kept,
    }
