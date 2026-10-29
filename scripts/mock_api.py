"""What the Origo and Gassco Booking mocks share: a tiny stdlib HTTP server with a
bearer-token check, the gas-day hours of a window, and plausible bookings per exit
point taken from data/nodes.csv and data/pipelines.csv.

Neither mock is Origo's or Gassco's real API or format: Origo and GBS publish none.
They give NORA's connectors a documented shape to be built and tested against
(docs/integrations.md), so a real adapter only swaps the transport and the format.
"""

from __future__ import annotations

import argparse
import contextlib
import hmac
import json
import math
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from nora.data import DATA_DIR, load_network
from nora.integrations import (
    EXIT_POINTS,
    GAS_DAY_START_HOUR,
    GAS_DAY_ZONE,
    current_gas_day,
)

MAX_HOURS = 31 * 24  # one request covers at most a month
BOOKED_SHARE = 0.9  # an exit with no booked_msm3d in nodes.csv: 90 % of what can land there

Build = Callable[[datetime, datetime], dict]


def exit_bookings(data_dir: Path = DATA_DIR) -> dict[str, tuple[str, float]]:
    """{node id: (Gassco's exit-point name, booked MSm3/d)} for every exit point in
    EXIT_POINTS that is in the network. A node's own booked_msm3d is used when it has
    one; otherwise 90 % of the capacity of the export lines landing there."""
    net = load_network(data_dir)
    names: dict[str, str] = {}
    for name, node_id in EXIT_POINTS.items():
        names.setdefault(node_id, name)  # the first spelling in EXIT_POINTS
    out = {}
    for node_id, name in sorted(names.items()):
        node = net.node_by_id.get(node_id)
        if node is None:
            continue
        landing = sum(
            p.capacity_msm3d or 0.0
            for p in net.pipelines
            if p.to_id == node_id and p.type == "export" and p.status == "operating"
        )
        booked = node.booked_msm3d or math.floor(landing * BOOKED_SHARE * 2) / 2
        if booked > 0:
            out[node_id] = (name, booked)
    return out


def hours(start: datetime, end: datetime) -> list[datetime]:
    """Every UTC hour that overlaps [start, end), so a window inside an hour still
    gets that hour's value."""
    first = start.astimezone(UTC).replace(minute=0, second=0, microsecond=0)
    count = math.ceil((end - first).total_seconds() / 3600)
    return [first + timedelta(hours=k) for k in range(max(0, count))]


def hour_of_gas_day(when: datetime) -> int:
    local = when.astimezone(GAS_DAY_ZONE)
    return (local.hour - GAS_DAY_START_HOUR) % 24


def iso(when: datetime) -> str:
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def window(query: str) -> tuple[datetime, datetime]:
    """`start` and `end` (ISO 8601, UTC when no offset) from the query string; without
    them, the current gas day."""
    params = parse_qs(query)

    def read(key: str) -> datetime | None:
        if key not in params:
            return None
        when = datetime.fromisoformat(params[key][0].replace("Z", "+00:00"))
        return when if when.tzinfo else when.replace(tzinfo=UTC)

    start, end = read("start"), read("end")
    if start is None:
        start = current_gas_day()[0] if end is None else end - timedelta(days=1)
    if end is None:
        end = current_gas_day(start)[1]
    if end <= start:
        raise ValueError("end must come after start")
    if (end - start) > timedelta(hours=MAX_HOURS):
        raise ValueError(f"at most {MAX_HOURS} hours per request")
    return start, end


def make_handler(path: str, token: str, build: Build) -> type[BaseHTTPRequestHandler]:
    """A handler that answers GET `path` with build(start, end) as JSON, behind a
    bearer token."""

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - the http.server name
            url = urlsplit(self.path)
            if url.path != path:
                return self.reply(404, {"error": f"not found; the mock serves GET {path}"})
            given = self.headers.get("Authorization", "")
            if not hmac.compare_digest(given.encode(), f"Bearer {token}".encode()):
                return self.reply(401, {"error": "missing or wrong bearer token"})
            try:
                start, end = window(url.query)
            except ValueError as error:
                return self.reply(400, {"error": f"bad start/end: {error}"})
            return self.reply(200, build(start, end))

        def reply(self, status: int, body: dict) -> None:
            data = json.dumps(body, indent=1).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            if status == 401:
                self.send_header("WWW-Authenticate", 'Bearer realm="nora-mock"')
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):  # quiet: the tests start these servers
            pass

    return Handler


def serve(name: str, path: str, port: int, url_name: str, token_name: str, make_build) -> None:
    """The command line both mocks share; make_build(bookings) answers the requests."""
    parser = argparse.ArgumentParser(description=f"Serve a mock {name} API for NORA.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=port)
    parser.add_argument("--token", default="mock-token", help="the bearer token to accept")
    parser.add_argument("--data", type=Path, default=DATA_DIR, help="NORA's data folder")
    args = parser.parse_args()
    server = ThreadingHTTPServer(
        (args.host, args.port), make_handler(path, args.token, make_build(exit_bookings(args.data)))
    )
    print(f"Mock {name} (made-up data) on http://{args.host}:{args.port}{path}")
    print(f"  export {url_name}=http://{args.host}:{args.port}{path}")
    print(f"  export {token_name}={args.token}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()
