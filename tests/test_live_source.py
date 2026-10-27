"""Live-source polling: `nora live --source gassco` (issue #3).

The Gassco connector is tested against a local http server serving the real
payload captured in tests/data/gassco_realTimeGraphData.json — no test ever
touches the network.
"""

from __future__ import annotations

import json
import socket
import threading
import urllib.request
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from nora.integrations import SOURCES, gassco
from nora.live import poll, serve

FIXTURE = Path(__file__).parent / "data" / "gassco_realTimeGraphData.json"


class _ApiHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path == "/down":
            self.send_error(503)
            return
        payload = FIXTURE.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: object) -> None:  # keep pytest output quiet
        pass


@pytest.fixture()
def api_url(monkeypatch):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = ThreadingHTTPServer(("127.0.0.1", port), _ApiHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()


def test_gassco_fetch_maps_countries_to_market_nodes(api_url, monkeypatch):
    monkeypatch.setenv("NORA_GASSCO_URL", api_url)
    now = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
    readings = list(gassco.fetch(now - timedelta(minutes=5), now))
    by_asset = {r.asset: r.value for r in readings}
    assert by_asset == {
        "the": 156.78,  # Germany
        "peg": 42.9,  # France
        "ztp": 43.6,  # Belgium
        "nbp": 62.1,  # Great Britain
    }
    assert all(r.metric == gassco.metric for r in readings)
    assert readings[0].when.tzinfo is not None  # epoch ms became an aware datetime


def test_poll_yields_frames_and_survives_a_dead_api(api_url, monkeypatch, capsys):
    monkeypatch.setenv("NORA_GASSCO_URL", api_url)
    feed = poll(gassco, poll_seconds=0)
    wait, first = next(feed)  # first frame is immediate, so the server starts fast
    assert wait == 0.0
    when, flows, metrics, index = first
    assert index == 0
    assert flows["nbp"] == 62.1
    # the API dies between polls: the feed reads as an SSE error event, not a crash
    monkeypatch.setenv("NORA_GASSCO_URL", api_url + "/down")
    wait, second = next(feed)
    assert isinstance(second, dict)
    assert "503" in second["error"]
    assert capsys.readouterr().err  # the failure was logged too


def test_serve_accepts_a_poller_instead_of_a_stream(api_url, monkeypatch, tmp_path):
    monkeypatch.setenv("NORA_GASSCO_URL", api_url)
    site = tmp_path / "site"
    site.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    thread = threading.Thread(
        target=serve,
        args=(site,),
        daemon=True,
        kwargs={
            "meta": gassco.meta(),
            "frames": lambda: poll(gassco, poll_seconds=1),
            "port": port,
            "open_browser": False,
        },
    )
    thread.start()
    for _ in range(50):
        try:
            response = urllib.request.urlopen(f"http://127.0.0.1:{port}/stream", timeout=5)
            break
        except OSError:
            threading.Event().wait(0.1)
    else:
        pytest.fail("the live server never came up")
    lines = [response.readline().decode().strip() for _ in range(5)]
    assert lines[0] == "event: meta"
    assert json.loads(lines[1][len("data: ") :])["name"] == "gassco"
    assert lines[3] == "event: frame"
    values = json.loads(lines[4][len("data: ") :])["values"]
    assert values["the"] == 156.78


def test_cli_offers_the_source_flag():
    import nora.cli as cli_mod

    # `--source` is choices-restricted to the SOURCES registry (exits 2 on a
    # bogus name), and `--poll-seconds` parses as a float.
    with pytest.raises(SystemExit) as boom:
        cli_mod.main(["live", "--source", "nope"])
    assert boom.value.code == 2


def test_sources_registry_only_contains_ready_connectors():
    assert set(SOURCES) == {"gassco"}
