# Working on NORA (for AI coding assistants and the people using them)

NORA (Network Operations and Realtime Analysis) is an open model of the North Sea gas
network: CSV data, a networkx graph, flow and outage analysis, streams replayed as live
data, and a pyvis chart published to GitHub Pages. Many people change it, often through
an assistant, so keep changes small, tested and easy to review.

## Commands

```bash
make setup     # once: .venv with NORA and dev tools
make check     # what CI runs: lint, validate, tests, build. Run before every commit.
make fix       # auto-format and fix lint
make serve     # build and open the site at http://127.0.0.1:8000
make live      # replay the first stream as a live feed at http://127.0.0.1:8765
.venv/bin/nora stats            # deliverable gas and the worst single outages
.venv/bin/nora stream show NAME # what a stream contains
```

## Map of the code

| file | job |
| --- | --- |
| `data/nodes.csv`, `data/pipelines.csv` | the network; documented in `data/README.md` |
| `data/streams/*/stream.toml` | time-series datasets; documented in `data/streams/README.md` |
| `src/nora/data.py` | load and validate the CSVs; every problem gets file, line and a suggestion |
| `src/nora/graph.py` | build the `networkx.DiGraph` |
| `src/nora/analysis.py` | max flow, min-cost routing, N-1 outages, `analyse()` for the site |
| `src/nora/stream.py` | load, import, synthesise and scaffold streams |
| `src/nora/live.py` | serve a stream as Server-Sent Events (`/stream`) |
| `src/nora/render.py` | pyvis nodes, edges and options, rendered through our own template |
| `src/nora/templates/network.*` | the chart page: template, CSS and all browser behaviour |
| `src/nora/templates/index.html.j2` | the home page |
| `src/nora/site.py` | writes the site folder that GitHub Pages serves |
| `src/nora/cli.py` | the `nora` command |
| `tests/` | pytest; `tests/conftest.py` has a five-node network to test against |

## Rules that keep it working

- **The CSVs are the source of truth.** Never hard-code assets in Python or JS. New
  columns need a line in `data/README.md` and handling in `data.py`.
- **Report data problems, do not crash.** Validation collects every problem into one
  `DataError` with file and line, so a contributor can fix them all in one pass.
- **Deterministic output.** Graphs are built in id order and flow results must not depend
  on `PYTHONHASHSEED` (a test checks this). No wall-clock times in the built site.
- **network.html stays one self-contained file.** No external scripts; vis-network is
  inlined from pyvis. Web fonts are the only optional external resource.
- **Data in the browser is untrusted.** Anyone can edit the CSVs, so build DOM with
  `textContent` (the `h()` helper), never `innerHTML` with data.
- **Units are MSm3/d** everywhere in code and data.
- **Honest labels.** Synthetic data is labelled synthetic; model results say they are
  from the model. Do not present estimates as measurements.
- **Add a test** with every behaviour change. Prefer the tiny network in `conftest.py`.
- Follow the style around you: plain names, short docstrings that say why, ruff clean.

## Typical tasks

- *Add or fix assets:* edit the CSVs, add a `source`, run `make check`.
- *Add a dataset:* `nora stream new NAME --from file.csv`, fix the mapping, `nora stream show NAME`.
- *New analysis:* add a function to `analysis.py`, include its result in `analyse()`,
  show it in `index.html.j2` or as a chart mode in `network.js`, and test it.
- *Connect a real live source:* write a generator yielding `(datetime, {asset: flow})`
  frames and serve it the way `live.serve` serves `replay`; the browser needs no change.

## Workflow

Branch from `main`, open a pull request, and the CI and preview workflows run. A preview
of the site is posted on the PR. Merging to `main` publishes the site automatically.
