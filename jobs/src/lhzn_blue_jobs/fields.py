"""Surface fields for the map: satellite rasters and modelled surface currents, fetched with forcingkit.

forcingkit (https://github.com/lhzn-io/forcingkit) does the fetching: CoastWatch ERDDAP composites (each pixel's
most recent valid value across sensors, with its age) and the NECOFS FVCOM surface layer on the model's own mesh.
This module only encodes them compactly for the page and publishes them. It keeps no cache and no state: each run
overwrites the same few files.

Published layout (under ``<root>/v1/fields/``):

- ``sst.json``, ``chl.json``, ``kd490.json``: one raster each over the waterway's box. ``grid`` gives the
  south-west cell centre, spacing and size; ``values`` is row-major from the south, as integers to multiply by
  ``scale`` (null where there is no value: land, cloud, the masked coastal band); ``age_days`` is each pixel's age at
  ``time`` (null where no value). Sources and attribution travel with the file.
- ``currents-mesh.json``: the model mesh inside the box: node positions, triangles (indices into the nodes),
  element centres, and each element's arrow level (0 shows at the widest zoom, higher levels fill in as the map zooms
  in).
- ``currents.json``: surface (top sigma layer) eastward and northward current per element, in cm/s, every
  ``step`` seconds from ``t0``: a model forecast, labelled as one.
"""

from __future__ import annotations

import logging
from datetime import datetime

import numpy as np
import pandas as pd

from .build import SCHEMA, Store, iso, now_utc

log = logging.getLogger(__name__)

BBOX = [-73.9, 40.7, -71.8, 41.45]  # Long Island Sound, from Throgs Neck to The Race
# name -> (forcingkit quantity, composite window in days, coastal pixels masked, scale: value = int * scale)
RASTERS = {
    "sst": ("sst", 2, 0, 0.01),  # MUR is a gap-free analysis: no compositing or coastal mask needed
    "chl": ("chlor_a", 7, 1, 0.01),
    "kd490": ("kd_490", 7, 1, 0.001),
}
CURRENT_HOURS_BACK = 24
CURRENT_HOURS_AHEAD = 72
CURRENT_STEP_HOURS = 2  # keeps the file near 5 MB for about 12,500 elements
ARROW_LEVELS = 6
ARROW_CELL_DEG = 0.08  # level 0: one arrow per 0.08 degree cell; each level halves the cell


def raster(name: str, end: datetime | None = None) -> dict:
    """One satellite raster, encoded for the page."""
    from forcingkit.fetchers import coastwatch

    quantity, days, coast, scale = RASTERS[name]
    end = end or now_utc()
    ds = coastwatch.mask_coast(coastwatch.composite(coastwatch.QUANTITIES[quantity], BBOX, end, days), coast)
    lat, lon = ds["lat"].values, ds["lon"].values
    value, age = ds["value"].values, ds["age_days"].values
    ints = np.where(np.isfinite(value), np.round(value / scale), np.nan)
    products = str(ds.attrs.get("products", "")).split(",")
    return {
        "schema": SCHEMA,
        "kind": name,
        "quantity": quantity,
        "units": ds["value"].attrs.get("units", ""),
        "scale": scale,
        "time": ds.attrs.get("end", iso(end)),
        "window_days": days,
        "coast_mask_pixels": coast,
        "grid": {
            "lon0": round(float(lon[0]), 6),
            "lat0": round(float(lat[0]), 6),
            "dlon": round(float(np.diff(lon).mean()), 7),
            "dlat": round(float(np.diff(lat).mean()), 7),
            "nx": int(lon.size),
            "ny": int(lat.size),
        },
        "values": [None if np.isnan(v) else int(v) for v in ints.ravel()],
        "age_days": [None if np.isnan(a) else round(float(a), 1) for a in age.ravel()],
        "valid_share": round(float(np.isfinite(value).mean()), 3),
        "products": products,
        "sources": [coastwatch.PRODUCTS[p].dataset for p in products if p in coastwatch.PRODUCTS],
        "attribution": ds.attrs.get("attribution", ""),
    }


def arrow_levels(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Thinning level per element: at level k the box is cut into cells of ARROW_CELL_DEG / 2**k, and in each cell
    the element nearest the cell's centre that has no level yet takes level k. Unassigned elements take the last
    level. The map shows levels up to a zoom-dependent limit, so arrows stay evenly spaced at every zoom."""
    levels = np.full(lon.size, ARROW_LEVELS, dtype=np.int8)
    for k in range(ARROW_LEVELS):
        size = ARROW_CELL_DEG / 2**k
        ix, iy = np.floor(lon / size), np.floor(lat / size)
        dist = (lon - (ix + 0.5) * size) ** 2 + (lat - (iy + 0.5) * size) ** 2
        free = levels == ARROW_LEVELS
        order = np.lexsort((dist, iy, ix))  # by cell, nearest the centre first
        seen: set[tuple[float, float]] = set()
        for i in order:
            cell = (ix[i], iy[i])
            if cell in seen:
                continue
            seen.add(cell)
            if free[i]:
                levels[i] = k
    return levels


def currents(end: datetime | None = None) -> tuple[dict, dict]:
    """The mesh and the surface current forecast, encoded for the page."""
    from forcingkit.fetchers import necofs

    end = end or now_utc()
    start = pd.Timestamp(end).floor("h") - pd.Timedelta(hours=CURRENT_HOURS_BACK)
    ds = necofs.read_surface(BBOX, start, CURRENT_HOURS_BACK + CURRENT_HOURS_AHEAD + 1)
    ds = ds.isel(time=slice(0, None, CURRENT_STEP_HOURS))
    lonc, latc = ds["lonc"].values.astype(np.float64), ds["latc"].values.astype(np.float64)
    mesh = {
        "schema": SCHEMA,
        "source": "NECOFS FVCOM GOM7, UMass Dartmouth (SMAST)",
        "bbox": BBOX,
        "nodes": [[round(float(x), 5), round(float(y), 5)] for x, y in zip(ds["node_lon"].values, ds["node_lat"].values)],
        "triangles": ds["triangles"].values.astype(int).tolist(),
        "centres": [[round(float(x), 5), round(float(y), 5)] for x, y in zip(lonc, latc)],
        "arrow_level": arrow_levels(lonc, latc).astype(int).tolist(),
        "arrow_levels": ARROW_LEVELS,
    }
    times = pd.DatetimeIndex(ds["time"].values).tz_localize("UTC")  # forcingkit returns naive UTC
    to_cm = lambda a: np.where(np.isfinite(a), np.round(a * 100.0), 0).astype(int)  # noqa: E731
    data = {
        "schema": SCHEMA,
        "kind": "currents",
        "label": "model forecast",
        "source": "NECOFS FVCOM GOM7, UMass Dartmouth (SMAST)",
        "url": ds.attrs.get("url"),
        "layer": "surface (top sigma layer)",
        "units": "cm/s",
        "generated_at": iso(end),
        "t0": iso(times[0]),
        "step": CURRENT_STEP_HOURS * 3600,
        "steps": int(times.size),
        "elements": int(lonc.size),
        "u": [to_cm(ds["u"].values[i]).tolist() for i in range(times.size)],
        "v": [to_cm(ds["v"].values[i]).tolist() for i in range(times.size)],
    }
    return mesh, data


def publish(store: Store) -> list[str]:
    """Fetch every field and write it; a field that fails is logged and left as it was. Returns the failures."""
    failed = []
    end = now_utc()
    for name in RASTERS:
        try:
            store.write_json(f"v1/fields/{name}.json", raster(name, end), max_age=3600)
        except Exception:
            log.exception("field %s not refreshed", name)
            failed.append(name)
    try:
        mesh, data = currents(end)
        store.write_json("v1/fields/currents-mesh.json", mesh, max_age=86400)
        store.write_json("v1/fields/currents.json", data, max_age=3600)
    except Exception:
        log.exception("currents not refreshed")
        failed.append("currents")
    return failed

