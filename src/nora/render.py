"""Draw the network with pyvis as one self-contained network.html.

pyvis builds the vis-network nodes, edges and options. NORA renders them through
its own Jinja template (templates/network.html.j2) instead of pyvis' default one,
and inlines the vis-network files bundled with pyvis, so the page works offline and
can be shared as a single attachment. Interaction lives in templates/network.js;
everything it needs arrives in the `nora` payload.
"""

from __future__ import annotations

import json
import math
from collections.abc import Sequence
from pathlib import Path

import pyvis
from pyvis.network import Network as PyvisNetwork

from .data import NODE_TYPES, PIPELINE_TYPES, Network
from .stream import Stream

PACKAGE_DIR = Path(__file__).parent
TEMPLATES = PACKAGE_DIR / "templates"
BASEMAP = PACKAGE_DIR / "assets" / "basemap.json"
PYVIS_DIR = Path(pyvis.__file__).parent

# Equirectangular projection centred on the North Sea, in canvas units per degree.
PROJECTION = {"lat0": 57.0, "lon0": 4.0, "scale": 64.0}

SHAPES = {
    "field": "dot",
    "hub": "square",
    "processing": "diamond",
    "terminal": "triangle",
    "lng": "star",
    "storage": "triangleDown",
    "market": "hexagon",
}
SIZES = {"field": 7, "hub": 5, "processing": 8, "terminal": 7, "lng": 9, "storage": 7, "market": 10}

OPTIONS = {
    "autoResize": True,
    "physics": {"enabled": False},
    "interaction": {
        "hover": True,
        "tooltipDelay": 120,
        "zoomSpeed": 0.7,
        "keyboard": {"enabled": True, "bindToWindow": False},
    },
    "nodes": {
        "borderWidth": 1.5,
        "font": {"size": 11, "face": "Archivo Narrow, Arial Narrow, sans-serif", "strokeWidth": 3},
    },
    "edges": {
        "smooth": False,
        "arrowStrikethrough": False,
        "arrows": {"to": {"enabled": True, "scaleFactor": 0.35}},
        "hoverWidth": 0.8,
        "selectionWidth": 1.4,
    },
}


def project(lat: float, lon: float) -> tuple[float, float]:
    scale = PROJECTION["scale"]
    x = (lon - PROJECTION["lon0"]) * math.cos(math.radians(PROJECTION["lat0"])) * scale
    return x, -(lat - PROJECTION["lat0"]) * scale


def declutter(points: dict[str, tuple[float, float]], spacing: float = 15.0, rounds: int = 60):
    """Nudge symbols apart that would overlap, so co-located assets stay clickable.

    The true coordinates stay in the data and the details panel; only the drawn
    position moves, by a few canvas units.
    """
    position = {key: list(points[key]) for key in sorted(points)}
    keys = list(position)
    for _ in range(rounds):
        moved = False
        for i, a in enumerate(keys):
            for b in keys[i + 1 :]:
                dx = position[b][0] - position[a][0]
                dy = position[b][1] - position[a][1]
                distance = math.hypot(dx, dy)
                if distance >= spacing:
                    continue
                if distance < 1e-9:
                    dx, dy, distance = 1.0, 0.0, 1.0
                push = (spacing - distance) / 2
                ux, uy = dx / distance * push, dy / distance * push
                position[a][0] -= ux
                position[a][1] -= uy
                position[b][0] += ux
                position[b][1] += uy
                moved = True
        if not moved:
            break
    return {key: (round(x, 1), round(y, 1)) for key, (x, y) in position.items()}


def _number(value: float | None, unit: str, digits: int = 0) -> str:
    return "not recorded" if value is None else f"{value:,.{digits}f} {unit}"


def network_html(
    net: Network, analysis: dict, streams: Sequence[Stream] = (), links: dict | None = None
) -> str:
    """The interactive map as a single HTML document."""
    links = links or {}
    outages = {(o["kind"], o["id"]): o for o in analysis["outages"]}
    flows = analysis["pipeline_flow"]
    positions = declutter({n.id: project(n.lat, n.lon) for n in net.nodes})
    view = PyvisNetwork(height="100%", width="100%", directed=True, cdn_resources="in_line")

    for node in sorted(net.nodes, key=lambda n: n.id):
        outage = outages.get(("node", node.id), {})
        x, y = positions[node.id]
        flow = analysis["delivered"].get(node.id, analysis["supplied"].get(node.id))
        title = [node.name, f"{NODE_TYPES[node.type]}, {node.country}"]
        if node.capacity_msm3d:
            title.append(f"Capacity {_number(node.capacity_msm3d, 'MSm³/d')}")
        if outage.get("lost"):
            title.append(f"If it trips: {outage['lost']:,.0f} MSm³/d lost")
        view.add_node(
            node.id,
            label=node.name,
            shape=SHAPES[node.type],
            size=SIZES[node.type],
            x=x,
            y=y,
            physics=False,
            title="\n".join(title),
            nora={
                "type": node.type,
                "country": node.country,
                "lat": node.lat,
                "lon": node.lon,
                "operator": node.operator,
                "capacity": node.capacity_msm3d,
                "status": node.status,
                "source": node.source,
                "notes": node.notes,
                "line": node.line,
                "lost": outage.get("lost", 0.0),
                "share": outage.get("share", 0.0),
                "modelFlow": flow,
            },
        )

    for pipe in sorted(net.pipelines, key=lambda p: p.id):
        outage = outages.get(("pipeline", pipe.id), {})
        flow = flows.get(pipe.id)
        utilization = analysis["utilization"].get(pipe.id)
        title = [pipe.name, PIPELINE_TYPES[pipe.type]]
        if pipe.capacity_msm3d:
            title.append(f"Capacity {_number(pipe.capacity_msm3d, 'MSm³/d')}")
        if pipe.length_km:
            title.append(f"Length {_number(pipe.length_km, 'km')}")
        view.add_edge(
            pipe.from_id,
            pipe.to_id,
            id=pipe.id,
            title="\n".join(title),
            arrows="to, from" if pipe.bidirectional else "to",
            nora={
                "type": pipe.type,
                "capacity": pipe.capacity_msm3d,
                "length": pipe.length_km,
                "diameter": pipe.diameter_in,
                "commissioned": pipe.commissioned,
                "bidirectional": pipe.bidirectional,
                "status": pipe.status,
                "operator": pipe.operator,
                "source": pipe.source,
                "notes": pipe.notes,
                "line": pipe.line,
                "lost": outage.get("lost", 0.0),
                "share": outage.get("share", 0.0),
                "modelFlow": flow,
                "utilization": utilization,
            },
        )

    view.options = OPTIONS
    view.set_template_dir(str(TEMPLATES), "network.html.j2")
    # Scripts and styles go in as plain strings, so Jinja never parses their braces.
    vis = PYVIS_DIR / "templates" / "lib" / "vis-9.1.2"
    view.templateEnv.globals["inline"] = {
        "vis_css": (vis / "vis-network.css").read_text(encoding="utf-8"),
        "vis_js": (vis / "vis-network.min.js").read_text(encoding="utf-8"),
        "css": (TEMPLATES / "network.css").read_text(encoding="utf-8"),
        "js": (TEMPLATES / "network.js").read_text(encoding="utf-8"),
    }
    view.templateEnv.globals["nora"] = {
        "projection": PROJECTION,
        "basemap": json.loads(BASEMAP.read_text()) if BASEMAP.exists() else [],
        "nodeTypes": NODE_TYPES,
        "pipelineTypes": PIPELINE_TYPES,
        "names": {n.id: n.name for n in net.nodes} | {p.id: p.name for p in net.pipelines},
        "deliverable": analysis["deliverable"],
        "worstOutage": max((o["lost"] for o in analysis["outages"]), default=0.0),
        "streams": [stream.payload() for stream in streams],
        "links": links,
    }
    return view.generate_html()
