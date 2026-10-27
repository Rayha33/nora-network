"""Load and validate NORA's network data: data/nodes.csv and data/pipelines.csv.

The CSV files are the source of truth and are edited by hand, often in the GitHub
web editor, so every problem is reported with its file and line number, plus a
suggestion when a value looks like a typo.
"""

from __future__ import annotations

import csv
import difflib
import math
import re
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = REPO_ROOT / "data"

NODE_TYPES = {
    "field": "Gas field or production hub",
    "hub": "Offshore riser or junction platform",
    "processing": "Gas processing plant",
    "terminal": "Receiving terminal",
    "lng": "LNG import terminal",
    "storage": "Gas storage site",
    "market": "Market or large consumer",
}
# Node types that put gas into the network; their capacity_msm3d is their supply.
SUPPLY_TYPES = ("field", "lng", "storage")

PIPELINE_TYPES = {
    "feeder": "Field to hub or plant",
    "trunk": "Offshore trunkline",
    "export": "Export line to a terminal",
    "interconnector": "Cross-border interconnector",
    "link": "Short platform link",
    "onshore": "Notional onshore grid entry",
}
STATUSES = ("operating", "planned", "decommissioned")

NODE_COLUMNS = (
    "id", "name", "type", "country", "lat", "lon", "operator",
    "capacity_msm3d", "status", "startup", "shutdown", "source", "notes",
)  # fmt: skip
PIPELINE_COLUMNS = (
    "id", "name", "from", "to", "type", "length_km", "diameter_in", "capacity_msm3d",
    "bidirectional", "commissioned", "status", "operator", "source", "notes",
)  # fmt: skip

_ID = re.compile(r"^[a-z][a-z0-9_]*$")


class DataError(ValueError):
    """Raised with every problem found, so a contributor can fix them in one pass."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        listing = "\n".join(f"  - {problem}" for problem in problems)
        super().__init__(f"{len(problems)} data problem(s):\n{listing}")


@dataclass(frozen=True)
class Node:
    id: str
    name: str
    type: str
    country: str
    lat: float
    lon: float
    operator: str
    capacity_msm3d: float | None
    status: str
    startup: int | None
    shutdown: int | None
    source: str
    notes: str
    line: int

    def active_in(self, year: int) -> bool:
        """Whether the asset was, is or is planned to be in operation in `year`.

        A node with no `startup` has always existed so far; one with no `shutdown`
        is still in operation. `shutdown` is the first year it was no longer in
        operation, so the year before is the last one it is shown for.
        """
        if self.startup is not None and year < self.startup:
            return False
        if self.shutdown is not None and year >= self.shutdown:
            return False
        return True


@dataclass(frozen=True)
class Pipeline:
    id: str
    name: str
    from_id: str
    to_id: str
    type: str
    length_km: float | None
    diameter_in: float | None
    capacity_msm3d: float | None
    bidirectional: bool
    commissioned: int | None
    status: str
    operator: str
    source: str
    notes: str
    line: int


@dataclass(frozen=True)
class Network:
    nodes: tuple[Node, ...]
    pipelines: tuple[Pipeline, ...]

    @cached_property
    def node_by_id(self) -> dict[str, Node]:
        return {node.id: node for node in self.nodes}

    @cached_property
    def pipeline_by_id(self) -> dict[str, Pipeline]:
        return {pipe.id: pipe for pipe in self.pipelines}

    @property
    def asset_ids(self) -> list[str]:
        """Every node and pipeline id; stream rows may refer to either."""
        return [node.id for node in self.nodes] + [pipe.id for pipe in self.pipelines]

    def nodes_in_year(self, year: int) -> tuple[Node, ...]:
        """The nodes in operation in `year`, in id order (the timeline's filter)."""
        return tuple(sorted((n for n in self.nodes if n.active_in(year)), key=lambda n: n.id))

    def asset_name(self, asset_id: str) -> str:
        asset = self.node_by_id.get(asset_id) or self.pipeline_by_id.get(asset_id)
        return asset.name if asset else asset_id


def suggest(value: str, options: Iterable[str]) -> str:
    """' (did you mean 'x'?)' when value is close to one of options, else ''."""
    match = difflib.get_close_matches(value, list(options), n=1, cutoff=0.6)
    return f" (did you mean '{match[0]}'?)" if match else ""


class _Row:
    """One CSV row plus what is needed to report its problems precisely."""

    def __init__(self, where: str, values: dict[str, str], problems: list[str]):
        self.where = where
        self.values = values
        self.problems = problems

    def problem(self, message: str) -> None:
        self.problems.append(f"{self.where}: {message}")

    def text(self, column: str, required: bool = False) -> str:
        value = self.values.get(column, "")
        if required and not value:
            self.problem(f"'{column}' is empty")
        return value

    def number(
        self,
        column: str,
        *,
        required: bool = False,
        low: float | None = None,
        high: float | None = None,
    ) -> float | None:
        raw = self.values.get(column, "")
        if not raw:
            if required:
                self.problem(f"'{column}' is empty")
            return None
        try:
            value = float(raw)
        except ValueError:
            self.problem(f"'{column}' must be a number, got '{raw}'")
            return None
        too_low = low is not None and value < low
        too_high = high is not None and value > high
        if not math.isfinite(value) or too_low or too_high:
            bounds = f"{low} to {high}" if high is not None else f"at least {low}"
            self.problem(f"'{column}' must be {bounds}, got {raw}")
            return None
        return value

    def choice(self, column: str, options: Iterable[str]) -> str:
        options = list(options)
        value = self.text(column, required=True)
        if value and value not in options:
            self.problem(
                f"'{column}' = '{value}' must be one of: {', '.join(options)}"
                + suggest(value, options)
            )
        return value

    def boolean(self, column: str) -> bool:
        value = self.text(column).lower()
        if value not in ("", "true", "false"):
            self.problem(f"'{column}' must be true or false, got '{value}'")
        return value == "true"

    def identifier(self, seen: dict[str, str]) -> str:
        value = self.text("id", required=True)
        if value and not _ID.match(value):
            self.problem(
                f"'id' = '{value}' must use lowercase letters, digits and underscores, "
                "starting with a letter"
            )
        if value in seen:
            self.problem(f"'id' = '{value}' is already used on {seen[value]}")
        elif value:
            seen[value] = self.where
        return value


def read_rows(path: Path, columns: Iterable[str], problems: list[str]) -> Iterator[_Row]:
    """Yield the rows of a CSV file, reporting missing columns and stray commas."""
    if not path.exists():
        problems.append(f"{path.name}: file not found in {path.parent}")
        return
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        missing = [column for column in columns if column not in (reader.fieldnames or ())]
        if missing:
            problems.append(f"{path.name}: missing column(s) {', '.join(missing)}")
            return
        for record in reader:
            values = {key: (value or "").strip() for key, value in record.items() if key}
            row = _Row(f"{path.name} line {reader.line_num}", values, problems)
            if None in record:
                row.problem("has more values than columns; wrap text containing commas in quotes")
            yield row


def load_network(data_dir: Path = DATA_DIR) -> Network:
    """Read and check nodes.csv and pipelines.csv; raise DataError listing every problem."""
    data_dir = Path(data_dir)
    problems: list[str] = []
    seen: dict[str, str] = {}  # ids are unique across both files
    nodes = _read_nodes(data_dir / "nodes.csv", seen, problems)
    pipelines = _read_pipelines(data_dir / "pipelines.csv", nodes, seen, problems)
    if problems:
        raise DataError(problems)
    return Network(tuple(nodes), tuple(pipelines))


def _read_nodes(path: Path, seen: dict[str, str], problems: list[str]) -> list[Node]:
    nodes = []
    for row in read_rows(path, NODE_COLUMNS, problems):
        node_id = row.identifier(seen)
        kind = row.choice("type", NODE_TYPES)
        status = row.choice("status", STATUSES)
        country = row.text("country", required=True)
        if country and not re.fullmatch(r"[A-Z]{2}", country):
            row.problem(f"'country' must be a two-letter code such as NO or GB, got '{country}'")
        lat = row.number("lat", required=True, low=-90, high=90)
        lon = row.number("lon", required=True, low=-180, high=180)
        capacity = row.number("capacity_msm3d", low=0)
        startup = row.number("startup", low=1900, high=2100)
        shutdown = row.number("shutdown", low=1900, high=2100)
        if startup is not None and shutdown is not None and shutdown < startup:
            row.problem(f"'shutdown' = {shutdown} is before 'startup' = {startup}")
        if kind in SUPPLY_TYPES and status == "operating" and not row.text("capacity_msm3d"):
            row.problem(f"a {kind} needs 'capacity_msm3d': how much gas it can supply")
        nodes.append(
            Node(
                id=node_id,
                name=row.text("name", required=True),
                type=kind,
                country=country,
                lat=lat if lat is not None else 0.0,
                lon=lon if lon is not None else 0.0,
                operator=row.text("operator"),
                capacity_msm3d=capacity,
                status=status,
                startup=int(startup) if startup is not None else None,
                shutdown=int(shutdown) if shutdown is not None else None,
                source=row.text("source"),
                notes=row.text("notes"),
                line=int(row.where.rsplit(" ", 1)[1]),
            )
        )
    return nodes


def _read_pipelines(
    path: Path, nodes: list[Node], seen: dict[str, str], problems: list[str]
) -> list[Pipeline]:
    node_ids = [node.id for node in nodes]
    known = set(node_ids)
    directions: dict[tuple[str, str], str] = {}
    pipelines = []
    for row in read_rows(path, PIPELINE_COLUMNS, problems):
        pipe_id = row.identifier(seen)
        ends = []
        for column in ("from", "to"):
            value = row.text(column, required=True)
            if value and value not in known:
                row.problem(
                    f"'{column}' = '{value}' is not an id in nodes.csv" + suggest(value, node_ids)
                )
            ends.append(value)
        source, target = ends
        if source and source == target:
            row.problem("'from' and 'to' are the same node")
        bidirectional = row.boolean("bidirectional")
        for direction in [(source, target)] + [(target, source)] * bidirectional:
            if direction in directions:
                row.problem(
                    f"{direction[0]} -> {direction[1]} is already modelled on "
                    f"{directions[direction]}; model parallel lines as one row"
                )
            else:
                directions[direction] = row.where
        commissioned = row.number("commissioned", low=1900, high=2100)
        pipelines.append(
            Pipeline(
                id=pipe_id,
                name=row.text("name", required=True),
                from_id=source,
                to_id=target,
                type=row.choice("type", PIPELINE_TYPES),
                length_km=row.number("length_km", low=0),
                diameter_in=row.number("diameter_in", low=0),
                capacity_msm3d=row.number("capacity_msm3d", low=0),
                bidirectional=bidirectional,
                commissioned=int(commissioned) if commissioned is not None else None,
                status=row.choice("status", STATUSES),
                operator=row.text("operator"),
                source=row.text("source"),
                notes=row.text("notes"),
                line=int(row.where.rsplit(" ", 1)[1]),
            )
        )
    return pipelines
