"""Connections to shipper systems: Origo (nominations and dispatch) and Gassco Booking
(GBS, capacity booking).

Neither system publishes an open API: access comes with shipper credentials. NORA
therefore works with what they export today, and has one marked place per system to
plug in a live connection once the API documentation and credentials are available.

  Origo  ->  nomination_msm3d  hourly nominated rate at each exit point
  GBS    ->  booked_msm3d      booked capacity at each exit point

From an export: put the CSV in a stream folder and add an [[import]] block per file to
its stream.toml, with `metric = "nomination_msm3d"` or `metric = "booked_msm3d"` and
the exit points mapped with EXIT_POINTS below (see data/streams/README.md). The site,
the plan check and the overview then use them like any other reading.

Live: subclass Connector, implement `fetch`, and serve it with nora.live like `replay`.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime

# Gassco's names for the exit points where Norwegian gas lands, mapped to NORA nodes.
EXIT_POINTS = {
    "St. Fergus": "st_fergus",
    "St Fergus": "st_fergus",
    "Easington": "easington",
    "Dornum": "dornum",
    "Emden": "emden",
    "Zeebrugge": "zeebrugge",
    "Dunkerque": "dunkirk",
    "Dunkirk": "dunkirk",
}


class NotConfigured(RuntimeError):
    """The live connection has no endpoint or credentials yet."""


@dataclass(frozen=True)
class Reading:
    when: datetime
    asset: str  # NORA node id
    metric: str  # nomination_msm3d or booked_msm3d
    value: float  # MSm3/d


class Connector:
    """A live source of readings. `fetch` returns what is known for [start, end)."""

    name = "connector"
    metric = ""
    env = ("",)  # environment variables holding the endpoint and credentials

    def configured(self) -> bool:
        return all(os.environ.get(variable) for variable in self.env)

    def status(self) -> str:
        missing = [v for v in self.env if not os.environ.get(v)]
        return "ready" if not missing else f"not configured: set {', '.join(missing)}"

    def fetch(self, start: datetime, end: datetime) -> Iterator[Reading]:
        raise NotConfigured(
            f"{self.name}: no live API connected yet ({self.status()}). Use its CSV export "
            "through stream.toml meanwhile; see nora/integrations.py."
        )


class Origo(Connector):
    """Nominations and dispatch. Fill in `fetch` with Origo's API when available."""

    name = "Origo"
    metric = "nomination_msm3d"
    env = ("NORA_ORIGO_URL", "NORA_ORIGO_TOKEN")


class GassocoBooking(Connector):
    """Gassco Booking (GBS): booked capacity. Fill in `fetch` when an API is available."""

    name = "Gassco Booking (GBS)"
    metric = "booked_msm3d"
    env = ("NORA_GBS_URL", "NORA_GBS_TOKEN")


CONNECTORS = (Origo(), GassocoBooking())
