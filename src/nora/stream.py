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
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import networkx as nx

from .analysis import routed_flow
from .data import DATA_DIR, SUPPLY_TYPES, DataError, Network, read_rows, suggest
from .graph import build_graph

STREAMS_DIR = DATA_DIR / "streams"
FLOW_COLUMNS = ("timestamp", "asset", "flow_msm3d")
METRIC_COLUMNS = ("timestamp", "asset", "metric", "value")
STREAM_ID = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
METRICS = {
    "flow_msm3d": "Flow (MSm3/d)",
    "pressure_bar": "Pressure (bar)",
    "nomination_msm3d": "Hourly nomination (MSm3/d)",
    "booked_msm3d": "Booked capacity (MSm3/d)",
    "h2s_ppm": "H2S (ppm)",
    "co2_molpct": "CO2 (mol %)",
}
# Typical gas quality at a field: each field gets a steady level in this range.
QUALITY_BASE = {"h2s_ppm": (0.2, 1.2), "co2_molpct": (0.5, 1.5)}
HELD = ("nomination_msm3d", "booked_msm3d")  # valid until the next value arrives
Row = tuple[datetime, str, str, float]  # time, asset, metric, value


def _check_stream_id(name: str) -> None:
    """Stream names become folder names: keep them inside data/streams."""
    if not STREAM_ID.fullmatch(name):
        raise DataError([f"stream name '{name}' must match {STREAM_ID.pattern} (a folder name)"])


@dataclass(frozen=True)
class Event:
    """Something that happens during a stream. Synthetic streams apply it to the model
    (capacity_factor 0 = asset offline); for real data it only marks the timeline."""

    label: str
    asset: str
    start: datetime
    end: datetime
    capacity_factor: float = 0.0
    planned: bool = False  # planned work is known in advance; a trip is not

    def active(self, when: datetime) -> bool:
        return self.start <= when < self.end


@dataclass(frozen=True)
class Pig:
    """A pig run: launched into a pipeline, travelling with the gas at about `speed_mps`,
    and launched again every `every_hours` when that is set (a pigging programme)."""

    label: str
    pipeline: str
    launch: datetime
    speed_mps: float
    every_hours: float = 0.0


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
    values: tuple[tuple[float | None, ...], ...]  # flows: values[time][asset]; None = no reading
    order: int = 100  # lower plays first on the site; set with `order =` in stream.toml
    # Other metrics, aligned to `times`: {metric: (assets, values[time][asset])}
    metrics: dict = field(default_factory=dict)
    pigs: tuple[Pig, ...] = ()

    def frames(self) -> Iterator[tuple[datetime, dict[str, float]]]:
        for when, row in zip(self.times, self.values, strict=True):
            yield when, {a: v for a, v in zip(self.assets, row, strict=True) if v is not None}

    def frames_full(self) -> Iterator[tuple[int, datetime, dict, dict]]:
        """(index, time, flows, {metric: {asset: value}}) for every time step."""
        for i, (when, flows) in enumerate(self.frames()):
            # Row i of each metric's matrix (transposing it per step cost O(steps²)).
            extra = {
                metric: {a: v for a, v in zip(assets, values[i], strict=True) if v is not None}
                for metric, (assets, values) in self.metrics.items()
            }
            yield i, when, flows, extra

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
                    "planned": e.planned,
                }
                for e in self.events
            ],
            "pigs": [
                {
                    "label": pig.label,
                    "pipeline": pig.pipeline,
                    "launch": int(pig.launch.timestamp()),
                    "speed": pig.speed_mps,
                    "every": round(pig.every_hours * 3600),
                }
                for pig in self.pigs
            ],
            "times": [int(t.timestamp()) for t in self.times],
            "assets": list(self.assets),
            "values": [[None if v is None else round(v, 2) for v in row] for row in self.values],
            "metrics": {
                metric: {
                    "assets": list(assets),
                    "values": [[None if v is None else round(v, 2) for v in row] for row in values],
                }
                for metric, (assets, values) in self.metrics.items()
            },
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
    pigs = _pigs(meta, net, where, problems)
    if "import" in meta:
        specs = meta["import"] if isinstance(meta["import"], list) else [meta["import"]]
        rows = [row for spec in specs for row in import_rows(folder, spec, where, problems)]
    elif "synthetic" in meta:
        rows = synthesize(net, meta["synthetic"], events)
    else:
        rows = read_flows(folder / "flows.csv", problems)
    _check_rows(rows, net, where, problems)
    if problems:
        raise DataError(problems)
    return replace(_pivot(name, meta, events, rows), pigs=pigs)


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
    """NORA's own format: timestamp,asset,flow_msm3d or timestamp,asset,metric,value.

    One row per timestamp+asset+metric: duplicate rows are reported as a problem
    (unlike [import] mappings, which sum repeated readings on purpose).
    """
    header = ""
    if path.exists():
        with path.open(encoding="utf-8-sig") as handle:
            header = handle.readline()
    long = "metric" in [c.strip() for c in header.split(",")]
    rows = []
    seen: dict[tuple[datetime, str, str], str] = {}  # (time, asset, metric) -> first line
    for row in read_rows(path, METRIC_COLUMNS if long else FLOW_COLUMNS, problems):
        try:
            when = parse_time(row.text("timestamp", required=True))
        except ValueError:
            row.problem(f"'timestamp' must be ISO 8601, got '{row.text('timestamp')}'")
            continue
        metric = row.choice("metric", METRICS) if long else "flow_msm3d"
        value = row.number("value" if long else "flow_msm3d", required=True)
        asset = row.text("asset", required=True)
        if value is None or not asset or metric not in METRICS:
            continue
        key = (when, asset, metric)
        if key in seen:  # one reading per timestamp+asset: duplicates are an error, not summed
            row.problem(
                f"duplicate reading for '{asset}' at {when:%Y-%m-%d %H:%M} UTC"
                f" (first on {seen[key]}); flows.csv keeps one row per timestamp and"
                " asset - sum repeated readings in an [import] mapping instead"
            )
            continue
        seen[key] = row.where
        rows.append((when, asset, metric, value))
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
    metric = spec.get("metric", "flow_msm3d")
    if metric not in METRICS:
        problems.append(
            f"{where}: [import] metric must be one of {', '.join(METRICS)}"
            + suggest(metric, METRICS)
        )
        return []
    layout = spec.get("layout", "long")
    if layout not in ("long", "wide"):
        problems.append(f'{where}: [import] layout must be "long" or "wide", got \'{layout}\'')
        return []
    mapping: dict[str, str] = spec.get("assets", {})
    factor_text = spec.get("factor", 1.0)
    try:
        factor = float(factor_text)
    except (TypeError, ValueError):
        problems.append(
            f"{where}: [import] factor must be a number"
            + suggest(str(factor_text), [str(f) for f in (0.001, 0.01, 0.1, 1.0, 10.0)])
        )
        return []
    tz_text = spec.get("timezone", "UTC")
    try:
        tz = ZoneInfo(str(tz_text))
    except Exception:  # ZoneInfoNotFoundError is not always importable as a name
        common = ["UTC", "Europe/Oslo", "Europe/London", "Europe/Berlin", "America/New_York"]
        problems.append(
            f"{where}: [import] timezone must be a valid IANA zone" + suggest(str(tz_text), common)
        )
        return []
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
    return [(when, asset, metric, value) for (when, asset), value in sorted(totals.items())]


def synthesize(
    net: Network,
    spec: dict,
    events: tuple[Event, ...] = (),
    pressure_windows: dict | None = None,
) -> list[Row]:
    """Generate plausible operating data from the network model.

    Field output follows a daily demand shape plus slow random drift per field, LNG
    send-out stays flatter, and each event scales an asset's capacity while it is
    active. Every step is routed with routed_flow, so the flows always balance.

    With `operations = true` the stream also gets:
      nomination_msm3d  hourly nominations at each terminal: the flow the shippers
                        planned without events; dispatch keeps the flows on
                        it until an event intervenes
      booked_msm3d      booked capacity at each terminal, one exit booked tight
      pressure_bar      pressure at each node, following the gas actually moving
                        through it with a lag, inside its operating window
    With `quality = true`, H2S (ppm) and CO2 (mol %) at each field: a steady level
    with a little noise, plus the `excursions` the spec lists.
    The same spec and seed always give the same rows.
    """
    start = parse_time(spec.get("start", "2026-01-05T00:00:00Z"))
    step = timedelta(minutes=int(spec.get("step_minutes", 60)))
    steps = int(spec.get("steps", 168))
    rng = random.Random(spec.get("seed", 1))
    base = build_graph(net)
    pipes = sorted({attrs["pipeline"] for _, _, attrs in base.edges(data=True)})
    suppliers = sorted(n for n, attrs in base.nodes(data=True) if attrs["type"] in SUPPLY_TYPES)
    operations = bool(spec.get("operations", False))
    drift = dict.fromkeys(suppliers, 0.0)
    rows: list[Row] = []
    actual: list[dict[str, float]] = []
    planned: list[dict[str, float]] = []
    times = [start + k * step for k in range(steps)]
    for when in times:
        graph = apply_events(base, events, when)
        supply, plan_supply = {}, {}
        for node in suppliers:
            drift[node] = 0.9 * drift[node] + rng.gauss(0, 0.012)
            share = _load(when, base.nodes[node]["type"], drift[node])
            # The event-applied graph, not the base: a derated or offline supply
            # node must actually reduce what it can push into the network...
            supply[node] = (graph.nodes[node]["capacity_msm3d"] or 0.0) * share
            # ...while the plan (the nominations) is what it would supply without
            # events, so a field outage shows as a shortfall against the plan.
            plan_supply[node] = (base.nodes[node]["capacity_msm3d"] or 0.0) * share
        # Dispatch keeps exit points on their nominations: the plan is what the supply
        # would deliver without events, and only an event pushes the flows off it.
        flow = routed_flow(graph, supply)
        rows += [
            (when, pipe, "flow_msm3d", round(flow.pipelines.get(pipe, 0.0), 3)) for pipe in pipes
        ]
        if operations:
            actual.append(_throughput(net, flow))
            planned.append(
                _throughput(net, flow if graph is base else routed_flow(base, plan_supply))
            )
    if operations:
        rows += _operations_rows(net, times, actual, planned, pressure_windows, rng)
    if spec.get("quality", False):
        rows += _quality_rows(net, times, spec.get("excursions", []), spec.get("seed", 1))
    return rows


def _quality_rows(net: Network, times: list[datetime], excursions: list, seed) -> list[Row]:
    """H2S and CO2 at each field. An excursion ramps up over an hour to `peak`, holds
    it for `hours`, and ramps down again: a slug of off-spec gas to follow. With
    `every_hours` it comes back that often."""
    rng = random.Random(f"quality-{seed}")  # its own generator: flows stay as they were
    fields = sorted(n.id for n in net.nodes if n.type == "field")
    problems, bumps = [], []
    for i, spec in enumerate(excursions, start=1):
        asset, metric = spec.get("asset", ""), spec.get("metric", "")
        where = f"synthetic excursion {i}"
        if asset not in fields:
            problems.append(f"{where}: '{asset}' is not a field" + suggest(asset, fields))
        if metric not in QUALITY_BASE:
            problems.append(f"{where}: metric must be one of {', '.join(QUALITY_BASE)}")
        try:
            peak, hours = float(spec["peak"]), float(spec.get("hours", 3))
            start, every = parse_time(spec["start"]), float(spec.get("every_hours", 0))
            while start <= times[-1]:
                bumps.append((asset, metric, peak, start, hours))
                if every <= 0:
                    break
                start += timedelta(hours=every)
        except (KeyError, ValueError) as error:
            problems.append(f"{where}: needs a peak and a start time ({error})")
    if problems:
        raise DataError(problems)
    rows: list[Row] = []
    for metric, (low, high) in QUALITY_BASE.items():
        for node in fields:
            base, noise = rng.uniform(low, high), 0.0
            for when in times:
                noise = 0.7 * noise + rng.gauss(0, 0.02)
                value = base * (1 + noise)
                for asset, kind, peak, start, hours in bumps:
                    if asset == node and kind == metric:
                        value += max(0.0, peak - base) * _plateau(when, start, hours)
                rows.append((when, node, metric, round(max(0.0, value), 2)))
    return rows


def _plateau(when: datetime, start: datetime, hours: float) -> float:
    """0 before and after, 1 from `start` for `hours`, with one-hour ramps."""
    t = (when - start).total_seconds() / 3600
    return max(0.0, min(1.0, t + 1, hours + 1 - t))


def _throughput(net: Network, flow) -> dict[str, float]:
    """Gas through each node: what it supplies, or what arrives at it."""
    through: dict[str, float] = dict(flow.supplied)
    for pipe in net.pipelines:
        value = flow.pipelines.get(pipe.id, 0.0)
        target = pipe.to_id if value > 0 else pipe.from_id
        if pipe.type != "onshore" or net.node_by_id[target].type == "market":
            through[target] = through.get(target, 0.0) + abs(value)
    return through


def _operations_rows(net, times, actual, planned, windows, rng) -> list[Row]:
    if windows is None:
        from .config import load_config

        windows = load_config()["pressure"]
    rows: list[Row] = []
    exits = sorted(n.id for n in net.nodes if n.type == "terminal")
    # Hourly nominations: the planned flow at each exit point.
    nominated: dict[str, list[float]] = {}
    for node in exits:
        nominated[node] = [round(p.get(node, 0.0), 1) for p in planned]
        for when, value in zip(times, nominated[node], strict=True):
            rows.append((when, node, "nomination_msm3d", value))
    # Bookings: comfortable headroom, except the busiest exit, booked tight.
    busiest = max(exits, key=lambda n: max(nominated[n]), default=None)
    for node in exits:
        peak = max(nominated[node])
        if peak <= 0:
            continue
        booked = math.ceil(peak * (1.05 if node == busiest else 1.15) * 2) / 2
        rows += [(when, node, "booked_msm3d", booked) for when in times]
    # Pressures: arrival points follow the gas arriving; departure points the load.
    typical = {
        node: statistics.median(p.get(node, 0.0) for p in planned) for node in net.node_by_id
    }
    for node in sorted(net.node_by_id):
        kind = net.node_by_id[node].type
        if kind not in windows or typical[node] <= 0:
            continue
        low, high = windows[kind]
        span = high - low
        arrival = kind in ("terminal", "market", "lng")
        pressure, noise = None, 0.0
        for when, through in zip(times, actual, strict=True):
            ratio = min(1.4, through.get(node, 0.0) / typical[node])
            share = -0.05 + 0.55 * ratio if arrival else 0.35 + 0.35 * ratio
            noise = 0.8 * noise + rng.gauss(0, 0.006)
            target = low + span * (share + noise)
            pressure = target if pressure is None else pressure + 0.45 * (target - pressure)
            rows.append((when, node, "pressure_bar", round(pressure, 1)))
    return rows


def _load(when: datetime, kind: str, drift: float) -> float:
    """Share of capacity in use: a morning and evening peak, quieter weekends."""
    hour = when.hour + when.minute / 60
    daily = 0.05 * math.cos(2 * math.pi * (hour - 18) / 24)
    daily += 0.02 * math.cos(2 * math.pi * (hour - 8) / 12)
    weekend = -0.05 if when.weekday() >= 5 else 0.0
    level = 0.55 + daily / 2 if kind == "lng" else 0.84 + daily
    return min(1.0, max(0.05, level + weekend + drift))


def apply_events(base: nx.DiGraph, events: tuple[Event, ...], when: datetime) -> nx.DiGraph:
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
                # A processing node's capacity travels on the node, not its edges:
                # scale it too, or a partial derate is silently ignored. A terminal or
                # hub without a capacity of its own takes what its lines can bring it.
                if not attrs.get("capacity_msm3d"):
                    attrs["capacity_msm3d"] = _intake(graph, event.asset)
                if attrs.get("capacity_msm3d"):
                    attrs["capacity_msm3d"] *= factor
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


def _intake(graph: nx.DiGraph, node: str) -> float | None:
    """What the lines into `node` can carry together; None when one has no capacity."""
    capacities = [edge.get("capacity") for _, _, edge in graph.in_edges(node, data=True)]
    if not capacities or None in capacities:
        return None
    return sum(capacities)


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
            )
        except (KeyError, ValueError) as error:
            problems.append(f"{where}/stream.toml pig {i}: needs a launch time ({error})")
            continue
        if pig.speed_mps <= 0:
            problems.append(f"{where}/stream.toml pig {i}: speed_mps must be above 0")
        elif pig.every_hours < 0:
            problems.append(f"{where}/stream.toml pig {i}: every_hours must be 0 or more")
        else:
            pigs.append(pig)
    pigs += _pig_programme(meta, net, {p.pipeline for p in pigs}, where, problems)
    return tuple(pigs)


# A pigging programme puts a pig on every trunk, export line and interconnector:
# one pig per main line, launches staggered evenly over `every_hours` from the stream
# start, so several are always under way. An explicit [[pigs]] entry wins for its line.
PIG_LINES = ("trunk", "export", "interconnector")


def _pig_programme(
    meta: dict, net: Network, explicit: set[str], where: str, problems: list[str]
) -> list[Pig]:
    synthetic = meta.get("synthetic")
    if not isinstance(synthetic, dict):
        return []
    programme = synthetic.get("pig_programme")
    if not isinstance(programme, dict):
        if programme is not None:
            problems.append(f"{where}/stream.toml pig_programme: must be a table")
        return []
    try:
        every = float(programme.get("every_hours", 48))
        speed = float(programme.get("speed_mps", 4.0))
    except (TypeError, ValueError):
        problems.append(
            f"{where}/stream.toml pig_programme: every_hours and speed_mps must be numbers"
        )
        return []
    if every <= 0:
        problems.append(f"{where}/stream.toml pig_programme: every_hours must be above 0")
        return []
    if speed <= 0:
        problems.append(f"{where}/stream.toml pig_programme: speed_mps must be above 0")
        return []
    start = parse_time(synthetic.get("start", "2026-01-05T00:00:00Z"))
    mains = sorted(p.id for p in net.pipelines if p.type in PIG_LINES and p.id not in explicit)
    pigs = []
    for i, pipeline in enumerate(mains):
        launch = start + timedelta(seconds=every * 3600 * i / max(1, len(mains)))
        pigs.append(
            Pig(
                label=f"Pig on {net.asset_name(pipeline)}",
                pipeline=pipeline,
                launch=launch,
                speed_mps=speed,
                every_hours=every,
            )
        )
    return pigs


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
        synthetic="synthetic" in meta,
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
        lines.append(
            f"pig: {pig.label} ({pig.pipeline}) launched {pig.launch:%a %H:%M}, {pig.speed_mps} m/s"
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
