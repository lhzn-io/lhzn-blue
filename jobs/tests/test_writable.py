"""The cost guard on object names (build.WRITABLE): every name the Sound's jobs write still passes, the Piscataqua
Region's few names pass, and nothing else does. Offline."""

import pytest

from lhzn_blue_jobs.build import WRITABLE

SOUND = [
    *(f"v1/{n}.json" for n in (
        "history", "history-salinity", "history-oxygen", "history-waves", "history-turbidity", "history-met", "live",
        "shore", "shore-history", "shore-tides", "rivers", "rivers-history", "usgs-tidal", "forecast-hrrr", "waves-nwps",
        "advisories", "advisories-now", "panels", "forecast-verification", "current-phase", "piscataqua", "asos",
    )),
    "v1/archive/WLIS_SFC.json", "v1/archive/EXRX_MET.json", "v1/archive/forecast-verification-sums.json",
    "v1/archive/usgs-tidal-pred.json",
    *(f"v1/fields/{n}.json" for n in (
        "sst", "chl", "kd490", "currents-mesh", "hrrr-wind", "hrrr-wind-history", "model-grids",
        "nwps-waves", "wind-against-tide", "rips", "piscataqua-currents", "piscataqua-currents-mesh",
    )),
    "v1/forecast-gfs.json", "v1/fields/currents.bin", "v1/piscataqua-pane/window.bin", "v1/piscataqua-pane/mesh.json",
    "v1/piscataqua-pane/nodes.f32", "v1/piscataqua-pane/tri.u16", "v1/fields/sst-90d.bin", "v1/fields/chl-90d.bin", "v1/fields/kd490-90d.bin", "v1/fields/piscataqua-currents-history.bin",
    "v1/hrrr-history/WLIS.json", "v1/hrrr-history/KHVN-recent.json",
]
REGION = [
    "v1/piscataqua-region/live.json", "v1/piscataqua-region/history.json",
    "v1/piscataqua-region/fields/currents.bin", "v1/piscataqua-region/fields/currents-mesh.json",
    "v1/piscataqua-region/fields/sst.json", "v1/piscataqua-region/fields/hrrr-wind.json",
    "v1/piscataqua-region/fields/sst-90d.bin",
]
REFUSED = [
    "v1/piscataqua-region/shore.json", "v1/piscataqua-region/fields/chl.json", "v1/piscataqua-region/../live.json",
    "v1/other-region/live.json", "v1/piscataqua-region/live.json.bak", "v1/live2.json", "v2/live.json",
    "v1/fields/currents.json", "v1/piscataqua-region/fields/currents.json",  # written as currents.bin
    "v1/piscataqua-pane/dem.bin", "v1/piscataqua-pane/tracks.f32",  # uploaded by hand, not by the jobs
]


@pytest.mark.parametrize("name", SOUND + REGION)
def test_written_names_pass(name):
    assert WRITABLE.fullmatch(name)


@pytest.mark.parametrize("name", REFUSED)
def test_other_names_are_refused(name):
    assert not WRITABLE.fullmatch(name)
