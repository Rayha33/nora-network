"""Local editing API and lossless row updates for the network CSVs."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import stat
import tempfile
import threading
from dataclasses import replace
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

from .data import (
    DATA_DIR,
    NODE_COLUMNS,
    PIPELINE_COLUMNS,
    DataError,
    Network,
    Node,
    Pipeline,
    load_network,
)
from .site import build_site

_EDIT_LOCK = threading.RLock()
_MAX_BODY = 1_000_000


def add_node(net: Network, values: dict) -> Network:
    """Return a network with one appended node; call check() before saving."""
    return replace(net, nodes=(*net.nodes, _node(values)))


def update_node(net: Network, node_id: str, changes: dict) -> Network:
    """Return a network with one node updated by its CSV column names."""
    _require_known(node_id, net.node_by_id, "node")
    _check_fields(changes, NODE_COLUMNS)
    nodes = tuple(replace(node, **changes) if node.id == node_id else node for node in net.nodes)
    return replace(net, nodes=nodes)


def remove_node(net: Network, node_id: str) -> Network:
    """Remove an unused node; connected pipelines must be removed first."""
    _require_known(node_id, net.node_by_id, "node")
    connected = [
        pipeline.id for pipeline in net.pipelines if node_id in (pipeline.from_id, pipeline.to_id)
    ]
    if connected:
        raise DataError(
            [f"Cannot remove node '{node_id}'; pipelines use it: {', '.join(connected)}"]
        )
    return replace(net, nodes=tuple(node for node in net.nodes if node.id != node_id))


def add_pipeline(net: Network, values: dict) -> Network:
    """Return a network with one appended pipeline; call check() before saving."""
    return replace(net, pipelines=(*net.pipelines, _pipeline(values)))


def update_pipeline(net: Network, pipeline_id: str, changes: dict) -> Network:
    """Return a network with one pipeline updated by its CSV column names."""
    _require_known(pipeline_id, net.pipeline_by_id, "pipeline")
    changes = _pipeline_values(changes, partial=True)
    changes.pop("line", None)
    pipelines = tuple(
        replace(pipeline, **changes) if pipeline.id == pipeline_id else pipeline
        for pipeline in net.pipelines
    )
    return replace(net, pipelines=pipelines)


def remove_pipeline(net: Network, pipeline_id: str) -> Network:
    """Return a network without the named pipeline."""
    _require_known(pipeline_id, net.pipeline_by_id, "pipeline")
    return replace(net, pipelines=tuple(p for p in net.pipelines if p.id != pipeline_id))


def check(net: Network) -> list[str]:
    """Validate a proposed network with data.py's loader, without changing its files."""
    with tempfile.TemporaryDirectory(prefix="nora-check-") as folder:
        root = Path(folder)
        _write_canonical(root / "nodes.csv", NODE_COLUMNS, (_node_values(n) for n in net.nodes))
        _write_canonical(
            root / "pipelines.csv",
            PIPELINE_COLUMNS,
            (_pipeline_record_values(p) for p in net.pipelines),
        )
        try:
            load_network(root)
        except DataError as error:
            return list(error.problems)
    return []


def save(net: Network, data_dir: Path = DATA_DIR) -> dict[Path, bytes]:
    """Validate and persist only changed CSV rows; return old bytes for rollback."""
    data_dir = Path(data_dir)
    with _EDIT_LOCK:
        problems = check(net)
        if problems:
            raise DataError(problems)
        original = load_network(data_dir)
        changes = {}
        for filename, columns, before, after, values in (
            (
                "nodes.csv",
                NODE_COLUMNS,
                original.nodes,
                net.nodes,
                _node_values,
            ),
            (
                "pipelines.csv",
                PIPELINE_COLUMNS,
                original.pipelines,
                net.pipelines,
                _pipeline_record_values,
            ),
        ):
            path = data_dir / filename
            current = path.read_bytes()
            updated = _edit_csv(current, columns, before, after, values)
            if updated != current:
                changes[path] = updated
        snapshot = {path: path.read_bytes() for path in changes}
        _atomic_replace(changes)
        return snapshot


def restore(snapshot: dict[Path, bytes]) -> None:
    """Atomically restore files changed by save(), for a failed site rebuild."""
    with _EDIT_LOCK:
        _atomic_replace(snapshot)


def network_payload(net: Network, revision: str) -> dict:
    """The editable JSON representation, including source line numbers for stable edits."""
    return {
        "revision": revision,
        "nodes": [{**_node_values(node), "line": node.line} for node in net.nodes],
        "pipelines": [
            {**_pipeline_record_values(pipeline), "line": pipeline.line}
            for pipeline in net.pipelines
        ],
    }


def network_from_payload(payload) -> Network:
    """Decode a full GET /api/network payload; reject client-supplied paths and fields."""
    if not isinstance(payload, dict) or set(payload) != {"revision", "nodes", "pipelines"}:
        raise DataError(["request: expected a revision and 'nodes' and 'pipelines' arrays"])
    revision = payload["revision"]
    if (
        not isinstance(revision, str)
        or len(revision) != 64
        or any(char not in "0123456789abcdef" for char in revision)
    ):
        raise DataError(["request: revision must be a SHA-256 hex digest from GET /api/network"])
    if not isinstance(payload["nodes"], list) or not isinstance(payload["pipelines"], list):
        raise DataError(["request: 'nodes' and 'pipelines' must be arrays"])
    return Network(
        tuple(_node(item) for item in payload["nodes"]),
        tuple(_pipeline(item) for item in payload["pipelines"]),
    )


def make_handler(data_dir: Path, out_dir: Path):
    """Build the same-origin JSON API handler used by `nora serve --edit`."""

    class EditHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(out_dir), **kwargs)

        def log_message(self, format, *args):  # noqa: A002 - keep the local console quiet
            pass

        def do_GET(self):
            if urlsplit(self.path).path == "/api/network":
                try:
                    with _EDIT_LOCK:
                        before = _data_revision(data_dir)
                        net = load_network(data_dir)
                        revision = _data_revision(data_dir)
                        if before != revision:
                            self._json(409, {"error": "network data changed while it was read"})
                            return
                        payload = network_payload(net, revision)
                except DataError as error:
                    self._json(500, {"problems": error.problems})
                    return
                self._json(200, payload)
                return
            if urlsplit(self.path).path.startswith("/api/"):
                self._json(404, {"error": "not found"})
                return
            super().do_GET()

        def do_POST(self):
            path = urlsplit(self.path).path
            if path not in ("/api/check", "/api/save"):
                self._json(404, {"error": "not found"})
                return
            if self.headers.get_content_type() != "application/json":
                self._json(415, {"error": "Content-Type must be application/json"})
                return
            if not self._same_origin():
                self._json(403, {"error": "a same-origin Origin header is required"})
                return
            length = self.headers.get("Content-Length")
            if length is None or not length.isdecimal():
                self._json(411, {"error": "Content-Length is required"})
                return
            if int(length) > _MAX_BODY:
                self._json(413, {"error": "request body is too large"})
                return
            try:
                payload = json.loads(self.rfile.read(int(length)).decode("utf-8"))
                net = network_from_payload(payload)
            except DataError as error:
                self._json(400, {"problems": error.problems})
                return
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as error:
                self._json(400, {"error": f"invalid JSON request: {error}"})
                return

            with _EDIT_LOCK:
                revision = payload["revision"]
                current = _data_revision(data_dir)
                if revision != current:
                    self._json(
                        409,
                        {
                            "error": (
                                "network data changed; fetch the latest network and reapply edits"
                            ),
                            "revision": current,
                        },
                    )
                    return
                if path == "/api/check":
                    problems = check(net)
                    self._json(
                        200,
                        {"valid": not problems, "problems": problems, "revision": current},
                    )
                    return
                try:
                    snapshot = save(net, data_dir)
                except DataError as error:
                    self._json(422, {"saved": False, "problems": error.problems})
                    return
                try:
                    build_site(out_dir, data_dir)
                except Exception as error:  # noqa: BLE001 - restore the last valid site on failure
                    try:
                        restore(snapshot)
                        build_site(out_dir, data_dir)
                    except Exception as rollback_error:  # noqa: BLE001 - report both failures
                        self._json(
                            500,
                            {
                                "saved": False,
                                "error": (
                                    f"build failed ({error}); rollback failed ({rollback_error})"
                                ),
                            },
                        )
                        return
                    self._json(
                        422 if isinstance(error, DataError) else 500,
                        {"saved": False, "error": str(error)},
                    )
                    return
                self._json(
                    200,
                    {"saved": True, "reload": True, "revision": _data_revision(data_dir)},
                )

        def _same_origin(self) -> bool:
            port = self.server.server_address[1]
            host = "127.0.0.1" if port == 80 else f"127.0.0.1:{port}"
            return (
                self.headers.get("Host") == host and self.headers.get("Origin") == f"http://{host}"
            )

        def _json(self, status: int, value: dict) -> None:
            body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(body)

    return EditHandler


def _node(values: dict) -> Node:
    _check_fields(values, (*NODE_COLUMNS, "line"))
    row = {column: values.get(column, "") for column in NODE_COLUMNS}
    return Node(**row, line=_line(values))


def _pipeline(values: dict) -> Pipeline:
    if not isinstance(values, dict):
        raise DataError(["request: each pipeline must be an object"])
    if "from" in values and "from_id" in values or "to" in values and "to_id" in values:
        raise DataError(["request: use either 'from'/'to' or 'from_id'/'to_id', not both"])
    converted = _pipeline_values(values, partial=False)
    if "from" not in values and "from_id" not in values:
        converted["from_id"] = ""
    if "to" not in values and "to_id" not in values:
        converted["to_id"] = ""
    return Pipeline(**converted, line=_line(values))


def _pipeline_values(value, partial: bool = False) -> dict:
    if isinstance(value, Pipeline):
        return {
            "id": value.id,
            "name": value.name,
            "from_id": value.from_id,
            "to_id": value.to_id,
            "type": value.type,
            "length_km": value.length_km,
            "diameter_in": value.diameter_in,
            "capacity_msm3d": value.capacity_msm3d,
            "bidirectional": value.bidirectional,
            "commissioned": value.commissioned,
            "status": value.status,
            "operator": value.operator,
            "source": value.source,
            "notes": value.notes,
        }
    if not isinstance(value, dict):
        raise DataError(["request: each pipeline must be an object"])
    if "from" in value and "from_id" in value or "to" in value and "to_id" in value:
        raise DataError(["request: use either 'from'/'to' or 'from_id'/'to_id', not both"])
    allowed_fields = {*PIPELINE_COLUMNS, "line", "from_id", "to_id"}
    _check_fields(value, allowed_fields)
    converted = dict(value)
    if "from" in converted:
        converted["from_id"] = converted.pop("from")
    if "to" in converted:
        converted["to_id"] = converted.pop("to")
    if not partial:
        converted = {
            (
                "from_id" if column == "from" else "to_id" if column == "to" else column
            ): converted.get(
                "from_id" if column == "from" else "to_id" if column == "to" else column, ""
            )
            for column in PIPELINE_COLUMNS
        }
    return converted


def _node_values(node) -> dict:
    return {column: getattr(node, column) for column in NODE_COLUMNS}


def _pipeline_record_values(pipeline) -> dict:
    values = _pipeline_values(pipeline)
    values["from"] = values.pop("from_id")
    values["to"] = values.pop("to_id")
    return values


def _line(values: dict) -> int:
    line = values.get("line", 0)
    if isinstance(line, bool) or not isinstance(line, int) or line < 0:
        raise DataError(["request: line must be a non-negative integer"])
    return line


def _check_fields(values, allowed) -> None:
    if not isinstance(values, dict):
        raise DataError(["request: each asset must be an object"])
    unknown = sorted(set(values) - set(allowed))
    if unknown:
        raise DataError([f"request: unknown field(s): {', '.join(unknown)}"])


def _require_known(asset_id, assets, kind: str) -> None:
    if asset_id not in assets:
        raise DataError([f"{kind}: unknown id '{asset_id}'"])


def _write_canonical(path: Path, columns, records) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for record in records:
            writer.writerow([record.get(column, "") for column in columns])


def _edit_csv(raw: bytes, columns, original, edited, record_values) -> bytes:
    bom = b"\xef\xbb\xbf" if raw.startswith(b"\xef\xbb\xbf") else b""
    text = raw[len(bom) :].decode("utf-8")
    physical_lines = text.splitlines(keepends=True)
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header = next(reader)
    except StopIteration:
        raise DataError(["CSV file is empty"]) from None
    if "id" not in header or any(column not in header for column in columns):
        raise DataError(["CSV header is missing required columns"])
    header_end = reader.line_num
    prefix = "".join(physical_lines[:header_end])
    cursor = header_end
    records = []
    for row in reader:
        end = reader.line_num
        raw_row = "".join(physical_lines[cursor:end])
        cursor = end
        values = dict(zip(header, row, strict=False))
        records.append({"id": values.get("id"), "line": end, "raw": raw_row, "values": values})
    tail = "".join(physical_lines[cursor:])
    newline = _newline(text)
    original_by_id = {item.id: item for item in original}
    edited_by_id = {item.id: item for item in edited}
    edited_by_line = {item.line: item for item in edited if item.line > 0}
    used = set()
    output_rows = []
    for record in records:
        old = original_by_id.get(record["id"])
        if old is None:
            output_rows.append(record["raw"])
            continue
        current = edited_by_id.get(old.id) or edited_by_line.get(old.line)
        if current is None:
            continue
        used.add(id(current))
        if _same_asset(current, old, columns):
            output_rows.append(record["raw"])
            continue
        values = dict(record["values"])
        values.update(record_values(current))
        ending = _ending(record["raw"], newline)
        rendered = _csv_row([values.get(column, "") for column in header], ending)
        if not record["raw"].endswith(("\n", "\r")):
            rendered = rendered[: -len(ending)]
        output_rows.append(rendered)
    new_items = [item for item in edited if id(item) not in used]
    result = prefix + "".join(output_rows) + tail
    if new_items and result and not result.endswith(("\n", "\r")):
        result += newline
    for item in new_items:
        values = record_values(item)
        result += _csv_row([values.get(column, "") for column in header], newline)
    return bom + result.encode("utf-8")


def _same_asset(left, right, columns) -> bool:
    left_values = _node_values(left) if isinstance(left, Node) else _pipeline_record_values(left)
    right_values = (
        _node_values(right) if isinstance(right, Node) else _pipeline_record_values(right)
    )
    return all(left_values.get(column) == right_values.get(column) for column in columns)


def _data_revision(data_dir: Path) -> str:
    digest = hashlib.sha256()
    for filename in ("nodes.csv", "pipelines.csv"):
        digest.update(filename.encode("ascii") + b"\0")
        digest.update((Path(data_dir) / filename).read_bytes())
    return digest.hexdigest()


def _newline(text: str) -> str:
    for index, char in enumerate(text):
        if char == "\r":
            return "\r\n" if text[index : index + 2] == "\r\n" else "\r"
        if char == "\n":
            return "\n"
    return "\n"


def _ending(row: str, fallback: str) -> str:
    if row.endswith("\r\n"):
        return "\r\n"
    if row.endswith("\n"):
        return "\n"
    if row.endswith("\r"):
        return "\r"
    return fallback


def _csv_row(values, ending: str) -> str:
    buffer = io.StringIO(newline="")
    csv.writer(buffer, lineterminator=ending).writerow(values)
    return buffer.getvalue()


def _atomic_replace(changes: dict[Path, bytes]) -> None:
    if not changes:
        return
    temps = {}
    replaced = []
    originals = {path: path.read_bytes() for path in changes}
    try:
        for path, content in changes.items():
            descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            temp = Path(name)
            temps[path] = temp
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(temp, stat.S_IMODE(path.stat().st_mode))
        for path, temp in temps.items():
            os.replace(temp, path)
            replaced.append(path)
    except Exception:
        for path in replaced:
            _atomic_write_one(path, originals[path])
        raise
    finally:
        for temp in temps.values():
            if temp.exists():
                temp.unlink()


def _atomic_write_one(path: Path, content: bytes) -> None:
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp, stat.S_IMODE(path.stat().st_mode))
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()
