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
- Operator pages for gas storage sites: Centrica (Rough), NAM/EBN (Norg), TAQA Energy
  (Bergermeer), Equinor Storage Deutschland (Etzel), EWE Gasspeicher (Jemgum) and
  Gas Storage Denmark (Stenlille, Lille Torup). Withdrawal capacities are peak-day
  rates converted to MSm3/d where the operator publishes them in other units.
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
