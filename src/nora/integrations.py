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
# The UK gas day starts at 05:00 UK time; National Gas's tables run over one gas day.
GAS_DAY_START_MINUTES = 5 * 60
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
    Cloudflare blocks requests without a browser User-Agent, so `fetch` sends one.

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
    # National Gas answers a client that names itself: no need to pose as a browser.
    user_agent = "nora-network (https://github.com/Rayha33/nora-network)"

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
                        # The table runs over a UK gas day, 05:00 to 05:00: after
                        # midnight "00:02" is newer than "23:58", so order by the
                        # minutes since 05:00, not by the text of the time.
                        def in_gas_day(reading):
                            hours, minutes = map(int, reading[0].split(":"))
                            return (hours * 60 + minutes - GAS_DAY_START_MINUTES) % 1440

                        return float(max(readings, key=in_gas_day)[1])
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
            self.url(), headers={"User-Agent": self.user_agent, "Accept": "application/json"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        when, value = self.parse(payload)
        yield Reading(when, "iuk", self.metric, value)


gassco = GasscoRealTime()
interconnector = NationalGasInterconnector()

origo = Origo()

# Live sources `nora live --source <name>` can poll.
SOURCES = {"gassco": gassco, "interconnector": interconnector, "origo": origo}

CONNECTORS = (origo, GassocoBooking(), gassco, interconnector)
