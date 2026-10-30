"""Rows for the producing fields and satellites shown on the zoomed-in Map, from SODIR.

    python scripts/build_satellites.py fclPoint.csv fldArea.csv field_description.csv

Ray, 30 Oct: "if zoomed in view i should be able to see much more details like more fields
and satellites (do the proper research to find the exact coordinates) and add them and
pipelines to the map view". Every field below is producing (SODIR fldArea), placed on its
own installation (SODIR fclPoint: the FPSO, platform or subsea template in service), or,
where SODIR registers none, at the middle of SODIR's field outline. Each is tied back to
the host SODIR's field description names (HOSTS: the description's own words are in the
row's notes) by a schematic line. They are detail for the Map only: capacity 0, so the
deliverable total and the flows stay as they were (their gas is in their host's), shown
from map zoom MIN_ZOOM, and left out of the Flow view.

Left out: fields produced through UK or Danish installations (Enoch, Rev, Trym), Yme
(standalone, its gas reinjected), Sindre (one well from Gullfaks C, with no installation or
outline of its own in SODIR) and the Barents Sea (Goliat, Johan Castberg, and Snøhvit's
LNG plant), which are not on the North Sea network.

Prints the new rows for data/nodes.csv and data/pipelines.csv, and the ids for each unit
in data/units.toml. Downloads (NLOD, credit SODIR):
  https://factpages.sodir.no/downloads/csv/fclPoint.zip
  https://factpages.sodir.no/downloads/csv/fldArea.zip
  field_description: https://factpages.sodir.no/public?/Factpages/external/tableview/
  field_description&rs:Command=Render&rc:Toolbar=false&rc:Parameters=f&IpAddress=not_used
  &CultureCode=en&rs:Format=CSV&Top100=false
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys

MIN_ZOOM = {"host": 5.5, "satellite": 6.0}

# SODIR field name -> (NORA id of its host, what the field is to it). A host with satellites
# of its own is "host"; the rest are "satellite". Hosts not yet in NORA come first.
HOSTS = {
    "ALVHEIM": ("beryl", "host"),  # rich gas through a pipeline to the SAGE system
    "KRISTIN": ("asgard", "host"),  # rich gas into Åsgard Transport
    "NJORD": ("asgard", "host"),  # gas through a 40 km line into Åsgard Transport
    "ULA": ("ekofisk", "host"),  # oil via Ekofisk; all gas reinjected
    "SNORRE": ("gullfaks", "host"),  # oil to Gullfaks A and Statfjord B; all gas reinjected
    "ELDFISK": ("ekofisk", "host"),  # oil and gas to the Ekofisk Centre
    "FRAM": ("troll", "host"),
    "FRAM H-NORD": ("fram", "host"),
    "VILJE": ("alvheim", "host"),
    "TOR": ("ekofisk", "satellite"),
    "TOMMELITEN A": ("ekofisk", "satellite"),
    "EMBLA": ("eldfisk", "satellite"),
    "HOD": ("valhall", "satellite"),
    "TAMBAR": ("ula", "satellite"),
    "TAMBAR ØST": ("ula", "satellite"),
    "ODA": ("ula", "satellite"),
    "BLANE": ("ula", "satellite"),
    "GUNGNE": ("sleipner", "satellite"),
    "SIGYN": ("sleipner", "satellite"),
    "UTGARD": ("sleipner", "satellite"),
    "EIRIN": ("gina_krog", "satellite"),
    "HANZ": ("ivar_aasen", "satellite"),
    "SYMRA": ("ivar_aasen", "satellite"),
    "SOLVEIG": ("edvard_grieg", "satellite"),
    "VOLUND": ("alvheim", "satellite"),
    "BØYLA": ("alvheim", "satellite"),
    "TYRVING": ("alvheim", "satellite"),
    "SKOGUL": ("vilje", "satellite"),
    "BREIDABLIKK": ("grane", "satellite"),
    "SVALIN": ("grane", "satellite"),
    "RINGHORNE ØST": ("jotun", "satellite"),  # via Balder: NORA's Jotun FPSO sits at Balder
    "OSEBERG SØR": ("oseberg", "satellite"),
    "OSEBERG ØST": ("oseberg", "satellite"),
    "TUNE": ("oseberg", "satellite"),
    "BRAGE": ("oseberg", "satellite"),
    "BYRDING": ("fram_h_nord", "satellite"),
    "VEGA": ("gjoa", "satellite"),
    "NOVA": ("gjoa", "satellite"),
    "DUVA": ("gjoa", "satellite"),
    "VALEMON": ("kvitebjorn", "satellite"),
    "GIMLE": ("gullfaks", "satellite"),
    "VISUND SØR": ("gullfaks", "satellite"),
    "STATFJORD NORD": ("statfjord", "satellite"),
    "STATFJORD ØST": ("statfjord", "satellite"),
    "SYGNA": ("statfjord", "satellite"),
    "VIGDIS": ("snorre", "satellite"),
    "ISLAY": ("fuka_tee", "satellite"),
    "HALTEN ØST": ("asgard", "satellite"),
    "TYRIHANS": ("kristin", "satellite"),
    "MARIA": ("kristin", "satellite"),
    "HYME": ("njord", "satellite"),
    "BAUGE": ("njord", "satellite"),
    "FENJA": ("njord", "satellite"),
    "ALVE": ("norne", "satellite"),
    "MARULK": ("norne", "satellite"),
    "SKULD": ("norne", "satellite"),
    "URD": ("norne", "satellite"),
    "VERDANDE": ("norne", "satellite"),
    "ALVE NORD": ("skarv", "satellite"),
    "IDUN NORD": ("skarv", "satellite"),
    "ÆRFUGL NORD": ("skarv", "satellite"),
    "ØRN": ("skarv", "satellite"),
}
TIED = r"tied|tie-back|connected to|routed|transported (by pipeline )?(to|via)|processed (on|at)"
PLACE_KINDS = ("FPSO", "CONDEEP", "JACKET", "SEMISUB", "TLP", "JACK-UP", "SUBSEA", "TEMPLATE")


def node_id(name: str) -> str:
    ascii_name = name.lower().replace("ø", "o").replace("æ", "ae").replace("å", "a")
    return re.sub(r"[^a-z0-9]+", "_", ascii_name).strip("_")


def title(name: str) -> str:
    words = [w if w in ("A", "B") else w.capitalize() for w in name.split(" ")]
    return " ".join(
        "-".join(p.capitalize() if len(p) > 1 else p for p in w.split("-")) for w in words
    )


OPERATORS = {
    "Equinor Energy AS": "Equinor",
    "Aker BP ASA": "Aker BP",
    "Vår Energi ASA": "Vår Energi",
    "ConocoPhillips Skandinavia AS": "ConocoPhillips",
    "Harbour Energy Norge AS": "Harbour Energy",
    "TotalEnergies EP Norge AS": "TotalEnergies",
    "TotalEnergies E&P Norge AS": "TotalEnergies",
    "TotalEnergies E&P UK Limited": "TotalEnergies",
    "DNO Norge AS": "DNO",
    "OKEA ASA": "OKEA",
    "Repsol Norge AS": "Repsol",
}


def operator(company: str) -> str:
    return OPERATORS.get(company.strip(), re.sub(r"\s+(Norge\s+)?(ASA|AS)$", "", company.strip()))


def numbers(wkt: str) -> list[tuple[float, float]]:
    values = [float(v) for v in re.findall(r"-?\d+\.?\d*", wkt)]
    return list(zip(values[0::2], values[1::2], strict=False))


def place(field: str, facilities: list[dict], outline: str) -> tuple[float, float, str, str]:
    """(lat, lon, where, startup year): the field's own installation in service, or the
    middle of its outline."""
    mine = [
        f
        for f in facilities
        if f["fclBelongsToName"] == field and f["fclPhase"] in ("IN SERVICE", "INSTALLATION")
    ]
    for kind in PLACE_KINDS:
        for f in mine:
            points = (
                numbers(f["fclPointGeometryWKT"]) if "EMPTY" not in f["fclPointGeometryWKT"] else []
            )
            if kind in f["fclKind"] and points:
                lon, lat = points[0]
                return (
                    lat,
                    lon,
                    f"SODIR installation {f['fclName']}",
                    (f["fclStartupDate"] or "")[:4],
                )
    points = numbers(outline)
    if not points:
        raise ValueError(f"{field}: no installation and no outline in SODIR")
    lon = sum(p[0] for p in points) / len(points)
    lat = sum(p[1] for p in points) / len(points)
    return lat, lon, "the middle of SODIR's field outline", ""


def tie_sentence(texts: list[str]) -> str:
    """The descriptions' sentence about where the field is tied back to, shortened: from
    Development, else Transport, else Transport's first sentence."""
    for text in texts:
        for sentence in re.split(r"(?<=\.)\s+", text):
            if re.search(TIED, sentence, re.I):
                return sentence.strip().rstrip(".")[:150]
    first = re.split(r"(?<=\.)\s+", texts[-1].strip())[0] if texts and texts[-1].strip() else ""
    return first.rstrip(".")[:150]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("facilities")
    parser.add_argument("fields")
    parser.add_argument("descriptions")
    args = parser.parse_args(argv)
    csv.field_size_limit(10**9)

    def read(path: str) -> list[dict]:
        with open(path, encoding="utf-8-sig") as handle:
            return list(csv.DictReader(handle))

    facilities, fields = read(args.facilities), {r["fldName"]: r for r in read(args.fields)}
    text = {}
    for r in read(args.descriptions):
        text.setdefault(r["fldName"], {})[r["fldDescriptionHeading"]] = r["fldDescriptionText"]
    nodes, lines, units = io.StringIO(), io.StringIO(), {}
    node_out, line_out = (
        csv.writer(nodes, lineterminator="\n"),
        csv.writer(lines, lineterminator="\n"),
    )
    names = {r["id"]: r["name"] for r in read("data/nodes.csv")} | {
        node_id(f): title(f) for f in HOSTS
    }
    for field, (host, role) in HOSTS.items():
        row = fields[field]
        if row["fldCurrentActivitySatus"].upper() != "PRODUCING":
            raise ValueError(f"{field} is {row['fldCurrentActivitySatus']}, not producing")
        lat, lon, where, startup = place(field, facilities, row["fldAreaGeometryWKT"])
        about = text.get(field, {})
        fid, said = (
            node_id(field),
            tie_sentence([about.get("Development", ""), about.get("Transport", "")]),
        )
        notes = f'Map detail, at {where}. SODIR: "{said}". No supply of its own in the model.'
        node_out.writerow(
            [
                fid,
                title(field),
                "field",
                "NO",
                f"{lat:.6f}",
                f"{lon:.6f}",
                operator(row["cmpLongName"]),
                0,
                "operating",
                startup,
                "",
                row["fldFactPageUrl"],
                notes,
                MIN_ZOOM[role],
                "",
            ]
        )
        host_name = names.get(host, host)
        line_out.writerow(
            [
                f"{fid}_{host}",
                f"{title(field)} - {host_name}",
                fid,
                host,
                "feeder",
                "",
                "",
                "",
                "false",
                startup,
                "operating",
                operator(row["cmpLongName"]),
                row["fldFactPageUrl"],
                "Schematic tie-back from SODIR's field description; no incremental supply.",
            ]
        )
        units.setdefault(host, []).append(fid)
    sys.stdout.write("# nodes.csv\n" + nodes.getvalue() + "# pipelines.csv\n" + lines.getvalue())
    for host, ids in units.items():
        print(f"# units: with {host}: {', '.join(ids)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
