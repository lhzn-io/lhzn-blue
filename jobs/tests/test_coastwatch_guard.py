"""A CoastWatch server that stops answering is asked once per run, then skipped as an outage. Offline."""

import pytest
import requests

from lhzn_blue_jobs import coastwatch_guard as guard
from lhzn_blue_jobs.outages import is_outage

SST = ["mur_sst"]


@pytest.fixture(autouse=True)
def fresh(monkeypatch):
    guard.reset()
    monkeypatch.setattr(guard, "servers", lambda ids: ["https://cw.example/erddap"])
    yield
    guard.reset()


def test_a_server_that_does_not_answer_is_asked_once_and_skipped(monkeypatch):
    calls = []

    def down(url, **kw):
        calls.append(url)
        raise requests.ConnectTimeout("no route")

    monkeypatch.setattr(guard.requests, "get", down)
    for _ in range(3):
        with pytest.raises(guard.Unreachable) as e:
            guard.require(SST)
        assert is_outage(e.value)
    assert calls == ["https://cw.example/erddap/version"]


def test_an_answering_server_is_asked_once(monkeypatch):
    calls = []

    class Ok:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(guard.requests, "get", lambda url, **kw: calls.append(url) or Ok())
    guard.require(SST)
    guard.require(SST)
    assert len(calls) == 1


def test_a_failure_to_connect_marks_the_server_down(monkeypatch):
    class Ok:
        def raise_for_status(self):
            return None

    monkeypatch.setattr(guard.requests, "get", lambda url, **kw: Ok())
    guard.require(SST)
    guard.failed(SST, ValueError("no valid data for ['sst_mur'] in the 2 days"))  # answered, just empty
    guard.require(SST)
    guard.failed(SST, RuntimeError("ERDDAP: giving up after 3 attempts: https://cw.example/x"))
    with pytest.raises(guard.Unreachable):
        guard.require(SST)
