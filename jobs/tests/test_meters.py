"""A current meter's 6-minute readings as hourly knots along and across its flood direction, and a held window
merged. Offline."""

from datetime import datetime, timezone

import pandas as pd
import pytest

from lhzn_blue_jobs import coops, meters

FLOOD = 310
METER = {"id": "GRTN", "coops_id": "nl0101", "flood_dir": FLOOD, "realtime_bin": 2, "bins_m": [6.0, 10.0]}
KT50 = 50 * meters.CMS_TO_KT


def rows(hour: str, s: float, d: float, n: int = 10) -> list[dict]:
    return [{"t": f"{hour}:{6 * i:02d}", "s": str(s), "d": str(d), "b": "1"} for i in range(n)]


def test_flood_and_ebb():
    flood, _ = meters.parts_hourly(rows("2026-10-29 10", 50.0, FLOOD), FLOOD)
    ebb, last = meters.parts_hourly(rows("2026-10-29 11", 50.0, FLOOD - 180), FLOOD)
    assert flood["kt"].iloc[0] == pytest.approx(KT50, abs=0.01)
    assert flood["x_kt"].iloc[0] == pytest.approx(0, abs=0.01)
    assert ebb["kt"].iloc[0] == pytest.approx(-KT50, abs=0.01)
    assert last["dir_deg"] == FLOOD - 180 and last["along_kt"] < 0


def test_across_is_clockwise_of_flood():
    f, _ = meters.parts_hourly(rows("2026-10-29 10", 50.0, FLOOD + 90), FLOOD)
    assert f["kt"].iloc[0] == pytest.approx(0, abs=0.01)
    assert f["x_kt"].iloc[0] == pytest.approx(KT50, abs=0.01)


def test_bad_pings_left_out():
    bad = rows("2026-10-29 10", 50.0, FLOOD, n=9) + [{"t": "2026-10-29 10:54", "s": "900", "d": str(FLOOD), "b": "1"}]
    f, _ = meters.parts_hourly(bad, FLOOD)
    assert f["kt"].iloc[0] == pytest.approx(KT50, abs=0.01)


def test_failed_bin_keeps_its_window(monkeypatch):
    end = datetime(2026, 10, 29, 12, 5, tzinfo=timezone.utc)
    held = {"t0": "2026-10-29T09:00:00Z", "step": 3600, "kt": [0.3, 0.2, 0.1], "x_kt": [0.0, 0.1, 0.0]}
    prev = {"GRTN": {"bins": {"1": held, "2": held}, "last_obs": None, "status": {}}}

    def fake_get(params):
        if params["bin"] == 1:
            raise coops.CoopsError("bad request")
        return {"data": rows("2026-10-29 12", 20.0, FLOOD, n=1)}

    monkeypatch.setattr(coops, "_get", fake_get)
    out = meters.live(prev, end, [METER])["GRTN"]
    assert out["bins"]["1"]["kt"][:3] == [0.3, 0.2, 0.1]  # kept
    assert out["bins"]["1"]["x_kt"][:3] == [0.0, 0.1, 0.0]
    assert out["bins"]["2"]["kt"][-1] == pytest.approx(20 * meters.CMS_TO_KT, abs=0.01)  # merged
    assert "bin 1" in out["status"]["last_error"]
    assert out["last_obs"]["along_kt"] > 0
    assert pd.Timestamp(out["bins"]["2"]["t0"]) == pd.Timestamp("2026-10-29T09:00:00Z")


def test_bin_without_across_refetches_its_window(monkeypatch):
    end = datetime(2026, 10, 29, 12, 5, tzinfo=timezone.utc)
    old = {"t0": "2026-10-29T09:00:00Z", "step": 3600, "kt": [0.3, 0.2, 0.1]}
    asked = []

    def fake_get(params):
        asked.append(params["begin_date"])
        return None

    monkeypatch.setattr(coops, "_get", fake_get)
    meters.live({"GRTN": {"bins": {"1": old, "2": old}}}, end, [METER])
    # Each bin asks from the window's start, 30 days back (in 30-day spans), not just the last few hours.
    assert sum(a.startswith("20260929") for a in asked) == 2
