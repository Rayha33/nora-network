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
  Baltic Pipe project site and BBL.
- `approximate, public data` for rows where no single authoritative public page could
  be pinned down. These are the best candidates for a better citation.

## nodes.csv

One row per asset.

| column | meaning |
| --- | --- |
| `id` | unique, lowercase with underscores: `troll`, `st_fergus` |
| `name` | display name |
| `type` | `field`, `hub`, `tee` (a subsea tie-in along a line: a dot in the Flow view), `processing`, `terminal`, `lng`, `storage` or `market` |
| `country` | two-letter code: `NO`, `GB`, `NL`, `DE`, `DK`, `BE`, `FR` |
| `lat`, `lon` | decimal degrees (east and north are positive) |
| `operator` | optional |
| `capacity_msm3d` | supply for `field`, `lng` and `storage` (required); processing capacity for plants; otherwise optional |
| `status` | `operating`, `planned` or `decommissioned` (only `operating` takes part in the analysis) |
| `startup` | year the asset started, or is planned to start, operating; blank when unknown. For Norwegian fields this comes from the field's SODIR fact page (`norskpetroleum.no`) |
| `shutdown` | the first year the asset was no longer in operation (it is shown up to and including the year before); blank while it operates |
| `source` | link backing up the row |
| `notes` | free text; wrap it in quotes if it contains a comma |
| `map_min_zoom` | optional map zoom at which a detailed field or tie-in appears; blank means always visible |
| `booked_msm3d` | optional, exit points only: capacity shippers have booked there. The routing fills it before shorter routes take the rest; the maximum flow is unchanged |

`market` nodes are where the analysis counts gas as delivered: virtual trading points
(NBP, TTF, THE and so on, placed schematically on the map) and large consumers such as
the Tjeldbergodden methanol plant.

A field that takes gas from the network instead of supplying it (Grane for injection,
Mariner for power) is a `field` with `capacity_msm3d` 0 and a line drawn towards it. It is
neither supply nor exit, so the routing sends it no gas; the line shows the real tie-in.

### flow_layout.toml

Where each node sits in the Flow view, as `node = [across, down]` in grid steps, laid
out like the operators' Area D overview: the UK on the left, Kårstø and the Norwegian
Sea on the right, fields at the top and the landings along the bottom. A node it does
not list is placed by `layout.py`. Drag a node in the Flow view and Save to move it.

### Editing in the page

In the Flow view, right-click empty paper to add a node there, drag a node to move it,
right-click a node to connect it to another or remove it, and right-click a line to
remove it (a node's removal takes its lines with it). The edits show at once in both views and are kept in
the browser until saved; a bar lists them with Undo, Save and Discard. With `make edit`
(`nora serve --edit`) running, Save validates them, writes `nodes.csv`,
`pipelines.csv`, `units.toml` (a new node joins the unit chosen in its form) and
`flow_layout.toml` (a dragged or new node keeps its place), and
rebuilds the site; a hosted NORA (below) saves the same way. Opened as a plain file or on
the hosted site, Save downloads the four files to put here and commit. A new row says "Added in the NORA editor" in `notes`: add its `source`.

### Local edit API

For a local editing workflow, start `nora serve --edit`. It binds only to
`127.0.0.1`; the JSON API is not available through `nora live`.
`GET /api/network` returns the nodes and pipelines in CSV-column form. Send that full
object to `POST /api/check` to validate without writing, or to `POST /api/save` to
validate, update the CSVs, and rebuild the served site. POST requests require
`Content-Type: application/json` and an `Origin` matching the local page. The API
accepts network data only, never file paths. Keep the returned `revision` field intact:
it prevents a save from overwriting CSV changes made since the network was fetched. A
stale request returns HTTP 409 and must be reapplied to a newly fetched network. An
optional `units` object, `{"new_node": "unit_id"}`, places new nodes in `units.toml`;
removed nodes leave their unit by themselves.

```bash
nora serve --edit
curl -o network.json http://127.0.0.1:8000/api/network
# Edit network.json, then validate it:
curl -X POST http://127.0.0.1:8000/api/check \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8000' \
  --data-binary @network.json
# Save only after reviewing a valid check:
curl -X POST http://127.0.0.1:8000/api/save \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8000' \
  --data-binary @network.json
```

### Hosting the editor

To save from a hosted NORA without downloading files, give the server an edit key and
put it behind HTTPS (a reverse proxy such as Caddy or nginx that passes the `Host`
header through):

```bash
NORA_EDIT_TOKEN="$(openssl rand -hex 24)" nora serve --edit --host 0.0.0.0 --no-browser
```

Without `NORA_EDIT_TOKEN`, `--host` other than `127.0.0.1` is refused. With it, every
`/api/check` and `/api/save` must send `Authorization: Bearer <key>` and an `Origin`
that matches the page's host; the page asks for the key at the first Save and keeps it
in that browser. Anyone with the key can change `data/`, so share it like a password,
and commit the saved files from the server's checkout as usual.

## pipeline_models.csv

One row per pipeline: the regression the What-if uses for its pressures, as a pipeline
modelling system (PMS) keeps them (Ray, 29 Oct: "pipeline-specific regression formulas and
correction factor"):

    p_in² − p_out² = correction × (a × Q² + b × Q)      pressures in bar a, Q in MSm³/d

| column | meaning |
| --- | --- |
| `pipeline` | a pipeline id from `pipelines.csv` |
| `a`, `b` | the regression's coefficients (bar² per (MSm³/d)², bar² per MSm³/d) |
| `correction` | used when today's pressures cannot tune the line (default 1) |
| `source` | where the row comes from |

`python scripts/build_pipeline_models.py` seeds `a` from the Weymouth equation (length and
diameter) for every line with both; it keeps any row whose source is not its own estimate,
so the PMS's regressions can replace the seeds. In the What-if the correction is tuned to
today's pressures where they allow it (the measured drop over the regression's, between 0.2
and 5). A line with no row passes its pressure through. Removing a pipeline in the editor
removes its row.

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
shows it ("61.90055°N  4.25673°E  ·  ED 58 m"), and offshore assets list it in their
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
  FUKA (the Frigg UK System) joins PL6N, PL2026 and PL6S; Mariner's gas import is PL3768.
- Lines that NORA cuts at a tie-in it models keep one register route split at that tee:
  Polarled at the Dvalin tie-in, Heimskringla's St Fergus leg at the Mariner tie-in and
  its Draupner leg at the Jotun tie-in (as Europipe II at the Baltic Pipe tie-in).
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
