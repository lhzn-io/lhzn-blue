"""The near files (fields.near): the hours around now from a map file, with its mesh and encoding. Offline."""

from datetime import datetime, timedelta, timezone

from lhzn_blue_jobs import fields, hrrr_grid, nwps

END = datetime(2026, 11, 8, 14, 37, tzinfo=timezone.utc)


def doc(hours: range) -> dict:
    t0 = datetime(2026, 11, 8, 14, tzinfo=timezone.utc)
    frames = [{"valid_time": f"{t0 + timedelta(hours=h):%Y-%m-%dT%H:%MZ}", "u": "AA==", "v": "AA=="} for h in hours]
    return {"kind": "wind", "mesh": {"nx": 1, "ny": 1}, "encoding": {"step": 0.25}, "frames": frames}


def test_keeps_only_the_window_around_the_hour():
    out = fields.near(doc(range(-24, 49)), END, hrrr_grid.NEAR_BACK, hrrr_grid.NEAR_AHEAD)
    times = [f["valid_time"] for f in out["frames"]]
    assert times[0] == "2026-11-08T12:00Z" and times[-1] == "2026-11-08T20:00Z"
    assert len(times) == hrrr_grid.NEAR_BACK + hrrr_grid.NEAR_AHEAD + 1
    assert out["near"] == {"from": "2026-11-08T12:00Z", "to": "2026-11-08T20:00Z"}
    assert out["mesh"] == {"nx": 1, "ny": 1} and out["encoding"] == {"step": 0.25}


def test_nwps_window_reaches_further_ahead():
    out = fields.near(doc(range(-24, 73)), END, nwps.FIELD_NEAR_BACK, nwps.FIELD_NEAR_AHEAD)
    assert out["frames"][-1]["valid_time"] == "2026-11-09T02:00Z"


def test_none_when_no_frame_is_near():
    assert fields.near(doc(range(-24, -10)), END, 2, 6) is None
