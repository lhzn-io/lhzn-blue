"""GFS at the stations: the water cells a station reads, the box's grid, and what the page's file keeps."""

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from lhzn_blue_jobs import gfs, hrrr_grid


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


def test_box_cells_are_water_over_the_box_and_one_cell_past_it():
    lat = np.arange(43.0, 39.0 - 0.01, -0.25)
    lon = np.arange(284.0, 290.0 + 0.01, 0.25)  # 76 W to 70 W
    land = np.zeros((lat.size, lon.size))
    land[lat >= 41.5, :] = 1  # Connecticut and north
    flat, clat, clon = gfs.box_cells(land, lat, lon, box=(-74.4, 40.3, -71.4, 41.7))
    assert sorted(set(clat)) == [40.25, 40.5, 40.75, 41.0, 41.25]  # 40.25 is the pad; 41.5 and 41.75 are land
    assert clon.min() == -74.5 and clon.max() == -71.25  # one cell past each side
    assert len(flat) == 5 * 14 and (land.ravel()[flat] == 0).all()
    assert (lat[flat // lon.size] == clat).all()


def test_grid_entry_round_trips_within_half_a_step():
    rng = np.random.default_rng(0)
    at = {lead: {"u10": rng.uniform(-20, 20, 7), "v10": rng.uniform(-20, 20, 7), "gust": rng.uniform(0, 30, 7)} for lead in (6, 3)}
    g = gfs.grid_entry(np.full(7, 41.0), np.linspace(-74, -72, 7), at)
    assert g["leads"] == [3, 6] and len(g["lat"]) == len(g["lon"]) == 7
    for f in ("u10", "v10", "gust"):
        for i, lead in enumerate(g["leads"]):
            assert np.abs(hrrr_grid.decode(g[f][i]) - at[lead][f]).max() <= hrrr_grid.STEP / 2 + 1e-9


def test_only_the_newest_two_cycles_keep_the_grid():
    end = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
    cycles = [pd.Timestamp("2026-10-30T06"), pd.Timestamp("2026-10-30T00"), pd.Timestamp("2026-10-29T18")]
    df = pd.DataFrame([r for c in cycles for r in rows(c, gfs.LEADS)], columns=["issue_time", "valid_time", "lead_h", "point", "field", "value"])
    grids = {c: {"leads": gfs.LEADS, "lat": [41.0], "lon": [-72.0], "u10": ["AA=="] * len(gfs.LEADS)} for c in cycles}
    page = gfs.page_file(None, df, end, grids)
    out = page["cycles"]
    assert [k for k, c in sorted(out.items()) if "grid" in c] == ["2026-10-30T00Z", "2026-10-30T06Z"]
    assert out["2026-10-29T18Z"]["leads"] == gfs.LEADS  # still within KEEP_FULL_HOURS: every lead, no grid
    assert all(len(c["points"]["EXRX"]["u10"]) == len(gfs.LEADS) for c in out.values())
    assert page["grid_encoding"]["step"] == hrrr_grid.STEP
    # The next cycle pushes the oldest grid out of the file's previous contents.
    nxt = pd.Timestamp("2026-10-30T12")
    df2 = pd.DataFrame(rows(nxt, gfs.LEADS), columns=df.columns)
    out2 = gfs.page_file(page, df2, end, {nxt: grids[cycles[0]]})["cycles"]
    assert [k for k, c in sorted(out2.items()) if "grid" in c] == ["2026-10-30T06Z", "2026-10-30T12Z"]


def test_a_file_without_grids_passes_through():
    end = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
    cycle = pd.Timestamp("2026-10-30T06")
    df = pd.DataFrame(rows(cycle, gfs.LEADS), columns=["issue_time", "valid_time", "lead_h", "point", "field", "value"])
    out = gfs.page_file(None, df, end)["cycles"]
    assert "grid" not in out["2026-10-30T06Z"]


def test_file_names():
    assert gfs.key(pd.Timestamp("2026-10-30T12"), 168).endswith("gfs.20261030/12/atmos/gfs.t12z.pgrb2.0p25.f168")
    assert gfs._gfs_root("gs://b/forecasts/") == "gs://b/forecasts/gfs"
