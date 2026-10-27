"""Build the NORA app page (network.html): a real map and a gas flow overview.

Both views read one payload (`NORA` in the page) and share one set of controls:

  Map   real geolocation: MapLibre GL with OpenFreeMap vector tiles, every asset at
        its true coordinates (templates/map.js)
  Flow  the whole network as a left-to-right schematic on dotted paper, built with
        pyvis (templates/flow.js); positions come from layout.py

pyvis builds the flow view's nodes, edges and options; NORA renders them through its
own template (templates/app.html.j2) instead of pyvis' default one. Scripts and styles
are inlined, so the page is a single file: only MapLibre and the map tiles come from
the web, and the flow view works offline.
"""

from __future__ import annotations

from collections.abc import Sequence
from html import escape
from pathlib import Path

import pyvis
from pyvis.network import Network as PyvisNetwork

from .data import NODE_TYPES, PIPELINE_TYPES, SUPPLY_TYPES, Network
from .icons import COLORS, icon_uri
from .layout import flow_positions
from .stream import Stream

PACKAGE_DIR = Path(__file__).parent
TEMPLATES = PACKAGE_DIR / "templates"
PYVIS_DIR = Path(pyvis.__file__).parent

MAPLIBRE = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl"
MAP_STYLES = {
    "day": "https://tiles.openfreemap.org/styles/positron",
    "night": "https://tiles.openfreemap.org/styles/dark",
}
MAP_BOUNDS = [[-3.5, 50.2], [12.0, 63.9]]  # west, south / east, north: the North Sea

SHORT = {
    "field": "Field",
    "hub": "Riser hub",
    "processing": "Gas plant",
    "terminal": "Terminal",
    "lng": "LNG terminal",
    "storage": "Storage",
    "market": "Market",
}

FONT = "Archivo, system-ui, -apple-system, sans-serif"
FLOW_OPTIONS = {
    "autoResize": True,
    "physics": {"enabled": False},
    "interaction": {
        "hover": True,
        "tooltipDelay": 150,
        "zoomSpeed": 0.6,
        "keyboard": {"enabled": True, "bindToWindow": False},
    },
    "nodes": {
        "shape": "circularImage",
        "size": 16,
        "borderWidth": 0,
        "borderWidthSelected": 3,
        "shapeProperties": {"interpolation": False},
        "font": {"face": FONT, "size": 12, "multi": "html", "vadjust": 3,
                 "bold": {"face": FONT, "size": 13.5, "mod": "bold"}},
    },
    "edges": {
        "smooth": {"type": "cubicBezier", "forceDirection": "horizontal", "roundness": 0.5},
        "arrows": {"to": {"enabled": True, "scaleFactor": 0.4}},
        "arrowStrikethrough": False,
        "hoverWidth": 0.6,
        "selectionWidth": 1.2,
        "font": {"face": FONT, "size": 10, "align": "horizontal", "strokeWidth": 0},
    },
}  # fmt: skip


def _model_flow(net: Network, analysis: dict) -> dict[str, float]:
    """Gas through each node in the max-flow model: supplied, delivered or passed on."""
    through: dict[str, float] = {}
    for pipe in net.pipelines:
        flow = analysis["pipeline_flow"].get(pipe.id, 0.0)
        target = pipe.to_id if flow > 0 else pipe.from_id
        through[target] = through.get(target, 0.0) + abs(flow)
    through |= analysis["supplied"]
    return {node: round(value, 1) for node, value in through.items()}


def assets_payload(net: Network, analysis: dict) -> dict[str, dict]:
    """Everything the details panel shows, for nodes and pipelines alike."""
    outages = {(o["kind"], o["id"]): o for o in analysis["outages"]}
    model = _model_flow(net, analysis)
    assets: dict[str, dict] = {}
    for node in net.nodes:
        outage = outages.get(("node", node.id), {})
        assets[node.id] = {
            "kind": "node",
            "name": node.name,
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
            "modelFlow": model.get(node.id),
            "supply": node.type in SUPPLY_TYPES,
        }
    for pipe in net.pipelines:
        outage = outages.get(("pipeline", pipe.id), {})
        assets[pipe.id] = {
            "kind": "pipeline",
            "name": pipe.name,
            "type": pipe.type,
            "from": pipe.from_id,
            "to": pipe.to_id,
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
            "modelFlow": analysis["pipeline_flow"].get(pipe.id),
            "utilization": analysis["utilization"].get(pipe.id),
        }
    return assets


def map_geojson(net: Network) -> dict[str, dict]:
    """Nodes and pipelines as GeoJSON at their true coordinates. Feature ids are numbers
    because MapLibre keys its per-feature styling (feature state) on them."""
    where = {node.id: [node.lon, node.lat] for node in net.nodes}
    nodes = [
        {
            "type": "Feature",
            "id": i,
            "properties": {"asset": node.id, "name": node.name, "type": node.type},
            "geometry": {"type": "Point", "coordinates": where[node.id]},
        }
        for i, node in enumerate(sorted(net.nodes, key=lambda n: n.id))
    ]
    pipes = [
        {
            "type": "Feature",
            "id": i,
            "properties": {"asset": pipe.id, "onshore": pipe.type == "onshore"},
            "geometry": {
                "type": "LineString",
                "coordinates": [where[pipe.from_id], where[pipe.to_id]],
            },
        }
        for i, pipe in enumerate(sorted(net.pipelines, key=lambda p: p.id))
    ]
    return {
        "nodes": {"type": "FeatureCollection", "features": nodes},
        "pipes": {"type": "FeatureCollection", "features": pipes},
    }


def _flow_view(net: Network) -> PyvisNetwork:
    """The gas flow overview as a pyvis network: icons at stage positions, curved lines."""
    positions = flow_positions(net)
    view = PyvisNetwork(height="100%", width="100%", directed=True, cdn_resources="in_line")
    for node in sorted(net.nodes, key=lambda n: n.id):
        x, y = positions[node.id]
        view.add_node(
            node.id,
            # vis-network renders labels (multi: "html") and titles as HTML, so
            # names from the crowd-edited CSVs must be escaped here.
            label=f"<b>{escape(node.name)}</b>\n{SHORT[node.type]}",
            shape="circularImage",
            image=icon_uri(node.type),
            x=x,
            y=y,
            physics=False,
            title=f"{escape(node.name)}\n{NODE_TYPES[node.type]}, {node.country}",
        )
    for pipe in sorted(net.pipelines, key=lambda p: p.id):
        view.add_edge(
            pipe.from_id,
            pipe.to_id,
            id=pipe.id,
            title=f"{escape(pipe.name)}\n{PIPELINE_TYPES[pipe.type]}",
            arrows="to, from" if pipe.bidirectional else "to",
        )
    view.options = FLOW_OPTIONS
    return view


def network_html(
    net: Network, analysis: dict, streams: Sequence[Stream] = (), links: dict | None = None
) -> str:
    """The app as a single HTML document."""
    view = _flow_view(net)
    view.set_template_dir(str(TEMPLATES), "app.html.j2")
    vis = PYVIS_DIR / "templates" / "lib" / "vis-9.1.2"
    # Scripts and styles go in as plain strings, so Jinja never parses their braces.
    view.templateEnv.globals["inline"] = {
        "vis_css": (vis / "vis-network.css").read_text(encoding="utf-8"),
        "vis_js": (vis / "vis-network.min.js").read_text(encoding="utf-8"),
        "css": (TEMPLATES / "app.css").read_text(encoding="utf-8"),
        "app_js": (TEMPLATES / "app.js").read_text(encoding="utf-8"),
        "map_js": (TEMPLATES / "map.js").read_text(encoding="utf-8"),
        "flow_js": (TEMPLATES / "flow.js").read_text(encoding="utf-8"),
    }
    view.templateEnv.globals["maplibre"] = MAPLIBRE
    worst = max((o["lost"] for o in analysis["outages"]), default=0.0)
    view.templateEnv.globals["nora"] = {
        "assets": assets_payload(net, analysis),
        "geo": map_geojson(net),
        "icons": {kind: icon_uri(kind) for kind in COLORS},
        "colors": COLORS,
        "nodeTypes": NODE_TYPES,
        "pipelineTypes": PIPELINE_TYPES,
        "short": SHORT,
        "mapStyles": MAP_STYLES,
        "bounds": MAP_BOUNDS,
        "deliverable": analysis["deliverable"],
        "worstOutage": worst,
        "streams": [stream.payload() for stream in streams],
        "links": links or {},
    }
    return view.generate_html()
