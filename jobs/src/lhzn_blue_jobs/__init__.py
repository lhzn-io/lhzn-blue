"""Ingest jobs for longhorizon.blue."""

import insitukit

from .merlin import USER_AGENT

# Every CO-OPS and ERDDAP request through insitukit names this site, as Merlin's and USGS's requests do.
insitukit.identify(USER_AGENT, application="lhzn-blue")
