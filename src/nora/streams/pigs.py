"""Pigs as data: tags, kinds, receivers, speed with the gas and ETAs.

Also the messages to the receiving station and the ETA-drift alarms.
"""

from __future__ import annotations

import math
import re

from ..data import Network, suggest
from .model import Pig

PIG_KINDS = ("cleaning", "inspection", "gauging")


def _pig_problem(pig: Pig, net: Network) -> str:
    """What is wrong with a pig's kind, receiver or notify interval; '' when nothing."""
    if pig.kind not in PIG_KINDS:
        return (
            f"kind must be {', '.join(PIG_KINDS[:-1])} or {PIG_KINDS[-1]}, got '{pig.kind}'"
            + suggest(pig.kind, PIG_KINDS)
        )
    if pig.receiver is not None and (
        not isinstance(pig.receiver, str) or pig.receiver not in net.node_by_id
    ):
        return f"unknown receiver '{pig.receiver}'" + suggest(
            str(pig.receiver), list(net.node_by_id)
        )
    if not pig.notify_every_hours > 0:
        return "notify_every_hours must be above 0"
    return ""


def pig_code(pipeline: str) -> str:
    """A short code for a line in a pig's tag: langeled_south -> LNS, iuk -> IUK.

    One word gives its first three letters. Several give the first word's initial and
    consonants, then each further word's initial (a number word whole: zeepipe_2a -> Z2A).
    """
    words = [w for w in re.split(r"[^A-Za-z0-9]+", pipeline.upper()) if w]
    if not words:
        return "PIG"
    if len(words) == 1:
        return words[0][:3]
    first = words[0][0] + "".join(c for c in words[0][1:] if c not in "AEIOU")
    rest = "".join(w if w[0].isdigit() else w[0] for w in words[1:])
    return (first[: max(1, 3 - len(rest))] + rest)[:4]


def pig_tag(pipeline: str, number: int) -> str:
    return f"PIG-{pig_code(pipeline)}-{number:03d}"


# A pig's speed and its messages to the receiving station. The browser moves the pigs
# and keeps the message log (app.js pigSpeed, pigMessages and pigAlarm); these are the
# same rules in Python, and tests/data/pig_messages.json holds cases both must pass.
# The messages are synthetic: NORA writes them as a dispatcher would, from the data.
PIG_SLOWEST, PIG_FASTEST = 0.3, 1.5  # a pig's speed against its set speed, at most

PIG_NOTICE_S = 2 * 3600  # the launch notice goes this long before the launch

PIG_DRIFT_S = 30 * 60  # an ETA update when the live ETA moves this far from the last sent

PIG_DRIFT_ALARM_S = 2 * 3600  # a drift this large, unsent, is an alarm

PIG_RESPONSE_S = 15 * 60  # the dispatcher sends that update this long after the move

PIG_GRACE_S = 15 * 60  # a scheduled update later than this is missed


def pig_speed(speed_mps: float, flow: float | None, typical: float | None) -> float:
    """A pig moves with the gas: its set speed times the line's flow against its typical
    flow, bounded to 0.3-1.5 times. No reading or no typical flow: its set speed."""
    if flow is None or not typical or typical <= 0:
        return speed_mps
    return speed_mps * min(PIG_FASTEST, max(PIG_SLOWEST, abs(flow) / typical))


def pig_eta(time: float, remaining: list[tuple[float, float]]) -> float:
    """The live ETA: now plus each stretch still ahead (metres) at its line's speed. The
    browser takes that speed from the line's mean flow over the last 24 hours, so the
    daily swing in the flows does not move an ETA days away."""
    return time + sum(metres / speed for metres, speed in remaining)


def pig_messages(
    launch: float,
    arrival: float | None,
    notify_s: float,
    checks: list[float],
    eta,
    receiver: str,
) -> list[dict]:
    """The messages to the receiving station over one run, in time order.

    A launch notice 2 h before the launch; an ETA update every `notify_s` after the launch;
    one more, PIG_RESPONSE_S later, whenever the live ETA (`eta(t)`, looked at at each
    time in `checks`; the browser looks every 15 minutes) has moved more than PIG_DRIFT_S
    from the last one sent; and the arrival confirmation. A pure function of its inputs,
    so replay and seek agree.
    """
    first = launch - PIG_NOTICE_S
    end = math.inf if arrival is None else arrival
    out = [{"t": first, "kind": "launch", "eta": eta(first), "to": receiver}]
    scheduled = []
    k = 1
    while launch + k * notify_s < end and (arrival is not None or k <= 1000):
        scheduled.append(launch + k * notify_s)
        k += 1
    if arrival is None:  # still under way when the data ends: up to the last data step
        scheduled = [t for t in scheduled if not checks or t <= checks[-1]]
    times = sorted({t for t in [*scheduled, *checks] if first < t < end})
    planned = set(scheduled)
    due = None

    def send(t: float, reason: str) -> None:
        out.append({"t": t, "kind": "update", "eta": eta(t), "to": receiver, "reason": reason})

    for t in times:
        if due is not None and due <= t:
            if not (due == t and t in planned):  # else the scheduled one goes instead
                send(due, "drift")
            due = None
        if t in planned:
            send(t, "scheduled")
            due = None
        elif due is None and abs(eta(t) - out[-1]["eta"]) > PIG_DRIFT_S:
            due = t + PIG_RESPONSE_S
    if due is not None and due < end:
        send(due, "drift")
    if arrival is not None:
        out.append({"t": arrival, "kind": "arrival", "eta": arrival, "to": receiver})
    return out


def pig_alarm(
    now: float, launch: float, arrival: float | None, notify_s: float, messages, eta_now
) -> tuple[int, str, float]:
    """(level, what, drift seconds) for a run at `now`: 1 when the live ETA is more than
    30 min from the last one sent, 3 past 2 h or when a scheduled update is missed."""
    if now < launch - PIG_NOTICE_S or (arrival is not None and now >= arrival):
        return 0, "", 0.0
    sent = [m for m in messages if m["t"] <= now]
    if not sent:
        return 0, "", 0.0
    drift = eta_now - sent[-1]["eta"]
    k = math.floor((now - PIG_GRACE_S - launch) / notify_s)
    if k >= 1 and sent[-1]["t"] < launch + k * notify_s:
        return 3, "missed", drift
    if abs(drift) > PIG_DRIFT_ALARM_S:
        return 3, "drift", drift
    if abs(drift) > PIG_DRIFT_S:
        return 1, "drift", drift
    return 0, "", drift
