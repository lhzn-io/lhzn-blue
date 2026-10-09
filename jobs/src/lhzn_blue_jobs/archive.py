"""Read the HDF5 snapshots the prototype notebook wrote, one file per dataset per download.

Each snapshot is a pandas DataFrame stored with ``df.to_hdf(path, key="data")``. The files are our
own downloads of the LISICOS ERDDAP server; they hold history the server no longer publishes under
the original dataset names (for example the EXRX surface and mid-depth series).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

KEEP = ["time", "depth", "sea_water_temperature", "sea_water_salinity", "oxygen_concentration_in_sea_water"]


def read_snapshot(path: Path) -> pd.DataFrame:
    """Return the snapshot's observation columns with a UTC ``time`` column."""
    df = pd.read_hdf(path, key="data")
    if "time" not in df.columns:
        df = df.reset_index()
    df = df[[c for c in KEEP if c in df.columns]].copy()
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df.sort_values("time").reset_index(drop=True)


def describe(path: Path) -> str:
    df = read_snapshot(path)
    depth = df["depth"].dropna().unique() if "depth" in df.columns else []
    return (
        f"{path.parent.name}/{path.name}: rows={len(df)} "
        f"{df['time'].min()} -> {df['time'].max()} depth={list(depth)[:3]} cols={list(df.columns)}"
    )


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        print(describe(Path(arg)))
