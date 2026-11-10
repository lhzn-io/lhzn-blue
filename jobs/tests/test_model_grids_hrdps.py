"""HRDPS on the wind models page: the cells over the box from a synthetic rotated grid, and winds to east and north."""

import numpy as np
import pytest

from lhzn_blue_jobs import model_grids as mg

hrdps = pytest.importorskip("forcingkit.fetchers.hrdps")

SP = (-36.08852, 245.305142)  # HRDPS's southern pole of rotation
D = 0.0225


def rotated_grid(flip_rows=False, flip_cols=False):
    """A patch of a rotated grid at HRDPS's spacing around the box, as the GRIB reader gives it: 2-D lon (0..360), lat."""
    x0, y0, x1, y1 = mg.BOX
    rx, ry = hrdps.geographic_to_rotated((x0 + x1) / 2, (y0 + y1) / 2, *SP)
    gx, gy = np.meshgrid(rx + D * np.arange(-120, 121), ry + D * np.arange(-80, 81))
    lon, lat = hrdps.rotated_to_geographic(gx, gy, *SP)
    lon = lon % 360.0
    if flip_rows:
        lon, lat = lon[::-1], lat[::-1]
    if flip_cols:
        lon, lat = lon[:, ::-1], lat[:, ::-1]
    return lon, lat


def test_cells_cover_the_box_rows_north_columns_east():
    lon, lat = rotated_grid()
    box = mg.hrdps_cells(lon, lat, *SP)
    g = box["grid"]
    assert len(g["lon"]) == len(g["lat"]) == (g["nx"] + 1) * (g["ny"] + 1)
    glon = np.array(g["lon"]).reshape(g["ny"] + 1, g["nx"] + 1)
    glat = np.array(g["lat"]).reshape(g["ny"] + 1, g["nx"] + 1)
    assert (glat[-1] > glat[0]).all() and (glon[:, -1] > glon[:, 0]).all()
    x0, y0, x1, y1 = mg.BOX
    assert glon.min() <= x0 and glon.max() >= x1 and glat.min() <= y0 and glat.max() >= y1
    # Each quad's corners average to its cell's center.
    cl = ((lon[box["rows"], box["cols"]] + 180) % 360) - 180
    ct = lat[box["rows"], box["cols"]]
    mid_lon = (glon[:-1, :-1] + glon[:-1, 1:] + glon[1:, :-1] + glon[1:, 1:]) / 4
    mid_lat = (glat[:-1, :-1] + glat[:-1, 1:] + glat[1:, :-1] + glat[1:, 1:]) / 4
    assert np.abs(mid_lon - cl).max() < 2e-4 and np.abs(mid_lat - ct).max() < 2e-4
    assert 9000 < g["nx"] * g["ny"] < 15000  # 2.5 km cells; the grid is turned about 33 degrees here, so more than the box holds


@pytest.mark.parametrize("flips", [(True, False), (False, True), (True, True)])
def test_file_order_does_not_change_the_grid(flips):
    a = mg.hrdps_cells(*rotated_grid(), *SP)["grid"]
    b = mg.hrdps_cells(*rotated_grid(*flips), *SP)["grid"]
    assert (a["nx"], a["ny"]) == (b["nx"], b["ny"])
    assert np.allclose(a["lon"], b["lon"], atol=2e-4) and np.allclose(a["lat"], b["lat"], atol=2e-4)


def test_grid_relative_winds_turn_to_east_and_north():
    lon, lat = rotated_grid(flip_rows=True)
    ang = hrdps.grid_east_angle(((lon + 180) % 360) - 180, lat, *SP)
    ue, vn = 6.0, -3.0  # the same earth-relative wind everywhere
    ug = np.cos(ang) * ue + np.sin(ang) * vn  # as on the grid's axes
    vg = -np.sin(ang) * ue + np.cos(ang) * vn
    box = mg.hrdps_cells(lon, lat, *SP)
    u, v = mg.hrdps_winds(box, ug, vg)
    assert u.shape == (box["grid"]["ny"], box["grid"]["nx"])
    assert np.allclose(u, ue, atol=1e-6) and np.allclose(v, vn, atol=1e-6)
    assert np.abs(ang).max() > 0.05  # the grid is turned here, so the test turns something


def test_models_finest_to_coarsest():
    assert mg.ORDER[:2] == ["hrdps", "hrrr"] and set(mg.ORDER) == set(mg.META)
