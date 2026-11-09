"""HRDPS at the stations: what the verification's file keeps, the archive's place, and the backfill's runs."""

from datetime import datetime, timezone

import pandas as pd

from lhzn_blue_jobs import forecast, hrdps, verify

COLUMNS = ["issue_time", "valid_time", "lead_h", "point", "field", "value"]


def rows(cycle, leads, value=1.0):
    return [(cycle, cycle + pd.Timedelta(hours=h), h, "EXRX", f, value) for h in leads for f in ("u10", "v10")]


def test_file_keeps_every_lead_for_new_runs_and_verification_leads_for_older():
    end = datetime(2026, 11, 9, 18, tzinfo=timezone.utc)
    cycles = [pd.Timestamp("2026-11-09T12"), pd.Timestamp("2026-11-09T06"), pd.Timestamp("2026-11-07T00"), pd.Timestamp("2026-11-01T00")]
    df = pd.DataFrame([r for c in cycles for r in rows(c, hrdps.LEADS)], columns=COLUMNS)
    out = hrdps.page_file(None, df, end)
    cyc = out["cycles"]
    assert sorted(cyc) == ["2026-11-07T00Z", "2026-11-09T06Z", "2026-11-09T12Z"]  # the 1st is past KEEP_DAYS
    assert cyc["2026-11-09T12Z"]["leads"] == hrdps.LEADS
    assert cyc["2026-11-07T00Z"]["leads"] == hrdps.VERIFY_LEADS
    assert "Environment and Climate Change Canada" in out["source"]


def test_file_adds_to_what_it_kept():
    end = datetime(2026, 11, 9, 18, tzinfo=timezone.utc)
    first = hrdps.page_file(None, pd.DataFrame(rows(pd.Timestamp("2026-11-09T06"), [1, 2]), columns=COLUMNS), end)
    both = hrdps.page_file(first, pd.DataFrame(rows(pd.Timestamp("2026-11-09T12"), [1, 2]), columns=COLUMNS), end)
    assert sorted(both["cycles"]) == ["2026-11-09T06Z", "2026-11-09T12Z"]


def test_verification_reads_the_file_at_hrrrs_leads():
    end = datetime(2026, 11, 9, 18, tzinfo=timezone.utc)
    page = hrdps.page_file(None, pd.DataFrame(rows(pd.Timestamp("2026-11-09T06"), hrdps.LEADS), columns=COLUMNS), end)
    fc = verify.forecasts_from_page(page, verify.HRDPS.fields)
    assert set(fc.columns) >= {"issue_time", "valid_time", "lead_h", "point", "u10", "v10"}
    assert verify.HRDPS.leads == tuple(verify.LEADS)
    assert verify.HRDPS.page_key == hrdps.KV_KEY


def test_archive_and_backfill_go_under_hrdps(tmp_path, monkeypatch):
    seen = []

    def fake_fetch(cycle, leads, pts, fields=hrdps.FIELDS):
        seen.append((cycle, tuple(leads), tuple(fields)))
        return pd.DataFrame(rows(cycle, leads), columns=COLUMNS)

    monkeypatch.setattr(hrdps, "fetch_cycle", fake_fetch)
    monkeypatch.setattr(forecast, "points", lambda: {"EXRX": (-73.73, 40.88)})
    counts = hrdps.backfill(str(tmp_path), "2026-11-08T00", "2026-11-09T00", task=1, tasks=2)
    assert counts == {"cycles": 2, "archived": 2, "already": 0, "empty": 0, "failed": 0}
    assert [c for c, _, _ in seen] == [pd.Timestamp("2026-11-08T06"), pd.Timestamp("2026-11-08T18")]
    assert all(leads == tuple(hrdps.VERIFY_LEADS) and fields == hrdps.WIND for _, leads, fields in seen)
    assert (tmp_path / "hrdps/2026/11/cycle=2026110806.csv.gz").exists()
    # A rerun skips what is archived.
    assert hrdps.backfill(str(tmp_path), "2026-11-08T00", "2026-11-09T00", task=1, tasks=2)["already"] == 2


def test_hrrrs_archive_reading_leaves_hrdps_out():
    assert "hrdps" in {m.archive_dir for m in verify.MODELS.values()}
