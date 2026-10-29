"""One upstream poller for every browser on /stream (review #49802).

Each SSE client used to run its own `poll`: ten tabs polled the source ten times an
interval, and every frame waited out a whole interval after its fetch before it went
out. SharedPoll polls once per interval for everyone and hands each result over as
soon as it lands.
"""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime

from nora.integrations import USER_AGENT, Connector, Reading
from nora.live import SharedPoll


class Counting(Connector):
    name = "counting"
    metric = "flow_msm3d"

    def __init__(self):
        self.fetches = 0
        self.lock = threading.Lock()

    def fetch(self, start, end):
        with self.lock:
            self.fetches += 1
            n = self.fetches
        yield Reading(datetime.now(tz=UTC), "dunkirk", self.metric, float(n))


def take(feed, n):
    """The first n results a reader sends, as the SSE handler would: wait, then call."""
    out = []
    while len(out) < n:
        wait, item = next(feed)
        time.sleep(wait)
        result = item()
        if result is not None:
            out.append(result)
    return out


def test_two_readers_share_one_upstream_poll():
    source = Counting()
    shared = SharedPoll(source, poll_seconds=0.3)
    results = {}

    def reader(name):
        results[name] = take(shared.frames(), 3)

    readers = [threading.Thread(target=reader, args=(k,)) for k in ("a", "b")]
    for t in readers:
        t.start()
    for t in readers:
        t.join(timeout=10)
    assert len(results["a"]) == len(results["b"]) == 3
    assert source.fetches <= 4, "one fetch per interval for both readers, not one each"
    values = [r[1]["dunkirk"] for r in results["a"]]
    assert values == sorted(values) and len(set(values)) == 3, "each result once, in order"


def test_a_result_goes_out_as_soon_as_it_is_fetched():
    source = Counting()
    shared = SharedPoll(source, poll_seconds=0.5)
    feed = shared.frames()
    first = take(feed, 1)[0]
    started = time.monotonic()
    second = take(feed, 1)[0]
    elapsed = time.monotonic() - started
    assert first[1]["dunkirk"] == 1 and second[1]["dunkirk"] == 2
    assert elapsed < 0.9, f"sent {elapsed:.2f} s after the last one: one interval, not two"
    # the frame's timestamp is the fetch, and it reached the reader right after it
    assert (datetime.now(tz=UTC) - second[0]).total_seconds() < 0.3


def test_nora_names_itself_to_gassco():
    """It used to pose as Chrome to get past Cloudflare."""
    assert "Mozilla" not in USER_AGENT and "nora-network" in USER_AGENT
