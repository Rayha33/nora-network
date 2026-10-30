import itertools
import json
import socket
import threading
import urllib.request
from collections import Counter
from datetime import UTC, datetime, timedelta

import pytest

from nora.data import DataError
from nora.live import replay, serve
from nora.stream import Event, Stream, list_streams, load_stream, scaffold, synthesize, write_flows


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


def test_duplicate_flows_rows_are_reported_with_file_and_line(tiny, tmp_path):
    """flows.csv keeps one reading per timestamp+asset: a duplicate is an error,
    not a silent overwrite (import mappings sum on purpose - see below)."""
    make_stream(
        tmp_path / "dup",
        "",
        {
            "flows.csv": "timestamp,asset,flow_msm3d\n2026-01-01T00:00Z,pipe_a,10\n"
            "2026-01-01T00:00Z,pipe_b,20\n2026-01-01T00:00Z,pipe_a,99\n"
        },
    )
    with pytest.raises(DataError, match="flows.csv line 4: duplicate reading"):
        load_stream("dup", tiny, tmp_path)


def test_duplicate_metric_rows_are_reported_too(tiny, tmp_path):
    make_stream(
        tmp_path / "dupm",
        "",
        {
            "flows.csv": "timestamp,asset,metric,value\n"
            "2026-01-01T00:00Z,a_terminal,pressure_bar,50\n"
            "2026-01-01T00:00Z,a_terminal,pressure_bar,55\n"
            "2026-01-01T00:00Z,a_terminal,nomination_msm3d,1\n"
        },
    )
    with pytest.raises(DataError, match="duplicate reading for 'a_terminal'"):
        load_stream("dupm", tiny, tmp_path)


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


def test_quality_excursions_hold_and_repeat(tiny, tmp_path):
    toml = """
[synthetic]
start = 2026-01-05T00:00:00Z
steps = 12
seed = 3
quality = true
[[synthetic.excursions]]
asset = "gas"
metric = "h2s_ppm"
peak = 5.0
start = 2026-01-05T02:00:00Z
hours = 1
every_hours = 6
"""
    make_stream(tmp_path / "q", toml)
    stream = load_stream("q", tiny, tmp_path)
    assets, values = stream.metrics["h2s_ppm"]
    assert list(assets) == ["gas"]  # readings at fields only
    h2s = [row[0] for row in values]
    for hour in (2, 8):  # for an hour, and again 6 hours on
        assert h2s[hour] == pytest.approx(5.0, abs=0.1)
    assert max(h2s[:2] + h2s[3:8] + h2s[9:]) < 2  # its usual level the rest of the time
    assert "co2_molpct" in stream.metrics


def test_synthetic_peaks_are_short(north_sea):
    """Ray, 29 Oct: "some of the CO2 peaks are unrealisticly long, cut the longest in
    half", then "simulated peaks are too long". No field's H2S or CO2 stays over the
    follow level for more than half an hour: about 14 km of gas, not whole lines. Each
    field still sends some."""
    from nora.config import load_config

    quality = load_config()["quality"]
    stream = load_stream("synthetic-week", north_sea)
    step_hours = (stream.times[1] - stream.times[0]).total_seconds() / 3600
    assert step_hours == 0.5, "half-hour peaks need half-hour data"
    for metric in ("h2s_ppm", "co2_molpct"):
        follow = quality[metric][0] * quality["follow_from"]
        assets, values = stream.metrics[metric]
        slugs = 0
        for column, asset in enumerate(assets):
            run = longest = 0
            for row in values:
                run = run + 1 if row[column] is not None and row[column] >= follow else 0
                slugs += run == 1
                longest = max(longest, run)
            hours = longest * step_hours
            assert hours <= 0.5, f"{asset}: {metric} over {follow:.2f} for {hours} h"
        assert slugs >= 4, f"{metric}: only {slugs} slugs in the week"


def test_synthetic_week_breaches_limits_now_and_then(north_sea):
    """Ray, 29 Oct: "random pressure and flow limits breached but keep the not too
    frequent. then less frequent a few of them turning red, meaning high high or low
    low". Pressures pass low and high, now and then low-low and high-high; a few lines
    run over capacity, fewer past its critical level; red is rarer than yellow."""
    from nora.config import load_config

    config = load_config()
    limits, load = config["pressure_limits"], config["thresholds"]["load"]
    kinds = {n.id: n.type for n in north_sea.nodes}
    capacity = {p.id: p.capacity_msm3d for p in north_sea.pipelines}
    stream = load_stream("synthetic-week", north_sea)
    assets, values = stream.metrics["pressure_bar"]
    seen, hours_with_any = Counter(), 0
    for row in values:
        hit = False
        for column, asset in enumerate(assets):
            p = row[column]
            if p is None:
                continue
            ll, low, high, hh, _top = limits[kinds[asset]]
            code = (
                "HH"
                if p >= hh
                else "H"
                if p >= high
                else "LL"
                if p <= ll
                else "L"
                if p <= low
                else None
            )
            if code:
                seen[code] += 1
                hit = True
        hours_with_any += hit
    assert all(seen[code] for code in ("L", "LL", "H", "HH")), seen
    assert seen["LL"] + seen["HH"] < seen["L"] + seen["H"], "red is rarer than yellow"
    assert hours_with_any < 0.4 * len(values), "not too frequent"
    over = Counter()
    for column, pid in enumerate(stream.assets):
        for row in stream.values if capacity.get(pid) else ():
            share = abs(row[column] or 0) / capacity[pid]
            over["critical" if share >= load[2] else "warning" if share >= load[0] else ""] += 1
    assert over["warning"] and over["critical"] and over["critical"] < over["warning"], over


def test_a_pressure_excursion_at_an_unknown_node_is_reported(tiny, tmp_path):
    toml = """
[synthetic]
steps = 2
operations = true
[[synthetic.pressure_excursions]]
asset = "hubb"
rise_bar = 5
start = 2026-01-05T00:00:00Z
"""
    make_stream(tmp_path / "bad", toml)
    with pytest.raises(DataError) as caught:
        load_stream("bad", tiny, tmp_path)
    assert any("'hubb' is not a node" in p for p in caught.value.problems)


def test_unknown_excursion_field_is_reported(tiny, tmp_path):
    toml = """
[synthetic]
steps = 2
quality = true
[[synthetic.excursions]]
asset = "hubb"
metric = "h2s_ppm"
peak = 5.0
start = 2026-01-05T00:00:00Z
"""
    make_stream(tmp_path / "bad", toml)
    with pytest.raises(DataError, match="not a field"):
        load_stream("bad", tiny, tmp_path)


def test_pig_programme_repeats(tiny, tmp_path):
    toml = """
[synthetic]
steps = 2
[[pigs]]
pipeline = "pipe_a"
launch = 2026-01-05T00:00:00Z
every_hours = 12
"""
    make_stream(tmp_path / "pig", toml)
    pig = load_stream("pig", tiny, tmp_path).payload()["pigs"][0]
    assert pig["every"] == 12 * 3600


def test_pig_programme_covers_every_main_line_staggered(tiny, tmp_path):
    toml = """
[synthetic]
start = 2026-01-05T00:00:00Z
steps = 2
pig_programme = { every_hours = 48, speed_mps = 4.0 }
"""
    make_stream(tmp_path / "programme", toml)
    pigs = load_stream("programme", tiny, tmp_path).pigs
    lines = sorted(p.pipeline for p in pigs)
    assert lines == ["pipe_a", "pipe_b"]  # every trunk/export/interconnector, nothing else
    start = datetime(2026, 1, 5, tzinfo=UTC)
    for i, pig in enumerate(sorted(pigs, key=lambda p: p.pipeline)):
        assert pig.launch == start + timedelta(seconds=48 * 3600 * i / 2)
        assert pig.every_hours == 48 and pig.speed_mps == 4.0


def test_explicit_pigs_win_over_the_programme(tiny, tmp_path):
    toml = """
[synthetic]
start = 2026-01-05T00:00:00Z
steps = 2
pig_programme = { every_hours = 48 }
[[pigs]]
pipeline = "pipe_a"
launch = 2026-01-06T00:00:00Z
every_hours = 12
"""
    make_stream(tmp_path / "mixed", toml)
    pigs = load_stream("mixed", tiny, tmp_path).pigs
    assert sorted(p.pipeline for p in pigs) == ["pipe_a", "pipe_b"]  # pipe_a appears once
    explicit = next(p for p in pigs if p.pipeline == "pipe_a")
    assert explicit.every_hours == 12  # the named entry kept its own programme
    assert explicit.launch == datetime(2026, 1, 6, tzinfo=UTC)


def test_bad_pig_programme_is_reported(tiny, tmp_path):
    toml = """
[synthetic]
steps = 2
pig_programme = { every_hours = 0 }
"""
    make_stream(tmp_path / "bad", toml)
    with pytest.raises(DataError) as caught:
        load_stream("bad", tiny, tmp_path)
    assert any("pig_programme" in p for p in caught.value.problems)


def test_pig_programme_with_bad_numbers_is_reported(tiny, tmp_path):
    toml = """
[synthetic]
steps = 2
pig_programme = { every_hours = "daily" }
"""
    make_stream(tmp_path / "prog", toml)
    with pytest.raises(DataError, match="pig_programme: every_hours and speed_mps must be numbers"):
        load_stream("prog", tiny, tmp_path)


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


def test_write_flows_round_trips_long_metrics(tiny, tmp_path):
    make_stream(
        tmp_path / "measured",
        "",
        {
            "flows.csv": "timestamp,asset,metric,value\n"
            "2026-01-01T00:00Z,pipe_a,flow_msm3d,10.5\n"
            "2026-01-01T00:00Z,a_terminal,pressure_bar,57\n"
            "2026-01-01T00:00Z,a_terminal,nomination_msm3d,30\n"
            "2026-01-01T00:00Z,a_terminal,booked_msm3d,40\n"
            "2026-01-01T01:00Z,pipe_a,flow_msm3d,11.5\n"
            "2026-01-01T01:00Z,a_terminal,pressure_bar,56\n"
            "2026-01-01T02:00Z,pipe_a,flow_msm3d,12.5\n"
            "2026-01-01T02:00Z,a_terminal,nomination_msm3d,35\n"
        },
    )
    stream = load_stream("measured", tiny, tmp_path)
    make_stream(tmp_path / "copy", "")

    write_flows(stream, tmp_path / "copy" / "flows.csv")
    restored = load_stream("copy", tiny, tmp_path)

    assert restored.values == stream.values
    assert restored.metrics == stream.metrics


def test_held_nomination_and_booking_metrics_forward_fill(tiny, tmp_path):
    make_stream(
        tmp_path / "held",
        "",
        {
            "flows.csv": "timestamp,asset,metric,value\n"
            "2026-01-01T00:00Z,a_terminal,nomination_msm3d,30\n"
            "2026-01-01T00:00Z,a_terminal,booked_msm3d,40\n"
            "2026-01-01T01:00Z,pipe_a,flow_msm3d,10\n"
            "2026-01-01T02:00Z,a_terminal,nomination_msm3d,35\n",
        },
    )

    stream = load_stream("held", tiny, tmp_path)

    assert stream.metrics["nomination_msm3d"][1] == ((30.0,), (30.0,), (35.0,))
    assert stream.metrics["booked_msm3d"][1] == ((40.0,), (40.0,), (40.0,))


def test_planned_events_are_in_stream_payload(tiny, tmp_path):
    make_stream(
        tmp_path / "planned",
        """
[[events]]
label = "Planned inspection"
asset = "pipe_a"
start = 2026-01-01T01:00:00Z
end = 2026-01-01T02:00:00Z
planned = true
""",
        {"flows.csv": "timestamp,asset,flow_msm3d\n2026-01-01T00:00Z,pipe_a,10\n"},
    )

    event = load_stream("planned", tiny, tmp_path).payload()["events"][0]

    assert event["label"] == "Planned inspection"
    assert event["asset"] == "pipe_a"
    assert event["planned"] is True
    assert event["start"] == int(datetime(2026, 1, 1, 1, tzinfo=UTC).timestamp())


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
    assert [f[1][1]["pipe_a"] for f in frames] == [1, 2, 1]
    # paced: an hour of data between frames, and starting over waits a step too (at
    # least 0.05 s, so even a very fast replay never restarts in a busy loop)
    assert [round(f[0], 9) for f in frames] == [0.0, 3600e-9, 0.05]


def test_replay_of_one_frame_waits_between_loops(tiny, tmp_path):
    """Review finding: a one-frame stream restarted at once, every loop, so the server
    resent its frame in a busy loop at 100% CPU."""
    make_stream(
        tmp_path / "s",
        "",
        {"flows.csv": "timestamp,asset,flow_msm3d\n2026-01-01T00:00Z,pipe_a,1\n"},
    )
    stream = load_stream("s", tiny, tmp_path)
    waits = [wait for wait, _ in itertools.islice(replay(stream, speed=3600), 3)]
    assert waits == [0.0, 1.0, 1.0]  # an hour of data a second: a frame a second


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
    with socket.socket() as probe:  # a free port, so parallel test runs don't collide
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
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
    else:
        pytest.fail("the live server never came up")
    lines = [response.readline().decode().strip() for _ in range(6)]
    assert lines[0] == "event: meta"
    assert json.loads(lines[1][len("data: ") :])["title"] == "Feed"
    assert lines[3] == "event: frame"
    assert json.loads(lines[4][len("data: ") :])["values"] == {"pipe_a": 1.0}


def test_live_server_sends_plan_and_nomination_lookahead(tiny, tmp_path):
    make_stream(
        tmp_path / "planned",
        'title = "Feed"\n',
        {
            "flows.csv": "timestamp,asset,metric,value\n"
            "2026-01-01T00:00Z,pipe_a,flow_msm3d,1\n"
            "2026-01-01T00:00Z,a_terminal,nomination_msm3d,30\n"
            "2026-01-01T01:00Z,pipe_a,flow_msm3d,2\n"
            "2026-01-01T01:00Z,a_terminal,nomination_msm3d,31\n"
            "2026-01-01T02:00Z,pipe_a,flow_msm3d,3\n"
            "2026-01-01T02:00Z,a_terminal,nomination_msm3d,32\n"
        },
    )
    stream = load_stream("planned", tiny, tmp_path)
    site = tmp_path / "site"
    site.mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    plan = [{"now": [0, "holds", None]} for _ in stream.times]
    thread = threading.Thread(
        target=serve,
        args=(site, stream),
        daemon=True,
        kwargs={"port": port, "speed": 1e9, "open_browser": False, "plan": plan},
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
    while response.readline().decode().strip() != "event: frame":
        pass
    frame = json.loads(response.readline().decode()[len("data: ") :])

    assert frame["plan"] == plan[0]
    assert frame["ahead"] == {"nomination_msm3d": {"a_terminal": [31.0, 32.0]}}


def test_live_server_sends_keepalive_comments_during_long_gaps(tiny, tmp_path):
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
    with socket.socket() as probe:  # a free port, so parallel test runs don't collide
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    # 3600 s of data at speed 18000 is a 0.2 s gap, cut into 0.05 s keepalive chunks.
    thread = threading.Thread(
        target=serve,
        args=(site, stream),
        daemon=True,
        kwargs={"port": port, "speed": 18000, "keepalive": 0.05, "open_browser": False},
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
    # meta and the first frame, then `: keepalive` comments between frames.
    lines = [response.readline().decode().strip() for _ in range(9)]
    assert lines[0] == "event: meta"
    assert lines[3] == "event: frame"
    assert json.loads(lines[4][len("data: ") :])["values"] == {"pipe_a": 1.0}
    assert lines[6] == ": keepalive"  # a comment every chunk while the gap is still open
    assert lines[8] == ": keepalive"


def test_mapping_with_a_minus_flips_the_sign(tiny, tmp_path):
    raw = "day,Out,In\n2026-01-01,-30,12\n"
    toml = """
[import]
layout = "wide"
timestamp = "day"
[import.assets]
"Out" = "-pipe_b"
"In" = "pipe_a"
"""
    make_stream(tmp_path / "signs", toml, {"raw.csv": raw})
    stream = load_stream("signs", tiny, tmp_path)
    assert dict(zip(stream.assets, stream.values[0], strict=True)) == {
        "pipe_a": 12.0,
        "pipe_b": 30.0,
    }


def test_long_layout_defaults_to_a_value_column(tiny, tmp_path):
    raw = "timestamp,point,value\n2026-01-01T00:00Z,A,5\n"
    toml = '[import]\nasset = "point"\n[import.assets]\n"A" = "pipe_a"\n'
    make_stream(tmp_path / "plain", toml, {"raw.csv": raw})
    assert load_stream("plain", tiny, tmp_path).values == ((5.0,),)


def test_stream_names_that_escape_the_folder_are_rejected(tiny, tmp_path):
    with pytest.raises(DataError, match="folder name"):
        load_stream("../evil", tiny, tmp_path)
    with pytest.raises(DataError, match="folder name"):
        load_stream("a/b", tiny, tmp_path)
    (tmp_path / "raw.csv").write_text("timestamp,point,value\n2026-01-01T00:00Z,A,5\n")
    with pytest.raises(DataError, match="folder name"):
        scaffold("../evil", tmp_path / "raw.csv", tiny, tmp_path / "streams")


def test_import_raw_file_must_stay_inside_the_stream_folder(tiny, tmp_path):
    (tmp_path / "secret.csv").write_text("timestamp,point,value\n2026-01-01T00:00Z,A,5\n")
    make_stream(
        tmp_path / "escape",
        '[import]\nfile = "../secret.csv"\nasset = "point"\n[import.assets]\n"A" = "pipe_a"\n',
    )
    with pytest.raises(DataError, match="inside the stream folder"):
        load_stream("escape", tiny, tmp_path)


def test_import_strips_whitespace_from_raw_values(tiny, tmp_path):
    raw = "when,point,dir,kwh\n2026-01-01T00:00Z,A, exit , 10 \n2026-01-01T00:00Z,A,entry,99\n"
    toml = """
[import]
file = "raw.csv"
timestamp = "when"
asset = "point"
value = "kwh"
[import.where]
dir = "exit"
[import.assets]
"A" = "pipe_a"
"""
    make_stream(tmp_path / "ws", toml, {"raw.csv": raw})
    stream = load_stream("ws", tiny, tmp_path)
    assert stream.values == ((10.0,),)


def test_events_with_inverted_times_are_rejected(tiny, tmp_path):
    make_stream(
        tmp_path / "back",
        """
[[events]]
label = "Backwards"
asset = "pipe_a"
start = 2026-01-05T04:00:00Z
end = 2026-01-05T02:00:00Z
""",
    )
    with pytest.raises(DataError, match="end must be after start"):
        load_stream("back", tiny, tmp_path)


def test_events_with_out_of_range_capacity_factor_are_rejected(tiny, tmp_path):
    make_stream(
        tmp_path / "hot",
        """
[[events]]
label = "Overdriven"
asset = "pipe_a"
start = 2026-01-05T02:00:00Z
end = 2026-01-05T04:00:00Z
capacity_factor = -1.0
""",
    )
    with pytest.raises(DataError, match="capacity_factor"):
        load_stream("hot", tiny, tmp_path)


def test_replay_with_an_empty_stream_sleeps_instead_of_spinning(monkeypatch):
    empty = Stream(
        name="e",
        title="e",
        description="",
        source="",
        license="",
        synthetic=False,
        events=(),
        times=(),
        assets=(),
        values=(),
    )
    sleeps = []

    def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 3:
            raise KeyboardInterrupt

    monkeypatch.setattr("nora.live.time.sleep", fake_sleep)
    with pytest.raises(KeyboardInterrupt):
        list(replay(empty, speed=1.0, loop=True))
    assert sleeps == [1.0, 1.0, 1.0]  # napping once per loop, not busy-looping


def test_sodir_stream_covers_real_fields(north_sea):
    stream = load_stream("sodir-field-production", north_sea)
    node_ids = {n.id for n in north_sea.nodes}
    assert set(stream.assets) <= node_ids  # every reading maps to an existing node
    assert list(stream.times) == sorted(stream.times)
    assert all(t.day == 1 and t.hour == 0 for t in stream.times)  # month starts
    troll = stream.values[0][stream.assets.index("troll")]
    assert troll and 50 < troll < 200  # MSm3/d, from SODIR's billion Sm3 per month


def test_order_sets_which_stream_comes_first(north_sea):
    synthetic = load_stream("synthetic-week", north_sea)
    real = load_stream("denmark-gas-energinet", north_sea)
    assert (synthetic.order, real.order) == (1, 100)
    assert not real.synthetic and real.source.startswith("https://")


def test_import_factor_and_timezone_report_as_data_errors(tiny, tmp_path):
    raw = "when,point,kwh\n2026-01-01T00:00:00+01:00,North A,1000\n"
    # a non-numeric factor must be a DataError naming the problem, not a traceback
    make_stream(
        tmp_path / "bad-factor",
        """
title = "Bad factor"
[import]
file = "raw.csv"
timestamp = "when"
asset = "point"
value = "kwh"
factor = "not-a-number"
""",
        {"raw.csv": raw},
    )
    with pytest.raises(DataError) as boom:
        load_stream("bad-factor", tiny, tmp_path)
    assert any("factor must be a number" in p for p in boom.value.problems)

    # a bogus timezone likewise
    make_stream(
        tmp_path / "bad-tz",
        """
title = "Bad timezone"
[import]
file = "raw.csv"
timestamp = "when"
asset = "point"
value = "kwh"
timezone = "Mars/Olympus"
""",
        {"raw.csv": raw},
    )
    with pytest.raises(DataError) as boom:
        load_stream("bad-tz", tiny, tmp_path)
    assert any("timezone must be a valid IANA zone" in p for p in boom.value.problems)


def test_a_derate_actually_cuts_a_supply_nodes_flow(tiny):
    """An event on a supply node used to be silently ignored: synthesize built its
    supply override from the *base* capacity. A 50% derate must roughly halve
    what the field pushes into its pipeline while it is active."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from nora.stream import Event, synthesize

    t0 = datetime(2026, 1, 5, tzinfo=ZoneInfo("UTC"))
    events = (Event("derate", "gas", t0.replace(hour=1), t0.replace(hour=2), 0.5),)
    rows = synthesize(
        tiny, {"start": "2026-01-05T00:00:00Z", "step_minutes": 60, "steps": 3, "seed": 1}, events
    )
    feed = {(when, asset): value for when, asset, metric, value in rows if asset == "feed"}
    hours = sorted({when for (when, _) in feed})
    before = feed[(hours[0], "feed")]
    during = feed[(hours[1], "feed")]
    assert during < before * 0.75, (before, during)
    assert feed[(hours[2], "feed")] > during, "and it recovers after the event"


def test_synthetic_nominations_are_the_plan_without_events(tiny):
    """Review finding: the nominations were routed with the supply an event had already
    cut, so a field outage moved the plan with it and never showed as a shortfall."""
    spec = {"start": "2026-01-05T00:00:00Z", "steps": 8, "operations": True, "seed": 3}
    start = datetime(2026, 1, 5, tzinfo=UTC)
    outage = Event(
        "Gas field derate", "gas", start + timedelta(hours=2), start + timedelta(hours=6), 0.5
    )

    def rows(events):
        return {
            (when, asset, metric): value
            for when, asset, metric, value in synthesize(tiny, spec, events)
        }

    calm, derated = rows(()), rows((outage,))
    nominations = [k for k in calm if k[2] == "nomination_msm3d"]
    assert nominations and all(calm[k] == derated[k] for k in nominations), (
        "the plan ignores the event"
    )
    hour = start + timedelta(hours=3)
    assert derated[(hour, "feed", "flow_msm3d")] < calm[(hour, "feed", "flow_msm3d")], (
        "the gas does not"
    )


def test_synthetic_pressures_move_like_line_pack(north_sea):
    """A pressure is its line pack, so it moves slowly: at most 1.5 bar an hour, and
    hardly at all most hours. Faster swings made pack rates of hundreds of MSm3/d where
    operators see a few (Ray, 29 Oct: the pack rate stays near 0). Only a random limit
    breach (a trip, a restriction) moves it faster, up to 6 bar an hour, in few hours."""
    import statistics

    from nora.stream import load_stream

    stream = load_stream("synthetic-week", north_sea)
    block = stream.payload()["metrics"]["pressure_bar"]
    rows = block["values"]
    steps = [
        abs(b - a)
        for j in range(len(block["assets"]))
        for a, b in zip((r[j] for r in rows), (r[j] for r in rows[1:]), strict=False)
        if a is not None and b is not None
    ]
    assert max(steps) <= 6 + 1e-9
    assert sum(step > 1.5 + 1e-9 for step in steps) < 0.02 * len(steps), "breaches are rare"
    assert statistics.median(steps) < 0.2


def test_synthetic_week_has_each_fields_gc_and_the_outside_temperature(north_sea):
    """Ray, 29 Oct: "GC values in a table like C1 Metan, C2 Etan, C3 Propan etc all the way
    to C6+ and then CO2, N2 ... O2, WDP and HCDP"; "what temperature it is at each of the
    main exit point hubs"."""
    stream = load_stream("synthetic-week", north_sea)
    keys = ("c1", "c2", "c3", "ic4", "nc4", "ic5", "nc5", "c6plus", "co2", "n2")
    columns = {k: stream.metrics[f"{k}_molpct"] for k in keys}
    assets, _ = columns["c1"]
    fields = {n.id for n in north_sea.nodes if n.type == "field" and n.capacity_msm3d}
    assert set(assets) == fields
    for row in range(0, len(stream.times), 24):
        for asset in assets:
            total = sum(columns[k][1][row][columns[k][0].index(asset)] or 0 for k in keys)
            assert abs(total - 100) < 0.05, f"{asset}: {total} mol %"
            c1 = columns["c1"][1][row][assets.index(asset)]
            assert 80 < c1 < 96, f"{asset}: methane {c1}"
    for metric, low, high in (("wdp_c", -25, -5), ("hcdp_c", -15, 2), ("o2_ppm", 0, 5)):
        _, values = stream.metrics[metric]
        flat = [v for r in values for v in r if v is not None]
        assert low < min(flat) and max(flat) < high, metric
    sites, temps = stream.metrics["air_temp_c"]
    assert {"zeebrugge", "easington", "dunkirk", "emden", "dornum", "nybro"} <= set(sites)
    flat = [v for r in temps for v in r if v is not None]
    assert min(flat) > -5 and max(flat) < 20, "late autumn by the North Sea"
