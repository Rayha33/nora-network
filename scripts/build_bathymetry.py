"""Build data/geo/bathymetry.json: the water depth under the map, so the map's
position readout can say "WD 58 m" for wherever the pointer is.

    python scripts/build_bathymetry.py                 # fetch from EMODnet (a few minutes)
    python scripts/build_bathymetry.py --cache tiles/  # keep the fetched tiles for a rerun
    python scripts/build_bathymetry.py --repack        # re-cut the band from the file, no fetch

The source is the EMODnet Digital Bathymetry (DTM), the European seabed model, read
through its open WCS service, https://ows.emodnet-bathymetry.eu/wcs, licence CC BY 4.0:
credit "EMODnet Bathymetry Consortium, EMODnet Digital Bathymetry (DTM)". The map's
bounds (nora.toml [map] bounds) are fetched in 2-degree tiles, each resampled to a
grid of STEP arc-minutes, and the depths are stored in whole metres (0 = land or no
data). Each row is stored as differences from the point to its west (the seabed
changes slowly, so they pack well: about 600 KB instead of 860), as little-endian
int16, zlib-deflated, in base64. The page inflates it in the browser. EMODnet's mean
depth is the average over its own ~115 m cells, so a reading is the depth of the area
under the pointer, not a sounding.

Only the sea within BAND_KM of the network (its nodes and laid routes) is kept; farther
out is stored as 0, no data. The deep Norwegian Sea basin, far from every pipeline, was
half of the 612 KB and the page's largest single part (review #49802). Rerun with
--repack after adding assets outside the band (tests/test_geo.py says when).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import math
import struct
import sys
import time
import tomllib
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "geo" / "bathymetry.json"
WCS = "https://ows.emodnet-bathymetry.eu/wcs"
STEP = 1.0  # arc-minutes between grid points
TILE = 2.0  # degrees per fetched tile
BAND_KM = 100.0  # depth is kept this far around the network's nodes and routes
AXIS = "http://www.opengis.net/def/axis/OGC/1/"


def bounds() -> tuple[float, float, float, float]:
    """West, south, east, north: the map's bounds from nora.toml."""
    config = tomllib.loads((ROOT / "nora.toml").read_text(encoding="utf-8"))
    (west, south), (east, north) = config["map"]["bounds"]
    return west, south, east, north


def tile_url(west: float, south: float, cols: int, rows: int) -> str:
    return (
        f"{WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=emodnet__mean"
        f"&subset=Lat({south},{south + rows * STEP / 60})"
        f"&subset=Long({west},{west + cols * STEP / 60})"
        f"&format=text/plain&SCALESIZE={AXIS}i({cols}),{AXIS}j({rows})"
    )


def parse(text: str, cols: int, rows: int) -> list[list[float | None]]:
    """The WCS text grid: rows from north to south after "Band 0:"; NaN is land."""
    lines = text.split("Band 0:", 1)[1].strip().splitlines()
    grid = [[None if v.lower() == "nan" else float(v) for v in line.split()] for line in lines]
    if len(grid) != rows or any(len(row) != cols for row in grid):
        raise ValueError(f"expected {rows}x{cols} values, got {len(grid)} rows")
    return grid


def fetch(url: str, cache: Path | None, attempts: int = 4) -> str:
    path = cache / f"{hashlib.sha1(url.encode()).hexdigest()[:16]}.txt" if cache else None
    if path and path.exists():
        return path.read_text(encoding="utf-8")
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=120) as response:
                text = response.read().decode("utf-8")
            if "Band 0:" not in text:
                raise ValueError(text[:200])
            if path:
                path.write_text(text, encoding="utf-8")
            return text
        except (OSError, ValueError, http.client.HTTPException) as error:  # incl. a read cut short
            print(f"  attempt {attempt}: {error}", file=sys.stderr)
            time.sleep(5 * attempt)
    raise SystemExit(f"could not fetch {url}")


def build(cache: Path | None) -> dict:
    west, south, east, north = bounds()
    per_tile = round(TILE * 60 / STEP)
    width, height = math.ceil((east - west) * 60 / STEP), math.ceil((north - south) * 60 / STEP)
    depth = [[0] * width for _ in range(height)]  # row 0 is the north edge
    jobs = []
    for top in range(0, height, per_tile):
        for left in range(0, width, per_tile):
            rows, cols = min(per_tile, height - top), min(per_tile, width - left)
            tile_south = north - (top + rows) * STEP / 60
            url = tile_url(west + left * STEP / 60, tile_south, cols, rows)
            jobs.append((top, left, rows, cols, url))
    print(f"{len(jobs)} tiles for a {width}x{height} grid at {STEP} arc-minutes")
    with ThreadPoolExecutor(max_workers=4) as pool:
        texts = list(pool.map(lambda job: fetch(job[4], cache), jobs))
    for (top, left, rows, cols, _), text in zip(jobs, texts, strict=True):
        for i, row in enumerate(parse(text, cols, rows)):
            for j, value in enumerate(row):
                # elevation below sea level is water depth; land and no data are 0
                below = value is not None and value < -0.5
                depth[top + i][left + j] = round(-value) if below else 0
    return pack(depth, west, north, width, height)


def network_points() -> list[tuple[float, float]]:
    """(lon, lat) of every node and along every pipeline: its laid route, or the chord."""
    sys.path.insert(0, str(ROOT / "src"))
    from nora.data import load_network
    from nora.render import routes

    net, laid = load_network(), routes()
    where = {n.id: (n.lon, n.lat) for n in net.nodes}
    points = list(where.values())
    for pipe in net.pipelines:
        line = laid.get(pipe.id) or [where[pipe.from_id], where[pipe.to_id]]
        for (x0, y0, *_), (x1, y1, *_) in zip(line, line[1:], strict=False):
            n = max(1, math.ceil(max(abs(x1 - x0), abs(y1 - y0)) / (STEP / 60)))
            points += [(x0 + (x1 - x0) * t / n, y0 + (y1 - y0) * t / n) for t in range(n + 1)]
    return points


def band(depth: list[list[int]], west: float, north: float, km: float = BAND_KM) -> None:
    """Zero every cell farther than `km` from the network, in place.

    A two-pass chamfer distance in kilometres (a degree of longitude shrinks with
    latitude), seeded at the cells under the network's points: exact enough for a
    band, and fast in plain Python."""
    height, width, step = len(depth), len(depth[0]), STEP / 60
    far = float("inf")
    dist = [[far] * width for _ in range(height)]
    for lon, lat in network_points():
        r, c = int((north - lat) / step), int((lon - west) / step)
        if 0 <= r < height and 0 <= c < width:
            dist[r][c] = 0.0
    dy = step * 111.2
    dx = [step * 111.2 * math.cos(math.radians(north - (r + 0.5) * step)) for r in range(height)]
    for rows, cols, sign in (
        (range(height), range(width), -1),
        (range(height - 1, -1, -1), range(width - 1, -1, -1), 1),
    ):
        for r in rows:
            row, prev = dist[r], (dist[r + sign] if 0 <= r + sign < height else None)
            diag = math.hypot(dx[r], dy)
            for c in cols:
                best = row[c]
                if 0 <= c + sign < width:
                    best = min(best, row[c + sign] + dx[r])
                if prev is not None:
                    best = min(best, prev[c] + dy)
                    if 0 <= c + sign < width:
                        best = min(best, prev[c + sign] + diag)
                    if 0 <= c - sign < width:
                        best = min(best, prev[c - sign] + diag)
                row[c] = best
    for r in range(height):
        depth[r] = [d if dist[r][c] <= km else 0 for c, d in enumerate(depth[r])]


def unpack(stored: dict) -> list[list[int]]:
    """The grid of whole metres from bathymetry.json (rows from north)."""
    raw = zlib.decompress(base64.b64decode(stored["data"]))
    deltas = struct.unpack(f"<{len(raw) // 2}h", raw)
    width, height = stored["width"], stored["height"]
    grid = []
    for r in range(height):
        row, total = [], 0
        for d in deltas[r * width : (r + 1) * width]:
            total += d
            row.append(total)
        grid.append(row)
    return grid


def pack(depth: list[list[int]], west: float, north: float, width: int, height: int) -> dict:
    band(depth, west, north)
    deltas = [d - (row[i - 1] if i else 0) for row in depth for i, d in enumerate(row)]
    raw = struct.pack(f"<{len(deltas)}h", *deltas)
    return {
        "source": "EMODnet Bathymetry Consortium, EMODnet Digital Bathymetry (DTM), "
        f"{WCS}, licence CC BY 4.0",
        "west": west,
        "north": north,
        "step": STEP / 60,  # degrees between grid points
        "width": width,
        "height": height,
        "encoding": "zlib, int16 little-endian differences along each row (from 0 at its "
        "west end), metres, rows from north, 0 = land or no data",
        "band_km": BAND_KM,  # sea farther than this from the network is stored as 0
        "data": base64.b64encode(zlib.compress(raw, 9)).decode("ascii"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--cache", type=Path, help="folder to keep fetched tiles in")
    parser.add_argument("--out", type=Path, default=OUT)
    parser.add_argument("--repack", action="store_true", help="re-cut the band from --out")
    args = parser.parse_args()
    if args.repack:
        stored = json.loads(args.out.read_text(encoding="utf-8"))
        result = {
            **stored,
            **pack(
                unpack(stored), stored["west"], stored["north"], stored["width"], stored["height"]
            ),
        }
    else:
        if args.cache:
            args.cache.mkdir(parents=True, exist_ok=True)
        result = build(args.cache)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {args.out}: {len(result['data']) // 1024} KB of depth data")


if __name__ == "__main__":
    main()
