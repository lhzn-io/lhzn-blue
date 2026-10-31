"""Verification by model: GFS is scored at its own leads and bands, from its own part of the archive."""

import gzip

import numpy as np
import pandas as pd

from lhzn_blue_jobs import verify


def obs(hours):
    t = pd.date_range("2026-10-01T06", periods=hours, freq="h", tz="UTC")
    return {"EXRX": pd.DataFrame({"wind_kt": 10.0, "dir_deg": 270.0, "air_f": 50.0, "pressure_mb": 1015.0, "water_c": 12.0}, index=t)}


def gfs_rows():
    issue = pd.Timestamp("2026-10-01T00", tz="UTC")
    rows = [{"issue_time": issue, "lead_h": h, "point": "EXRX", "u10": 6.0, "v10": 0.0} for h in (6, 12, 24, 96)]
    df = pd.DataFrame(rows)
    df["valid_time"] = df["issue_time"] + pd.to_timedelta(df["lead_h"], unit="h")
    return df


def test_gfs_pairs_take_its_bands_and_leave_air_and_pressure_missing():
    d = verify.pairs(gfs_rows(), obs(120), verify.GFS.bands)
    assert sorted(d["band"].unique()) == ["6-24", "96-168"]
    assert d["e_t"].isna().all() and d["e_p"].isna().all() and d["stability"].isna().all()
    assert np.allclose(d["e_spd"], 6.0 * verify.MS_TO_KT - 10.0 * verify.HEIGHT_FACTOR)


def test_gfs_public_lists_its_leads_and_model():
    groups: dict = {}
    verify.accumulate(groups, verify.pairs(gfs_rows(), obs(120), verify.GFS.bands))
    out = verify.public({"groups": groups, "through": "2026-10-06T00:00Z"}, pd.Timestamp("2026-10-06", tz="UTC"), verify.GFS)
    assert out["model"] == "gfs" and out["leads"] == [6, 12, 24, 96]
    assert set(out["bins"]) == set(verify.GFS.bands) and set(out["recent"]["bands"]) == {"6-24", "96-168"}
    assert out["by_lead"]["96"]["all"]["n"] == 1 and out["by_lead"]["96"]["all"]["air_n"] == 0


def test_hrrr_keeps_its_own_defaults():
    assert verify.HRRR.sums_key == verify.SUMS_KEY and verify.HRRR.public_key == verify.PUBLIC_KEY
    assert list(verify.HRRR.leads) == verify.LEADS and verify.HRRR.bands == verify.BANDS


def write_cycle(path, field_rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    df = pd.DataFrame(field_rows, columns=["issue_time", "valid_time", "lead_h", "point", "field", "value"])
    path.write_bytes(gzip.compress(df.to_csv(index=False).encode()))


def test_each_model_reads_its_own_part_of_the_archive(tmp_path):
    hrrr = [("2026-10-01T00:00Z", "2026-10-01T06:00Z", 6, "EXRX", f, 1.0) for f in ("u10", "v10", "t2m", "mslp")]
    gfsr = [("2026-10-01T00:00Z", "2026-10-05T00:00Z", 96, "EXRX", f, 2.0) for f in ("u10", "v10", "gust")]
    write_cycle(tmp_path / "2026/10/cycle=2026100100.csv.gz", hrrr)
    write_cycle(tmp_path / "gfs/2026/10/cycle=2026100100.csv.gz", gfsr)
    h = verify.forecasts_from_archive(tmp_path)
    g = verify.forecasts_from_archive(tmp_path, verify.GFS)
    assert h["lead_h"].tolist() == [6] and g["lead_h"].tolist() == [96]
    assert "gust" not in g.columns and g["u10"].tolist() == [2.0]
