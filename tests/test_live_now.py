"""`nora live --now`: a stream re-timed to the wall clock and looped, for a showcase."""

from __future__ import annotations

import itertools
import json
import socket
import threading
import time
import urllib.request
from datetime import UTC, datetime

import pytest

import nora.live
from nora.cli import main
from nora.data import DATA_DIR
from nora.live import Meta, NowReplay, serve
from nora.stream import load_stream

HOUR = 3600
# 14:23:10 UTC on 29 Oct 2026: the feed's hour 0 is stamped 14:00, the hour it falls in
STARTED = datetime(2026, 10, 29, 14, 23, 10, tzinfo=UTC).timestamp()
ORIGIN = datetime(2026, 10, 29, 14, tzinfo=UTC).timestamp()
RECORDED = datetime(2026, 1, 1, tzinfo=UTC).timestamp()  # the stream's own first hour

TOML = """title = "Three hours"
[[events]]
asset = "pipe_a"
label = "Pipe A down"
start = 2026-01-01T01:00:00Z
end = 2026-01-01T02:00:00Z

[[pigs]]
label = "Cleaning pig, Pipe A"
pipeline = "pipe_a"
launch = 2026-01-01T01:00:00Z
speed_mps = 4.0
every_hours = 1
id = 7
"""
FLOWS = (
    "timestamp,asset,flow_msm3d\n"
    "2026-01-01T00:00Z,pipe_a,1\n2026-01-01T01:00Z,pipe_a,2\n2026-01-01T02:00Z,pipe_a,3\n"
)


class Clock:
    """A wall clock the test moves by hand."""

    def __init__(self, now: float):
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def stream(tiny, tmp_path):
    folder = tmp_path / "streams" / "three"
    folder.mkdir(parents=True)
    (folder / "stream.toml").write_text(TOML)
    (folder / "flows.csv").write_text(FLOWS)
    return load_stream("three", tiny, tmp_path / "streams")


def frames_only(items):
    return [(wait, item) for wait, item in items if not isinstance(item, Meta)]


def test_now_maps_hour_k_to_now_plus_k_steps(stream):
    feed = NowReplay(stream, clock=Clock(STARTED), history_hours=0)
    items = list(itertools.islice(feed.frames(), 4))
    assert isinstance(items[0][1], Meta)  # the re-timed meta comes first
    frames = items[1:]
    assert [item[0].timestamp() for _, item in frames] == [ORIGIN + k * HOUR for k in range(3)]
    assert [item[1]["pipe_a"] for _, item in frames] == [1, 2, 3]
    assert [item[3] for _, item in frames] == [0, 1, 2]  # the stream's own row: plan, ahead
    # hour 0 holds now, so it goes at once; hour 1 when the wall clock reaches 15:00
    assert [wait for wait, _ in frames] == [
        0.0,
        ORIGIN + HOUR - STARTED,
        ORIGIN + 2 * HOUR - STARTED,
    ]


def test_now_loops_for_ever_with_rising_times(stream):
    clock = Clock(STARTED)
    feed = NowReplay(stream, clock=clock, history_hours=0)
    items, sent = [], []
    for wait, item in itertools.islice(feed.frames(), 13):
        clock.now += wait  # the server waits that long before sending
        items.append((wait, item))
        if not isinstance(item, Meta):
            sent.append(clock.now)
    frames = frames_only(items)
    times = [item[0].timestamp() for _, item in frames]
    assert times == [ORIGIN + k * HOUR for k in range(9)]  # one step apart, across wraps too
    assert all(b > a for a, b in itertools.pairwise(times))
    assert [item[1]["pipe_a"] for _, item in frames] == [1, 2, 3] * 3
    # every frame after the first goes out when the wall clock reaches its stamp
    assert sent[1:] == times[1:]
    loops = [item["retimed"]["loop"] for _, item in items if isinstance(item, Meta)]
    assert loops == [0, 1, 2, 3]  # a new meta for each loop, just before its first frame
    # that meta carries the wait, so it lands with the frame, not an hour early
    second = next(i for i, (_, item) in enumerate(items) if isinstance(item, Meta) and i)
    assert items[second][0] > 0 and items[second + 1][0] == 0.0


def test_now_meta_carries_retimed_pigs_and_events(stream):
    feed = NowReplay(stream, clock=Clock(STARTED), history_hours=0)
    shift = ORIGIN - RECORDED
    period = 3 * HOUR  # three hourly frames, then one step to start over
    for loop in (0, 1, 5):
        meta = feed.meta(loop)
        # the pig, launched at the stream's 01:00 and again every hour, runs at 01:00 and
        # 02:00 of each loop: this loop's runs and the loop before's (one may be under way),
        # each a pig of its own so last loop's do not keep relaunching
        launches = [pig["launch"] for pig in meta["pigs"]]
        assert launches == [
            RECORDED + shift + n * period + h * HOUR for n in (loop - 1, loop) for h in (1, 2)
        ]
        assert [pig["id"] for pig in meta["pigs"]] == [7, 8, 7, 8]
        assert all(p["every"] == 0 and p["pipeline"] == "pipe_a" for p in meta["pigs"])
        # this loop's events and the loop before's (the history a reader gets first)
        starts = sorted(event["start"] for event in meta["events"])
        assert starts == [RECORDED + HOUR + shift + n * period for n in (loop - 1, loop)]
        assert all(e["end"] - e["start"] == HOUR for e in meta["events"])
    meta = feed.meta(0)
    assert "times" not in meta and "values" not in meta  # frames carry the readings
    assert meta["title"] == "Three hours (recorded, re-timed to now)"
    assert "not live readings" in meta["description"]
    assert meta["synthetic"] is False
    assert meta["retimed"] == {"origin": ORIGIN, "speed": 1.0, "loop": 0}


def test_now_keeps_synthetic_data_labelled_synthetic(stream):
    from dataclasses import replace

    meta = NowReplay(replace(stream, synthetic=True), clock=Clock(STARTED)).meta(0)
    assert meta["synthetic"] is True
    assert meta["title"] == "Three hours (synthetic, re-timed to now)"


def test_now_sends_recent_history_first_then_waits(stream):
    clock = Clock(STARTED)
    feed = NowReplay(stream, clock=clock, history_hours=2)
    clock.now = ORIGIN + 4.5 * HOUR  # a reader connects in loop 1, at its second hour
    items = list(itertools.islice(feed.frames(), 5))
    assert items[0][1]["retimed"]["loop"] == 1  # one meta covers the history too
    frames = items[1:]
    assert [item[0].timestamp() for _, item in frames] == [ORIGIN + k * HOUR for k in (2, 3, 4, 5)]
    assert [wait for wait, _ in frames[:3]] == [0.0, 0.0, 0.0]  # the past, at once
    assert frames[3][0] == pytest.approx(HOUR / 2)


def test_now_speed_runs_the_clock_faster(stream):
    feed = NowReplay(stream, speed=60, clock=Clock(STARTED), history_hours=0)
    frames = frames_only(itertools.islice(feed.frames(), 4))
    assert frames[0][0] == 0.0
    assert frames[2][0] - frames[1][0] == pytest.approx(HOUR / 60)  # an hour a minute


def test_cli_now_replays_at_real_time(monkeypatch, tmp_path):
    served = {}
    monkeypatch.setattr(
        nora.live, "serve", lambda site_dir, stream, **kw: served.update(stream=stream, **kw)
    )
    args = ["--data", str(DATA_DIR), "live", "--now", "--no-browser", "--out", str(tmp_path)]
    assert main([*args, "--stream", "synthetic-week"]) == 0
    assert served["now"] is True and served["speed"] == 1.0  # real time unless --speed


def test_cli_now_does_not_go_with_ingest_and_speed_is_positive():
    assert main(["live", "--now", "--ingest", "--no-browser"]) == 1
    assert main(["live", "--now", "--speed", "0", "--no-browser"]) == 1


def test_live_server_now_sends_frames_stamped_now(stream, tmp_path):
    site = tmp_path / "site"
    site.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    kwargs = {"port": port, "speed": 1.0, "open_browser": False, "now": True}
    threading.Thread(target=serve, args=(site, stream), daemon=True, kwargs=kwargs).start()
    for _ in range(50):
        try:
            response = urllib.request.urlopen(f"http://127.0.0.1:{port}/stream", timeout=5)
            break
        except OSError:
            threading.Event().wait(0.1)
    else:
        pytest.fail("the live server never came up")
    lines = [response.readline().decode().strip() for _ in range(12)]
    assert lines[0] == "event: meta"  # only the re-timed one: no recorded dates first
    meta = json.loads(lines[1][len("data: ") :])
    assert meta["title"].endswith("(recorded, re-timed to now)")
    assert [lines[i] for i in (3, 6, 9)] == ["event: frame"] * 3
    frames = [json.loads(lines[i][len("data: ") :]) for i in (4, 7, 10)]
    # two hours of history at once (the loop before), then the hour that holds now
    assert [f["t"] - frames[2]["t"] for f in frames] == [-2 * HOUR, -HOUR, 0]
    assert frames[2]["t"] % HOUR == 0 and 0 <= time.time() - frames[2]["t"] < HOUR + 5
    assert [f["values"]["pipe_a"] for f in frames] == [2, 3, 1]
