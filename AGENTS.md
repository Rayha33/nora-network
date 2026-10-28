# Working on NORA (for AI coding assistants and the people using them)

NORA (Network Operations and Realtime Analysis) is an open model of the North Sea gas
network: CSV data, a networkx graph, flow and outage analysis, streams replayed as live
data, and an app with a real map and a pyvis gas flow overview, published to GitHub
Pages. Many people change it, often through an assistant, so keep changes small, tested
and easy to review.

## Commands

```bash
make setup     # once: .venv with NORA and dev tools
make check     # what CI runs: lint, validate, Python and JS tests, build. Run before every commit.
make fix       # auto-format and fix lint
make serve     # build and open the site at http://127.0.0.1:8000
make live      # replay the first stream as a live feed at http://127.0.0.1:8765
.venv/bin/nora stats            # deliverable gas and the worst single outages
.venv/bin/nora stream show NAME # what a stream contains
```

## Map of the code

| file | job |
| --- | --- |
| `nora.toml` | display settings, alarm thresholds, `[quality]` limits, pressure windows, light and dark palettes; validated by `src/nora/config.py` |
| `data/nodes.csv`, `data/pipelines.csv` | the network; documented in `data/README.md` |
| `data/units.toml` | the operating units; every node in exactly one (`src/nora/units.py`) |
| `data/streams/*/stream.toml` | time-series datasets; documented in `data/streams/README.md` |
| `src/nora/data.py` | load and validate the CSVs; every problem gets file, line and a suggestion |
| `src/nora/graph.py` | build the `networkx.DiGraph` |
| `src/nora/analysis.py` | max flow, min-cost routing, N-1 outages, plant capacity, `analyse()` for the site |
| `src/nora/ops.py` | plan check (are the nominations deliverable?), look-ahead, decision support |
| `src/nora/stream.py` | load, import, synthesise (flows, operations, gas quality, pigs) and scaffold streams |
| `src/nora/live.py` | serve a stream, or poll a live source, as Server-Sent Events (`/stream`) |
| `src/nora/integrations.py` | live connectors: Gassco real-time, Origo and Gassco Booking (skeletons) |
| `src/nora/layout.py` | Flow view positions: layered stages, ordered and spaced to minimise crossings |
| `src/nora/icons.py` | one icon per asset type, shared by both views |
| `src/nora/render.py` | the app page: one payload for both views, map GeoJSON, the pyvis flow network |
| `src/nora/templates/app.*` | the app shell: page, styles, shared state, styling rules, alarms, routes of pigs and peaks, gas quality, what-if, player |
| `src/nora/templates/map.js` | Map view: MapLibre on OpenFreeMap tiles, assets at true coordinates |
| `src/nora/templates/flow.js` | Flow view: the pyvis network on dotted paper, top to bottom |
| `src/nora/templates/index.html.j2` | the home page |
| `src/nora/site.py` | writes the site folder that GitHub Pages serves |
| `src/nora/cli.py` | the `nora` command |
| `src/nora/edit.py` | local-only JSON API and lossless CSV editing for `nora serve --edit` |
| `scripts/fetch_*.py` | download real data (ENTSOG, Energinet, SODIR) into a stream's raw file |
| `tests/` | pytest; `tests/conftest.py` has a five-node network to test against |
| `tests/js/` | Node tests that load the real templates (`make test-js`); see its README |

## Rules that keep it working

- **The CSVs are the source of truth.** Never hard-code assets in Python or JS. New
  columns need a line in `data/README.md` and handling in `data.py`.
- **Report data problems, do not crash.** Validation collects every problem into one
  `DataError` with file and line, so a contributor can fix them all in one pass.
- **Deterministic output.** Graphs are built in id order and flow results must not depend
  on `PYTHONHASHSEED` (a test checks this). No wall-clock times in the built site.
- **network.html stays one file.** vis-network and NORA's scripts are inlined, so the Flow
  view works offline. Only MapLibre (pinned, integrity-checked), map tiles and fonts
  come from the web; a test enforces this.
- **Style in one place.** `App.pipeStyle` and `App.nodeStyle` in app.js decide colour,
  width and labels for every mode; the views only apply them, so both stay in step.
- **Views are independent.** map.js and flow.js each implement the view contract at the
  top of app.js. Work on one without touching the other.
- **Data in the browser is untrusted.** Anyone can edit the CSVs, so build DOM with
  `textContent` (the `h()` helper), never `innerHTML` with data.
- **Units are MSm3/d** everywhere in code and data.
- **Honest labels.** Synthetic data is labelled synthetic; model results say they are
  from the model. Do not present estimates as measurements.
- **Add a test** with every behaviour change. Prefer the tiny network in `conftest.py`.
- **Local editing API:** `nora serve --edit` must bind only to `127.0.0.1`. Keep its
  JSON-only, same-origin checks and never accept client-supplied file paths. Validate
  the complete proposed network before writing; preserve untouched CSV rows exactly.
- Follow the style around you: plain names, short docstrings that say why, ruff clean.

## Typical tasks

- *Add or fix assets:* edit the CSVs, add a `source`, run `make check`.
- *Add a dataset:* `nora stream new NAME --from file.csv`, fix the mapping, `nora stream show NAME`.
- *New analysis:* add a function to `analysis.py`, include its result in `analyse()`,
  show it in `index.html.j2` or as a mode in `app.js` (pipeStyle / nodeStyle), and test it.
- *Connect a real live source:* write a generator yielding `(datetime, {asset: flow})`
  frames and serve it the way `live.serve` serves `replay`; the browser needs no change.

## Workflow

Branch from `main`, open a pull request, and the CI and preview workflows run. A preview
of the site is posted on the PR. Merging to `main` publishes the site automatically.
