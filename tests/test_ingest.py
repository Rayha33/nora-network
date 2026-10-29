"""Pushed live data (Ray, 29 Oct: "whats important is that it is easy to wire up live
data to this application"): `nora live --ingest` takes readings POSTed as JSON to
/ingest from any system and plays them on /stream. Nothing from outside is trusted."""

from __future__ import annotations

import json
import socket
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from nora.live import Inbox, serve
from nora.stream import METRICS

ASSETS = {"kollsnes", "troll_kollsnes", "dornum"}


def take(inbox: Inbox):
    """The next frame the inbox would send."""
    _wait, fresh = next(inbox.frames())
    return fresh()


def test_a_push_in_either_shape_is_kept_and_merged():
    inbox = Inbox(ASSETS)
    reply = inbox.push(
        {
            "t": 1793275200,
            "flows": {"troll_kollsnes": 101.2},
            "metrics": {"pressure_bar": {"kollsnes": 152.1}},
        }
    )
    assert reply == {"accepted": 2, "ignored": []}
    inbox.push(
        [{"asset": "dornum", "metric": "pressure_bar", "value": 66.4, "t": "2026-10-29T12:00:00Z"}]
    )
    when, flows, metrics, index = take(inbox)
    assert flows == {"troll_kollsnes": 101.2}, (
        "earlier readings stay: every frame is the whole picture"
    )
    assert metrics["pressure_bar"] == {"kollsnes": 152.1, "dornum": 66.4}
    assert when.isoformat() == "2026-10-29T12:00:00+00:00" and index == 1


def test_unknown_ids_metrics_and_non_numbers_are_turned_away_and_listed():
    inbox = Inbox(ASSETS)
    reply = inbox.push(
        {
            "flows": {"kolsnes": 1, "troll_kollsnes": float("nan")},
            "metrics": {
                "pressure_psi": {"kollsnes": 2200},
                "pressure_bar": {"kollsnes": "152", "dornum": True},
            },
        }
    )
    assert reply["accepted"] == 0
    assert {(i["asset"], i["why"]) for i in reply["ignored"]} == {
        ("kolsnes", "unknown asset"),
        ("troll_kollsnes", "not a number"),
        ("kollsnes", "unknown metric"),
        ("kollsnes", "not a number"),
        ("dornum", "not a number"),
    }
    inbox.push({"metrics": {"pressure_bar": {"kollsnes": 150.0}}})
    inbox.push({"metrics": {"pressure_bar": {"kollsnes": None}}})
    assert take(inbox)[2]["pressure_bar"] == {}, "null clears a reading"
    with pytest.raises(ValueError):
        inbox.push("152.1")


def _server(tmp_path: Path, token: str = ""):
    site = tmp_path / "site"
    site.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    inbox = Inbox(ASSETS)
    kwargs = {
        "meta": Inbox.meta(),
        "frames": inbox.frames,
        "port": port,
        "open_browser": False,
        "inbox": inbox,
        "token": token,
    }
    threading.Thread(target=serve, args=(site,), kwargs=kwargs, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            urllib.request.urlopen(f"{base}/", timeout=2)
            break
        except urllib.error.HTTPError:
            break
        except OSError:
            threading.Event().wait(0.1)
    return base


def post(base: str, body, token: str = "", kind: str = "application/json"):
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {"Content-Type": kind} | ({"Authorization": f"Bearer {token}"} if token else {})
    request = urllib.request.Request(f"{base}/ingest", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_ingest_over_http_reaches_the_page_and_keeps_its_checks(tmp_path):
    base = _server(tmp_path, token="s3cret")
    reading = {"metrics": {"pressure_bar": {"kollsnes": 152.1}}}
    assert post(base, reading)[0] == 401, "no token"
    assert post(base, reading, token="wrong")[0] == 401
    assert post(base, reading, token="s3cret", kind="text/plain")[0] == 415, "JSON only"
    assert post(base, b"{not json", token="s3cret")[0] == 400
    assert post(base, {"metrics": {"pressure_bar": {"nowhere": 1}}}, token="s3cret")[0] == 422
    status, reply = post(base, reading, token="s3cret")
    assert (status, reply["accepted"]) == (202, 1)
    stream = urllib.request.urlopen(f"{base}/stream", timeout=5)
    lines = [stream.readline().decode().strip() for _ in range(5)]
    assert lines[0] == "event: meta" and json.loads(lines[1][6:])["name"] == "ingest"
    assert lines[3] == "event: frame"
    assert json.loads(lines[4][6:])["metrics"]["pressure_bar"] == {"kollsnes": 152.1}


def test_ingest_beyond_this_computer_needs_a_token(monkeypatch, capsys):
    import nora.cli as cli

    monkeypatch.delenv("NORA_INGEST_TOKEN", raising=False)
    assert cli.main(["live", "--ingest", "--host", "0.0.0.0", "--no-browser"]) != 0
    assert "NORA_INGEST_TOKEN" in capsys.readouterr().err


def test_the_guide_names_every_metric():
    guide = (Path(__file__).parent.parent / "docs" / "live-data.md").read_text(encoding="utf-8")
    missing = [m for m in ["flow_msm3d", *METRICS] if f"`{m}`" not in guide]
    assert missing == [], f"docs/live-data.md does not name {missing}"
