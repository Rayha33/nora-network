"""What a stream is: its rows, events, pigs and the Stream itself.

Shared by the loader (nora.stream), the importer and the generator.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from ..data import DATA_DIR, DataError

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
    # A field's export gas from its gas chromatograph (GC), and its dew points
    "c1_molpct": "Methane, C1 (mol %)",
    "c2_molpct": "Ethane, C2 (mol %)",
    "c3_molpct": "Propane, C3 (mol %)",
    "ic4_molpct": "i-Butane, iC4 (mol %)",
    "nc4_molpct": "n-Butane, nC4 (mol %)",
    "ic5_molpct": "i-Pentane, iC5 (mol %)",
    "nc5_molpct": "n-Pentane, nC5 (mol %)",
    "c6plus_molpct": "Hexanes and heavier, C6+ (mol %)",
    "n2_molpct": "Nitrogen, N2 (mol %)",
    "o2_ppm": "Oxygen, O2 (ppm)",
    "wdp_c": "Water dew point (°C)",
    "hcdp_c": "Hydrocarbon dew point (°C)",
    "air_temp_c": "Outside air temperature (°C)",
}

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
    ident: int | None = None  # the pig ID operators use (stream.toml `id`); each relaunch counts up
    tag: str = ""  # the tag on the pig, such as PIG-LGS-014; generated when not given
    kind: str = "cleaning"  # cleaning, inspection or gauging
    receiver: str | None = None  # the receiving station (a node); None: the end of its route
    notify_every_hours: float = 6.0  # an ETA update to the receiver this often


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
                    "id": pig.ident,
                    "tag": pig.tag,
                    "kind": pig.kind,
                    "receiver": pig.receiver,
                    "notify": round(pig.notify_every_hours * 3600),
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
