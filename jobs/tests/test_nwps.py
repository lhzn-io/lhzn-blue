"""NWPS: where the runs are on NOMADS."""

def test_url_v15_name():
    from datetime import datetime

    from lhzn_blue_jobs import nwps

    run = datetime(2026, 11, 13, 12)
    assert nwps.url(run) == "https://nomads.ncep.noaa.gov/pub/data/nccf/com/nwps/prod/er.20261113/okx/12/CG1/nwps.t12z.cg1.okx.grib2"
    assert nwps.file_name(run) == "okx_nwps_CG1_20261113_1200.grib2"
