"""Outages (a source with no data) are warnings; faults fail the job. Offline."""

import logging

import pytest
import requests

from lhzn_blue_jobs import coops, erddap, merlin
from lhzn_blue_jobs.outages import is_outage, record

OUTAGES = [
    # The CoastWatch errors that failed the fields jobs in October 2026.
    ValueError("no valid data for ['sst_mur'] in the 2 days to 2026-10-26T00:06:21Z"),
    ValueError("no valid data for ['sst_mur'] between 2026-07-27T23:59:59Z and 2026-10-26T00:06:21Z"),
    requests.ConnectionError("Connection refused"),
    requests.ReadTimeout("read timed out"),
    requests.HTTPError("503 Server Error: Service Unavailable"),
    merlin.ServerUnreachable("server unreachable since 2026-10-15T10:00:00Z"),
    erddap.Unreachable("no connection after 3 attempts"),
    coops.CoopsError("No data was found. This product may not be offered at this station"),
    RuntimeError("giving up after 4 attempts: https://example.org/x"),
    OSError("NetCDF: DAP failure"),
    TimeoutError(),
]
FAULTS = [
    merlin.RequestBudgetExceeded("40 requests reached this job's budget"),
    erddap.BudgetExceeded("60 requests reached this run's budget"),
    TypeError("unsupported operand type(s) for +: 'int' and 'str'"),
    KeyError("water_f"),
    ValueError("could not convert string to float: 'abc'"),
    ValueError("refusing to write unexpected object name: v1/x.json"),
]


@pytest.mark.parametrize("exc", OUTAGES)
def test_outages_are_recognised(exc):
    assert is_outage(exc)


@pytest.mark.parametrize("exc", FAULTS)
def test_faults_are_not_outages(exc):
    assert not is_outage(exc)


def test_record_fails_the_job_only_for_faults():
    failed: list[str] = []
    log = logging.getLogger("test")
    record(failed, "sst", OUTAGES[0], log)
    record(failed, "sst-90d", OUTAGES[1], log)
    assert failed == []
    record(failed, "currents", FAULTS[2], log)
    assert failed == ["currents"]
