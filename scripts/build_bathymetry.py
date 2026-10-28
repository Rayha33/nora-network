"""Build data/geo/bathymetry.json: the water depth under the map, so the map's
position readout can say "WD 58 m" for wherever the pointer is.

    python scripts/build_bathymetry.py                 # fetch from EMODnet (a few minutes)
    python scripts/build_bathymetry.py --cache tiles/  # keep the fetched tiles for a rerun

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
        "data": base64.b64encode(zlib.compress(raw, 9)).decode("ascii"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--cache", type=Path, help="folder to keep fetched tiles in")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    if args.cache:
        args.cache.mkdir(parents=True, exist_ok=True)
    result = build(args.cache)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {args.out}: {len(result['data']) // 1024} KB of depth data")


if __name__ == "__main__":
    main()
