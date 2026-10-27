"""Time series ("streams") that NORA replays as if they were arriving live.

Each stream is a folder in data/streams/ holding a stream.toml. Its rows come from
one of three places, picked by what stream.toml contains:

  [import]     a raw file plus a column and asset mapping (real datasets)
  [synthetic]  generated from the network model, with scripted events (demos)
  neither      flows.csv already in NORA's format: timestamp,asset,flow_msm3d

`asset` is a pipeline id (flow along it in MSm3/d; negative means against its
from -> to direction) or a node id (throughput at that node). `nora stream new`
writes a stream.toml for a raw file; see data/streams/README.md.
"""

from __future__ import annotations

import csv
import json
import math
import random
import re
import shutil
import statistics
import tomllib
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import networkx as nx

from .analysis import routed_flow
from .data import DATA_DIR, SUPPLY_TYPES, DataError, Network, read_rows, suggest
from .graph import build_graph

STREAMS_DIR = DATA_DIR / "streams"
FLOW_COLUMNS = ("timestamp", "asset", "flow_msm3d")
STREAM_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
Row = tuple[datetime, str, float]


def _check_stream_id(name: str) -> None:
    """Stream names become folder names: keep them inside data/streams."""
    if not STREAM_ID.fullmatch(name):
        raise DataError(
            [f"stream name '{name}' must match {STREAM_ID.pattern} (a folder name)"]
        )


@dataclass(frozen=True)
class Event:
    """Something that happens during a stream. Synthetic streams apply it to the model
    (capacity_factor 0 = asset offline); for real data it only marks the timeline."""

    label: str
    asset: str
    start: datetime
    end: datetime
    capacity_factor: float = 0.0

    def active(self, when: datetime) -> bool:
        return self.start <= when < self.end


@dataclass(frozen=True)
class Stream:
    name: str
    title: str
    description: str
    source: str
    license: str
    synthetic: bool
    events: tuple[Event, ...]
    times: tuple[datetime, ...]
    assets: tuple[str, ...]
    values: tuple[tuple[float | None, ...], ...]  # values[time][asset]; None = no reading
    order: int = 100  # lower plays first on the site; set with `order =` in stream.toml

    def frames(self) -> Iterator[tuple[datetime, dict[str, float]]]:
        for when, row in zip(self.times, self.values, strict=True):
            yield when, {a: v for a, v in zip(self.assets, row, strict=True) if v is not None}

    def payload(self) -> dict:
        """Compact JSON for the browser: epoch-second times and a value matrix."""
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "source": self.source,
            "license": self.license,
            "synthetic": self.synthetic,
            "events": [
                {
                    "label": e.label,
                    "asset": e.asset,
                    "start": int(e.start.timestamp()),
                    "end": int(e.end.timestamp()),
                }
                for e in self.events
            ],
            "times": [int(t.timestamp()) for t in self.times],
            "assets": list(self.assets),
            "values": [[None if v is None else round(v, 2) for v in row] for row in self.values],
        }


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
    if "import" in meta:
        rows = import_rows(folder, meta["import"], where, problems)
    elif "synthetic" in meta:
        rows = synthesize(net, meta["synthetic"], events)
    else:
        rows = read_flows(folder / "flows.csv", problems)
    _check_rows(rows, net, where, problems)
    if problems:
        raise DataError(problems)
    return _pivot(name, meta, events, rows)


def parse_time(value: str | datetime, tz: ZoneInfo | None = None, fmt: str | None = None):
    """ISO 8601 (or `fmt` for strptime) to an aware UTC datetime; naive times use `tz`."""
    if isinstance(value, datetime):
        when = value
    elif fmt:
        when = datetime.strptime(value.strip(), fmt)
    else:
        when = datetime.fromisoformat(value.strip())
    if when.tzinfo is None:
        when = when.replace(tzinfo=tz or UTC)
    return when.astimezone(UTC)


def read_flows(path: Path, problems: list[str]) -> list[Row]:
    rows = []
    for row in read_rows(path, FLOW_COLUMNS, problems):
        try:
            when = parse_time(row.text("timestamp", required=True))
        except ValueError:
            row.problem(f"'timestamp' must be ISO 8601, got '{row.text('timestamp')}'")
            continue
        flow = row.number("flow_msm3d", required=True)
        if flow is not None:
            rows.append((when, row.text("asset", required=True), flow))
    return rows


def import_rows(folder: Path, spec: dict, where: str, problems: list[str]) -> list[Row]:
    """Turn a raw file into rows using the [import] mapping from stream.toml.

    layout = "long": one reading per line, with `asset` and `value` columns.
    layout = "wide": one line per time, one column per point.
    [import.assets] maps raw point names (long) or column names (wide) to NORA ids;
    points mapped to "" are skipped, and a leading "-" ("-baltic_pipe_east") flips
    the sign for sources that report outflows as negative. Readings that map to the
    same asset and time are summed, and every value is multiplied by `factor` to get
    MSm3/d.
    """
    path = folder / spec.get("file", "raw.csv")
    if path.resolve().parent != Path(folder).resolve():
        problems.append(
            f"{where}: raw file must stay inside the stream folder, got {spec.get('file')!r}"
        )
        return []
    if not path.exists():
        problems.append(f"{where}: raw file {path.name} not found")
        return []
    layout = spec.get("layout", "long")
    if layout not in ("long", "wide"):
        problems.append(f'{where}: [import] layout must be "long" or "wide", got \'{layout}\'')
        return []
    mapping: dict[str, str] = spec.get("assets", {})
    factor = float(spec.get("factor", 1.0))
    tz = ZoneInfo(spec.get("timezone", "UTC"))
    time_column = spec.get("timestamp", "timestamp")
    where_filter: dict[str, str] = {k: str(v) for k, v in spec.get("where", {}).items()}
    totals: dict[tuple[datetime, str], float] = {}
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=spec.get("delimiter", ","))
        needed = [time_column, *where_filter]
        needed += (
            [spec.get("asset", "asset"), spec.get("value", "value")] if layout == "long" else []
        )
        missing = [c for c in needed if c not in (reader.fieldnames or ())]
        if missing:
            columns = ", ".join(reader.fieldnames or ())
            problems.append(f"{where}: {path.name} has no column(s) {missing}; it has: {columns}")
            return []
        for record in reader:
            # raw files are messier than NORA's own CSVs: strip before filtering
            record = {k: (v or "").strip() for k, v in record.items()}
            if any(record.get(column, "") != value for column, value in where_filter.items()):
                continue
            line = f"{where}/{path.name} line {reader.line_num}"
            try:
                when = parse_time(record[time_column], tz, spec.get("time_format"))
            except ValueError:
                problems.append(f"{line}: cannot read time '{record[time_column]}'")
                continue
            if layout == "long":
                point = record[spec.get("asset", "asset")]
                value_column = spec.get("value", "value")
                pairs = [(mapping.get(point, point) if mapping else point, record[value_column])]
            else:
                pairs = [(asset, record.get(column, "")) for column, asset in mapping.items()]
            for asset, raw in pairs:
                if not asset or raw in ("", None):
                    continue
                sign = -1.0 if asset.startswith("-") else 1.0
                asset = asset.removeprefix("-")
                try:
                    value = sign * float(raw) * factor
                except ValueError:
                    problems.append(f"{line}: '{raw}' is not a number")
                    continue
                totals[(when, asset)] = totals.get((when, asset), 0.0) + value
    return [(when, asset, value) for (when, asset), value in sorted(totals.items())]


def synthesize(net: Network, spec: dict, events: tuple[Event, ...] = ()) -> list[Row]:
    """Generate plausible flows from the network model.

    Field output follows a daily demand shape plus slow random drift per field, LNG
    send-out stays flatter, and each event scales an asset's capacity while it is
    active. Every step is routed with routed_flow, so the flows always balance. The
    same spec and seed always give the same rows.
    """
    start = parse_time(spec.get("start", "2026-01-05T00:00:00Z"))
    step = timedelta(minutes=int(spec.get("step_minutes", 60)))
    rng = random.Random(spec.get("seed", 1))
    base = build_graph(net)
    pipes = sorted({attrs["pipeline"] for _, _, attrs in base.edges(data=True)})
    suppliers = sorted(n for n, attrs in base.nodes(data=True) if attrs["type"] in SUPPLY_TYPES)
    drift = dict.fromkeys(suppliers, 0.0)
    rows: list[Row] = []
    for k in range(int(spec.get("steps", 168))):
        when = start + k * step
        graph = _apply_events(base, events, when)
        supply = {}
        for node in suppliers:
            drift[node] = 0.9 * drift[node] + rng.gauss(0, 0.012)
            if node in graph:
                capacity = graph.nodes[node]["capacity_msm3d"] or 0.0
                supply[node] = capacity * _load(when, graph.nodes[node]["type"], drift[node])
        flow = routed_flow(graph, supply)
        rows += [(when, pipe, round(flow.pipelines.get(pipe, 0.0), 3)) for pipe in pipes]
    return rows


def _load(when: datetime, kind: str, drift: float) -> float:
    """Share of capacity in use: a morning and evening peak, quieter weekends."""
    hour = when.hour + when.minute / 60
    daily = 0.05 * math.cos(2 * math.pi * (hour - 18) / 24)
    daily += 0.02 * math.cos(2 * math.pi * (hour - 8) / 12)
    weekend = -0.05 if when.weekday() >= 5 else 0.0
    level = 0.55 + daily / 2 if kind == "lng" else 0.84 + daily
    return min(1.0, max(0.05, level + weekend + drift))


def _apply_events(base: nx.DiGraph, events: tuple[Event, ...], when: datetime) -> nx.DiGraph:
    active = [e for e in events if e.active(when)]
    if not active:
        return base
    graph = base.copy()
    for event in active:
        factor = event.capacity_factor
        if event.asset in graph:
            attrs = graph.nodes[event.asset]
            if attrs["type"] in SUPPLY_TYPES:
                attrs["capacity_msm3d"] = (attrs["capacity_msm3d"] or 0.0) * factor
            elif factor == 0:
                graph.remove_node(event.asset)
            else:
                for _, _, edge in graph.out_edges(event.asset, data=True):
                    if "capacity" in edge:
                        edge["capacity"] *= factor
            continue
        edges = [(u, v) for u, v, a in graph.edges(data=True) if a["pipeline"] == event.asset]
        if factor == 0:
            graph.remove_edges_from(edges)
        for u, v in edges if factor else ():
            if "capacity" in graph.edges[u, v]:
                graph.edges[u, v]["capacity"] *= factor
    return graph


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


def _check_rows(rows: list[Row], net: Network, where: str, problems: list[str]) -> None:
    if not rows and not problems:
        problems.append(f"{where}: no rows; check the [import] mapping with `nora stream show`")
    known = set(net.asset_ids)
    unknown = sorted({asset for _, asset, _ in rows if asset not in known})
    for asset in unknown[:20]:
        problems.append(
            f"{where}: '{asset}' is not a node or pipeline id" + suggest(asset, net.asset_ids)
        )
    if any(not math.isfinite(value) for _, _, value in rows):
        problems.append(f"{where}: contains values that are not finite numbers")


def _pivot(name: str, meta: dict, events: tuple[Event, ...], rows: list[Row]) -> Stream:
    times = sorted({when for when, _, _ in rows})
    assets = sorted({asset for _, asset, _ in rows})
    t_index = {when: i for i, when in enumerate(times)}
    a_index = {asset: i for i, asset in enumerate(assets)}
    values: list[list[float | None]] = [[None] * len(assets) for _ in times]
    for when, asset, value in rows:
        values[t_index[when]][a_index[asset]] = value
    return Stream(
        name=name,
        title=meta.get("title", name),
        description=meta.get("description", ""),
        source=meta.get("source", ""),
        license=meta.get("license", ""),
        synthetic="synthetic" in meta,
        events=events,
        times=tuple(times),
        assets=tuple(assets),
        values=tuple(tuple(row) for row in values),
        order=int(meta.get("order", 100)),
    )


def write_flows(stream: Stream, path: Path) -> None:
    """Write a stream in NORA's own flows.csv format."""
    with Path(path).open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(FLOW_COLUMNS)
        for when, values in stream.frames():
            stamp = when.strftime("%Y-%m-%dT%H:%M:%SZ")
            writer.writerows((stamp, asset, value) for asset, value in values.items())


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
    for event in stream.events:
        lines.append(
            f"event: {event.label} ({event.asset}) {event.start:%a %H:%M} to {event.end:%a %H:%M}"
        )
    return "\n".join(lines)


def scaffold(name: str, raw: Path, net: Network, streams_dir: Path = STREAMS_DIR) -> Path:
    """Start a new stream from a raw CSV: copy it in and draft stream.toml.

    Guesses the time column, whether the file is long or wide, and which NORA asset
    each point is, by name. Every guess is written out for a person to check.
    """
    _check_stream_id(name)
    folder = Path(streams_dir) / name
    if folder.exists():
        raise DataError([f"streams/{name} already exists"])
    with Path(raw).open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        columns = list(reader.fieldnames or [])
        sample = [record for _, record in zip(range(2000), reader, strict=False)]
    if not columns:
        raise DataError([f"{raw}: no header row"])

    def numeric(column: str) -> bool:
        values = [r[column] for r in sample if r.get(column)]
        try:
            return bool(values) and all(math.isfinite(float(v)) for v in values[:50])
        except ValueError:
            return False

    time_column = next(
        (c for c in columns if any(k in c.lower() for k in ("time", "date", "period", "gasday"))),
        columns[0],
    )
    numbers = [c for c in columns if c != time_column and numeric(c)]
    labels = [c for c in columns if c != time_column and not numeric(c)]
    wide = len(numbers) > 2 or not labels
    if wide:
        points, asset_column, value_column = numbers, None, None
    else:
        asset_column = max(labels, key=lambda c: len({r[c] for r in sample}))
        value_column = numbers[0] if numbers else "value"
        points = sorted({r[asset_column] for r in sample})[:200]

    names = {}
    for node in net.nodes:
        names[node.name.lower()] = node.id
        names[node.id] = node.id
    for pipe in net.pipelines:
        names[pipe.name.lower()] = pipe.id
        names[pipe.id] = pipe.id

    def guess(point: str) -> str:
        key = point.lower()
        if key in names:
            return names[key]
        for label, asset in names.items():
            if len(label) > 3 and label in key:
                return asset
        match = suggest(key, names).split("'")
        return names[match[1]] if len(match) > 1 else ""

    def q(text: str) -> str:
        return json.dumps(text, ensure_ascii=False)

    lines = [
        f"title = {q(name.replace('-', ' ').capitalize())}",
        'description = ""',
        'source = ""   # where the raw file came from (URL)',
        'license = ""',
        "",
        "[import]",
        f"file = {q(raw.name)}",
        f'layout = "{"wide" if wide else "long"}"',
        f"timestamp = {q(time_column)}",
    ]
    if not wide:
        lines += [f"asset = {q(asset_column)}", f"value = {q(value_column)}"]
    lines += [
        "factor = 1.0        # multiply raw values by this to get MSm3/d",
        'timezone = "UTC"    # for timestamps without an offset, e.g. "Europe/Oslo"',
        "",
        "# Raw point -> NORA node or pipeline id (see data/nodes.csv and data/pipelines.csv).",
        '# Guesses are filled in by name; points mapped to "" are skipped.',
        "[import.assets]",
    ]
    lines += [f"{q(point)} = {q(guess(point))}" for point in points]
    folder.mkdir(parents=True)
    shutil.copyfile(raw, folder / raw.name)
    toml_path = folder / "stream.toml"
    toml_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return toml_path
