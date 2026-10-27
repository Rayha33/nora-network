"""Units for level 2 (unit control), from data/units.toml.

A unit is the set of assets one operator desk looks after. Every node belongs to
exactly one unit; a pipeline belongs to the unit of the node it leaves from.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from .data import DATA_DIR, DataError, Network, suggest

UNITS_PATH = DATA_DIR / "units.toml"


def load_units(net: Network, path: Path = UNITS_PATH) -> list[dict]:
    """[{id, name, nodes, pipelines}] in file order; raises DataError listing every problem."""
    path = Path(path)
    if not path.exists():
        return [
            {
                "id": "all",
                "name": "Whole network",
                "nodes": sorted(net.node_by_id),
                "pipelines": sorted(net.pipeline_by_id),
            }
        ]
    try:
        spec = tomllib.loads(path.read_text(encoding="utf-8")).get("units", {})
    except tomllib.TOMLDecodeError as error:
        raise DataError([f"{path.name}: {error}"]) from None
    problems: list[str] = []
    owner: dict[str, str] = {}
    units = []
    for unit_id, unit in spec.items():
        nodes = []
        for node in unit.get("nodes", []):
            if node not in net.node_by_id:
                problems.append(
                    f"{path.name} [{unit_id}]: '{node}' is not a node id"
                    + suggest(node, list(net.node_by_id))
                )
            elif node in owner:
                problems.append(f"{path.name} [{unit_id}]: '{node}' is already in [{owner[node]}]")
            else:
                owner[node] = unit_id
                nodes.append(node)
        units.append({"id": unit_id, "name": unit.get("name", unit_id), "nodes": nodes})
    missing = sorted(set(net.node_by_id) - set(owner))
    if missing:
        problems.append(f"{path.name}: nodes in no unit: {', '.join(missing)}")
    if problems:
        raise DataError(problems)
    for unit in units:
        members = set(unit["nodes"])
        unit["pipelines"] = sorted(p.id for p in net.pipelines if p.from_id in members)
    return units
