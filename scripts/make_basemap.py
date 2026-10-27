"""Rebuild src/nora/assets/basemap.json, the coastline drawn behind the network.

Source: Natural Earth 1:50m land polygons (public domain), ne_50m_land.geojson from
https://github.com/nvkelso/natural-earth-vector/tree/master/geojson

    python scripts/make_basemap.py path/to/ne_50m_land.geojson

Clips the land to the map window, simplifies it, and writes each ring as a flat
[lon, lat, lon, lat, ...] list rounded to 3 decimals.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

WINDOW = (-8.0, 48.0, 18.0, 70.0)  # west, south, east, north
TOLERANCE = 0.025  # degrees; about 2.5 km
OUT = Path(__file__).resolve().parents[1] / "src" / "nora" / "assets" / "basemap.json"


def clip(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Sutherland-Hodgman clip of a polygon ring against the rectangular window."""
    west, south, east, north = WINDOW
    edges = [
        (lambda p: p[0] >= west, lambda a, b: _at_x(a, b, west)),
        (lambda p: p[0] <= east, lambda a, b: _at_x(a, b, east)),
        (lambda p: p[1] >= south, lambda a, b: _at_y(a, b, south)),
        (lambda p: p[1] <= north, lambda a, b: _at_y(a, b, north)),
    ]
    for inside, cross in edges:
        if not ring:
            break
        clipped = []
        previous = ring[-1]
        for point in ring:
            if inside(point):
                if not inside(previous):
                    clipped.append(cross(previous, point))
                clipped.append(point)
            elif inside(previous):
                clipped.append(cross(previous, point))
            previous = point
        ring = clipped
    return ring


def _at_x(a, b, x):
    t = (x - a[0]) / (b[0] - a[0])
    return (x, a[1] + t * (b[1] - a[1]))


def _at_y(a, b, y):
    t = (y - a[1]) / (b[1] - a[1])
    return (a[0] + t * (b[0] - a[0]), y)


def simplify(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Douglas-Peucker simplification (iterative, so long coastlines do not recurse deeply)."""
    if len(points) < 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        worst, index = 0.0, None
        for i in range(first + 1, last):
            distance = _to_segment(points[i], points[first], points[last])
            if distance > worst:
                worst, index = distance, i
        if index is not None and worst > TOLERANCE:
            keep[index] = True
            stack += [(first, index), (index, last)]
    return [p for p, kept in zip(points, keep, strict=True) if kept]


def _to_segment(point, start, end) -> float:
    """Distance from point to the segment start-end (closed rings have start == end)."""
    (x, y), (x1, y1), (x2, y2) = point, start, end
    dx, dy = x2 - x1, y2 - y1
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / length))
    return ((x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2) ** 0.5


def main(source: str) -> None:
    features = json.loads(Path(source).read_text())["features"]
    rings = []
    for feature in features:
        geometry = feature["geometry"]
        polygons = (
            geometry["coordinates"]
            if geometry["type"] == "MultiPolygon"
            else [geometry["coordinates"]]
        )
        for polygon in polygons:
            ring = simplify(clip([tuple(p) for p in polygon[0]]))
            if len(ring) >= 4:
                rings.append([round(c, 3) for point in ring for c in point])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rings, separators=(",", ":")))
    print(f"wrote {OUT} ({len(rings)} rings, {OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main(sys.argv[1])
