"""Read our saved downloads of the LISICOS ERDDAP server, one file per dataset per download.

Two kinds: the prototype notebook's HDF5 files (a pandas DataFrame stored with ``df.to_hdf(path,
key="data")``), and the snapshot job's ``<DATASET>.csv.gz`` (the server's own CSV; see snapshot.py).
They hold history the server no longer publishes under the original dataset names (for example the
EXRX surface and mid-depth series).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

KEEP = ["time", "depth", "sea_water_temperature", "sea_water_salinity", "oxygen_concentration_in_sea_water"]


def read_snapshot(path: Path, keep: list[str] | None = None) -> pd.DataFrame:
    """Return the snapshot's observation columns (water quality unless ``keep`` names others) with a UTC
    ``time`` column."""
    if path.name.endswith(".csv.gz"):
        df = pd.read_csv(path, skiprows=[1])  # row 2 holds units
    else:
        df = pd.read_hdf(path, key="data")
    if "time" not in df.columns:
        df = df.reset_index()
    df = df[[c for c in (keep or KEEP) if c in df.columns]].copy()
    df["time"] = pd.to_datetime(df["time"], utc=True)
    return df.sort_values("time").reset_index(drop=True)


def saved_downloads(archive_dir: Path, dataset: str) -> list[Path]:
    """Every saved download of a dataset, oldest first: folders are named for the download time
    (``20250411-110127`` or ``download_time=20261013-084500``)."""
    files = [*archive_dir.glob(f"*/{dataset}.h5"), *archive_dir.glob(f"*/{dataset}.csv.gz")]
    return sorted(files, key=lambda f: f.parent.name.split("=")[-1])


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
