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
integrations.py) can replace `replay` without touching the browser side. Or push:
`nora live --ingest` takes readings POSTed as JSON to /ingest from any system (see
docs/live-data.md). `nora live --now` replays a stream re-timed to the wall clock,
looping, as a showcase (NowReplay; a new `meta` event per loop). Long gaps
between frames are filled with SSE `: keepalive` comments (about one every 15 s), so
browsers and proxies don't reap an idle connection.
"""

from __future__ import annotations

import hmac
import itertools
import json
import math
import sys
import threading
import time
import webbrowser
from bisect import bisect_right
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .integrations import Connector
from .stream import METRICS, Stream

# (when, flows, metrics, index), and from a poller optionally the hours ahead:
# {metric: {asset: [the next hours' values]}} (Origo's nominations).
Frame = tuple[datetime, dict[str, float], dict[str, dict[str, float]], int]
PacedFrame = tuple[float, Frame]  # wall-seconds to wait, then the frame itself
PolledItem = Frame | dict  # a dict is an error event: {"error": message}

KEEPALIVE_SECONDS = 15.0  # max silence before an SSE comment keeps the line warm
INGEST_LIMIT = 1_000_000  # the most bytes one push may carry
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


class Meta(dict):
    """A `meta` event sent part-way through a feed: `nora live --now` sends one per loop,
    with that loop's pigs and events re-timed. A plain dict item is an error event."""


class NowReplay:
    """Replay a stream as if it were happening now (`nora live --now`): a showcase.

    The stream's hour k is stamped origin + k*step, where origin is the wall-clock hour
    the server started in, so the app's clock reads true. The stream loops for ever
    and the times keep rising across loops. Pigs and events move with their loop.
    speed is data-seconds per wall-second (1 = real time; above 1 the clock runs ahead).

    One instance serves every browser, so they all see the same time. Each reader
    first gets the last `history_hours` at once, so trends have their past. Synthetic
    data stays labelled synthetic and a recording says it is one: re-timed is not live.
    """

    def __init__(
        self,
        stream: Stream,
        speed: float = 1.0,
        clock: Callable[[], float] = time.time,
        history_hours: float = 24.0,
    ):
        self.stream, self.speed, self.clock = stream, speed, clock
        times = stream.times
        self.step = (times[1] - times[0]).total_seconds() if len(times) > 1 else 3600.0
        # Each frame's place within one loop (irregular streams keep their spacing);
        # a loop lasts the stream's span plus one step before it starts over.
        self.offsets = [(t - times[0]).total_seconds() for t in times]
        self.period = (self.offsets[-1] if times else 0.0) + self.step
        self.started = clock()
        align = min(self.step, 3600.0)  # on the hour (or on the step, for finer data)
        self.origin = math.floor(self.started / align) * align
        self.history = min(max(0, len(times) - 1), round(history_hours * 3600 / self.step))
        hidden = ("times", "values", "metrics", "plan")
        self.payload = {k: v for k, v in stream.payload().items() if k not in hidden}

    def when(self, position: int) -> float:
        """Epoch seconds of the feed's frame number `position` (0 = the stream's first
        frame in the first loop; negative positions are the loop before)."""
        loop, index = divmod(position, len(self.offsets))
        return self.origin + loop * self.period + self.offsets[index]

    def now(self) -> float:
        """The feed's clock: the wall clock at speed 1."""
        return self.started + (self.clock() - self.started) * self.speed

    def position(self) -> int:
        """The frame that holds now: the latest one stamped at or before the feed's clock."""
        loop, into = divmod(self.now() - self.origin, self.period)
        return int(loop) * len(self.offsets) + bisect_right(self.offsets, into) - 1

    def meta(self, loop: int) -> Meta:
        """The meta event for a loop: the pigs and events of it and of the loop before (a
        pig launched then may still be on its way; the history a reader gets reaches back).

        Each run of a relaunched pig goes out as a pig of its own (`every` 0, its run's
        id): left relaunching, last loop's pigs would run on beside this loop's.
        """
        shift = self.origin - self.stream.times[0].timestamp()  # the first loop's
        meta = Meta(self.payload)
        meta["pigs"] = []
        for n in (loop - 1, loop):
            ends = self.origin + (n + 1) * self.period
            for pig in self.payload["pigs"]:
                launch, every = pig["launch"] + shift + n * self.period, pig["every"]
                runs = math.ceil((ends - launch) / every) if every > 0 else 1
                meta["pigs"] += [
                    {
                        **pig,
                        "launch": round(launch + run * every),
                        "every": 0,
                        "id": None if pig["id"] is None else pig["id"] + run,
                    }
                    for run in range(max(0, runs))
                ]
        meta["events"] = [
            {
                **event,
                "start": round(event["start"] + shift + n * self.period),
                "end": round(event["end"] + shift + n * self.period),
            }
            for n in (loop - 1, loop)
            for event in self.payload["events"]
        ]
        kind = "synthetic" if self.stream.synthetic else "recorded"
        meta["title"] = f"{self.stream.title} ({kind}, re-timed to now)"
        meta["description"] = (
            f"{self.stream.description} Replayed with its times moved to now "
            f"(nora live --now), looping: not live readings."
        ).strip()
        meta["retimed"] = {"origin": round(self.origin), "speed": self.speed, "loop": loop}
        return meta

    def frames(self) -> Iterator[tuple[float, Frame | Meta]]:
        """One reader's feed: the meta, the recent history at once, then each frame when
        the feed's clock reaches it; a new meta before the first frame of each loop."""
        n = len(self.offsets)
        if not n:
            return
        current = self.position()
        loop = current // n
        yield 0.0, self.meta(loop)
        for position in itertools.count(current - self.history):
            wait = max(0.0, (self.when(position) - self.now()) / self.speed)
            index = position % n
            if position > current and position // n != loop:  # history is in the first meta
                loop = position // n
                yield wait, self.meta(loop)
                wait = 0.0
            when = datetime.fromtimestamp(self.when(position), tz=UTC)
            yield wait, (when, *self._row(index), index)

    def _row(self, index: int) -> tuple[dict, dict]:
        flows = {
            a: v
            for a, v in zip(self.stream.assets, self.stream.values[index], strict=True)
            if v is not None
        }
        metrics = {
            metric: {a: v for a, v in zip(assets, values[index], strict=True) if v is not None}
            for metric, (assets, values) in self.stream.metrics.items()
        }
        return flows, metrics


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
        readings = list(source.fetch(now - timedelta(seconds=poll_seconds), now + source.ahead))
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


def _when(value) -> datetime:
    """A reading's time: epoch seconds (or milliseconds), or ISO 8601; now if absent."""
    if value is None:
        return datetime.now(tz=UTC)
    if isinstance(value, bool):
        raise ValueError("a time is epoch seconds or ISO 8601, not true or false")
    if isinstance(value, int | float):
        seconds = value / 1000 if value > 1e11 else value
        return datetime.fromtimestamp(seconds, tz=UTC)
    if isinstance(value, str):
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return when if when.tzinfo else when.replace(tzinfo=UTC)
    raise ValueError(f"a time is epoch seconds or ISO 8601, not {value!r}")


def _readings(body) -> tuple[datetime, list[tuple[str, str, object]]]:
    """(when, [(metric, asset, value)]) from one push, in either shape:

    {"t": ..., "flows": {asset: v}, "metrics": {metric: {asset: v}}}
    [{"asset": id, "metric": "pressure_bar", "value": 152.1, "t": ...}, ...]
    """
    if isinstance(body, dict):
        when = _when(body.get("t"))
        flows, metrics = body.get("flows") or {}, body.get("metrics") or {}
        if not isinstance(flows, dict) or not isinstance(metrics, dict):
            raise ValueError('"flows" is {asset: value} and "metrics" is {metric: {asset: value}}')
        out = [("flow_msm3d", asset, value) for asset, value in flows.items()]
        for metric, values in metrics.items():
            if not isinstance(values, dict):
                raise ValueError(f'"metrics.{metric}" is {{asset: value}}')
            out += [(metric, asset, value) for asset, value in values.items()]
        return when, out
    if isinstance(body, list):
        if not all(isinstance(r, dict) for r in body):
            raise ValueError('a list of readings is [{"asset": ..., "metric": ..., "value": ...}]')
        times = [_when(r["t"]) for r in body if r.get("t") is not None]
        out = [(r.get("metric", "flow_msm3d"), r.get("asset"), r.get("value")) for r in body]
        return (max(times) if times else datetime.now(tz=UTC)), out
    raise ValueError("send a JSON object or a list of readings")


class Inbox:
    """Readings pushed to /ingest (`nora live --ingest`), for every browser on /stream.

    Any system can feed NORA this way without a connector: a historian's export job, a
    script, a message-queue bridge. A push may carry one reading or all of them; the
    inbox keeps the latest value of each, so every frame it sends is the whole picture.
    Readings for ids or metrics NORA does not know, and values that are not numbers, are
    turned away and listed in the reply, never stored.
    """

    def __init__(self, assets: set[str]):
        self.assets = assets
        self._changed = threading.Condition()
        self._seq, self._index = 0, -1
        self._when: datetime | None = None
        self._flows: dict[str, float] = {}
        self._metrics: dict[str, dict[str, float]] = {}

    def push(self, body) -> dict:
        when, readings = _readings(body)
        accepted, ignored = 0, []
        with self._changed:
            for metric, asset, value in readings:
                number = isinstance(value, int | float) and not isinstance(value, bool)
                why = (
                    "unknown metric"
                    if metric != "flow_msm3d" and metric not in METRICS
                    else "unknown asset"
                    if asset not in self.assets
                    else "not a number"
                    if value is not None and not (number and math.isfinite(value))
                    else None
                )
                if why:
                    ignored.append({"asset": asset, "metric": metric, "why": why})
                    continue
                flow = metric == "flow_msm3d"
                store = self._flows if flow else self._metrics.setdefault(metric, {})
                if value is None:
                    store.pop(asset, None)  # null clears a reading
                else:
                    store[asset] = float(value)
                accepted += 1
            if accepted:
                self._when, self._index, self._seq = when, self._index + 1, self._seq + 1
                self._changed.notify_all()
        return {"accepted": accepted, "ignored": ignored[:50]}

    def frames(self) -> Iterator[tuple[float, Callable[[], PolledItem | None]]]:
        """One reader's feed: what is known at once, then each push as it lands."""
        seen = 0

        def fresh() -> PolledItem | None:
            nonlocal seen
            with self._changed:
                self._changed.wait_for(lambda: self._seq > seen, timeout=KEEPALIVE_SECONDS)
                if self._seq == seen:
                    return None
                seen = self._seq
                metrics = {metric: dict(values) for metric, values in self._metrics.items()}
                return (self._when, dict(self._flows), metrics, self._index)

        while True:
            yield 0.0, fresh

    @staticmethod
    def meta() -> dict:
        return {
            "name": "ingest",
            "title": "Live data",
            "description": "Readings pushed to this server (POST /ingest), the latest of each.",
            "source": "POST /ingest",
            "synthetic": False,
        }


class _Handler(SimpleHTTPRequestHandler):
    meta: dict = {}
    plan: list | None = None
    ahead: Callable[[int], dict] | None = None  # nominations already sent for later hours
    frames: Callable[[], Iterator[PacedFrame]]
    keepalive: float = KEEPALIVE_SECONDS  # max silence between bytes on /stream
    inbox: Inbox | None = None  # `nora live --ingest`: readings pushed to /ingest
    token: str = ""  # the bearer token a push must carry (NORA_INGEST_TOKEN)

    def log_message(self, format, *args):  # noqa: A002 - keep the console quiet
        pass

    def do_POST(self):
        """Readings pushed as JSON (docs/live-data.md). JSON only, with the server's bearer
        token when it has one, at most INGEST_LIMIT bytes; nothing outside is trusted."""
        if urlsplit(self.path).path != "/ingest" or self.inbox is None:
            return self._reply(404, {"error": "not found: push to /ingest of `nora live --ingest`"})
        if self.token and not hmac.compare_digest(
            self.headers.get("Authorization", ""), f"Bearer {self.token}"
        ):
            need = "send the header Authorization: Bearer <NORA_INGEST_TOKEN>"
            return self._reply(401, {"error": need})
        if "application/json" not in self.headers.get("Content-Type", ""):
            return self._reply(415, {"error": "send Content-Type: application/json"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= INGEST_LIMIT:
            return self._reply(413, {"error": f"a push is 1 to {INGEST_LIMIT} bytes of JSON"})
        try:
            result = self.inbox.push(json.loads(self.rfile.read(length)))
        except (ValueError, KeyError) as error:
            return self._reply(400, {"error": str(error) or "not JSON"})
        return self._reply(202 if result["accepted"] else 422, result)

    def _reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlsplit(self.path).path != "/stream":
            return super().do_GET()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            if self.meta:  # `nora live --now` sends its own, re-timed, from the feed
                self._send("meta", self.meta)
            for wait, item in self.frames():
                self._pause(wait)
                if callable(item):  # a SharedPoll reader: the result after the wait
                    item = item()
                    if item is None:  # still fetching: keep the line warm
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        continue
                if isinstance(item, Meta):  # a new loop of `nora live --now`
                    self._send("meta", item)
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
    inbox: Inbox | None = None,
    token: str = "",
    now: bool = False,
) -> None:
    """Serve the site and a feed on /stream: replay a `stream`, or poll a live source.

    A poller (see `poll`) passes `meta` and `frames` instead of a `stream`, so
    `nora live --source gassco` serves real data without touching the browser side.
    `now` replays the stream re-timed to the wall clock, looping (NowReplay).
    """
    hidden = ("times", "values", "metrics", "plan")
    if now:
        assert stream is not None, "--now replays a stream"
        meta, frames = {}, NowReplay(stream, speed).frames  # one clock for every reader
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
            "inbox": inbox,
            "token": token,
        },
    )
    server = ThreadingHTTPServer((host, port), partial(handler, directory=str(site_dir)))
    server.daemon_threads = True
    url = f"http://{host}:{port}/network.html?live=/stream"
    if stream and now:
        pace = "real time" if speed == 1 else f"{speed:g}x real time"
        print(f"Replaying '{stream.title}' re-timed to now, at {pace}, looping")
    elif stream:
        print(f"Replaying '{stream.title}' at {speed:g}x as a live feed")
    else:
        print(f"Serving '{meta.get('title', 'live feed')}' as a live feed")
    print(f"  map:  {url}")
    print(f"  feed: http://{host}:{port}/stream  (Ctrl-C to stop)")
    if inbox is not None:
        auth = ' -H "Authorization: Bearer $NORA_INGEST_TOKEN"' if token else ""
        example = '{"metrics": {"pressure_bar": {"kollsnes": 152.1}}}'
        print(f"  push: curl -X POST http://{host}:{port}/ingest{auth} \\")
        print(f"          -H 'Content-Type: application/json' -d '{example}'")
        print("        (docs/live-data.md)")
    if open_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
