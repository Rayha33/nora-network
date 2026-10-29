"""Build data/geo/routes.json: the real routes of NORA's pipelines, so the map draws
each line where it is laid instead of straight from end to end.

    python scripts/build_routes.py                    # download all three public registers
    python scripts/build_routes.py --from pipLine.csv  # SODIR only, as before
    python scripts/build_routes.py --from pipLine.csv --nsta-from nsta.json \
        --emodnet-from emodnet.json                  # complete offline build

Sources:
- Norwegian Offshore Directorate (SODIR) pipeline register, licence NLOD:
  https://factpages.sodir.no/downloads/csv/pipLine.zip
- North Sea Transition Authority (NSTA), UKCS offshore infrastructure pipelines (WGS84):
  the NSTA_URL FeatureServer below.
- EMODnet Human Activities, Pipelines, licence CC BY 4.0: actual offshore routes in the
  Netherlands and Denmark. https://emodnet.ec.europa.eu/en/human-activities

SEGMENTS maps each NORA pipeline to the SODIR segments that make it up, as
(from facility, to facility) pairs in the order the gas flows; NSTA_ROUTES and
EMODNET_ROUTES do the same with stable public pipeline identifiers. The script joins the
parts, splits Europipe II, Baltic Pipe and CATS where NORA has a tie-in node, simplifies
lines (Douglas-Peucker, about 300 m) and rounds to 3 decimals. Notional market/grid links
and aggregate gathering systems deliberately stay straight and dashed where applicable.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

SODIR_URL = "https://factpages.sodir.no/downloads/csv/pipLine.zip"
NSTA_LAYER = (
    "https://services-eu1.arcgis.com/OZMfUznmLTnWccBc/arcgis/rest/services/"
    "UKCS_offshore_infrastructure_pipeline_linear_(WGS84)/FeatureServer/1"
)
NSTA_URL = NSTA_LAYER + "/query"
EMODNET_WFS = "https://ows.emodnet-humanactivities.eu/wfs"
EMODNET_RECORD = (
    "https://emodnet.ec.europa.eu/geonetwork/srv/api/records/aca3dd01-77ac-47fe-8291-6ca916daaa6d"
)
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
    "skarv_asgard_t": [("SKARV ERB", "ÅSGARD T")],
    "draugen_asgard_t": [("DRAUGEN", "DRAUGEN T")],
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
    "asgard_transport": (
        [("ÅSGARD ERB", "KÅRSTØ")],
        [
            ("asgard_transport_inlet", "asgard_t"),
            ("asgard_transport_upper", "draugen_t"),
            ("asgard_transport", None),
        ],
    ),
    "europipe_2": (
        [("KÅRSTØ", "EMDEN")],
        [("europipe_2_north", "baltic_tie"), ("europipe_2_south", None)],
    ),
    "baltic_pipe": (
        [("NYBRO TEE", "Niechorze-Pogorzelica, Polen")],
        [("baltic_pipe_ns", "nybro"), ("baltic_pipe_east", None)],
    ),
}

# UK routes: NORA pipeline id -> NSTA's stable pipeline number. CATS is handled
# separately because NORA divides PL774 at the Culzean/Stella tie-in (CATS T5).
NSTA_ROUTES = {
    "flags": "PL2",
    "sage": "PL762",
    "culzean_cats": "PL4106",
    "seal": "PL1570",
    "iuk": "PL1339",
    "bbl": "PL2225",
}
NSTA_CATS = "PL774"

# Dutch and Danish routes: NORA pipeline id -> EMODnet pipeline ids, in flow order.
# NOGAT is two registered lines: F3-FB -> L2-FA -> Callantsoog/Den Helder.
EMODNET_ROUTES = {
    "nogat": ["PL0090_PR", "PL0091_PR"],
    "ngt": ["PL0003_PR"],
    "wgt": ["PL0004_PR"],
    "tyra_f3": ["PL0162_PR"],
    "tyra_nybro": ["PL1017_PR"],
}

CREDITS = {
    "sodir": f"Norwegian Offshore Directorate (SODIR), {SODIR_URL}, licence NLOD",
    "nsta": f"North Sea Transition Authority (NSTA), UKCS pipeline linear WGS84, {NSTA_LAYER}",
    "emodnet": f"EMODnet Human Activities, Pipelines, {EMODNET_RECORD}, licence CC BY 4.0",
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


def chain(found: dict, segments: list, start: list[float]) -> list[list[float]] | None:
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


def split_route(
    route: list[list[float]], pieces: list[tuple[str, str | None]], where: dict
) -> dict[str, list[list[float]]]:
    """Split one registered trunk at NORA's tie-in nodes, retaining both sides of a cut."""
    out = {}
    start = 0
    for pid, until in pieces:
        if until is None:
            out[pid] = route[start:]
            continue
        target = where[until]
        cut = min(
            range(start, len(route)),
            key=lambda i: (route[i][0] - target[0]) ** 2 + (route[i][1] - target[1]) ** 2,
        )
        out[pid] = route[start : cut + 1]
        start = cut
    return out


def nsta_parts(data: dict) -> dict[str, list]:
    """The longest active gas pipeline for each needed NSTA number (spools and concrete
    mattresses can share a number with the trunk). ArcGIS paths are equivalent to parts."""
    wanted = set(NSTA_ROUTES.values()) | {NSTA_CATS}
    chosen = {}
    for feature in data.get("features", []):
        attr = feature.get("attributes", {})
        number = attr.get("NSTAPIPNO")
        geometry = feature.get("geometry") or {}
        if (
            number not in wanted
            or attr.get("INF_TYPE") != "PIPELINE"
            or attr.get("FLUID") != "GAS"
            or attr.get("STATUS") != "ACTIVE"
            or not geometry.get("paths")
        ):
            continue
        length = attr.get("LENGTH_M") or 0
        if number not in chosen or length > chosen[number][0]:
            chosen[number] = (length, geometry["paths"])
    return {number: value[1] for number, value in chosen.items()}


def emodnet_parts(data: dict) -> dict[str, list]:
    """EMODnet's public pipeline id -> its MultiLineString parts in WGS84."""
    wanted = {key for keys in EMODNET_ROUTES.values() for key in keys}
    out = {}
    for feature in data.get("features", []):
        key = feature.get("properties", {}).get("id")
        geometry = feature.get("geometry") or {}
        if key not in wanted or not geometry.get("coordinates"):
            continue
        coordinates = geometry["coordinates"]
        out[key] = [coordinates] if geometry.get("type") == "LineString" else coordinates
    return out


def build(text: str, nsta_data: dict | None = None, emodnet_data: dict | None = None) -> dict:
    found = lines(text)
    where = nodes()
    routes, missing, route_sources = {}, [], {}
    starts = pipeline_starts()
    for pid, segments in SEGMENTS.items():
        route = chain(found, segments, where[starts[pid]])
        if route:
            routes[pid] = route
            route_sources[pid] = "sodir"
        else:
            missing.append(pid)
    for whole, pieces in SPLITS.values():
        route = chain(found, whole, where[starts[pieces[0][0]]])
        if not route:
            missing += [pid for pid, _ in pieces]
            continue
        routes.update(split_route(route, pieces, where))
        route_sources.update({pid: "sodir" for pid, _ in pieces})

    if nsta_data is not None:
        found_nsta = nsta_parts(nsta_data)
        for pid, number in NSTA_ROUTES.items():
            parts = found_nsta.get(number)
            route = walk(parts, where[starts[pid]]) if parts else None
            if route:
                routes[pid] = route
                route_sources[pid] = "nsta"
            else:
                missing.append(pid)
        pieces = [("cats_north", "cats_t5"), ("cats", None)]
        parts = found_nsta.get(NSTA_CATS)
        route = walk(parts, where[starts[pieces[0][0]]]) if parts else None
        if route:
            routes.update(split_route(route, pieces, where))
            route_sources.update({pid: "nsta" for pid, _ in pieces})
        else:
            missing += [pid for pid, _ in pieces]

    if emodnet_data is not None:
        found_emodnet = emodnet_parts(emodnet_data)
        for pid, segments in EMODNET_ROUTES.items():
            route = chain(found_emodnet, segments, where[starts[pid]])
            if route:
                routes[pid] = route
                route_sources[pid] = "emodnet"
            else:
                missing.append(pid)

    out = {
        pid: [[round(x, 3), round(y, 3)] for x, y in simplify(points)]
        for pid, points in sorted(routes.items())
    }
    used = set(route_sources.values())
    return {
        "source": " | ".join(credit for key, credit in CREDITS.items() if key in used),
        "sources": {key: credit for key, credit in CREDITS.items() if key in used},
        "route_sources": {pid: route_sources[pid] for pid in sorted(out)},
        "routes": out,
        "missing": sorted(missing),
    }


def download_json(url: str, params: dict, *, post: bool = False) -> dict:
    """One JSON API response; NSTA uses POST so its query stays readable and robust."""
    body = urllib.parse.urlencode(params).encode() if post else None
    if not post:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, data=body)
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def download_nsta() -> dict:
    numbers = sorted(set(NSTA_ROUTES.values()) | {NSTA_CATS})
    quoted = ",".join(f"'{number}'" for number in numbers)
    return download_json(
        NSTA_URL,
        {
            "f": "json",
            "where": f"NSTAPIPNO IN ({quoted}) AND INF_TYPE = 'PIPELINE'",
            "outFields": "OBJECTID,NSTAPIPNO,PIPE_NAME,INF_TYPE,FLUID,STATUS,LENGTH_M",
            "returnGeometry": "true",
            "outSR": "4326",
            "resultRecordCount": 100,
        },
        post=True,
    )


def download_emodnet() -> dict:
    return download_json(
        EMODNET_WFS,
        {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": "emodnet:pipelines",
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
            "bbox": "-3.5,50.2,15.5,67.4,EPSG:4326",
            "count": 10000,
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--from", dest="source", type=Path, help="a local SODIR pipLine.csv")
    parser.add_argument("--nsta-from", type=Path, help="a local NSTA FeatureServer JSON response")
    parser.add_argument("--emodnet-from", type=Path, help="a local EMODnet WFS GeoJSON response")
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    if args.source:
        text = args.source.read_text(encoding="utf-8-sig")
    else:
        with urllib.request.urlopen(SODIR_URL, timeout=60) as response:
            archive = zipfile.ZipFile(io.BytesIO(response.read()))
        text = archive.read("pipLine.csv").decode("utf-8-sig")

    def optional(path: Path | None, download) -> dict | None:
        if path:
            return json.loads(path.read_text(encoding="utf-8-sig"))
        # --from on its own retains the old SODIR-only offline behaviour.
        return None if args.source else download()

    result = build(
        text,
        nsta_data=optional(args.nsta_from, download_nsta),
        emodnet_data=optional(args.emodnet_from, download_emodnet),
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(result, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8"
    )
    points = sum(len(r) for r in result["routes"].values())
    print(f"Wrote {args.out}: {len(result['routes'])} routes, {points} points")
    if result["missing"]:
        print("No registered route for:", ", ".join(result["missing"]), file=sys.stderr)


if __name__ == "__main__":
    main()
