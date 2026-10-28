"""Build data/geo/coastline.json: the land around the North Sea, for the map NORA draws
itself when the browser has no WebGL (and so MapLibre cannot draw).

    python scripts/build_coastline.py                # download and build
    python scripts/build_coastline.py --from land-10m.json

The source is Natural Earth's 1:10m land polygons (public domain,
https://www.naturalearthdata.com), as the TopoJSON file of the world-atlas package
(pinned below). The script decodes the TopoJSON, clips every ring to the box around the
network, simplifies it (Douglas-Peucker, in degrees) and rounds to 2 decimals, so the
file stays small enough to ship inside network.html (about 60 KB).
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from pathlib import Path

URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-10m.json"
OUT = Path(__file__).resolve().parents[1] / "data" / "geo" / "coastline.json"
BOX = (-14.0, 46.0, 24.0, 71.0)  # west, south, east, north: the network with a margin
TOLERANCE = 0.03  # degrees, about 3 km: invisible at the zooms the fallback map uses
MIN_AREA = 0.03  # square degrees: drop islets smaller than this
DECIMALS = 2  # about 1 km


def decode(topology: dict) -> list[list[tuple[float, float]]]:
    """Every ring of the TopoJSON's land object, in lon/lat."""
    sx, sy = topology["transform"]["scale"]
    tx, ty = topology["transform"]["translate"]
    arcs = []
    for arc in topology["arcs"]:
        x = y = 0
        points = []
        for dx, dy in arc:  # quantised and delta-encoded
            x, y = x + dx, y + dy
            points.append((x * sx + tx, y * sy + ty))
        arcs.append(points)

    def ring(indices: list[int]) -> list[tuple[float, float]]:
        out: list[tuple[float, float]] = []
        for i in indices:
            points = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(points[1:] if out else points)
        return out

    rings = []
    for geometry in topology["objects"]["land"]["geometries"]:
        polygons = geometry["arcs"] if geometry["type"] == "MultiPolygon" else [geometry["arcs"]]
        for polygon in polygons:
            rings.extend(ring(r) for r in polygon)
    return rings


def clip(points: list[tuple[float, float]], box=BOX) -> list[tuple[float, float]]:
    """Sutherland-Hodgman against the box: a filled ring stays a filled ring."""
    west, south, east, north = box
    edges = [
        (lambda p: p[0] >= west, lambda a, b: _at_x(a, b, west)),
        (lambda p: p[0] <= east, lambda a, b: _at_x(a, b, east)),
        (lambda p: p[1] >= south, lambda a, b: _at_y(a, b, south)),
        (lambda p: p[1] <= north, lambda a, b: _at_y(a, b, north)),
    ]
    for inside, cross in edges:
        if not points:
            break
        source, points = points, []
        previous = source[-1]
        for current in source:
            if inside(current):
                if not inside(previous):
                    points.append(cross(previous, current))
                points.append(current)
            elif inside(previous):
                points.append(cross(previous, current))
            previous = current
    return points


def _at_x(a, b, x):
    return (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))


def _at_y(a, b, y):
    return (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y)


def simplify(points: list[tuple[float, float]], tolerance: float) -> list[tuple[float, float]]:
    """Douglas-Peucker, iterative so long coastlines do not hit the recursion limit."""
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        (ax, ay), (bx, by) = points[first], points[last]
        dx, dy = bx - ax, by - ay
        length = (dx * dx + dy * dy) ** 0.5
        worst, index = 0.0, None
        for i in range(first + 1, last):
            px, py = points[i]
            if length:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / length
            else:
                d = ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > worst:
                worst, index = d, i
        if index is not None and worst > tolerance:
            keep[index] = True
            stack += [(first, index), (index, last)]
    return [p for p, k in zip(points, keep, strict=True) if k]


def area(points: list[tuple[float, float]]) -> float:
    return (
        abs(
            sum(
                a[0] * b[1] - b[0] * a[1]
                for a, b in zip(points, points[1:] + points[:1], strict=True)
            )
        )
        / 2
    )


def build(topology: dict) -> dict:
    rings = []
    for raw in decode(topology):
        ring = simplify(clip(raw), TOLERANCE)
        if len(ring) >= 4 and area(ring) >= MIN_AREA:
            rings.append([[round(x, DECIMALS), round(y, DECIMALS)] for x, y in ring])
    return {
        "source": f"Natural Earth 1:10m land (public domain), via {URL}",
        "box": list(BOX),
        "rings": rings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", type=Path, help="a local land TopoJSON file")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    if args.source:
        topology = json.loads(args.source.read_text(encoding="utf-8"))
    else:
        with urllib.request.urlopen(URL, timeout=60) as response:
            topology = json.load(response)
    result = build(topology)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    points = sum(len(r) for r in result["rings"])
    print(f"Wrote {args.out}: {len(result['rings'])} rings, {points} points")


if __name__ == "__main__":
    main()
