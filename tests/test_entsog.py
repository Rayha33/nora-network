"""The ENTSOG live source: polling, mapping, stale handling and the cache (issue #3).

All HTTP is faked; only the JSON shape comes from the real platform.
"""

import json
import threading
import urllib.request
from datetime import UTC, datetime, timedelta
from functools import partial
from http.server import ThreadingHTTPServer

import nora.live
from nora.cli import main
from nora.data import DATA_DIR
from nora.entsog import POINT_DIRECTIONS, poll_entsog, read_mapping
from nora.live import Frame

TOML = """
title = "test"
[import]
layout = "long"
factor = 2.18e-6
[import.assets]
"Dunkerque" = "franpipe"
"Zeebrugge ZPT" = "zeepipe_1"
"""

DUNKERQUE, ZEEBRUGGE = POINT_DIRECTIONS["Dunkerque"], POINT_DIRECTIONS["Zeebrugge ZPT"]
HOUR = "2026-10-27T10:00:00+00:00"


def row(label: str, when: str, value: str) -> dict:
    """An ENTSOG row, cut down to the fields the poller reads."""
    return {"periodFrom": when, "pointLabel": label, "value": value}


def rows(label: str, when: str, value: str) -> list[dict]:
    return [row(label, when, value)]


def write_toml(folder) -> None:
    (folder / "stream.toml").write_text(TOML, encoding="utf-8")


def test_read_mapping_reads_the_stream_toml(tmp_path):
    write_toml(tmp_path)
    mapping, factor = read_mapping(tmp_path / "stream.toml")
    assert mapping == {"Dunkerque": "franpipe", "Zeebrugge ZPT": "zeepipe_1"}
    assert factor == 2.18e-6


def test_read_mapping_wants_an_import_block(tmp_path):
    (tmp_path / "stream.toml").write_text('title = "empty"\n', encoding="utf-8")
    try:
        read_mapping(tmp_path / "stream.toml")
        raise AssertionError("should have refused to serve from nothing")
    except ValueError as error:
        assert "import.assets" in str(error)


def test_first_frame_maps_points_to_assets(tmp_path):
    write_toml(tmp_path)
    mapping, factor = read_mapping(tmp_path / "stream.toml")

    def fetch(point, start, end):
        assert end - start == timedelta(days=1)  # a one-day window, like the real poll
        return rows(
            "Dunkerque" if point == DUNKERQUE else "Zeebrugge ZPT",
            HOUR,
            "1000000",  # kWh/h -> 2.18 MSm3/d with the stream's factor
        )

    feed = poll_entsog(mapping, factor, cache=tmp_path / "cache.json", fetch=fetch)
    wait, frame = next(feed)
    assert wait == 0.0  # the first frame goes out at once
    assert frame.values == {"franpipe": 2.18, "zeepipe_1": 2.18}
    assert frame.when == datetime(2026, 10, 27, 10, tzinfo=UTC)
    assert frame.stale is False


def test_frames_come_one_per_interval(tmp_path):
    write_toml(tmp_path)
    mapping, factor = read_mapping(tmp_path / "stream.toml")
    feed = poll_entsog(
        mapping, factor, interval=300, cache=None, fetch=lambda *a: rows("Dunkerque", HOUR, "1")
    )
    next(feed)
    wait, frame = next(feed)
    assert wait == 300  # then one frame every interval
    assert frame.index == 1


def test_api_down_keeps_the_last_frame_marked_stale(tmp_path):
    write_toml(tmp_path)
    mapping, factor = read_mapping(tmp_path / "stream.toml")
    polls = []

    def fetch(point, start, end):
        polls.append(point)
        if len(polls) > 2:  # the platform stops answering after the first round
            raise OSError("502 Bad Gateway")
        return rows("Dunkerque" if point == DUNKERQUE else "Zeebrugge ZPT", HOUR, "1000000")

    feed = poll_entsog(mapping, factor, cache=None, fetch=fetch)
    _, good = next(feed)
    next(feed)  # second poll still fine
    _, stale = next(feed)
    assert stale.values == good.values  # the last frame, not a blank one
    assert stale.when == good.when
    assert stale.index == good.index  # no new data, so the timeline does not move
    assert stale.stale is True


def test_no_result_found_is_a_down_api(tmp_path):
    """ENTSOG answers 404 'No result found' when a window has nothing: like the
    script, the poller reads it as no data and repeats the last frame stale."""
    write_toml(tmp_path)
    mapping, factor = read_mapping(tmp_path / "stream.toml")
    feed = poll_entsog(mapping, factor, cache=None, fetch=lambda *a: [])
    _, frame = next(feed)
    assert frame.values == {} and frame.stale is True  # nothing known yet


def test_the_last_good_frame_is_cached_and_served_on_restart(tmp_path):
    write_toml(tmp_path)
    mapping, factor = read_mapping(tmp_path / "stream.toml")
    cache = tmp_path / "cache.json"

    def up(_point, _start, _end):
        return rows("Dunkerque" if _point == DUNKERQUE else "Zeebrugge ZPT", HOUR, "1000000")

    next(poll_entsog(mapping, factor, cache=cache, fetch=up))
    assert cache.exists()  # written after the first good poll
    saved = json.loads(cache.read_text())
    assert saved["values"] == {"franpipe": 2.18, "zeepipe_1": 2.18}

    feed = poll_entsog(
        mapping, factor, cache=cache, fetch=lambda *a: (_ for _ in ()).throw(OSError("still down"))
    )
    _, frame = next(feed)  # a restart serves the cache while the poll is in flight
    assert frame.values == {"franpipe": 2.18, "zeepipe_1": 2.18}
    assert frame.stale is True


def test_points_without_a_direction_are_skipped(tmp_path):
    """A stream.toml can map points the poller has no point direction for (the
    landings that return nothing today); they are simply not polled."""
    (tmp_path / "stream.toml").write_text(TOML + '"St Fergus" = "vesterled"\n', encoding="utf-8")
    mapping, factor = read_mapping(tmp_path / "stream.toml")
    asked = []

    def fetch(point, start, end):
        asked.append(point)
        return rows("Dunkerque" if point == DUNKERQUE else "Zeebrugge ZPT", HOUR, "1000000")

    _, frame = next(poll_entsog(mapping, factor, cache=None, fetch=fetch))
    assert sorted(asked) == sorted([DUNKERQUE, ZEEBRUGGE])  # St Fergus was never asked
    assert "vesterled" not in frame.values


def test_stale_frames_are_marked_on_the_wire(tmp_path):
    """The SSE event for a stale frame carries `stale: true`; anything else in
    the frame is exactly what replay sends, so the browser needs no change."""
    feed = iter(
        [
            (0.0, Frame(datetime(2026, 10, 27, tzinfo=UTC), {"franpipe": 2.18}, {}, 0, True)),
        ]
    )
    handler = type(
        "TestHandler",
        (nora.live._Handler,),
        {
            "meta": {},
            "plan": None,
            "ahead": None,
            "frames": staticmethod(lambda: feed),
            "keepalive": 1.0,
        },
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(handler, directory=str(tmp_path)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{server.server_address[1]}/stream", timeout=10
        ) as response:
            body = response.read().decode()
    finally:
        server.shutdown()
    assert '"stale": true' in body
    assert '"values": {"franpipe": 2.18}' in body


def test_cli_live_source_entsog_serves_a_live_feed(monkeypatch, tmp_path):
    """`nora live --source entsog` builds the poller from the stream's own
    stream.toml and hands it to serve instead of the replay."""
    served = {}
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))  # keep the cache off ~
    monkeypatch.setattr(
        nora.live, "serve", lambda site_dir, stream, **kw: served.update(stream=stream, **kw)
    )
    monkeypatch.setattr(
        "nora.entsog.fetch_rows",
        lambda point, start, end: rows(
            "Dunkerque" if point == DUNKERQUE else "Zeebrugge ZPT", HOUR, "1000000"
        ),
    )
    rc = main(
        [
            "--data",
            str(DATA_DIR),
            "live",
            "--stream",
            "norway-exports",
            "--source",
            "entsog",
            "--interval",
            "60",
            "--no-browser",
            "--out",
            str(tmp_path / "site"),
        ]
    )
    assert rc == 0
    assert served["stream"].name == "norway-exports"
    assert served["plan"] is None  # a live feed has no recorded timeline to plan
    _, frame = next(served["frames"]())  # the poller is wired, and it polls
    assert frame.values == {"franpipe": 2.18, "zeepipe_1": 2.18}
    assert frame.stale is False
