"""Time series ("streams") that NORA replays as if they were arriving live.

Each stream is a folder in data/streams/ holding a stream.toml. Its rows come from
one of three places, picked by what stream.toml contains:

  [import]     a raw file plus a column and asset mapping (real datasets); use
               [[import]] once per file to combine several, e.g. flows from SCADA,
               nominations from Origo and bookings from Gassco Booking
  [synthetic]  generated from the network model, with scripted events (demos)
  neither      flows.csv in NORA's format: timestamp,asset,flow_msm3d or
               timestamp,asset,metric,value

Metrics (METRICS below): flow_msm3d on a pipeline (negative = against its from -> to
direction) or a node (throughput); pressure_bar at a node; nomination_msm3d and
booked_msm3d at an exit point, held until the next value. `nora stream new` writes a
stream.toml for a raw file; see data/streams/README.md.

The internals live in nora/streams/ (model, importing, synthetic, pigs); this module
is the public API and re-exports what callers import from it.
"""

from __future__ import annotations

import csv
import math
import statistics
import tomllib
from dataclasses import replace
from datetime import datetime, timedelta
from pathlib import Path

from .data import DataError, Network, suggest
from .streams.importing import import_rows, read_flows, scaffold
from .streams.model import (
    FLOW_COLUMNS,
    HELD,
    METRIC_COLUMNS,
    METRICS,
    STREAM_ID,
    STREAMS_DIR,
    Event,
    Pig,
    Row,
    Stream,
    _check_stream_id,
    parse_time,
)
from .streams.pigs import (
    PIG_DRIFT_ALARM_S,
    PIG_DRIFT_S,
    PIG_GRACE_S,
    PIG_KINDS,
    PIG_NOTICE_S,
    PIG_RESPONSE_S,
    PIG_SLOWEST,
    _pig_problem,
    pig_alarm,
    pig_code,
    pig_eta,
    pig_messages,
    pig_speed,
    pig_tag,
)
from .streams.synthetic import (
    GC_LEAN,
    GC_RICH,
    PIG_LINES,
    QUALITY_BASE,
    _pig_programme,
    apply_events,
    start_of,
    synthesize,
)

__all__ = [
    "Event",
    "FLOW_COLUMNS",
    "GC_LEAN",
    "GC_RICH",
    "HELD",
    "METRICS",
    "METRIC_COLUMNS",
    "PIG_DRIFT_ALARM_S",
    "PIG_DRIFT_S",
    "PIG_GRACE_S",
    "PIG_KINDS",
    "PIG_LINES",
    "PIG_NOTICE_S",
    "PIG_RESPONSE_S",
    "PIG_SLOWEST",
    "Pig",
    "QUALITY_BASE",
    "Row",
    "STREAMS_DIR",
    "STREAM_ID",
    "Stream",
    "apply_events",
    "describe",
    "import_rows",
    "list_streams",
    "load_stream",
    "parse_time",
    "pig_alarm",
    "pig_code",
    "pig_eta",
    "pig_messages",
    "pig_speed",
    "pig_tag",
    "read_flows",
    "scaffold",
    "start_of",
    "synthesize",
    "write_flows",
]


def list_streams(streams_dir: Path = STREAMS_DIR) -> list[str]:
    if not Path(streams_dir).is_dir():
        return []
    return sorted(p.parent.name for p in Path(streams_dir).glob("*/stream.toml"))


def load_stream(name: str, net: Network, streams_dir: Path = STREAMS_DIR) -> Stream:
    """Read one stream folder and check every row against the network."""
    _check_stream_id(name)
    folder = Path(streams_dir) / name
    where = f"streams/{name}"
    meta_path = folder / "stream.toml"
    if not meta_path.exists():
        raise DataError([f"{where}: stream.toml not found"])
    try:
        meta = tomllib.loads(meta_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as error:
        raise DataError([f"{where}/stream.toml: {error}"]) from None
    problems: list[str] = []
    events = _events(meta, net, where, problems)
    pigs = _pigs(meta, net, where, problems)
    # `synthetic = true` labels made-up rows read from a file (a mock API's, say);
    # a [synthetic] table generates them from the model.
    if not isinstance(meta.get("synthetic", False), bool | dict):
        problems.append(f"{where}: synthetic must be true, false or a [synthetic] table")
    if "import" in meta:
        specs = meta["import"] if isinstance(meta["import"], list) else [meta["import"]]
        rows = [row for spec in specs for row in import_rows(folder, spec, where, problems)]
    elif isinstance(meta.get("synthetic"), dict):
        rows = synthesize(net, meta["synthetic"], events)
    else:
        rows = read_flows(folder / "flows.csv", problems)
    _check_rows(rows, net, where, problems)
    if problems:
        raise DataError(problems)
    return replace(_pivot(name, meta, events, rows), pigs=pigs)


def _events(meta: dict, net: Network, where: str, problems: list[str]) -> tuple[Event, ...]:
    events = []
    for i, spec in enumerate(meta.get("events", []), start=1):
        asset = spec.get("asset", "")
        if asset not in net.asset_ids:
            problems.append(
                f"{where}/stream.toml event {i}: unknown asset '{asset}'"
                + suggest(asset, net.asset_ids)
            )
            continue
        try:
            event = Event(
                label=spec.get("label", asset),
                asset=asset,
                start=parse_time(spec["start"]),
                end=parse_time(spec["end"]),
                capacity_factor=float(spec.get("capacity_factor", 0.0)),
                planned=bool(spec.get("planned", False)),
            )
        except (KeyError, ValueError) as error:
            problems.append(f"{where}/stream.toml event {i}: needs start and end times ({error})")
            continue
        if event.end <= event.start:
            problems.append(
                f"{where}/stream.toml event {i}: end must be after start "
                f"({event.start:%Y-%m-%d %H:%M} -> {event.end:%Y-%m-%d %H:%M})"
            )
        elif not 0.0 <= event.capacity_factor <= 1.0:
            problems.append(
                f"{where}/stream.toml event {i}: capacity_factor must be between 0 and 1, "
                f"got {event.capacity_factor}"
            )
        else:
            events.append(event)
    return tuple(events)


def _pigs(meta: dict, net: Network, where: str, problems: list[str]) -> tuple[Pig, ...]:
    pigs = []
    for i, spec in enumerate(meta.get("pigs", []), start=1):
        pipeline = spec.get("pipeline", "")
        if pipeline not in net.pipeline_by_id:
            problems.append(
                f"{where}/stream.toml pig {i}: unknown pipeline '{pipeline}'"
                + suggest(pipeline, list(net.pipeline_by_id))
            )
            continue
        try:
            pig = Pig(
                label=spec.get("label", f"Pig on {net.asset_name(pipeline)}"),
                pipeline=pipeline,
                launch=parse_time(spec["launch"]),
                speed_mps=float(spec.get("speed_mps", 4.0)),
                every_hours=float(spec.get("every_hours", 0.0)),
                ident=int(spec["id"]) if "id" in spec else None,
                tag=str(spec.get("tag", "")).strip(),
                kind=str(spec.get("kind", "cleaning")),
                receiver=spec.get("receiver"),
                notify_every_hours=float(spec.get("notify_every_hours", 6.0)),
            )
        except (KeyError, ValueError) as error:
            problems.append(f"{where}/stream.toml pig {i}: needs a launch time ({error})")
            continue
        if pig.ident is not None and not 1 <= pig.ident <= 99999:
            problems.append(f"{where}/stream.toml pig {i}: id must be a number of 1 to 5 digits")
        elif pig.speed_mps <= 0:
            problems.append(f"{where}/stream.toml pig {i}: speed_mps must be above 0")
        elif pig.every_hours < 0:
            problems.append(f"{where}/stream.toml pig {i}: every_hours must be 0 or more")
        elif _pig_problem(pig, net):
            problems.append(f"{where}/stream.toml pig {i}: {_pig_problem(pig, net)}")
        else:
            pigs.append(pig)
    pigs += _pig_programme(meta, net, {p.pipeline for p in pigs}, where, problems)
    # Every pig carries a tag: PIG-<line code>-<its number in this stream>, unless given.
    return tuple(
        pig if pig.tag else replace(pig, tag=pig_tag(pig.pipeline, n))
        for n, pig in enumerate(pigs, start=1)
    )


def _check_rows(rows: list[Row], net: Network, where: str, problems: list[str]) -> None:
    if not rows and not problems:
        problems.append(f"{where}: no rows; check the [import] mapping with `nora stream show`")
    known = set(net.asset_ids)
    unknown = sorted({asset for _, asset, _, _ in rows if asset not in known})
    for asset in unknown[:20]:
        problems.append(
            f"{where}: '{asset}' is not a node or pipeline id" + suggest(asset, net.asset_ids)
        )
    if any(not math.isfinite(value) for _, _, _, value in rows):
        problems.append(f"{where}: contains values that are not finite numbers")


def _matrix(times: list[datetime], rows: list[Row], hold: bool):
    assets = sorted({asset for _, asset, _, _ in rows})
    t_index = {when: i for i, when in enumerate(times)}
    a_index = {asset: i for i, asset in enumerate(assets)}
    values: list[list[float | None]] = [[None] * len(assets) for _ in times]
    for when, asset, _, value in rows:
        values[t_index[when]][a_index[asset]] = value
    if hold:  # a nomination or booking stays valid until the next one
        for j in range(len(assets)):
            last = None
            for row in values:
                row[j] = last = row[j] if row[j] is not None else last
    return tuple(assets), tuple(tuple(row) for row in values)


def _pivot(name: str, meta: dict, events: tuple[Event, ...], rows: list[Row]) -> Stream:
    times = sorted({when for when, _, _, _ in rows})
    by_metric: dict[str, list[Row]] = {}
    for row in rows:
        by_metric.setdefault(row[2], []).append(row)
    assets, values = _matrix(times, by_metric.pop("flow_msm3d", []), hold=False)
    metrics = {m: _matrix(times, r, hold=m in HELD) for m, r in sorted(by_metric.items())}
    return Stream(
        name=name,
        title=meta.get("title", name),
        description=meta.get("description", ""),
        source=meta.get("source", ""),
        license=meta.get("license", ""),
        synthetic="synthetic" in meta and meta["synthetic"] is not False,
        events=events,
        times=tuple(times),
        assets=assets,
        values=values,
        order=int(meta.get("order", 100)),
        metrics=metrics,
    )


def write_flows(stream: Stream, path: Path) -> None:
    """Write a stream in NORA's own flows.csv format (with a metric column when the
    stream has more than flows)."""
    with Path(path).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(METRIC_COLUMNS if stream.metrics else FLOW_COLUMNS)
        for _, when, flows, extra in stream.frames_full():
            stamp = when.strftime("%Y-%m-%dT%H:%M:%SZ")
            if not stream.metrics:
                writer.writerows((stamp, asset, value) for asset, value in flows.items())
                continue
            writer.writerows((stamp, asset, "flow_msm3d", value) for asset, value in flows.items())
            for metric, values in extra.items():
                writer.writerows((stamp, asset, metric, value) for asset, value in values.items())


def describe(stream: Stream, net: Network) -> str:
    """Human summary for `nora stream show`."""
    lines = [f"{stream.title}  ({'synthetic' if stream.synthetic else 'real data'})"]
    if stream.times:
        span = stream.times[-1] - stream.times[0]
        step = stream.times[1] - stream.times[0] if len(stream.times) > 1 else timedelta(0)
        lines.append(
            f"{len(stream.times)} time steps every {step}, {stream.times[0]:%Y-%m-%d %H:%M} "
            f"to {stream.times[-1]:%Y-%m-%d %H:%M} UTC ({span})"
        )
    lines.append(f"{len(stream.assets)} assets:")
    for i, asset in enumerate(stream.assets):
        series = [row[i] for row in stream.values if row[i] is not None]
        mean = statistics.fmean(series) if series else 0.0
        lines.append(
            f"  {asset:<24} {net.asset_name(asset):<34} mean {mean:8.2f} MSm3/d  "
            f"({len(series)} readings)"
        )
    for metric, (assets, _) in stream.metrics.items():
        lines.append(
            f"{METRICS[metric]}: {len(assets)} assets ({', '.join(assets[:6])}"
            + (", ..." if len(assets) > 6 else "")
            + ")"
        )
    for pig in stream.pigs:
        to = f" to {net.asset_name(pig.receiver)}" if pig.receiver else ""
        lines.append(
            f"pig: {pig.tag} {pig.kind}, {pig.label} ({pig.pipeline}){to} launched "
            f"{pig.launch:%a %H:%M}, {pig.speed_mps} m/s, ETA update every "
            f"{pig.notify_every_hours:g} h"
        )
    for event in stream.events:
        lines.append(
            f"event: {event.label} ({event.asset}) {event.start:%a %H:%M} to {event.end:%a %H:%M}"
        )
    return "\n".join(lines)
