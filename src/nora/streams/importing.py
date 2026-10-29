"""Reading streams from raw files: NORA's flows.csv, [[import]] mappings, `nora stream new`."""

from __future__ import annotations

import csv
import json
import math
import shutil
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ..data import DataError, Network, read_rows, suggest
from .model import (
    FLOW_COLUMNS,
    METRIC_COLUMNS,
    METRICS,
    STREAMS_DIR,
    Row,
    _check_stream_id,
    parse_time,
)


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
