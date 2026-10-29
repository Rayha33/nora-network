"""Serve the built site and replay a stream as a live feed (Server-Sent Events).

    nora live --stream synthetic-week --speed 3600

serves the site and opens network.html?live=/stream, where the app updates from the
event stream instead of the data baked into the page. The feed sends one `meta` event,
then a `frame` event per time step:

    {"t": epoch seconds, "values": {asset: flow},
     "metrics": {"pressure_bar": {node: bar}, "nomination_msm3d": {exit: rate}, ...},
     "plan": {"now": [level, text, asset], "ahead": [level, text, asset, hours], ...}}

Anything that yields (timestamp, flows, metrics, index) frames can be served the same
way, so a real feed (a SCADA historian, Origo, or a TSO's transparency API; see
integrations.py) can replace `replay` without touching the browser side. Long gaps
between frames are filled with SSE `: keepalive` comments (about one every 15 s), so
browsers and proxies don't reap an idle connection.
"""

from __future__ import annotations

import json
import math
import sys
import threading
import time
import webbrowser
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .integrations import Connector
from .stream import Stream

# (when, flows, metrics, index), and from a poller optionally the hours ahead:
# {metric: {asset: [the next hours' values]}} (Origo's nominations).
Frame = tuple[datetime, dict[str, float], dict[str, dict[str, float]], int]
PacedFrame = tuple[float, Frame]  # wall-seconds to wait, then the frame itself
PolledItem = Frame | dict  # a dict is an error event: {"error": message}

KEEPALIVE_SECONDS = 15.0  # max silence before an SSE comment keeps the line warm
POLL_SECONDS = 300.0  # Gassco publishes its real-time figures every 5 minutes


def replay(stream: Stream, speed: float = 3600.0, loop: bool = True) -> Iterator[PacedFrame]:
    """Yield (wait, frame) pairs: `wait` is the wall-seconds to pause before the frame.

    speed is data-seconds per wall-second: 3600 plays one hour of data per second.
    The generator never sleeps (except for an empty stream, below), so the live
    server can cut each wait into keepalive-sized chunks and write an SSE comment
    between them; see _Handler._pause.
    """
    # Starting over waits one step of the stream, like any other frame: an instant
    # restart made a one-frame stream resend its frame in a busy loop.
    step = (stream.times[1] - stream.times[0]).total_seconds() if len(stream.times) > 1 else 3600.0
    restart = 0.0
    while True:
        previous = None
        steps = 0
        for index, when, flows, metrics in stream.frames_full():
            wait = (
                restart if previous is None else max(0.0, (when - previous).total_seconds() / speed)
            )
            previous = when
            steps += 1
            yield wait, (when, flows, metrics, index)
        if not loop:
            return
        restart = max(step / speed, 0.05)
        if not steps:
            # An empty stream would otherwise spin at 100% CPU until the
            # client disconnects; nap instead and try again.
            time.sleep(1.0)


def nominations_ahead(stream: Stream, index: int, hours: float = 6.0) -> dict:
    """Nominations already sent for the next `hours`, per exit point: shippers nominate
    ahead, so a live feed knows them before the gas flows."""
    if "nomination_msm3d" not in stream.metrics or len(stream.times) < 2:
        return {}
    assets, values = stream.metrics["nomination_msm3d"]
    step = (stream.times[1] - stream.times[0]).total_seconds() / 3600
    later = values[index + 1 : index + 1 + max(1, round(hours / step))]
    return {
        "nomination_msm3d": {
            asset: [row[j] for row in later] for j, asset in enumerate(assets) if later
        }
    }


def poll_once(source: Connector, index: int, poll_seconds: float = POLL_SECONDS) -> PolledItem:
    """One poll of a live connector: a frame, or an error event ({"error": ...}).

    A failed poll logs and comes back as an error event, never an exception, so a
    down API reads as a stale feed, not a dead server.
    """
    now = datetime.now(tz=UTC)
    try:
        readings = list(source.fetch(now - timedelta(seconds=poll_seconds), now))
        if not readings:
            raise ValueError(f"{source.name}: empty response")
        # What holds now (the latest reading per asset up to now) and, from a
        # source that knows them (Origo's nominations), the hours ahead.
        current = [r for r in readings if r.when <= now] or readings
        latest = {r.asset: r.value for r in sorted(current, key=lambda r: r.when)}
        later: dict[str, list[float]] = {}
        for r in sorted((r for r in readings if r.when > now), key=lambda r: r.when):
            later.setdefault(r.asset, []).append(r.value)
        when = max(r.when for r in current)
        flows = dict(latest) if source.flows else {}
        item = (when, flows, {source.metric: latest}, index)
        return (*item, {source.metric: later}) if later else item
    except Exception as error:  # noqa: BLE001 - the feed must outlive any one poll
        print(f"{source.name}: poll failed: {error}", file=sys.stderr)
        return {"error": str(error), "source": source.name}


def poll(
    source: Connector, poll_seconds: float = POLL_SECONDS
) -> Iterator[tuple[float, PolledItem]]:
    """Yield (wait, frame) pairs by polling a live connector every poll_seconds.

    A failed poll never ends the feed: it yields an SSE error event instead of a
    frame, and keeps polling. The first frame is sent at once. One generator polls
    for one reader; a server with several browsers shares one SharedPoll instead.
    """
    index, first = 0, True
    while True:
        # Every attempt after the first waits, failed or not: a source that is down
        # is retried every poll_seconds, never in a tight loop.
        wait, first = (0.0 if first else poll_seconds), False
        item = poll_once(source, index, poll_seconds)
        if not isinstance(item, dict):
            index += 1
        yield wait, item


class SharedPoll:
    """One upstream poller for every browser on /stream.

    Review #49802: each SSE client ran its own `poll`, so ten open tabs polled the
    source ten times every interval, and each frame then sat out a whole interval
    before it was sent. Here one daemon thread polls every poll_seconds and every
    client gets each result as soon as it lands. `frames` follows the handler's
    (wait, item) protocol; its item is a callable the handler calls after the wait,
    so the wait is spent before the fetch, not after it.
    """

    def __init__(self, source: Connector, poll_seconds: float = POLL_SECONDS):
        self.source, self.poll_seconds = source, poll_seconds
        self.polls = 0  # upstream fetches so far, whatever the number of readers
        self._changed = threading.Condition()
        self._item: PolledItem | None = None
        self._seq = 0  # bumps with every poll result
        self._due = 0.0  # time.monotonic() of the next poll
        self._thread: threading.Thread | None = None

    def _run(self) -> None:
        index = 0
        while True:
            item = poll_once(self.source, index, self.poll_seconds)
            if not isinstance(item, dict):
                index += 1
            with self._changed:
                self.polls += 1
                self._item, self._seq = item, self._seq + 1
                self._due = time.monotonic() + self.poll_seconds
                self._changed.notify_all()
            time.sleep(self.poll_seconds)

    def _start(self) -> None:
        with self._changed:
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, daemon=True)
                self._thread.start()

    def frames(self) -> Iterator[tuple[float, Callable[[], PolledItem | None]]]:
        """One reader's feed: the latest result at once, then each new one."""
        self._start()
        seen = 0

        def fresh() -> PolledItem | None:
            nonlocal seen
            with self._changed:
                # a fetch can take a while (30 s timeout); nothing new is a keepalive
                self._changed.wait_for(lambda: self._seq > seen, timeout=KEEPALIVE_SECONDS)
                if self._seq == seen:
                    return None
                seen = self._seq
                return self._item

        while True:
            with self._changed:
                wait = 0.0 if self._seq > seen else max(0.0, self._due - time.monotonic())
            yield wait, fresh


class _Handler(SimpleHTTPRequestHandler):
    meta: dict = {}
    plan: list | None = None
    ahead: Callable[[int], dict] | None = None  # nominations already sent for later hours
    frames: Callable[[], Iterator[PacedFrame]]
    keepalive: float = KEEPALIVE_SECONDS  # max silence between bytes on /stream

    def log_message(self, format, *args):  # noqa: A002 - keep the console quiet
        pass

    def do_GET(self):
        if urlsplit(self.path).path != "/stream":
            return super().do_GET()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self._send("meta", self.meta)
            for wait, item in self.frames():
                self._pause(wait)
                if callable(item):  # a SharedPoll reader: the result after the wait
                    item = item()
                    if item is None:  # still fetching: keep the line warm
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        continue
                if isinstance(item, dict):  # a poller failure: tell the browser, keep serving
                    self._send("error", item)
                    continue
                when, values, metrics, index, *polled = item
                frame = {"t": int(when.timestamp()), "values": values, "metrics": metrics}
                if self.plan:
                    frame["plan"] = self.plan[index]
                if polled:  # a poller that knows the hours ahead (Origo)
                    frame["ahead"] = polled[0]
                elif self.ahead:
                    frame["ahead"] = self.ahead(index)
                self._send("frame", frame)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser went away

    def _pause(self, wait: float) -> None:
        """Sleep `wait` seconds in keepalive-sized chunks, writing an SSE comment

        after each chunk while more wait remains, so an idle hour at speed 1 still
        puts a `: keepalive` line on the wire every ~15 s and proxies keep the line.
        """
        while wait > 0:
            chunk = min(wait, self.keepalive)
            time.sleep(chunk)
            wait -= chunk
            if wait > 0:
                self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()

    def _send(self, event: str, data: dict) -> None:
        # A polled source can carry NaN (no finite check out there): bare NaN is
        # invalid JSON, JSON.parse would drop every frame. Null it instead.
        def safe(value):
            if isinstance(value, dict):
                return {k: safe(v) for k, v in value.items()}
            if isinstance(value, list):
                return [safe(v) for v in value]
            if isinstance(value, float) and not math.isfinite(value):
                return None
            return value

        self.wfile.write(f"event: {event}\ndata: {json.dumps(safe(data))}\n\n".encode())
        self.wfile.flush()


def serve(
    site_dir: Path,
    stream: Stream | None = None,
    *,
    meta: dict | None = None,
    frames: Callable[[], Iterator[tuple[float, PolledItem]]] | None = None,
    host: str = "127.0.0.1",
    port: int = 8765,
    speed: float = 3600.0,
    keepalive: float = KEEPALIVE_SECONDS,
    open_browser: bool = True,
    plan: list | None = None,
) -> None:
    """Serve the site and a feed on /stream: replay a `stream`, or poll a live source.

    A poller (see `poll`) passes `meta` and `frames` instead of a `stream`, so
    `nora live --source gassco` serves real data without touching the browser side.
    """
    hidden = ("times", "values", "metrics", "plan")
    if meta is None:
        assert stream is not None, "serve needs a stream, or meta and frames"
        meta = {k: v for k, v in stream.payload().items() if k not in hidden}
    if frames is None:
        frames = partial(replay, stream, speed)
    handler = type(
        "StreamHandler",
        (_Handler,),
        {
            "meta": meta,
            "plan": plan,
            "ahead": staticmethod(partial(nominations_ahead, stream)) if stream else None,
            "frames": staticmethod(frames),
            "keepalive": keepalive,
        },
    )
    server = ThreadingHTTPServer((host, port), partial(handler, directory=str(site_dir)))
    server.daemon_threads = True
    url = f"http://{host}:{port}/network.html?live=/stream"
    if stream:
        print(f"Replaying '{stream.title}' at {speed:g}x as a live feed")
    else:
        print(f"Serving '{meta.get('title', 'live feed')}' as a live feed")
    print(f"  map:  {url}")
    print(f"  feed: http://{host}:{port}/stream  (Ctrl-C to stop)")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
