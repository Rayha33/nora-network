# Streams: replaying data as if it were live

A stream is a time series of network readings (flows, pressures, nominations, bookings,
gas quality) that NORA plays back on the chart: PIGs, flow-change peaks and gas-quality
parcels move along the pipelines, and alarms fire when a reading crosses a limit.
`nora live` can also serve a stream as a real live feed (Server-Sent Events), so the
chart behaves exactly as it will once it is connected to a live source. Synthetic
streams demonstrate the interface; they are not records of actual operations.

Each stream is one folder here with a `stream.toml`:

```
data/streams/
  synthetic-week/
    stream.toml        generated from the network model, with scripted events
  my-real-data/
    stream.toml        title, source and the mapping below
    raw.csv            the file exactly as you downloaded it
```

## Add a real dataset in four steps

1. **Get a CSV of flows over time.** Any of these layouts works:

   | layout | looks like |
   | --- | --- |
   | long | `time, point, value` with one reading per row |
   | wide | `time, Point A, Point B, ...` with one column per point |

2. **Scaffold the stream:**

   ```bash
   nora stream new my-data --from ~/Downloads/flows.csv
   ```

   This copies the file to `data/streams/my-data/` and writes a `stream.toml`. It guesses
   the time column and the layout, and maps each point to a NORA asset by name.

3. **Check the mapping** in `stream.toml`. Each raw point maps to a pipeline id
   (`data/pipelines.csv`) or a node id (`data/nodes.csv`). Set `factor` so values come
   out in MSm3/d, then check the result:

   ```bash
   nora stream show my-data
   ```

4. **See it:** `nora build` adds it to the chart's player (choose it in the dataset
   menu), and `nora live --stream my-data` serves it as a live feed.

Commit the folder and open a pull request. Your preview link will show the replay.

## Public live sources

`nora live --source gassco` serves aggregate Norwegian exports by receiving country.
For the physically bidirectional Interconnector (IUK) between Bacton and Zeebrugge:

```bash
nora live --source interconnector --poll-seconds 120
```

This polls National Gas's public latest-flows API. Positive `iuk` values mean Bacton →
Zeebrugge; negative values mean Zeebrugge → Bacton, in MSm³/d. The existing map arrows,
flow quadrants and asset readings use that sign directly. Zeebrugge/IUK is operated by
Interconnector/Fluxys, not GTS. The static site's replay cannot poll this API
because it does not allow cross-origin browser requests; use the local live server above.

The site replays a recorded year of the same pipeline instead: `iuk-flows`, the daily
physical flow from National Gas's data portal (Bacton into IUK, PUBOB2038, less IUK
into Bacton, PUBOBJ592). Refresh it with

```bash
python scripts/fetch_nationalgas.py 2025-10-01 2026-10-28 data/streams/iuk-flows/raw.csv
```

`--ids` takes other publication ids from the portal's Find gas data list, for any
other UK entry or exit point.

## stream.toml reference

```toml
title = "Norwegian exports, one week"
description = "Hourly physical flows where Norwegian gas lands."
source = "https://transparency.entsog.eu/"     # where the data came from
synthetic = true             # optional: label made-up rows (a mock API's) as synthetic
license = "..."                                 # the source's terms

[import]
file = "raw.csv"
layout = "long"              # "long" or "wide"
timestamp = "periodFrom"     # column holding the time
asset = "pointLabel"         # long only: column naming the point
value = "value"              # long only: column holding the number
factor = 2.18e-6             # multiply raw values by this to get MSm3/d
timezone = "UTC"             # for times without an offset, e.g. "Europe/Oslo"
time_format = ""             # optional strptime format when times are not ISO 8601
delimiter = ","

[import.where]               # optional: keep only rows where column == value
directionKey = "exit"

[import.assets]              # raw point -> NORA id; points mapped to "" are skipped
"Easington" = "langeled_south"
"Dornum GASPOOL" = "europipe_2_south"

[[events]]                   # optional markers on the timeline
label = "Planned maintenance"
asset = "kollsnes"
start = 2026-10-21T06:00:00Z
end = 2026-10-21T19:00:00Z
planned = true                # known ahead; omit or false for unplanned events
```

### Importing more than one metric

Use one `[[import]]` table per file. Set `metric` on each table; all mapped readings
in that file use that metric. For example, flow and pressure can be imported separately:

```toml
[[import]]
file = "flows.csv"
metric = "flow_msm3d"
timestamp = "timestamp"
asset = "point"
value = "value"
factor = 1.0
[import.assets]
"Pipe A" = "pipe_a"

[[import]]
file = "pressure.csv"
metric = "pressure_bar"
timestamp = "timestamp"
asset = "point"
value = "value"
factor = 1.0
[import.assets]
"Terminal A" = "a_terminal"
```

Supported metric keys are:

| key | meaning and usual location | held between readings? |
| --- | --- | --- |
| `flow_msm3d` | flow on a pipeline (signed from `from` to `to`) or node throughput | no |
| `pressure_bar` | node pressure in bar | no |
| `nomination_msm3d` | hourly nominated rate at an exit point | yes |
| `booked_msm3d` | booked capacity at an exit point | yes |
| `h2s_ppm` | H₂S concentration at a field, ppm | no |
| `co2_molpct` | CO₂ concentration at a field, mol % | no |

For `flows.csv`, the long metric format is `timestamp,asset,metric,value`; the shorter
`timestamp,asset,flow_msm3d` format remains supported for flows only. Nominations and
bookings carry forward from their first reading until replaced; earlier missing values
remain missing. Imported files use one `metric` per `[[import]]` block.

Readings that map to the same asset at the same time are added together, so several
raw points can feed one pipeline or terminal. Put a `-` before the id
(`"KWhToPoland" = "-baltic_pipe_east"`) when the source reports outflows as negative. A value on a pipeline is its flow from
`from` to `to`; a negative value flows the other way.

Instead of `[import]` you can write `flows.csv` yourself in NORA's own format:

```csv
timestamp,asset,flow_msm3d
2026-10-19T00:00:00Z,langeled_south,68.4
```

Each row is one reading: keep **one row per timestamp and asset** (and metric). A
repeated key is a data error - `nora validate` reports it with its file and line
rather than silently keeping one of the values. This is deliberate: `flows.csv` is
hand-editable, so a duplicate usually means a copy-paste mistake, and the audit
trail should show it. It differs from `[import]` mappings, which sum readings that
map to the same asset and time on purpose (see above); combine raw points in the
mapping rather than by adding rows to `flows.csv`.

`nora stream export my-data --out flows.csv` writes any stream in that format.

## Synthetic streams

A `[synthetic]` section generates flows from the network model instead of reading a
file: supply follows a daily demand curve, each step is routed through the network, and
every `[[events]]` entry scales an asset's capacity while it is active
(`capacity_factor = 0` takes it offline). Use it to script what-if scenarios.

```toml
[synthetic]
start = 2026-10-19T00:00:00Z
step_minutes = 60
steps = 168
seed = 7
operations = true  # also generate pressure, nominations and bookings
quality = true     # generate field H₂S/CO₂ readings and any listed excursions
```

With `operations = true`, the model generates hourly exit nominations and bookings,
plus illustrative pressure readings. With `quality = true`, each field gets a baseline
H₂S and CO₂ reading. Add excursions to demonstrate a changing gas-quality parcel:

```toml
[[synthetic.excursions]]
asset = "field_id"
metric = "h2s_ppm" # or "co2_molpct"
peak = 5.0
start = 2026-10-19T06:00:00Z
hours = 3
every_hours = 24 # optional repeat interval
```

Quality tracking is an estimate: it follows the pipeline carrying the most flow out of
each node, and assumes the other gas at a mixing point has the median field reading.
The overview estimates concentration and arrival time at the exit; its colored badge
appears only after a configured warning threshold is crossed. The configured limits
live in `[quality]` in `nora.toml`.

## PIG runs

An explicit `[[pigs]]` entry starts a PIG on one pipeline. `every_hours` repeats the run;
leave it out (or set it to zero) for a single launch:

```toml
[[pigs]]
pipeline = "langeled_south"
label = "Langeled inspection"
launch = 2026-10-19T06:00:00Z
speed_mps = 4.0
every_hours = 36
```

For a synthetic stream, `pig_programme = { every_hours = 48, speed_mps = 4.0 }` creates
a staggered programme on every trunk, export line and interconnector. An explicit
`[[pigs]]` entry takes precedence on its pipeline.

## Units

Flows are in MSm3/d, million standard cubic metres per day. Energy units convert through
the gas's calorific value; for Norwegian gas, about 11 kWh per standard cubic metre:

| raw unit | factor to MSm3/d |
| --- | --- |
| kWh/h | 24 / 11.0 / 1e6 = 2.18e-6 |
| kWh/d | 1 / 11.0 / 1e6 = 9.09e-8 |
| GWh/d | 1 / 11.0 = 0.0909 |
| mcm/d (million m3/d) | 1.0 |

## Real sources

### Energinet (Denmark): in the repository

`denmark-gas-energinet/` holds daily measured flows from Energinet's open
[Energi Data Service](https://www.energidataservice.dk/tso-gas/Gasflow). It is a good
template for a wide CSV with energy units and outflows reported as negative numbers.
Refresh it with:

```bash
python scripts/fetch_energinet.py 2026-08-01 2026-10-27 data/streams/denmark-gas-energinet/raw.csv
```

### SODIR (Norway): in the repository

`sodir-field-production/` holds monthly net gas production per Norwegian
offshore field from the [SODIR factpages](https://factpages.sodir.no/). The raw
CSV keeps SODIR's own columns plus two derived ones: `month` (the month's first
day, from prfYear and prfMonth) and `gas_msm3d` (net gas converted from billion
Sm3 per month to MSm3/d, NORA's unit). Data licence: NLOD. Refresh with:

```bash
python scripts/fetch_sodir.py 2024-09 2026-08 data/streams/sodir-field-production/raw.csv
```

Fields that map to a node in `data/nodes.csv` are committed; the others
(Gullfaks Sør, Oseberg Sør/Øst, Statfjord Nord/Øst, Vest Ekofisk, Visund Sør
and the rest of SODIR's 136 fields) are left out for now.

### ENTSOG Transparency Platform (Norwegian landings): in the repository

ENTSOG publishes physical flows at Europe's interconnection points, including the
terminals where Norwegian gas lands. Gassco registers its own side of every landing but
publishes nothing there (`hasData` is false for all of `NO-TSO-0001`), so the readings
come from the receiving operators, under their own point keys. `scripts/fetch_entsog.py`
asks for them point by point (the platform's own rule):

```bash
python scripts/fetch_entsog.py 2026-10-13 2026-10-20 data/streams/norway-exports/raw.csv
python scripts/fetch_entsog.py 2026-10-01 2026-10-28 data/streams/norway-exports-daily/raw.csv --period day
```

`norway-exports` is hourly (13 to 20 Oct 2026); `norway-exports-daily` is per gas day
(1 to 28 Oct 2026) and adds Easington, which National Gas reports daily only. Means are
for 13 to 20 Oct at about 11 kWh per Sm3.

| Norwegian landing | ENTSOG point direction(s) | NORA asset | mean MSm3/d |
| --- | --- | --- | --- |
| Dunkerque (Franpipe) | FR-TSO-0003ITP-00045entry | `franpipe` | 47.0 |
| Zeebrugge ZPT (Zeepipe I) | BE-TSO-0001ITP-00106entry | `zeepipe_1` | 42.5 |
| Dornum (Europipe II) | DE-TSO-0009ITP-00525entry (Dornum GASPOOL) | `europipe_2_south` | 61.6 |
| Emden EPT1 (Europipe I and Norpipe) | DE-TSO-0009ITP-00080entry (OGE), DE-TSO-0005ITP-00081entry (GUD), NL-TSO-0001ITP-00160entry (GTS), added | `emden` (the terminal) | 82.7 |
| Baltic Pipe North Sea Entry | DK-TSO-0001ITP-00630entry | `baltic_pipe_ns` | 18.2 |
| Easington (Langeled) | UK-TSO-0001ITP-00091entry, daily only | `langeled_south` (daily dataset) | 68.2 (1 to 28 Oct) |
| St Fergus (Vesterled) | UK-TSO-0001ITP-00022entry, daily only | none: see below | |

Why some points are not what they look like (checked 29 Oct 2026):

- **Gassco's keys have no data.** `operatorpointdirections?tsoCountry=NO` lists Gassco
  at Dornum (ITP-00208), Emden EPT1 (ITP-00209), Emden NPT (ITP-00210) and the other
  landings, every one with `hasData: false`. The German operators report under their
  own keys instead (`operatorpointdirections?tSOCountry=DE`, `?tSOCountry=NL`).
- **Emden NPT ended in 2015.** Thyssengas, GUD and GTS's Emden (NPT) points are valid
  to 2015-09-30; OGE's remark reads "From 01/10/2015 6 am point is merged with Emden
  NPT". Norpipe and Europipe I have been metered together at Emden EPT1 since, so their
  sum is read on the `emden` terminal and not split between the two lines.
- **Pipe-in-pipe repeats.** Thyssengas's Emden (EPT1) (ITP-00105) is flagged pipe-in-pipe
  with GUD's (ITP-00081) and reports the same flow hour by hour; Dornum / NETRA at OGE
  (ITP-00126) and GUD (ITP-00188) repeat Dornum GASPOOL (ITP-00525). Adding them would
  put Emden at about 108 MSm3/d and Dornum at about 127, far above the lines' capacity.
  The fetched set matches ENTSOG's own dashboard list
  ([Gas flows corridors and IPs used for the dashboards](https://www.entsog.eu/sites/default/files/2023-09/Gas%20flows%20corridors%20and%20IPs%20used%20for%20the%20dashboards_v18-09-2023.pdf)).
- **The UK reports daily only.** National Gas still publishes Easington and St Fergus
  on the platform, but an hourly query (`periodType=hour`) returns "No result found";
  `periodType=day` works. National Gas's own data portal has the same daily values
  (System Entry Volume, Easington-Langeled, D+1, PUBOBJ570) and hourly readings only
  for the current gas day (the live instantaneous flows), so no hourly history exists.
- **St Fergus is not Vesterled alone.** ENTSOG's dashboard list gives St Fergus's source
  as "Norway+UK", and its flow (mean 43.2, up to 51.2 MSm3/d in Oct 2026) is above
  Vesterled's 39 MSm3/d. National Gas splits St Fergus by sub-terminal (NSMP, Shell,
  Mobil), and each takes UK gas as well (FUKA at NSMP, Fulmar at Shell), so no public
  series measures Vesterled, FLAGS or SAGE alone. These lines have no readings.

For a cross-check, Gassco's real-time figures on 29 Oct 2026 (Belgium 43.6, France 46,
Germany 158.9 MSm3/d) were within 2 % of the ENTSOG readings for Belgium and France
that day; ENTSOG's German points added up to about 139, some 12 % lower than Gassco's
Germany figure, a gap these public data do not explain.

## Choosing the dataset that plays first

The home page replays the stream with the lowest `order` (default 100, then by name).
`synthetic-week` sets `order = 1` because it moves the whole network.
