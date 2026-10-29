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
integrations.py and entsog.py) can replace `replay` without touching the browser
side. Long gaps
between frames are filled with SSE `: keepalive` comments (about one every 15 s), so
browsers and proxies don't reap an idle connection.
"""

from __future__ import annotations

import json
import time
import webbrowser
from collections.abc import Callable, Iterator
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlsplit

from .stream import Stream


class Frame(NamedTuple):
    """One time step of a feed. `stale` (live sources) marks a repeated frame
    served while the API behind it is down; the browser shows the age anyway."""

    when: datetime
    values: dict[str, float]
    metrics: dict[str, dict[str, float]]
    index: int
    stale: bool = False


PacedFrame = tuple[float, Frame]  # wall-seconds to wait, then the frame itself

KEEPALIVE_SECONDS = 15.0  # max silence before an SSE comment keeps the line warm


def replay(stream: Stream, speed: float = 3600.0, loop: bool = True) -> Iterator[PacedFrame]:
    """Yield (wait, frame) pairs: `wait` is the wall-seconds to pause before the frame.

    speed is data-seconds per wall-second: 3600 plays one hour of data per second.
    The generator never sleeps (except for an empty stream, below), so the live
    server can cut each wait into keepalive-sized chunks and write an SSE comment
    between them; see _Handler._pause.
    """
    while True:
        previous = None
        steps = 0
        for index, when, flows, metrics in stream.frames_full():
            wait = 0.0 if previous is None else max(0.0, (when - previous).total_seconds() / speed)
            previous = when
            steps += 1
            yield wait, Frame(when, flows, metrics, index)
        if not loop:
            return
        if not steps:
            # An empty stream would otherwise spin at 100% CPU until the
            # client disconnects; nap instead and try again.
            time.sleep(1.0)


def nominations_ahead(stream: Stream, index: int, hours: float = 2.0) -> dict:
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
            for wait, frame in self.frames():
                self._pause(wait)
                event = {
                    "t": int(frame.when.timestamp()),
                    "values": frame.values,
                    "metrics": frame.metrics,
                }
                if self.plan:
                    event["plan"] = self.plan[frame.index]
                if self.ahead:
                    event["ahead"] = self.ahead(frame.index)
                if frame.stale:
                    event["stale"] = True
                self._send("frame", event)
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
        self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
        self.wfile.flush()


def serve(
    site_dir: Path,
    stream: Stream,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    speed: float = 3600.0,
    keepalive: float = KEEPALIVE_SECONDS,
    open_browser: bool = True,
    plan: list | None = None,
    frames: Callable[[], Iterator[PacedFrame]] | None = None,
) -> None:
    """Serve the site and `stream` as a live feed. Without `frames` the stream is
    replayed at `speed`; pass another generator (e.g. entsog.poll_entsog) to serve
    a live source instead, the way `replay` serves a recording."""
    hidden = ("times", "values", "metrics", "plan")
    meta = {k: v for k, v in stream.payload().items() if k not in hidden}
    feed = frames or partial(replay, stream, speed)
    handler = type(
        "StreamHandler",
        (_Handler,),
        {
            "meta": meta,
            "plan": plan,
            "ahead": staticmethod(partial(nominations_ahead, stream)),
            "frames": staticmethod(feed),
            "keepalive": keepalive,
        },
    )
    server = ThreadingHTTPServer((host, port), partial(handler, directory=str(site_dir)))
    server.daemon_threads = True
    url = f"http://{host}:{port}/network.html?live=/stream"
    how = "as a live feed" if frames else f"at {speed:g}x as a live feed"
    print(f"{'Serving' if frames else 'Replaying'} '{stream.title}' {how}")
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
