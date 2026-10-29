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
make edit      # the same, and the network editor's Save writes data/ (right-click in Flow)
make live      # replay the first stream as a live feed at http://127.0.0.1:8765
.venv/bin/nora stats            # deliverable gas and the worst single outages
.venv/bin/nora stream show NAME # what a stream contains
```

## Map of the code

| file | job |
| --- | --- |
| `nora.toml` | display settings, alarm thresholds, `[quality]` limits, pressure windows, light and dark palettes; validated by `src/nora/config.py` |
| `src/nora/config.py` | deep-merges and validates `nora.toml`; the validated settings drive thresholds, pressure windows and both palettes |
| `data/nodes.csv`, `data/pipelines.csv` | the network; documented in `data/README.md` |
| `data/units.toml` | the operating units; every node in exactly one (`src/nora/units.py`) |
| `data/pipeline_models.csv`, `src/nora/pms.py`, `scripts/build_pipeline_models.py` | each pipeline's regression for the What-if's pressures (as a PMS keeps them), seeded from Weymouth |
| `data/flow_layout.toml` | where each node sits in the Flow view, Area D-style; dragging a node and Save updates it |
| `src/nora/units.py` | validates unit membership and assigns each pipeline to the unit of its source node |
| `data/streams/*/stream.toml` | time-series datasets; documented in `data/streams/README.md` |
| `src/nora/data.py` | load and validate the CSVs; every problem gets file, line and a suggestion |
| `src/nora/graph.py` | build the `networkx.DiGraph` |
| `src/nora/analysis.py` | max flow, min-cost routing, N-1 outages, plant capacity, `analyse()` for the site |
| `src/nora/ops.py` | plan check (are the nominations deliverable?), look-ahead, decision support |
| `src/nora/stream.py` | load, import, synthesise (flows, operations, gas quality, pigs) and scaffold streams |
| `src/nora/live.py` | serve a stream, a polled source or readings pushed to `/ingest` as Server-Sent Events (`/stream`); [docs/live-data.md](docs/live-data.md) |
| `src/nora/integrations.py` | live connectors: Gassco real-time, National Gas (IUK), Origo and Gassco Booking (built against mocks; [docs/integrations.md](docs/integrations.md)) |
| `src/nora/layout.py` | Flow view positions: layered stages, ordered and spaced to minimise crossings |
| `src/nora/icons.py` | one icon per asset type, shared by both views |
| `src/nora/render.py` | the app page: one payload for both views, map GeoJSON, the pyvis flow network |
| `src/nora/templates/app.*` | the app shell: page, styles, shared state, styling rules, alarms, routes of pigs and peaks, gas quality, what-if, player |
| `src/nora/templates/map.js` | Map view: MapLibre on OpenFreeMap tiles, assets at true coordinates |
| `src/nora/templates/map2d.js` | the same Map view on a plain 2D canvas, used when the browser has no WebGL (or `?map=simple`) |
| `src/nora/templates/flow.js` | Flow view: the pyvis network on dotted paper, top to bottom |
| `src/nora/templates/index.html.j2` | the home page: it opens the app (no essay) |
| `src/nora/site.py` | writes the site folder that factorlab.app/nora-network/ serves |
| `src/nora/cli.py` | the `nora` command |
| `src/nora/edit.py` | the editor's JSON API (`nora serve --edit`) and lossless editing of the data files |
| `scripts/fetch_*.py` | download real data (ENTSOG, Energinet, SODIR, National Gas) into a stream's raw file |
| `scripts/mock_origo.py`, `scripts/mock_gbs.py`, `scripts/mock_api.py` | mock Origo and GBS APIs (made-up data) for `nora integrations fetch` and the tests |
| `data/geo/coastline.json`, `scripts/build_coastline.py` | the land around the North Sea (Natural Earth, public domain) for the canvas map |
| `data/geo/routes.json`, `scripts/build_routes.py` | laid pipeline routes from SODIR's register (NLOD), drawn on both maps |
| `data/geo/bathymetry.json`, `scripts/build_bathymetry.py` | water depth under the map (EMODnet, CC BY 4.0) for the position readout ("ED 58 m") and asset facts |
| `tests/` | pytest; `tests/conftest.py` has a five-node network to test against |
| `tests/js/` | Node tests that load the real templates (`make test-js`); see its README |
| `tests/browser/` | the browser smoke check: the built site in headless Chromium, every screen, both themes (`make smoke`, CI job "browser smoke"); see its README |

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
- **Style in one place.** `App.pipeStyle()` and `App.nodeStyle()` in app.js are the only
  view-neutral style entry points for pipelines and nodes. `App.markers()` supplies the
  moving PIG/peak/quality markers and `App.drawMarker()` draws their shared symbols.
  The Map and Flow views apply these results; do not duplicate threshold or state rules.
- **Gas quality.** `[quality]` limits in `nora.toml` drive the H₂S and CO₂ levels. Their
  marker colours (`h2s`, `co2` in each palette) stay muted and distinct from the alarm
  colours; see the display rules below.
- **Views are independent.** map.js and flow.js each implement the view contract at the
  top of app.js. Work on one without touching the other.
- **Data in the browser is untrusted.** Anyone can edit the CSVs, so build DOM with
  `textContent` (the `h()` helper), never `innerHTML` with data.
- **Units are MSm3/d** everywhere in code and data.
- **Honest labels.** Synthetic data is labelled synthetic; model results say they are
  from the model. Do not present estimates as measurements.
- **Do not overstate diagnostics.** Level 4 shows the readings, gaps, dataset/asset
  source metadata and CSV row available to NORA. It is not yet end-to-end live SCADA
  interface/tag lineage.
- **Add a test** with every behaviour change. Prefer the tiny network in `conftest.py`.
- **Editing API:** `nora serve --edit` binds only to `127.0.0.1` unless `NORA_EDIT_TOKEN`
  is set; hosted, every check and save must carry that key. Keep its JSON-only,
  same-origin and key checks and never accept client-supplied file paths. Validate
  the complete proposed network before writing; preserve untouched CSV rows exactly.
- Follow the style around you: plain names, short docstrings that say why, ruff clean.

## Display rules (binding)

The maintainer set these for the network views. Make every visual change smaller and
calmer, never louder.

- **Calm grey paper.** Colour appears only for abnormal states, in the ISO alarm order:
  pre-alarm amber (triangle, "3"), medium orange (diamond, "2"), alarm red (square, "1").
  Colour never stands alone: it always comes with a shape, a number and text. Normal
  states are greys: light grey normal, dark grey closed, lightest grey active, never
  pure white. Model answers (Load, Risk) never borrow the alarm palette.
- **Hairline lines**, thin and minimal. Never put text over text; labels never fade.
- **Visuals over absolute numbers:** the trend toward a limit, the last 2 hours and the
  time to the limit.
- **Pigs and peaks are small**: about 5 to 6 px, with a 4 px band from tail to head.
  Only a few move at a time, and slowly.
- **Configurable for any screen:** a control-room video wall, an operator desk and a
  tablet (issue #59). The top bar keeps a fixed size. Light and dark modes both work.

## Typical tasks

- *Add or fix assets:* edit the CSVs, add a `source`, run `make check`.
- *Add a dataset:* `nora stream new NAME --from file.csv`, fix the mapping, `nora stream show NAME`.
- *New analysis:* add a function to `analysis.py`, include its result in `analyse()`,
  show it in the app (a mode in `app.js`: pipeStyle / nodeStyle, or a panel), and test it.
- *Connect live data:* push JSON to `nora live --ingest` from any system, poll a source
  with a `Connector`, or replay files as a stream; see [docs/live-data.md](docs/live-data.md).
  The browser needs no change.

## Workflow

Branch from `main`, open a pull request, and CI runs; its run keeps the built site as an
artifact. Check a change locally with `make serve`. Merging to `main` publishes the site
automatically.

NORA is published in one place only: https://factorlab.app/nora-network/, which copies
the `gh-pages` branch (built on every merge) every 10 minutes. There are no other NORA
sites and no PR preview sites (Ray, 29 Oct). Nothing has to be deployed by hand. [HANDOVER.md](HANDOVER.md) records what has been
done and decided so far; unmerged work in progress from earlier sessions is kept on
`archive/*` branches.
