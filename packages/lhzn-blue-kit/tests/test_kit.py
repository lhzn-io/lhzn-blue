"""The kit's statistics, its store's cost guard and the CO-OPS predictions reader. Offline."""

import re
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from lhzn_blue_kit import coops, stats
from lhzn_blue_kit.store import Store


def test_a_day_with_less_than_half_its_records_has_no_mean():
    t = pd.date_range("2026-07-01", periods=96 * 2, freq="15min", tz="UTC")
    s = pd.Series(10.0, index=t)
    s.iloc[96 + 50:] = np.nan  # the second day keeps 50 of 96
    s.iloc[96:96 + 47] = np.nan  # and then only 3
    out = stats.day_means(s, 96, 2)
    assert out.iloc[0] == 10.0 and pd.isna(out.iloc[1])


def test_exceedance_counts_the_share_strictly_above():
    assert stats.exceedance([0.1, 0.2, 0.3, np.nan], [0.0, 0.2, 0.3]) == [1.0, 0.3333, 0.0]
    assert stats.exceedance([], [1.0]) == [None]


def test_joint_pairs_the_nearest_time_within_the_tolerance():
    t = pd.date_range("2026-07-01", periods=3, freq="20min", tz="UTC")
    a = pd.Series([0.05, 0.25, 4.0], index=t)
    b = pd.Series([5.0, 35.0], index=[t[0] + pd.Timedelta(minutes=2), t[2] + pd.Timedelta(minutes=20)])
    counts = stats.joint(a, b, [0.0, 0.2, 3.0], [0, 20], pair_s=600)
    assert counts == [[1, 0], [0, 0], [0, 0]]  # only the first burst has a partner within 10 minutes


def test_climatology_of_a_seasonal_cycle_follows_it():
    t = pd.date_range("2008-01-01", "2017-12-31", freq="D")
    days = pd.Series(10 + 8 * np.sin(2 * np.pi * (t.dayofyear - 110) / 365.25), index=t)
    c = stats.climatology(days)
    assert len(c["mean"]) == 366 and c["mean"][59] == c["mean"][58]
    assert c["mean"][200] == pytest.approx(10 + 8 * np.sin(2 * np.pi * 90 / 365.25), abs=0.3)
    assert all(p >= m for p, m in zip(c["p90"], c["mean"]))
    assert min(c["n"]) >= 10 * 11 - 3


def test_the_store_refuses_names_outside_its_pattern_and_oversized_objects(tmp_path):
    store = Store(str(tmp_path), re.compile(r"v1/a\.json"), max_bytes=10)
    store.write_json("v1/a.json", {"x": 1}, max_age=60)
    assert store.read_json("v1/a.json") == {"x": 1}
    with pytest.raises(ValueError, match="unexpected object name"):
        store.write_json("v1/b.json", {}, max_age=60)
    with pytest.raises(ValueError, match="exceeds"):
        store.write_bytes("v1/a.json", b"x" * 11, max_age=60)


def test_predictions_read_every_window_and_keep_the_range(monkeypatch):
    calls = []

    def fake_get(params):
        calls.append(params)
        lo = datetime.strptime(params["begin_date"], "%Y%m%d %H:%M")
        return {"predictions": [{"t": (lo + pd.Timedelta(minutes=6 * k)).strftime("%Y-%m-%d %H:%M"), "v": str(k)} for k in range(3)]}

    monkeypatch.setattr(coops, "_get", fake_get)
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    s = coops.predictions("8419870", start, datetime(2026, 2, 5, tzinfo=timezone.utc))
    assert len(calls) == 2 and calls[0]["interval"] == "6" and calls[0]["datum"] == "MLLW"
    assert len(s) == 6 and s.index[0] == pd.Timestamp(start) and s.iloc[1] == 1.0
