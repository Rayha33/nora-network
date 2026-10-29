# NORA: Network Operations and Realtime Analysis

An open model of the North Sea gas network that anyone can improve: the fields,
platforms, processing plants, terminals and pipelines that carry Norwegian, British,
Dutch and Danish gas to Europe's markets.

**[Open the live site](https://rayha33.github.io/nora-network/)** ·
[the app on its own](https://rayha33.github.io/nora-network/network.html) ·
[contribute](CONTRIBUTING.md)

[![CI](https://github.com/Rayha33/nora-network/actions/workflows/ci.yml/badge.svg)](https://github.com/Rayha33/nora-network/actions/workflows/ci.yml)
[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Rayha33/nora-network?quickstart=1)

## What it does

- **Map.** The network at its true coordinates on a real map (MapLibre with free
  OpenFreeMap tiles). Click any asset for its details and a link to its data row.
- **Flow.** The whole Gassco network as a gas flow overview drawn with
  [pyvis](https://pyvis.readthedocs.io/): fields on the left, terminals and markets on
  the right, on a dotted paper canvas, with flows written on the lines.
- **Analysis.** [networkx](https://networkx.org/) computes how much gas the network can
  deliver to each market (max flow) and how much is lost if any single asset trips (N-1).
  The *Load* and *Risk* modes show both, on the map and in the flow overview.
- **Live replay.** Time series of flows, from a synthetic week to real daily flows from
  Energinet and a year of the Interconnector (IUK) both ways from National Gas, play
  back as if they were arriving live: lines
  fill and empty, dots move with the gas, alarms fire when a flow drops. Add a real
  dataset with one command; `nora live` serves it as a real Server-Sent Events feed.
- **One-file sharing.** `network.html` is a single file you can email or host anywhere;
  the flow overview even works offline. The whole site is static and rebuilt on every merge.
- **Any screen in a control room.** One page fits a video wall, an operator desk and a
  tablet. It picks a display profile and one UI scale from the window: large and dark
  on a wall, with the pointer hidden when idle. Settings, Display can change both, and
  so can the link: `?display=wall|desk|compact`, `?scale=150`, and `?rotate=60` to cycle
  Overview, Map and Flow on an unattended screen.

## Quick start

```bash
git clone https://github.com/Rayha33/nora-network.git && cd nora-network
make setup        # finds Python 3.11+ (macOS's own python3 is too old) and creates .venv
make check        # lint, validate, Python and JS tests, build: what CI runs
make serve        # builds the site and opens http://127.0.0.1:8000
```

You need Python 3.11 or newer and git. Node 20+ is optional: with it, `make check` also
runs the JavaScript tests. `make help` lists every command.

Or press the Codespaces badge above for a ready-made workspace in the browser.

```bash
.venv/bin/nora stats                    # what the network delivers, and its weak points
.venv/bin/nora live                     # replay a stream as a live feed
.venv/bin/nora stream new my-data --from flows.csv   # add your own dataset
```

## Add your own data

| you have | do this |
| --- | --- |
| a correction or a source | edit `data/nodes.csv` or `data/pipelines.csv` in the browser ([how](CONTRIBUTING.md)) |
| a time series of flows | `nora stream new NAME --from file.csv`, check the mapping ([guide](data/streams/README.md)) |
| a live API | yield frames from a generator and serve them like `nora.live.replay` ([AGENTS.md](AGENTS.md)) |

## How it fits together

```
data/*.csv ─► data.py (validate) ─► graph.py (networkx) ─► analysis.py (max flow, N-1)
                                                       │
data/streams/ ─► stream.py (import, synthesise) ───────┼─► render.py ─► network.html (Map: MapLibre, Flow: pyvis)
                                                       └─► site.py ─► index.html + data/*.json
                                    live.py ─► /stream (Server-Sent Events) ─► network.html?live=/stream
```

Every pull request is checked, built and given its own preview link. Merging to `main`
publishes the site to GitHub Pages. Details for contributors and AI assistants are in
[CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Roadmap

The [issues](https://github.com/Rayha33/nora-network/issues) are the roadmap. Directions:

- **Realtime.** Connect live sources such as the ENTSOG Transparency Platform.
- **Data quality.** Sources for every row.
- **Scenarios.** What-if outages and demand cases run in the browser.
- **Operations.** Line pack, pressure and alarms closer to a real control room.

## About the data

Positions, capacities and lengths are approximate figures compiled from public sources,
and many rows still need a citation. Map data is from
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, with tiles by [OpenFreeMap](https://openfreemap.org/). NORA is for
learning, exploration and discussion, and is not suitable for operational decisions.

MIT licensed. See [LICENSE](LICENSE).
