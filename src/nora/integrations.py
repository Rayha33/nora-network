"""Connections to shipper systems: Origo (nominations and dispatch) and Gassco Booking
(GBS, capacity booking).

Neither system publishes an open API: access comes with shipper credentials. NORA
therefore connects to documented mocks of them (scripts/mock_origo.py and
scripts/mock_gbs.py, shapes in docs/integrations.md), so a real adapter only swaps the
transport (`download`) and the format (`parse`) once the API documentation and
credentials are available.

  Origo  ->  nomination_msm3d  hourly nominated rate at each exit point
  GBS    ->  booked_msm3d      booked capacity at each exit point

`nora integrations fetch origo --to STREAM` writes a stream folder from either system;
`nora live --source origo` (or `gbs`) polls it. From an export instead: put the CSV in a
stream folder and add an [[import]] block per file to its stream.toml, with
`metric = "nomination_msm3d"` or `metric = "booked_msm3d"` and the exit points mapped
with EXIT_POINTS below (see data/streams/README.md). The site, the plan check and the
overview then use them like any other reading.

Live: subclass Connector, implement `fetch`, and serve it with nora.live like `replay`
(yield (wait, frame) pairs; the server writes keepalive comments while it waits).

Public live sources need no credentials: `nora live --source gassco` polls aggregate
Norwegian exports.
"""

from __future__ import annotations

import csv
import json
import os
import re
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
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
# NORA says who it is (review #49802: it used to pose as Chrome to get past the
# Cloudflare check in front of gassco.eu). If Cloudflare refuses an honest client, the
# feed reports the failed poll; asking Gassco for access is the way past that.
USER_AGENT = "nora-network (https://github.com/Rayha33/nora-network)"


# The European gas day runs from 06:00 to 06:00 CET (CEST in summer), so it is 23 or 25
# hours long when the clocks change. Nominations and bookings are counted per gas day.
GAS_DAY_ZONE = ZoneInfo("Europe/Oslo")
GAS_DAY_START_HOUR = 6
# Norwegian export gas carries about 11 kWh per standard cubic metre (gross calorific
# value); data/streams/README.md uses the same figure for its kWh factors.
GCV_KWH_PER_SM3 = 11.0


def gas_day_of(when: datetime) -> date:
    """The gas day an instant belongs to."""
    return (when.astimezone(GAS_DAY_ZONE) - timedelta(hours=GAS_DAY_START_HOUR)).date()


def gas_day_start(day: date) -> datetime:
    """When gas day `day` starts, in UTC (05:00 UTC in winter, 04:00 UTC in summer)."""
    local = datetime(day.year, day.month, day.day, GAS_DAY_START_HOUR, tzinfo=GAS_DAY_ZONE)
    return local.astimezone(UTC)


def kwh_per_hour_to_msm3d(kwh_h: float, gcv: float = GCV_KWH_PER_SM3) -> float:
    """An hourly energy rate (kWh/h) as a volume rate in MSm3/d at calorific value `gcv`."""
    return kwh_h * 24 / gcv / 1e6


class ConnectorError(RuntimeError):
    """A live connection failed: unreachable, refused, too slow or a bad answer."""


class NotConfigured(ConnectorError):
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
    # How far past now a live poll asks for: nominations are known hours ahead.
    ahead = timedelta(0)

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


class ShipperConnector(Connector):
    """A shipper system behind a bearer token (Origo, Gassco Booking).

    Neither API is public, so NORA is built against the mocks in scripts/ (documented
    in docs/integrations.md). `download` is the transport and `parse` the format: a real
    adapter replaces `parse`, and `download` too if the real API is not a GET with
    `start` and `end` query parameters that answers JSON.
    """

    url_variable = ""
    token_variable = ""
    timeout = 30.0  # seconds

    @property
    def env(self) -> tuple[str, str]:
        return (self.url_variable, self.token_variable)

    def download(self, start: datetime, end: datetime) -> dict:
        """GET the endpoint for [start, end) and return its JSON, or raise a clear error."""
        if not self.configured():
            raise NotConfigured(f"{self.name}: {self.status()}")
        url = os.environ[self.url_variable]
        query = urllib.parse.urlencode({"start": _iso(start), "end": _iso(end)})
        url += ("&" if urllib.parse.urlsplit(url).query else "?") + query
        request = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {os.environ[self.token_variable]}",
                "Accept": "application/json",
                "User-Agent": USER_AGENT,
            },
        )
        too_slow = f"{self.name}: no answer from {url} within {self.timeout:g} s"
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403):
                raise ConnectorError(
                    f"{self.name}: {url} refused the token (HTTP {error.code}); "
                    f"check {self.token_variable}"
                ) from None
            raise ConnectorError(
                f"{self.name}: {url} answered HTTP {error.code}: {_error_text(error)}"
            ) from None
        except TimeoutError as error:  # socket.timeout is TimeoutError since 3.10
            raise ConnectorError(too_slow) from error
        except urllib.error.URLError as error:
            if isinstance(error.reason, TimeoutError):
                raise ConnectorError(too_slow) from error
            raise ConnectorError(f"{self.name}: cannot reach {url}: {error.reason}") from error
        except ValueError as error:  # not JSON, or not UTF-8
            raise ConnectorError(f"{self.name}: {url} did not answer JSON: {error}") from None
        if not isinstance(payload, dict):
            raise ConnectorError(f"{self.name}: {url} answered a {type(payload).__name__}")
        return payload

    def fetch(self, start: datetime, end: datetime) -> Iterator[Reading]:
        yield from self.parse(self.download(start, end))

    def parse(self, payload: dict) -> Iterator[Reading]:
        raise NotImplementedError

    @staticmethod
    def asset(point: str) -> str | None:
        """Gassco's name for the exit point (EXIT_POINTS), or already a NORA node id."""
        node_id = point if re.fullmatch(r"[a-z0-9_]+", point) else None
        return EXIT_POINTS.get(point) or node_id

    @staticmethod
    def hour(item: dict) -> datetime:
        when = datetime.fromisoformat(str(item["hour"]).replace("Z", "+00:00"))
        if when.tzinfo is None:
            raise ConnectorError(f"hour {item['hour']!r} has no UTC offset")
        return when.astimezone(UTC)


def _iso(when: datetime) -> str:
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _error_text(error: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(error.read() or b"{}")
    except ValueError:
        return str(error.reason)
    return str(body.get("error", error.reason)) if isinstance(body, dict) else ""


class Origo(ShipperConnector):
    """The shippers' hourly nominations at each exit point, from Origo (Ray, 29 Oct:
    "origo integration for hourly nominations from the shippers at each exitpoint ...
    what is important are rate of change at each exit point for the next 6 hours").

    `fetch` reads NORA_ORIGO_URL with NORA_ORIGO_TOKEN as a bearer token and yields one
    reading per exit point and hour; a live poll asks for the next 6 hours too, so the
    page shows them. Origo's API is not public: `parse` reads the shape of the mock in
    scripts/mock_origo.py (docs/integrations.md), hourly quantities in kWh/h converted
    to MSm3/d at the payload's calorific value, or rates already in MSm3/d:

        {"unit": "kWh/h", "gcv_kwh_per_sm3": 11.0, "nominations": [
            {"point": "Emden", "hour": "2026-10-29T05:00:00Z", "kwh_h": 16203229}]}
        {"nominations": [{"point": "Emden", "hour": "2026-10-29T06:00:00Z", "msm3d": 44.0}]}

    `point` is Gassco's exit-point name (EXIT_POINTS) or a NORA node id.
    """

    name = "Origo"
    metric = "nomination_msm3d"
    url_variable, token_variable = "NORA_ORIGO_URL", "NORA_ORIGO_TOKEN"
    flows = False
    ahead = timedelta(hours=6)

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

    def parse(self, payload: dict) -> Iterator[Reading]:
        gcv = float(payload.get("gcv_kwh_per_sm3") or GCV_KWH_PER_SM3)
        for item in payload.get("nominations", []):
            asset = self.asset(str(item.get("point", "")))
            if item.get("msm3d") is not None:
                value = float(item["msm3d"])
            elif item.get("kwh_h") is not None:
                value = kwh_per_hour_to_msm3d(float(item["kwh_h"]), gcv)
            else:
                continue
            if asset:
                yield Reading(self.hour(item), asset, self.metric, value)


class GasscoBooking(ShipperConnector):
    """Gassco Booking (GBS): the capacity shippers have booked at each exit point.

    `fetch` reads NORA_GBS_URL with NORA_GBS_TOKEN as a bearer token. GBS's API is not
    public: `parse` reads the shape of the mock in scripts/mock_gbs.py
    (docs/integrations.md), one booking per exit point and hour in Sm3/d (a million
    Sm3/d is one MSm3/d), or already in MSm3/d:

        {"unit": "Sm3/d", "bookings": [
            {"point": "Emden", "hour": "2026-10-29T05:00:00Z", "sm3_d": 39500000}]}
    """

    name = "Gassco Booking (GBS)"
    metric = "booked_msm3d"
    url_variable, token_variable = "NORA_GBS_URL", "NORA_GBS_TOKEN"
    flows = False

    def meta(self) -> dict:
        return {
            "name": "gbs",
            "title": "Gassco Booking (GBS) bookings",
            "description": (
                "Capacity booked by the shippers at each exit point, from Gassco Booking. "
                "Values in MSm3/d."
            ),
            "source": "Gassco Booking (GBS)",
            "synthetic": False,
        }

    def parse(self, payload: dict) -> Iterator[Reading]:
        for item in payload.get("bookings", []):
            asset = self.asset(str(item.get("point", "")))
            if item.get("msm3d") is not None:
                value = float(item["msm3d"])
            elif item.get("sm3_d") is not None:
                value = float(item["sm3_d"]) / 1e6
            else:
                continue
            if asset:
                yield Reading(self.hour(item), asset, self.metric, value)


GassocoBooking = GasscoBooking  # its earlier, misspelt name


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
gbs = GasscoBooking()

# Live sources `nora live --source <name>` can poll.
SOURCES = {"gassco": gassco, "origo": origo, "gbs": gbs}

CONNECTORS = (origo, gbs, gassco)

# Shipper systems `nora integrations fetch NAME --to STREAM` writes into a stream.
FETCHABLE = {"origo": origo, "gbs": gbs}


def window_bound(text: str, *, end: bool = False) -> datetime:
    """A `--start`/`--end` value: a date is that gas day (its start, or for `end` its
    end, so one date for both is one gas day); an ISO time without an offset is UTC."""
    text = text.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        day = date.fromisoformat(text)
        return gas_day_start(day + timedelta(days=1) if end else day)
    when = datetime.fromisoformat(text.replace("Z", "+00:00"))
    return (when if when.tzinfo else when.replace(tzinfo=UTC)).astimezone(UTC)


def current_gas_day(now: datetime | None = None) -> tuple[datetime, datetime]:
    """Start and end of the gas day running at `now` (default: now)."""
    day = gas_day_of(now or datetime.now(tz=UTC))
    return gas_day_start(day), gas_day_start(day + timedelta(days=1))


def write_stream(
    key: str, payload: dict, readings: list[Reading], folder: Path, start: datetime, end: datetime
) -> None:
    """Write what a shipper connector fetched into a stream folder NORA replays.

    flows.csv holds the readings in NORA's long format (timestamp,asset,metric,value),
    which `load_stream` reads; readings already there for other metrics or hours stay,
    so Origo and GBS can share one stream. stream.toml says where each part came from,
    and a mock's data is labelled synthetic.
    """
    connector = FETCHABLE[key]
    folder.mkdir(parents=True, exist_ok=True)
    csv_path, toml_path = folder / "flows.csv", folder / "stream.toml"
    rows: dict[tuple[str, str, str], str] = {}
    if csv_path.exists():
        with csv_path.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                metric = row.get("metric") or "flow_msm3d"
                value = row["value"] if "value" in row else row.get("flow_msm3d", "")
                rows[(row["timestamp"], metric, row["asset"])] = value
    for reading in readings:
        rows[(_iso(reading.when), reading.metric, reading.asset)] = f"{reading.value:.3f}"
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(("timestamp", "asset", "metric", "value"))
        for (stamp, metric, asset), value in sorted(rows.items()):
            writer.writerow((stamp, asset, metric, value))

    fetched = {}
    if toml_path.exists():
        fetched = tomllib.loads(toml_path.read_text(encoding="utf-8")).get("fetched", {})
    # Only where it came from: never a query string, which could carry a key.
    url = urllib.parse.urlsplit(os.environ.get(connector.url_variable, ""))
    fetched[key] = {
        "title": connector.meta()["title"],
        "url": urllib.parse.urlunsplit((url.scheme, url.netloc, url.path, "", "")),
        "start": _iso(start),
        "end": _iso(end),
        "mock": payload.get("mock") is True,
        "notice": str(payload.get("notice", "")),
    }
    mock = any(part["mock"] for part in fetched.values())
    title = ", ".join(part["title"] for part in fetched.values()) + (" (mock)" if mock else "")
    description = " ".join(
        f"{part['title']}, {part['start']} to {part['end']}, from {part['url']}."
        + (f" MOCK DATA, not real: {part['notice']}" if part["mock"] else "")
        for part in fetched.values()
    )
    lines = [
        "# Written by `nora integrations fetch`; fetch again to refresh (docs/integrations.md).",
        f"title = {json.dumps(title)}",
        f"description = {json.dumps(description + ' Values in MSm3/d.')}",
        f"source = {json.dumps(', '.join(part['url'] for part in fetched.values()))}",
        f"synthetic = {'true' if mock else 'false'}  # mock data is labelled synthetic",
        "order = 900  # plays after the recorded and demo streams",
    ]
    for name, part in fetched.items():
        lines += ["", f"[fetched.{name}]"]
        lines += [f"{field} = {json.dumps(value)}" for field, value in part.items()]
    toml_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
