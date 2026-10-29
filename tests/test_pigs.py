"""Pigs (Ray, 27 Oct): "i should be able to click a pig to see more information like ETA,
tag number, if message has been sent to receiving station, last updated ETA sent to
receiving station". Tags, kinds and receivers from stream.toml; a speed that follows the
gas; the synthetic messages to the receiving station and the ETA-drift alarm.

tests/data/pig_messages.json holds runs that app.js must answer the same way
(tests/js/pigs.test.mjs reads the same file)."""

import json
from pathlib import Path

import pytest

from nora.data import DataError
from nora.stream import (
    PIG_DRIFT_S,
    PIG_NOTICE_S,
    PIG_RESPONSE_S,
    load_stream,
    pig_alarm,
    pig_code,
    pig_eta,
    pig_messages,
    pig_speed,
    pig_tag,
)

CASES = json.loads((Path(__file__).parent / "data" / "pig_messages.json").read_text())
H = 3600


def make_stream(folder, toml):
    folder.mkdir(parents=True)
    (folder / "stream.toml").write_text(toml)


def step(samples):
    """eta(t) from (time, ETA) samples: the last sample at or before t."""

    def eta(t):
        value = samples[0][1]
        for when, v in samples:
            if when <= t:
                value = v
        return value

    return eta


# ---------------------------------------------------------------- tags, kinds, receivers


def test_pig_code_and_tag():
    assert pig_code("iuk") == "IUK"
    assert pig_code("vesterled") == "VES"
    assert pig_code("langeled_south") == "LNS"
    assert pig_code("europipe_2_north") == "E2N"
    assert pig_code("zeepipe_2a") == "Z2A" and pig_code("zeepipe_2b") == "Z2B"
    assert pig_tag("langeled_south", 14) == "PIG-LNS-014"


def test_programme_pigs_get_tags_and_explicit_tags_are_kept(tiny, tmp_path):
    toml = """
[synthetic]
start = 2026-01-05T00:00:00Z
steps = 2
pig_programme = { every_hours = 48, kind = "gauging" }
[[pigs]]
pipeline = "pipe_a"
tag = "PIG-LGS-014"
kind = "inspection"
receiver = "a_terminal"
notify_every_hours = 4
launch = 2026-01-05T00:00:00Z
"""
    make_stream(tmp_path / "tags", toml)
    pigs = {p.pipeline: p for p in load_stream("tags", tiny, tmp_path).pigs}
    assert pigs["pipe_a"].tag == "PIG-LGS-014"
    assert pigs["pipe_a"].kind == "inspection" and pigs["pipe_a"].receiver == "a_terminal"
    assert pigs["pipe_a"].notify_every_hours == 4
    # The programme's pig: PIG-<line code>-<its number in the stream>, the programme's kind.
    assert pigs["pipe_b"].tag == "PIG-PPB-002"
    assert pigs["pipe_b"].kind == "gauging" and pigs["pipe_b"].receiver is None
    assert pigs["pipe_b"].notify_every_hours == 6


def test_payload_carries_tag_kind_receiver_and_notify(tiny, tmp_path):
    toml = """
[synthetic]
steps = 2
[[pigs]]
pipeline = "pipe_a"
receiver = "a_terminal"
launch = 2026-01-05T00:00:00Z
"""
    make_stream(tmp_path / "p", toml)
    pig = load_stream("p", tiny, tmp_path).payload()["pigs"][0]
    assert pig["tag"] == "PIG-PPA-001"
    assert pig["kind"] == "cleaning"  # the default
    assert pig["receiver"] == "a_terminal"
    assert pig["notify"] == 6 * H


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ('receiver = "a_terminl"', "unknown receiver 'a_terminl' (did you mean 'a_terminal'?)"),
        ('kind = "cleanin"', "kind must be cleaning, inspection or gauging, got 'cleanin'"),
        ("notify_every_hours = 0", "notify_every_hours must be above 0"),
    ],
)
def test_bad_kind_receiver_or_notify_is_reported(tiny, tmp_path, line, expected):
    toml = f"""
[synthetic]
steps = 2
[[pigs]]
pipeline = "pipe_a"
launch = 2026-01-05T00:00:00Z
{line}
"""
    make_stream(tmp_path / "bad", toml)
    with pytest.raises(DataError) as caught:
        load_stream("bad", tiny, tmp_path)
    assert any(expected in p and "pig 1" in p for p in caught.value.problems), caught.value


def test_bad_programme_kind_is_reported(tiny, tmp_path):
    make_stream(tmp_path / "k", '[synthetic]\nsteps = 2\npig_programme = { kind = "magic" }\n')
    with pytest.raises(DataError, match="pig_programme: kind must be"):
        load_stream("k", tiny, tmp_path)


# ---------------------------------------------------------------- speed and ETA


def test_pig_speed_follows_the_gas_within_bounds():
    assert pig_speed(4.0, 50, 50) == 4.0
    assert pig_speed(4.0, -25, 50) == 2.0  # the direction does not matter, the amount does
    assert pig_speed(4.0, 1, 50) == pytest.approx(1.2)  # never under 0.3 times
    assert pig_speed(4.0, 500, 50) == 6.0  # never over 1.5 times
    assert pig_speed(4.0, None, 50) == 4.0  # no reading: its set speed
    assert pig_speed(4.0, 10, 0) == 4.0  # no typical flow: its set speed


def test_pig_eta_adds_each_stretch_at_its_speed():
    assert pig_eta(1000, []) == 1000
    assert pig_eta(1000, [(36_000, 4.0), (18_000, 2.0)]) == 1000 + 9000 + 9000


# ---------------------------------------------------------------- messages


def test_launch_notice_cadence_and_arrival():
    launch, arrival = 10 * H, 30 * H
    log = pig_messages(launch, arrival, 6 * H, [], lambda t: arrival, "easington")
    assert [(m["t"], m["kind"]) for m in log] == [
        (launch - PIG_NOTICE_S, "launch"),
        (16 * H, "update"),
        (22 * H, "update"),
        (28 * H, "update"),
        (arrival, "arrival"),
    ]
    assert all(m["to"] == "easington" and m["eta"] == arrival for m in log)


def test_an_eta_that_moves_more_than_30_minutes_gets_its_own_update():
    launch, moved = 10 * H, 30 * H + 45 * 60
    eta = step([[0, 30 * H], [14 * H, moved]])
    checks = [h * H for h in range(40)]
    log = pig_messages(launch, moved, 6 * H, checks, eta, "easington")
    drift = [m for m in log if m.get("reason") == "drift"]
    assert len(drift) == 1
    assert drift[0]["t"] == 14 * H + PIG_RESPONSE_S and drift[0]["eta"] == moved
    # Under 30 minutes: only the scheduled updates.
    small = step([[0, 30 * H], [14 * H, 30 * H + PIG_DRIFT_S - 60]])
    assert not [
        m for m in pig_messages(launch, 31 * H, 6 * H, checks, small, "x") if "drift" in m.values()
    ]


def test_a_pig_still_under_way_has_no_arrival_and_no_updates_past_the_data():
    log = pig_messages(10 * H, None, 6 * H, [h * H for h in range(23)], lambda t: 30 * H, "x")
    assert [m["kind"] for m in log] == ["launch", "update", "update"]


@pytest.mark.parametrize("case", CASES["cases"], ids=lambda c: c["name"])
def test_messages_match_the_shared_cases(case):
    log = pig_messages(
        case["launch"],
        case["arrival"],
        case["notify"],
        case["checks"],
        step(case["eta"]),
        case["receiver"],
    )
    assert log == case["messages"]


@pytest.mark.parametrize("case", CASES["alarms"], ids=lambda c: c["name"])
def test_drift_alarm_matches_the_shared_cases(case):
    level, what, drift = pig_alarm(
        case["now"],
        case["launch"],
        case["arrival"],
        case["notify"],
        case["messages"],
        case["eta_now"],
    )
    assert (level, what, drift) == (case["level"], case["what"], case["drift"])


def test_drift_alarm_levels():
    log = [{"t": 8 * H, "kind": "launch", "eta": 30 * H, "to": "x"}]
    assert pig_alarm(9 * H, 10 * H, 30 * H, 6 * H, log, 30 * H + 20 * 60)[0] == 0
    assert pig_alarm(9 * H, 10 * H, 30 * H, 6 * H, log, 30 * H + 45 * 60)[:2] == (1, "drift")
    assert pig_alarm(9 * H, 10 * H, 30 * H, 6 * H, log, 32 * H + 1)[:2] == (3, "drift")
    # The 16:00 update never went: missed once it is 15 minutes late.
    assert pig_alarm(16 * H + 10 * 60, 10 * H, 30 * H, 6 * H, log, 30 * H)[0] == 0
    assert pig_alarm(16 * H + 16 * 60, 10 * H, 30 * H, 6 * H, log, 30 * H)[:2] == (3, "missed")
