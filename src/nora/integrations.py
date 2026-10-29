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

Live: subclass Connector, implement `fetch`, and serve it with nora.live like `replay`
(yield (wait, frame) pairs; the server writes keepalive comments while it waits).

Public live sources need no credentials: `nora live --source gassco` polls aggregate
Norwegian exports.
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime

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

# Gassco's real-time endpoint aggregates flow by receiving country, not by terminal.
# Where Norwegian gas lands at one terminal only, the country total is that terminal's
# flow. Germany (Emden, Dornum) and Great Britain (St Fergus, Easington) land at two,
# and the market nodes that took their totals are no longer in the network (Ray, 29
# Oct), so those totals have no node: NORA does not invent a split. "Other" and
# "Total" have no node either.
GASSCO_URL = "https://gassco.eu/wp-json/gassco/v1/realTimeGraphData"
RECEIVING_COUNTRIES = {
    "France": "dunkirk",
    "Belgium": "zeebrugge",
}
# NORA says who it is (review #49802: it used to pose as Chrome to get past the
# Cloudflare check in front of gassco.eu). If Cloudflare refuses an honest client, the
# feed reports the failed poll; asking Gassco for access is the way past that.
USER_AGENT = "nora-network (https://github.com/Rayha33/nora-network)"


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
    flows = True  # its readings are flows; nominations and bookings are not

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
    """The shippers' hourly nominations at each exit point, from Origo (Ray, 29 Oct:
    "origo integration for hourly nominations from the shippers at each exitpoint ...
    what is important are rate of change at each exit point for the next 6 hours").

    `fetch` reads NORA_ORIGO_URL with NORA_ORIGO_TOKEN as a bearer token and yields one
    reading per exit point and hour, the coming hours included: the live feed sends
    the hours ahead with each frame, so the page shows the next 6 hours. Origo's API is
    not public: `parse` reads the shape below; adapt it to the real one.

        {"nominations": [{"point": "Emden", "hour": "2026-10-29T06:00:00Z", "msm3d": 44.0}]}

    `point` is Gassco's exit-point name (EXIT_POINTS) or a NORA node id.
    """

    name = "Origo"
    metric = "nomination_msm3d"
    env = ("NORA_ORIGO_URL", "NORA_ORIGO_TOKEN")
    flows = False

    def meta(self) -> dict:
        return {
            "name": "origo",
            "title": "Origo nominations",
            "description": (
                "The shippers' hourly nominations at each exit point, from Origo, with the "
                "coming hours. Values in MSm3/d."
            ),
            "source": "Origo",
            "synthetic": False,
        }

    def fetch(self, start: datetime, end: datetime) -> Iterator[Reading]:
        if not self.configured():
            raise NotConfigured(f"{self.name}: {self.status()}")
        request = urllib.request.Request(
            os.environ["NORA_ORIGO_URL"],
            headers={
                "Authorization": f"Bearer {os.environ['NORA_ORIGO_TOKEN']}",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        yield from self.parse(payload)

    def parse(self, payload: dict) -> Iterator[Reading]:
        for item in payload.get("nominations", []):
            point = str(item.get("point", ""))
            # Gassco's name for the exit point, or already a NORA node id
            node_id = point if re.fullmatch(r"[a-z0-9_]+", point) else None
            asset = EXIT_POINTS.get(point) or node_id
            if not asset or item.get("msm3d") is None:
                continue
            when = datetime.fromisoformat(str(item["hour"]).replace("Z", "+00:00"))
            yield Reading(when, asset, self.metric, float(item["msm3d"]))


class GassocoBooking(Connector):
    """Gassco Booking (GBS): booked capacity. Fill in `fetch` when an API is available."""

    name = "Gassco Booking (GBS)"
    metric = "booked_msm3d"
    env = ("NORA_GBS_URL", "NORA_GBS_TOKEN")
    flows = False


class GasscoRealTime(Connector):
    """Gassco's public real-time export: aggregate Norwegian flow by receiving country.

    Endpoint: GASSCO_URL (open, no key; the figures on Gassco's home page chart come
    from it). Values are MSm3/d and the timestamp is epoch milliseconds; Gassco
    publishes every 5 minutes, so that is the poll interval the CLI defaults to.
    `fetch` sends NORA's own User-Agent; Cloudflare may refuse it until Gassco allows
    NORA in, and the feed then reports each failed poll.

    The endpoint aggregates per country, not per terminal, so only a country with a
    single receiving terminal (France: Dunkirk, Belgium: Zeebrugge) gets a reading;
    NORA does not split the German or British totals between their two terminals.
    """

    name = "Gassco real-time exports"
    metric = "gassco_exit_msm3d"
    env = ()  # open endpoint; NORA_GASSCO_URL only overrides where to read it

    def url(self) -> str:
        return os.environ.get("NORA_GASSCO_URL", GASSCO_URL)

    def status(self) -> str:
        return f"ready ({self.url()})"

    def meta(self) -> dict:
        """The SSE `meta` event for `nora live --source gassco`: same shape as a
        stream's, minus the arrays (a poller has no pre-loaded times or values)."""
        return {
            "name": "gassco",
            "title": self.name,
            "description": (
                "Aggregate Norwegian export flow by receiving country, polled from "
                "Gassco's real-time endpoint; France lands at Dunkirk and Belgium at "
                "Zeebrugge. Germany and Great Britain land at two terminals each, so "
                "their totals are not shown. Values in MSm3/d."
            ),
            "source": GASSCO_URL,
            "synthetic": False,
        }

    def fetch(self, start: datetime, end: datetime) -> Iterator[Reading]:
        request = urllib.request.Request(
            self.url(),
            headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        when = datetime.fromtimestamp(payload["timestamp"] / 1000, tz=UTC)
        for node in payload["nodes"]:
            if asset := RECEIVING_COUNTRIES.get(node["name"]):
                yield Reading(when, asset, self.metric, float(node["value"]))


gassco = GasscoRealTime()

origo = Origo()

# Live sources `nora live --source <name>` can poll.
SOURCES = {"gassco": gassco, "origo": origo}

CONNECTORS = (origo, GassocoBooking(), gassco)
