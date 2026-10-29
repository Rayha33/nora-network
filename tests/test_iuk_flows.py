"""Real Interconnector (IUK) flows on the site (Ray, 29 Oct: "the interconnector data
need to be implemented"). The live connector needs `nora live` on your own machine,
because National Gas allows no cross-origin requests from the static site, so the site
replays a recorded year of National Gas's daily physical flows instead."""

from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from pathlib import Path

import pytest

from nora.integrations import USER_AGENT, interconnector
from nora.stream import load_stream

ROOT = Path(__file__).resolve().parents[1]
EXPORT = "NTS Physical Flows, Bacton, Interconnector"  # PUBOB2038: Bacton -> Zeebrugge
IMPORT = "System Entry Volume, BactonInterconnector, D+1"  # PUBOBJ592: Zeebrugge -> Bacton


def fetcher():
    spec = importlib.util.spec_from_file_location(
        "fetch_nationalgas", ROOT / "scripts" / "fetch_nationalgas.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The shape National Gas's find-gas-data download returns, trimmed.
DOWNLOAD = f"""Applicable At,Applicable For,Data Item,Value,Generated Time,Quality Indicator
28/10/2026 09:12:42,27/10/2026,"{EXPORT}",6.32629,28/10/2026 11:30:00,
28/10/2026 05:16:09,27/10/2026,"{IMPORT}",0,28/10/2026 11:30:00,
27/10/2026 08:39:16,26/10/2026,"{EXPORT}",8.1,27/10/2026 11:30:00,
27/10/2026 09:00:00,26/10/2026,"{EXPORT}",8.53431,27/10/2026 16:36:00,A
"""


def test_the_download_becomes_one_reading_per_point_and_gas_day():
    rows = fetcher().readings(DOWNLOAD)
    assert rows == [
        # the amended value, published later, replaces the first one
        {"gas_day": "2026-10-26T05:00", "point": EXPORT, "value": "8.53431", "quality": "A"},
        {"gas_day": "2026-10-27T05:00", "point": EXPORT, "value": "6.32629", "quality": ""},
        {"gas_day": "2026-10-27T05:00", "point": IMPORT, "value": "0", "quality": ""},
    ]


def test_the_site_replays_iuk_as_one_signed_flow(north_sea):
    stream = load_stream("iuk-flows", north_sea)
    assert not stream.synthetic
    assert stream.assets == ("iuk",)
    flow = {when: row[0] for when, row in zip(stream.times, stream.values, strict=True)}
    # Gas days start at 05:00 UK time: 04:00 UTC in summer, 05:00 UTC in winter.
    assert flow[datetime(2026, 7, 15, 4, tzinfo=UTC)] == pytest.approx(34.94673)  # exports
    assert flow[datetime(2026, 1, 5, 5, tzinfo=UTC)] == pytest.approx(-5.04243)  # imports
    assert flow[datetime(2026, 10, 27, 5, tzinfo=UTC)] == pytest.approx(6.32629)
    assert len(stream.times) >= 365, "a year of gas days: summer exports and winter imports"


def test_national_gas_is_asked_with_an_honest_user_agent():
    # The data portal answers a plain client that names itself. Every NORA client
    # names itself now, Gassco's too (review #49802: it used to pose as Chrome).
    for agent in (fetcher().USER_AGENT, interconnector.user_agent, USER_AGENT):
        assert "Mozilla" not in agent and "nora-network" in agent
