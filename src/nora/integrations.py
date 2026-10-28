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
Norwegian exports, and `nora live --source interconnector --poll-seconds 120` polls
signed physical IUK flow from National Gas (see below).
"""

from __future__ import annotations

import json
import os
import re
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

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

# Gassco's real-time endpoint aggregates flow by receiving country, not by terminal;
# a country total lands on that country's market node. "Other" and "Total" have no node.
GASSCO_URL = "https://gassco.eu/wp-json/gassco/v1/realTimeGraphData"
RECEIVING_COUNTRIES = {
    "Germany": "the",
    "France": "peg",
    "Belgium": "ztp",
    "Great Britain": "nbp",
}
# Cloudflare in front of gassco.eu rejects anything that does not look like a browser.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36"
)


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


class GasscoRealTime(Connector):
    """Gassco's public real-time export: aggregate Norwegian flow by receiving country.

    Endpoint: GASSCO_URL (open, no key; the figures on Gassco's home page chart come
    from it). Values are MSm3/d and the timestamp is epoch milliseconds; Gassco
    publishes every 5 minutes, so that is the poll interval the CLI defaults to.
    Cloudflare blocks requests without a browser User-Agent, so `fetch` sends one.

    The endpoint aggregates per country, not per terminal, so a reading lands on the
    receiving country's market node (a country total is closest to "gas delivered
    there") rather than pretending a single terminal measured it. NORA keeps no
    record of which share went to which terminal; the map shows the honest aggregate.
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
                "Gassco's real-time endpoint; a country total lands on that country's "
                "market node (THE, PEG, ZTP, NBP). Values in MSm3/d."
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


class NationalGasInterconnector(Connector):
    """Signed physical IUK flow from National Gas's public latest-flows API.

    Bacton INT Export is Bacton -> Zeebrugge (positive, the pipeline CSV direction);
    BACTON IC is Zeebrugge -> Bacton (negative). Both are mcm/day, numerically the
    same unit as MSm3/d. National Gas updates the instantaneous readings every two
    minutes. Zeebrugge/IUK is operated by Interconnector/Fluxys, not GTS.
    """

    name = "National Gas IUK physical flow"
    metric = "flow_msm3d"
    env = ()
    url_default = "https://data.nationalgas.com/api/latest-gas-flows"

    def url(self) -> str:
        return os.environ.get("NORA_NATIONAL_GAS_URL", self.url_default)

    def status(self) -> str:
        return f"ready ({self.url()})"

    def meta(self) -> dict:
        return {
            "name": "interconnector",
            "title": self.name,
            "description": (
                "Signed physical flow on Interconnector (IUK): positive Bacton to "
                "Zeebrugge, negative Zeebrugge to Bacton. National Gas instantaneous "
                "readings in MSm3/d; Zeebrugge/IUK is operated by Interconnector/Fluxys."
            ),
            "source": self.url_default,
            "synthetic": False,
        }

    @staticmethod
    def parse(payload: dict) -> tuple[datetime, float]:
        data = payload["data"]

        def latest(section: str, label: str) -> float:
            for row in data[section]["data"]:
                name = row.get("SYSTEM ENTRY NAME") or row.get("TERMINAL TOTALS")
                if name and name.casefold() == label.casefold():
                    readings = [
                        (time, value)
                        for time, value in row.items()
                        if re.fullmatch(r"\d{2}:\d{2}", time) and isinstance(value, (int, float))
                    ]
                    if readings:
                        return float(sorted(readings)[-1][1])
            raise ValueError(f"National Gas: missing {label} reading")

        published = data.get("publishedDate")
        if not published:
            raise ValueError("National Gas: missing publication timestamp")
        local = datetime.strptime(published, "%d/%m/%Y %H:%M").replace(
            tzinfo=ZoneInfo("Europe/London")
        )
        value = latest("Demand from interconnectors", "Bacton INT Export") - latest(
            "Supply from entry points", "BACTON IC"
        )
        return local.astimezone(UTC), value

    def fetch(self, start: datetime, end: datetime) -> Iterator[Reading]:
        request = urllib.request.Request(
            self.url(), headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        when, value = self.parse(payload)
        yield Reading(when, "iuk", self.metric, value)


gassco = GasscoRealTime()
interconnector = NationalGasInterconnector()

# Live sources `nora live --source <name>` can poll.
SOURCES = {"gassco": gassco, "interconnector": interconnector}

CONNECTORS = (Origo(), GassocoBooking(), gassco, interconnector)
