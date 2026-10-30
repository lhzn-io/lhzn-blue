"""GFS at the stations: the water cells a station reads, and what the page's file keeps."""

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from lhzn_blue_jobs import gfs


def small_grid():
    """A 1 degree patch around the Sound on GFS's own conventions: latitude north first, longitude 0 to 360 east."""
    lat = np.arange(42.0, 40.0 - 0.01, -0.25)
    lon = np.arange(286.0, 288.0 + 0.01, 0.25)  # 74 W to 72 W
    land = np.zeros((lat.size, lon.size))
    land[:3, :] = 1  # Connecticut: the three northern rows (42.0, 41.75, 41.5)
    return land, lat, lon


def test_weights_take_water_cells_near_the_station():
    land, lat, lon = small_grid()
    w = gfs.weights(land, lat, lon, {"EXRX": (-73.7, 40.88)})
    cells, wt = w["EXRX"]
    assert len(cells) == gfs.NEAREST and abs(wt.sum() - 1) < 1e-9
    rows = cells // lon.size
    assert (lat[rows] <= 41.25).all()  # none of the land rows
    assert wt[0] == wt.max()  # the nearest weighs most


def test_a_station_out_of_reach_is_left_out():
    land, lat, lon = small_grid()
    assert gfs.weights(land, lat, lon, {"FAR": (-60.0, 41.0)}) == {}


def rows(cycle, leads, value=1.0):
    return [(cycle, cycle + pd.Timedelta(hours=h), h, "EXRX", f, value) for h in leads for f in ("u10", "v10")]


def test_page_file_keeps_every_lead_for_new_cycles_and_verification_leads_for_older():
    end = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
    cycles = [pd.Timestamp("2026-10-30T06"), pd.Timestamp("2026-10-30T00"), pd.Timestamp("2026-10-28T00"), pd.Timestamp("2026-10-20T00")]
    df = pd.DataFrame([r for c in cycles for r in rows(c, gfs.LEADS)], columns=["issue_time", "valid_time", "lead_h", "point", "field", "value"])
    out = gfs.page_file(None, df, end)["cycles"]
    assert sorted(out) == ["2026-10-28T00Z", "2026-10-30T00Z", "2026-10-30T06Z"]  # the 20th is past KEEP_DAYS
    assert out["2026-10-30T06Z"]["leads"] == gfs.LEADS
    assert out["2026-10-28T00Z"]["leads"] == gfs.VERIFY_LEADS
    assert len(out["2026-10-28T00Z"]["points"]["EXRX"]["u10"]) == len(gfs.VERIFY_LEADS)


def test_the_newest_two_keep_every_lead_however_old():
    end = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
    cycles = [pd.Timestamp("2026-10-27T00"), pd.Timestamp("2026-10-27T06")]  # GFS, or the job, down for days
    df = pd.DataFrame([r for c in cycles for r in rows(c, gfs.LEADS)], columns=["issue_time", "valid_time", "lead_h", "point", "field", "value"])
    out = gfs.page_file(None, df, end)["cycles"]
    assert all(c["leads"] == gfs.LEADS for c in out.values())


def test_file_names():
    assert gfs.key(pd.Timestamp("2026-10-30T12"), 168).endswith("gfs.20261030/12/atmos/gfs.t12z.pgrb2.0p25.f168")
    assert gfs._gfs_root("gs://b/forecasts/") == "gs://b/forecasts/gfs"
