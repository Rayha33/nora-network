"""Poll the ENTSOG Transparency Platform and serve it as a live feed.

    nora live --source entsog

The generator polls the platform's `operationaldatas` endpoint for physical flows
at the points where Norwegian gas lands, on the entry side of the receiving
operators (Gassco publishes nothing for its own side; see scripts/fetch_entsog.py).
The [import.assets] mapping in a stream's stream.toml turns ENTSOG point labels
into NORA asset ids, so the same mapping that imports recorded data also drives
the live feed, and the browser side needs no change.

Decisions (issue #3):
  * interval: 15 minutes. ENTSOG publishes hourly, so polling more often only
    asks the same question again; 15 minutes lands a new hour of data soon
    after it appears without loading the platform.
  * caching: the last good frame is written to a JSON file (default under
    ~/.cache/nora), so a restart serves something immediately while the first
    poll is still in flight.
  * API down (timeouts, 5xx, "No result found"): keep the last frame and repeat
    it with `stale = true` on the frame; the browser sees the age in its clock.
"""

from __future__ import annotations

import json
import os
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .live import Frame, PacedFrame
from .stream import parse_time

URL = "https://transparency.entsog.eu/api/v1/operationaldatas"
POLL_SECONDS = 15 * 60  # default seconds between polls; override with --interval
WINDOW = timedelta(days=1)  # how far back to ask, so a late poll still finds data

# Point directions known to work today (the script in scripts/fetch_entsog.py
# polls more landings, but only Dunkerque and Zeebrugge ZPT return data; see
# issue #2). Keyed by the pointLabel ENTSOG returns, which is also the key of
# the [import.assets] mapping in stream.toml.
POINT_DIRECTIONS = {
    "Dunkerque": "FR-TSO-0003ITP-00045entry",  # Franpipe
    "Zeebrugge ZPT": "BE-TSO-0001ITP-00106entry",  # Zeepipe I
}

# fetch: point direction + time window -> raw ENTSOG rows. Module-level so tests
# (and one day a faster mirror) can monkeypatch the whole HTTP layer at once.
Fetch = Callable[[str, datetime, datetime], "list[dict]"]


def read_mapping(stream_toml: Path) -> tuple[dict[str, str], float]:
    """The [import] block of a stream.toml: {ENTSOG point label: NORA asset id},
    and the factor that turns ENTSOG's kWh/h into MSm3/d."""
    meta = tomllib.loads(Path(stream_toml).read_text(encoding="utf-8"))
    spec = meta.get("import", {})
    if not isinstance(spec, dict) or not spec.get("assets"):
        raise ValueError(f"{stream_toml}: no [import.assets] mapping to serve from")
    mapping = {str(point): str(asset) for point, asset in spec["assets"].items()}
    return mapping, float(spec.get("factor", 1.0))


def default_cache(stream_name: str) -> Path:
    """Where the last good frame is cached, outside the repository's data."""
    base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "nora" / f"entsog-{stream_name}.json"


def fetch_rows(point: str, start: datetime, end: datetime) -> list[dict]:
    """One point, one window: the platform asks for one point per query."""
    query = urllib.parse.urlencode(
        {
            "pointDirection": point,
            "indicator": "Physical Flow",
            "periodType": "hour",
            "timezone": "UCT",
            "from": start.strftime("%Y-%m-%d"),
            "to": end.strftime("%Y-%m-%d"),
            "limit": -1,
        },
        quote_via=urllib.parse.quote,  # ENTSOG wants %20, not +, in "Physical Flow"
    )
    try:
        with urllib.request.urlopen(f"{URL}?{query}", timeout=120) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:  # ENTSOG's "No result found"
            return []
        raise
    # the platform's key changed: older docs say operationalData, the current
    # API returns the lowercase plural. `get`'s default (not `or`) keeps a
    # legitimate empty result from looking like a missing key.
    rows = data.get("operationaldatas", data.get("operationalData"))
    if rows is None:
        raise KeyError(f"unexpected response keys: {list(data)}")
    return rows


def _poll(
    mapping: dict[str, str],
    factor: float,
    fetch: Fetch,
    now: datetime,
) -> tuple[datetime, dict[str, float]] | None:
    """Ask every mapped point for its latest hourly flow, or None if the poll
    failed anywhere (an error, or no readings at all): then the caller repeats
    the last frame, stale, rather than showing half a picture."""
    values: dict[str, float] = {}
    latest: datetime | None = None
    for label, asset in mapping.items():
        point = POINT_DIRECTIONS.get(label)
        if point is None:
            continue  # a point stream.toml maps that we cannot poll (yet)
        try:
            rows = fetch(point, now - WINDOW, now)
        except (OSError, KeyError, ValueError):  # down, slow, or malformed
            return None
        for row in rows:
            if row.get("pointLabel") != label:
                continue
            when = parse_time(row["periodFrom"])
            if latest is None or when > latest:
                latest = when
            values[asset] = values.get(asset, 0.0) + float(row["value"]) * factor
    if not values or latest is None:
        return None
    return latest, {asset: round(value, 2) for asset, value in values.items()}


def _read_cache(cache: Path | None) -> Frame | None:
    if cache is None or not cache.exists():
        return None
    try:
        saved = json.loads(cache.read_text(encoding="utf-8"))
        return Frame(parse_time(saved["when"]), saved["values"], {}, 0, stale=True)
    except (OSError, ValueError, KeyError):  # a corrupt cache is not worth stopping for
        return None


def _write_cache(cache: Path | None, when: datetime, values: dict[str, float]) -> None:
    if cache is None:
        return
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"when": when.isoformat(), "values": values}), encoding="utf-8")
    except OSError:  # a read-only cache dir is not worth stopping the feed for
        pass


def poll_entsog(
    mapping: dict[str, str],
    factor: float = 1.0,
    *,
    interval: float = POLL_SECONDS,
    cache: Path | None = None,
    fetch: Fetch | None = None,  # None -> the module's fetch_rows, picked up at
    # call time so tests (and mirrors) can monkeypatch the HTTP layer.
    clock: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> Iterator[PacedFrame]:
    """Yield (wait, frame) pairs the way live.replay does, but from the live API.

    One frame per `interval` seconds. While the API is down the last good frame
    is repeated with `stale = true`; the last good frame is also cached to disk
    and served (stale) immediately on a fresh start.
    """
    fetch = fetch or fetch_rows
    last = _read_cache(cache)
    index = 0
    first = True
    while True:
        fresh = _poll(mapping, factor, fetch, clock())
        wait = 0.0 if first else interval
        first = False
        if fresh is not None:
            when, values = fresh
            last = Frame(when, values, {}, index, stale=False)
            index += 1
            _write_cache(cache, when, values)
            yield wait, last
            continue
        if last is None:
            last = Frame(clock(), {}, {}, index, stale=True)
        yield wait, last._replace(stale=True)  # keep the last frame, marked stale
