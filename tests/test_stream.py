import itertools
import json
import threading
import urllib.request
from datetime import UTC, datetime

import pytest

from nora.data import DataError
from nora.live import replay, serve
from nora.stream import list_streams, load_stream, scaffold, write_flows


def make_stream(folder, toml, files=None):
    folder.mkdir(parents=True)
    (folder / "stream.toml").write_text(toml)
    for name, text in (files or {}).items():
        (folder / name).write_text(text)
    return folder


def test_every_stream_in_the_repo_loads(north_sea):
    names = list_streams()
    assert names, "the repo should ship at least one stream"
    for name in names:
        stream = load_stream(name, north_sea)
        assert stream.times and stream.assets


def test_canonical_flows_csv(tiny, tmp_path):
    make_stream(
        tmp_path / "s",
        'title = "Plain"\n',
        {
            "flows.csv": "timestamp,asset,flow_msm3d\n2026-01-01T00:00Z,pipe_a,10\n"
            "2026-01-01T01:00Z,pipe_a,12\n2026-01-01T01:00Z,market,30\n"
        },
    )
    stream = load_stream("s", tiny, tmp_path)
    assert stream.assets == ("market", "pipe_a")
    assert stream.values == ((None, 10.0), (30.0, 12.0))


def test_long_import_maps_points_sums_and_scales(tiny, tmp_path):
    raw = (
        "when,point,dir,kwh\n"
        "2026-01-01T00:00:00+01:00,North A,exit,1000\n"
        "2026-01-01T00:00:00+01:00,North A2,exit,500\n"
        "2026-01-01T00:00:00+01:00,North A,entry,999\n"
        "2026-01-01T00:00:00+01:00,Ignored,exit,7\n"
    )
    toml = """
title = "Imported"
[import]
file = "raw.csv"
timestamp = "when"
asset = "point"
value = "kwh"
factor = 0.01
[import.where]
dir = "exit"
[import.assets]
"North A" = "pipe_a"
"North A2" = "pipe_a"
"Ignored" = ""
"""
    make_stream(tmp_path / "imp", toml, {"raw.csv": raw})
    stream = load_stream("imp", tiny, tmp_path)
    assert stream.times == (datetime(2025, 12, 31, 23, tzinfo=UTC),)  # converted to UTC
    assert stream.assets == ("pipe_a",)
    assert stream.values[0][0] == pytest.approx(15.0)


def test_wide_import(tiny, tmp_path):
    raw = "Gas day,Pipe A flow,Pipe B flow\n2026-01-01,40,20\n2026-01-02,35,25\n"
    toml = """
[import]
file = "raw.csv"
layout = "wide"
timestamp = "Gas day"
[import.assets]
"Pipe A flow" = "pipe_a"
"Pipe B flow" = "pipe_b"
"""
    make_stream(tmp_path / "wide", toml, {"raw.csv": raw})
    stream = load_stream("wide", tiny, tmp_path)
    assert stream.values == ((40.0, 20.0), (35.0, 25.0))


def test_unknown_asset_is_reported_with_a_suggestion(tiny, tmp_path):
    make_stream(
        tmp_path / "bad",
        "",
        {"flows.csv": "timestamp,asset,flow_msm3d\n2026-01-01T00:00Z,pipe_c,1\n"},
    )
    with pytest.raises(DataError, match="did you mean 'pipe_"):
        load_stream("bad", tiny, tmp_path)


def test_synthetic_stream_is_deterministic_and_applies_events(tiny, tmp_path):
    toml = """
[synthetic]
start = 2026-01-05T00:00:00Z
steps = 6
seed = 3
[[events]]
label = "Pipe A trips"
asset = "pipe_a"
start = 2026-01-05T02:00:00Z
end = 2026-01-05T04:00:00Z
"""
    make_stream(tmp_path / "syn", toml)
    first = load_stream("syn", tiny, tmp_path)
    assert first == load_stream("syn", tiny, tmp_path)
    pipe_a = first.assets.index("pipe_a")
    flows = [row[pipe_a] for row in first.values]
    assert flows[2] == flows[3] == 0  # tripped
    assert flows[1] > 0 and flows[4] > 0


def test_scaffold_guesses_the_mapping(tiny, tmp_path):
    raw = tmp_path / "export.csv"
    raw.write_text(
        "periodFrom,pointLabel,value\n2026-01-01T00:00Z,Terminal A,5\n"
        "2026-01-01T00:00Z,Pipe B,6\n2026-01-01T00:00Z,Somewhere else,7\n"
    )
    toml_path = scaffold("new-data", raw, tiny, tmp_path / "streams")
    text = toml_path.read_text()
    assert 'layout = "long"' in text and 'timestamp = "periodFrom"' in text
    assert '"Terminal A" = "a_terminal"' in text
    assert '"Pipe B" = "pipe_b"' in text
    stream = load_stream("new-data", tiny, tmp_path / "streams")
    assert set(stream.assets) <= {"a_terminal", "pipe_b", "pipe_a", "b_terminal"}


def test_write_flows_round_trips(tiny, tmp_path):
    make_stream(
        tmp_path / "s",
        "",
        {"flows.csv": "timestamp,asset,flow_msm3d\n2026-01-01T00:00:00Z,pipe_a,10.5\n"},
    )
    stream = load_stream("s", tiny, tmp_path)
    make_stream(tmp_path / "copy", "")
    write_flows(stream, tmp_path / "copy" / "flows.csv")
    assert load_stream("copy", tiny, tmp_path).values == stream.values


def test_replay_loops_through_frames(tiny, tmp_path):
    make_stream(
        tmp_path / "s",
        "",
        {
            "flows.csv": "timestamp,asset,flow_msm3d\n"
            "2026-01-01T00:00Z,pipe_a,1\n2026-01-01T01:00Z,pipe_a,2\n"
        },
    )
    stream = load_stream("s", tiny, tmp_path)
    frames = list(itertools.islice(replay(stream, speed=1e9), 3))
    assert [f[1]["pipe_a"] for f in frames] == [1, 2, 1]


def test_live_server_sends_meta_then_frames(tiny, tmp_path):
    make_stream(
        tmp_path / "s",
        'title = "Feed"\n',
        {
            "flows.csv": "timestamp,asset,flow_msm3d\n"
            "2026-01-01T00:00Z,pipe_a,1\n2026-01-01T01:00Z,pipe_a,2\n"
        },
    )
    stream = load_stream("s", tiny, tmp_path)
    site = tmp_path / "site"
    site.mkdir()
    port = 18765
    thread = threading.Thread(
        target=serve,
        args=(site, stream),
        daemon=True,
        kwargs={"port": port, "speed": 1e9, "open_browser": False},
    )
    thread.start()
    for _ in range(50):
        try:
            response = urllib.request.urlopen(f"http://127.0.0.1:{port}/stream", timeout=5)
            break
        except OSError:
            threading.Event().wait(0.1)
    lines = [response.readline().decode().strip() for _ in range(6)]
    assert lines[0] == "event: meta"
    assert json.loads(lines[1][len("data: ") :])["title"] == "Feed"
    assert lines[3] == "event: frame"
    assert json.loads(lines[4][len("data: ") :])["values"] == {"pipe_a": 1.0}
