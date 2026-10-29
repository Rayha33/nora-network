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

from nora.integrations import SOURCES, gassco, interconnector
from nora.live import poll, serve

FIXTURE = Path(__file__).parent / "data" / "gassco_realTimeGraphData.json"


class _ApiHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path == "/down":
            self.send_error(503)
            return
        payload = (
            (FIXTURE.parent / "national_gas_latest.json").read_bytes()
            if self.path == "/national-gas"
            else FIXTURE.read_bytes()
        )
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


def test_gassco_fetch_maps_single_terminal_countries_to_their_terminal(api_url, monkeypatch):
    monkeypatch.setenv("NORA_GASSCO_URL", api_url)
    now = datetime(2026, 10, 27, 12, 0, tzinfo=UTC)
    readings = list(gassco.fetch(now - timedelta(minutes=5), now))
    by_asset = {r.asset: r.value for r in readings}
    # Germany and Great Britain land at two terminals each: no node, no invented split
    assert by_asset == {
        "dunkirk": 42.9,  # France
        "zeebrugge": 43.6,  # Belgium
    }
    assert all(r.metric == gassco.metric for r in readings)
    assert readings[0].when.tzinfo is not None  # epoch ms became an aware datetime


def test_interconnector_combines_bacton_export_and_import_into_signed_iuk_flow(
    api_url, monkeypatch
):
    monkeypatch.setenv("NORA_NATIONAL_GAS_URL", api_url + "/national-gas")
    now = datetime(2026, 10, 28, 12, 0, tzinfo=UTC)
    readings = list(interconnector.fetch(now - timedelta(minutes=2), now))
    assert len(readings) == 1
    reading = readings[0]
    assert reading.asset == "iuk"
    assert reading.metric == "flow_msm3d"
    assert reading.value == pytest.approx(12.3 - 4.5)
    assert reading.when == datetime(2026, 10, 28, 9, 48, tzinfo=UTC)


def test_interconnector_sign_reverses_for_zeebrugge_to_bacton():
    fixture = json.loads((Path(__file__).parent / "data" / "national_gas_latest.json").read_text())
    imported = fixture["data"]["Supply from entry points"]["data"][1]
    imported["09:44"] = 14.5
    when, value = interconnector.parse(fixture)
    assert value == pytest.approx(12.3 - 14.5)
    assert when.tzinfo is not None


def test_poll_yields_frames_and_survives_a_dead_api(api_url, monkeypatch, capsys):
    monkeypatch.setenv("NORA_GASSCO_URL", api_url)
    feed = poll(gassco, poll_seconds=0)
    wait, first = next(feed)  # first frame is immediate, so the server starts fast
    assert wait == 0.0
    when, flows, metrics, index = first
    assert index == 0
    assert flows["dunkirk"] == 42.9
    # the API dies between polls: the feed reads as an SSE error event, not a crash
    monkeypatch.setenv("NORA_GASSCO_URL", api_url + "/down")
    wait, second = next(feed)
    assert isinstance(second, dict)
    assert "503" in second["error"]
    assert capsys.readouterr().err  # the failure was logged too


def test_a_source_down_from_the_start_is_retried_slowly(api_url, monkeypatch, capsys):
    """A first poll that fails must not turn into a tight retry loop."""
    monkeypatch.setenv("NORA_GASSCO_URL", api_url + "/down")
    feed = poll(gassco, poll_seconds=300)
    waits = [next(feed)[0] for _ in range(3)]
    assert waits == [0.0, 300, 300]
    capsys.readouterr()


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
    assert values["zeebrugge"] == 43.6


def test_serve_shares_one_poller_between_browsers(api_url, monkeypatch, tmp_path):
    """Review #49802: two browsers on /stream, one upstream poll (SharedPoll)."""
    from nora.live import SharedPoll

    monkeypatch.setenv("NORA_GASSCO_URL", api_url)
    site = tmp_path / "site"
    site.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    shared = SharedPoll(gassco, poll_seconds=3600)
    kwargs = {"meta": gassco.meta(), "frames": shared.frames, "port": port, "open_browser": False}
    threading.Thread(target=serve, args=(site,), daemon=True, kwargs=kwargs).start()
    responses = []
    for _ in range(2):
        for _ in range(50):
            try:
                responses.append(
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/stream", timeout=5)
                )
                break
            except OSError:
                threading.Event().wait(0.1)
        else:
            pytest.fail("the live server never came up")
    for response in responses:
        lines = [response.readline().decode().strip() for _ in range(5)]
        assert lines[3] == "event: frame"
        assert json.loads(lines[4][len("data: ") :])["values"]["zeebrugge"] == 43.6
    assert shared.polls == 1, "both browsers got the frame from one upstream fetch"


def test_cli_offers_the_source_flag():
    import nora.cli as cli_mod

    # `--source` is choices-restricted to the SOURCES registry (exits 2 on a
    # bogus name), and `--poll-seconds` parses as a float.
    with pytest.raises(SystemExit) as boom:
        cli_mod.main(["live", "--source", "nope"])
    assert boom.value.code == 2


def test_sources_registry_only_contains_ready_connectors(monkeypatch):
    assert set(SOURCES) == {"gassco", "interconnector", "origo"}
    # Origo is wired; without its endpoint and token it says what to set
    from nora.integrations import NotConfigured

    monkeypatch.delenv("NORA_ORIGO_URL", raising=False)
    monkeypatch.delenv("NORA_ORIGO_TOKEN", raising=False)
    with pytest.raises(NotConfigured, match="NORA_ORIGO_URL"):
        list(SOURCES["origo"].fetch(datetime.now(tz=UTC), datetime.now(tz=UTC)))


def test_a_nan_from_a_polled_source_becomes_null_not_invalid_json(api_url, monkeypatch, tmp_path):
    """Gassco's JSON can carry NaN (Python json allows it); bare NaN in an SSE
    frame is invalid JSON and JSON.parse would drop every frame."""
    import json as json_mod

    real_urlopen = urllib.request.urlopen

    def nan_json(url, *args, **kwargs):
        class R:
            def read(self):
                return (
                    b'{"nodes": [{"name": "Germany", "value": NaN},'
                    b'{"name": "France", "value": 42.9}], "timestamp": 1793101090000}'
                )

            def close(self):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return R()

    monkeypatch.setattr(urllib.request, "urlopen", nan_json)
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
            "frames": lambda: poll(gassco, poll_seconds=3600),
            "port": port,
            "open_browser": False,
        },
    )
    thread.start()
    import time as time_mod

    for _ in range(50):
        try:
            response = real_urlopen(f"http://127.0.0.1:{port}/stream", timeout=10)
            break
        except OSError:
            time_mod.sleep(0.1)
    else:
        pytest.fail("the live server never came up")
    lines = []
    while True:
        line = response.readline().decode().strip()
        lines.append(line)
        if line == "event: frame":
            lines.append(response.readline().decode().strip())  # its data line
            break
        if len(lines) > 10:
            pytest.fail(f"no frame event: {lines}")
    data = lines[-1]
    payload = data[len("data: ") :]
    assert "NaN" not in payload, payload  # never invalid JSON
    assert json_mod.loads(payload)  # and it parses


def test_interconnector_takes_the_newest_reading_after_midnight():
    """Review finding: readings were ordered by the text of their time, so after
    midnight "23:58" beat "00:02" and the IUK flow froze at the evening's value."""
    fixture = json.loads((Path(__file__).parent / "data" / "national_gas_latest.json").read_text())
    exported = fixture["data"]["Demand from interconnectors"]["data"][1]  # Bacton INT Export
    assert exported["TERMINAL TOTALS"] == "Bacton INT Export"
    for key in [k for k in exported if ":" in k]:
        del exported[key]
    exported.update({"23:58": 9.0, "00:02": 11.0})  # the gas day runs on past midnight
    _, value = interconnector.parse(fixture)
    assert value == pytest.approx(11.0 - 4.5)  # the 00:02 export, less the 09:44 import


def test_origo_reads_hourly_nominations_by_exit_point():
    """Ray, 29 Oct: Origo's hourly nominations at each exit point; the next 6 hours."""
    from nora.integrations import origo

    payload = {
        "nominations": [
            {"point": "Emden", "hour": "2026-10-29T06:00:00Z", "msm3d": 44.0},
            {"point": "dornum", "hour": "2026-10-29T07:00:00Z", "msm3d": 113.5},
            {"point": "Somewhere else", "hour": "2026-10-29T07:00:00Z", "msm3d": 9.0},
            {"point": "Zeebrugge", "hour": "2026-10-29T07:00:00Z", "msm3d": None},
        ]
    }
    readings = list(origo.parse(payload))
    assert [(r.asset, r.value) for r in readings] == [("emden", 44.0), ("dornum", 113.5)]
    assert all(r.metric == "nomination_msm3d" and r.when.tzinfo for r in readings)
    assert origo.flows is False, "nominations are not flows"


def test_a_poller_sends_the_hours_ahead_with_each_frame(monkeypatch):
    """Origo knows the coming hours: the frame carries them as `ahead`, and nominations
    never pose as flows."""
    from nora.integrations import Reading, origo

    now = datetime.now(tz=UTC).replace(minute=0, second=0, microsecond=0)
    hours = [now + timedelta(hours=k) for k in range(-1, 6)]
    monkeypatch.setattr(
        type(origo),
        "fetch",
        lambda self, start, end: iter(
            Reading(t, "emden", self.metric, 40.0 + i) for i, t in enumerate(hours)
        ),
    )
    _, (when, flows, metrics, index, ahead) = next(poll(origo, poll_seconds=0))
    assert flows == {} and metrics == {"nomination_msm3d": {"emden": 41.0}}
    assert ahead == {"nomination_msm3d": {"emden": [42.0, 43.0, 44.0, 45.0, 46.0]}}
