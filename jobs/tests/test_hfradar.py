"""The Sound's HF radar archive (hfradar.py): the box, where the files go, and that requests name this site. The
reading and the file format are forcingkit's and tested there. Offline."""

from forcingkit.fetchers import hfradar as fk

from lhzn_blue_jobs import hfradar
from lhzn_blue_jobs.merlin import USER_AGENT


def test_box_is_the_sound():
    assert fk.box_key(hfradar.BBOX) == "40.850N_41.300N_073.800W_071.800W"


def test_store_is_a_directory_unless_a_bucket(tmp_path, monkeypatch):
    monkeypatch.setenv("FORCINGKIT_CACHE_DIR", str(tmp_path))
    assert hfradar.store(None).root == tmp_path / "hfradar"  # forcingkit's own cache
    assert hfradar.store(str(tmp_path / "elsewhere")).root == tmp_path / "elsewhere"


def test_archive_passes_the_box_store_and_user_agent(tmp_path, monkeypatch):
    seen = {}

    def fake(bbox, start, end, store, session):
        seen.update(bbox=bbox, start=start, end=end, store=store, agent=session.headers["User-Agent"])
        return {"1km": [], "2km": []}

    monkeypatch.setattr(fk, "archive", fake)
    assert hfradar.archive(str(tmp_path), "all") == {"1km": [], "2km": []}
    assert seen["bbox"] == hfradar.BBOX and seen["start"] == "all" and seen["end"] is None
    assert seen["store"].root == tmp_path and seen["agent"] == USER_AGENT
