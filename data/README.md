# NORA data

The network is two CSV files you can edit in any spreadsheet or straight in GitHub's web
editor. `nora validate` (and CI on every pull request) checks them and explains any
problem with its file and line number.

Values are approximate figures compiled from public sources. **The most valuable
contribution is a `source` link** for a row that has none.

## Sources

Every row carries a `source` entry pointing at (or describing) the public data it was
compiled from:

- Operator pages for fields, plants and terminals (e.g. `https://www.equinor.com/...`).
- Gassco (`https://gassco.no/en/our-activities/pipelines-and-platforms`) for the
  Norwegian offshore pipeline network.
- Wikipedia articles for individual, well-documented pipelines (Statpipe, Zeepipe,
  Langeled, Europipe, Norpipe, Franpipe, Vesterled, CATS, FLAGS, etc.).
- Operator/TSO sites for onshore grid-entry rows: National Grid (UK/NBP), Gasunie
  (NL/TTF), Trading Hub Europe (DE/THE), Fluxys (BE/ZTP), Energinet (DK/ETF), the
  Baltic Pipe project site, IUK and BBL.
- `approximate, public data` for rows where no single authoritative public page could
  be pinned down. These are the best candidates for a better citation.

## nodes.csv

One row per asset.

| column | meaning |
| --- | --- |
| `id` | unique, lowercase with underscores: `troll`, `st_fergus` |
| `name` | display name |
| `type` | `field`, `hub`, `processing`, `terminal`, `lng`, `storage` or `market` |
| `country` | two-letter code: `NO`, `GB`, `NL`, `DE`, `DK`, `BE`, `FR` |
| `lat`, `lon` | decimal degrees (east and north are positive) |
| `operator` | optional |
| `capacity_msm3d` | supply for `field`, `lng` and `storage` (required); processing capacity for plants; otherwise optional |
| `status` | `operating`, `planned` or `decommissioned` (only `operating` takes part in the analysis) |
| `startup` | year the asset started, or is planned to start, operating; blank when unknown. For Norwegian fields this comes from the field's SODIR fact page (`norskpetroleum.no`) |
| `shutdown` | the first year the asset was no longer in operation (it is shown up to and including the year before); blank while it operates |
| `source` | link backing up the row |
| `notes` | free text; wrap it in quotes if it contains a comma |

`market` nodes are where the analysis counts gas as delivered: virtual trading points
(NBP, TTF, THE and so on, placed schematically on the map) and large consumers such as
the Tjeldbergodden methanol plant.

## pipelines.csv

One row per pipeline. Parallel lines between the same two nodes are one row.

| column | meaning |
| --- | --- |
| `id`, `name` | as for nodes; ids are unique across both files |
| `from`, `to` | node ids; gas normally flows `from` to `to` |
| `type` | `feeder`, `trunk`, `export`, `interconnector`, `link` or `onshore` |
| `length_km` | optional; the great-circle distance is used when empty |
| `diameter_in` | optional |
| `capacity_msm3d` | empty means unlimited (used for notional `onshore` grid entries) |
| `bidirectional` | `true` if it can flow both ways |
| `commissioned` | year, optional |
| `status`, `operator`, `source`, `notes` | as for nodes |

## Units

MSm3/d is million standard cubic metres per day. One MSm3/d over a year is about
0.365 bcm (billion cubic metres).

## streams/

Time series that the chart replays as live data. See [streams/README.md](streams/README.md).

## Coastline

`geo/coastline.json` is the land around the North Sea that the Map view draws itself
when a browser has no WebGL. It comes from Natural Earth's 1:10m land polygons (public
domain, https://www.naturalearthdata.com), clipped to the network's area and simplified
by `scripts/build_coastline.py`. Rebuild it with `python scripts/build_coastline.py`.

## Water depth

`geo/bathymetry.json` is the water depth under the map: the map's position readout
shows it ("61.90055°N  4.25673°E  ·  WD 58 m"), and offshore assets list it in their
facts. It is EMODnet's Digital Bathymetry (DTM), the European seabed model, licence CC
BY 4.0 (credit: EMODnet Bathymetry Consortium), resampled to a 1 arc-minute grid over
the map's bounds and stored in whole metres. A reading is the mean depth of the area
under the pointer, not a sounding. Rebuild it with `python scripts/build_bathymetry.py`
(it fetches about 90 tiles from EMODnet's open WCS service).

## Pipeline routes and positions

`geo/routes.json` holds the laid routes of the physical trunk and feeder pipelines, so
the map draws each line where it runs, not straight from end to end. It is built by
`scripts/build_routes.py`, which records the public register segments used for each NORA
pipeline and the source of every route:

- Norwegian Offshore Directorate's pipeline register
  (https://factpages.sodir.no/downloads/csv/pipLine.zip, licence NLOD, credit
  "Norwegian Offshore Directorate") for the Norwegian system and its export lines.
- North Sea Transition Authority's UKCS offshore infrastructure pipeline linear WGS84
  FeatureServer for FLAGS, SAGE, CATS, SEAL, IUK and BBL. NSTA PL774 is split at CATS T5;
  Culzean's PL4106 joins that tee rather than taking a false path to the CATS riser.
- EMODnet Human Activities, Pipelines
  (https://emodnet.ec.europa.eu/en/human-activities, licence CC BY 4.0) for NOGAT, NGT,
  WGT, Tyra West–F3 and Tyra–Nybro. NOGAT joins its F3–L2 and L2–Callantsoog sections.

Run `python scripts/build_routes.py` to refresh all three sources. `--from pipLine.csv`
retains a SODIR-only offline build; add `--nsta-from nsta.json` and
`--emodnet-from emodnet.json` for a complete offline rebuild. Aggregate gathering lines
and notional grid/market links remain schematic: they do not represent a surveyed pipe.

Positions of Norwegian platforms, subsea tees and landing terminals follow SODIR's
facility register (fclPoint): the Draupner S and E riser platforms, for example, are
bridge-linked about 120 m apart. A node far from the route it sits on is in the wrong
place, and `tests/test_geo.py` checks for it.
