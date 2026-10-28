"""Build data/geo/routes.json: the real routes of NORA's pipelines, so the map draws
each line where it is laid instead of straight from end to end.

    python scripts/build_routes.py                    # download SODIR's pipelines
    python scripts/build_routes.py --from pipLine.csv

The source is the Norwegian Offshore Directorate's (SODIR) pipeline register,
https://factpages.sodir.no/downloads/csv/pipLine.zip, licence NLOD
(https://data.norge.no/nlod/en): credit "Norwegian Offshore Directorate". Its
geometries run to the landing terminals (Emden, Dornum, Zeebrugge, Dunkerque,
Easington, St Fergus). Lines outside it (UK, Dutch and Danish systems) keep a
straight line on the map.

SEGMENTS maps each NORA pipeline to the SODIR segments that make it up, as
(from facility, to facility) pairs in the order the gas flows; the script joins them,
splits Europipe II and Baltic Pipe where NORA has a tie-in node, simplifies the line
(Douglas-Peucker, about 300 m) and rounds to 3 decimals.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://factpages.sodir.no/downloads/csv/pipLine.zip"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "geo" / "routes.json"
TOLERANCE = 0.003  # degrees, about 300 m

# NORA pipeline id -> SODIR (fclNameFrom, fclNameTo) segments, in the direction of flow.
SEGMENTS = {
    "troll_kollsnes": [("TROLL A", "KOLLSNES")],
    "kvitebjorn_kollsnes": [("KVITEBJØRN", "KOLLSNES")],
    "visund_kvitebjorn": [("VISUND", "VISUND T")],
    "ogt": [("OSEBERG D", "HEIMDAL HRP")],
    "statpipe_rich": [("STATFJORD B", "STAT-SSTC"), ("STAT-SSTC", "KÅRSTØ")],
    "statpipe_dry": [("KÅRSTØ", "DRAUPNER S")],
    "statpipe_heimdal": [("HEIMDAL", "DRAUPNER S")],
    "statpipe_ekofisk": [("DRAUPNER S", "NORPIPE Y")],
    "sleipner_draupner": [("SLEIPNER R", "DRAUPNER S")],
    "zeepipe_2a": [("KOLLSNES", "SLEIPNER R")],
    "zeepipe_2b": [("KOLLSNES", "DRAUPNER E")],
    "langeled_north": [("NYHAMNA", "SLEIPNER R")],
    "langeled_south": [("SLEIPNER R", "EASINGTON")],
    "asgard_transport": [("ÅSGARD ERB", "KÅRSTØ")],
    "polarled": [("AASTA HANSTEEN PLEM", "NYHAMNA")],
    "ormen_lange_nyhamna": [("ORMEN LANGE A", "NYHAMNA")],
    "gudrun_sleipner": [("GUDRUN", "SLEIPNER A")],
    "uhgp": [("EDVARD GRIEG", "SAGE-T")],
    "haltenpipe": [("HEIDRUN", "TJELDBERGODDEN")],
    "heidrun_asgard": [("HEIDRUN", "NORNE/HEIDRUN T")],
    "ngts": [("NORNE ERB", "NORNE/HEIDRUN T")],
    "norpipe": [
        ("EKOFISK J", "NORPIPE Y"),
        ("NORPIPE Y", "B-11"),
        ("B-11", "H-7 BP"),
        ("H-7 BP", "EMDEN"),
    ],
    "europipe_1": [("DRAUPNER E", "EUROPIPE-SCP"), ("EUROPIPE-SCP", "EMDEN")],
    "franpipe": [("DRAUPNER E", "DUNKERQUE")],
    "zeepipe_1": [("SLEIPNER R", "ZEEPIPE-SCP"), ("ZEEPIPE-SCP", "ZEEBRUGGE")],
    "vesterled": [("HEIMDAL HRP", "ST.FERGUS")],
    "tampen_link": [("STATFJORD B", "FLAGS-T")],
    "gjoa_flags": [("GJØA", "GJØA-T")],
}
# One SODIR line that NORA splits at a tie-in node: (whole route, [(nora id, until node)]).
SPLITS = {
    "europipe_2": (
        [("KÅRSTØ", "EMDEN")],
        [("europipe_2_north", "baltic_tie"), ("europipe_2_south", None)],
    ),
    "baltic_pipe": (
        [("NYBRO TEE", "Niechorze-Pogorzelica, Polen")],
        [("baltic_pipe_ns", "nybro"), ("baltic_pipe_east", None)],
    ),
}


def lines(text: str) -> dict[tuple[str, str], list[list[list[float]]]]:
    """In-service SODIR gas pipelines: (from, to) -> the parts of its route, each a
    list of [lon, lat]. SODIR does not store a MULTILINESTRING's parts in order."""
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        if row["pplCurrentPhase"] != "IN SERVICE" or not row["pplMedium"].lower().startswith("gas"):
            continue
        parts = [
            [[float(v) for v in pair.split()] for pair in part.split(",")]
            for part in re.findall(r"\(([^()]+)\)", row["pipGeometryWKT"])
        ]
        if parts:
            out.setdefault((row["fclNameFrom"], row["fclNameTo"]), parts)
    return out


def _d2(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def walk(parts: list[list[list[float]]], start: list[float]) -> list[list[float]]:
    """One line from unordered parts: from `start`, keep taking the part with an end
    nearest to where the line has got to, turned to continue from there."""
    # Degenerate parts (all on one spot) are noise in the register: leave them out.
    rest = [list(p) for p in parts if max(_d2(p[0], q) for q in p) > 0.0001]
    line, here = [], start
    while rest:
        i = min(range(len(rest)), key=lambda k: min(_d2(rest[k][0], here), _d2(rest[k][-1], here)))
        part = rest.pop(i)
        if _d2(part[-1], here) < _d2(part[0], here):
            part = part[::-1]
        if line and _d2(part[0], here) > 0.2**2:
            continue  # not connected to where the line has got to (a stray piece)
        line.extend(part)
        here = line[-1]
    return line


def chain(
    found: dict, segments: list[tuple[str, str]], start: list[float]
) -> list[list[float]] | None:
    """Join the segments in order of flow, starting from `start` (the NORA node the
    pipeline leaves from); each next segment continues from where the last one ended."""
    route: list[list[float]] = []
    for key in segments:
        parts = found.get(key)
        if parts is None:
            return None
        route.extend(walk(parts, route[-1] if route else start))
    return route


def simplify(points: list[list[float]], tolerance: float = TOLERANCE) -> list[list[float]]:
    if len(points) < 3:
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
            d = abs(dy * px - dx * py + bx * ay - by * ax) / length if length else 0.0
            if d > worst:
                worst, index = d, i
        if index is not None and worst > tolerance:
            keep[index] = True
            stack += [(first, index), (index, last)]
    return [p for p, k in zip(points, keep, strict=True) if k]


def nodes() -> dict[str, list[float]]:
    with (ROOT / "data" / "nodes.csv").open(encoding="utf-8", newline="") as handle:
        return {r["id"]: [float(r["lon"]), float(r["lat"])] for r in csv.DictReader(handle)}


def pipeline_starts() -> dict[str, str]:
    with (ROOT / "data" / "pipelines.csv").open(encoding="utf-8", newline="") as handle:
        return {r["id"]: r["from"] for r in csv.DictReader(handle)}


def build(text: str) -> dict:
    found = lines(text)
    where = nodes()
    routes, missing = {}, []
    starts = pipeline_starts()
    for pid, segments in SEGMENTS.items():
        route = chain(found, segments, where[starts[pid]])
        if route:
            routes[pid] = route
        else:
            missing.append(pid)
    for whole, pieces in SPLITS.values():
        route = chain(found, whole, where[starts[pieces[0][0]]])
        if not route:
            missing += [pid for pid, _ in pieces]
            continue
        start = 0
        for pid, until in pieces:
            if until is None:
                routes[pid] = route[start:]
                continue
            target = where[until]
            cut = min(
                range(start, len(route)),
                key=lambda i: (route[i][0] - target[0]) ** 2 + (route[i][1] - target[1]) ** 2,
            )
            routes[pid] = route[start : cut + 1]
            start = cut
    out = {
        pid: [[round(x, 3), round(y, 3)] for x, y in simplify(points)]
        for pid, points in sorted(routes.items())
    }
    return {
        "source": f"Norwegian Offshore Directorate (SODIR) pipeline register, {URL}, licence NLOD",
        "routes": out,
        "missing": sorted(missing),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", type=Path, help="a local pipLine.csv")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    if args.source:
        text = args.source.read_text(encoding="utf-8-sig")
    else:
        with urllib.request.urlopen(URL, timeout=60) as response:
            archive = zipfile.ZipFile(io.BytesIO(response.read()))
        text = archive.read("pipLine.csv").decode("utf-8-sig")
    result = build(text)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(result, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8"
    )
    points = sum(len(r) for r in result["routes"].values())
    print(f"Wrote {args.out}: {len(result['routes'])} routes, {points} points")
    if result["missing"]:
        print("No SODIR route for:", ", ".join(result["missing"]), file=sys.stderr)


if __name__ == "__main__":
    main()
