"""The land under the simple map (data/geo/coastline.json, drawn by map2d.js when the
browser has no WebGL): land is land and the sea stays sea."""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _script():
    path = ROOT / "scripts" / "build_coastline.py"
    spec = importlib.util.spec_from_file_location("build_coastline", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def inside(point, rings):
    """Even-odd fill, as the canvas draws the land: is the point on land?"""
    x, y = point
    crossings = 0
    for ring in rings:
        for (ax, ay), (bx, by) in zip(ring, ring[1:] + ring[:1], strict=True):
            if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
                crossings += 1
    return crossings % 2 == 1


def test_a_ring_across_the_date_line_is_clipped_where_it_really_is():
    """Natural Earth cuts Eurasia at the date line (Chukotka), so its ring jumps from
    +180 to -180 and back. Taken as straight lines in degrees, those two jumps cross the
    whole map at 65 and 69 N and the clip filled the Norwegian Sea between them as land."""
    script = _script()
    # A body from 0 to 179 E, 50-60 N, with an arm over the date line at 66-69 N.
    ring = [
        (0, 50), (179, 50), (179, 66), (-179, 66), (-170, 66), (-170, 69),
        (-179, 69), (179, 69), (178, 69), (178, 60), (0, 60),
    ]  # fmt: skip
    clipped = script.clip(script.unwrap(ring))
    assert inside((5, 55), [clipped]), "the body inside the box is land"
    assert not inside((5, 67), [clipped]), "the sea north of it is not"
    west, south, east, north = script.BOX
    assert all(west <= x <= east and south <= y <= north for x, y in clipped)


def test_the_shipped_land_leaves_the_norwegian_sea_open():
    land = json.loads((ROOT / "data" / "geo" / "coastline.json").read_text())["rings"]
    for sea in [(0, 67), (5, 69), (-10, 66), (3, 56), (20, 70.9)]:
        assert not inside(sea, land), f"{sea} is sea"
    for ground in [(10, 61), (-3, 53), (15, 65), (9, 56), (-3.5, 57.1)]:
        assert inside(ground, land), f"{ground} is land"
