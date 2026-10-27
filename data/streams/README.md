# Streams: replaying data as if it were live

A stream is a time series of gas flows that NORA plays back on the chart: pipelines
fill and empty hour by hour, dots move along them, and alarms fire when a flow drops.
`nora live` can also serve a stream as a real live feed (Server-Sent Events), so the
chart behaves exactly as it will once it is connected to a live source.

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

## stream.toml reference

```toml
title = "Norwegian exports, one week"
description = "Hourly physical flows at Gassco's exit points."
source = "https://transparency.entsog.eu/"     # where the data came from
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
"Dornum (EPT1 & EPT2)" = "dornum"

[[events]]                   # optional markers on the timeline
label = "Planned maintenance"
asset = "kollsnes"
start = 2026-10-21T06:00:00Z
end = 2026-10-21T19:00:00Z
```

Readings that map to the same asset at the same time are added together, so several
raw points can feed one pipeline or terminal. Put a `-` before the id
(`"KWhToPoland" = "-baltic_pipe_east"`) when the source reports outflows as negative. A value on a pipeline is its flow from
`from` to `to`; a negative value flows the other way.

Instead of `[import]` you can write `flows.csv` yourself in NORA's own format:

```csv
timestamp,asset,flow_msm3d
2026-10-19T00:00:00Z,langeled_south,68.4
```

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
```

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

### ENTSOG Transparency Platform: help wanted

ENTSOG publishes physical flows at Europe's interconnection points, including the
terminals where Norwegian gas lands. Gassco publishes nothing for its own side, so the
readings come from the receiving operators. `scripts/fetch_entsog.py` asks for them point
by point (the platform's own rule):

```bash
python scripts/fetch_entsog.py 2026-10-13 2026-10-20 raw.csv
nora stream new norway-exports --from raw.csv
```

| ENTSOG point direction | NORA asset |
| --- | --- |
| UK-TSO-0001ITP-00022entry (St Fergus) | `vesterled` |
| UK-TSO-0001ITP-00091entry (Easington) | `langeled_south` |
| BE-TSO-0001ITP-00106entry (Zeebrugge ZPT) | `zeepipe_1` |
| FR-TSO-0003ITP-00045entry (Dunkerque) | `franpipe` |
| DE-TSO-0005/0009ITP-00208entry (Dornum) | `dornum` |
| DE-TSO-0002/0005, NL-TSO-0001ITP-00210entry (Emden NPT) | `norpipe` |

On 2026-10-27 the platform returned "No result found" for recent dates and timed out on
older ones, so this dataset is not in the repository yet. If you get it working, see
[issue #2](https://github.com/Rayha33/nora-network/issues/2).

## Choosing the dataset that plays first

The home page replays the stream with the lowest `order` (default 100, then by name).
`synthetic-week` sets `order = 1` because it moves the whole network.
