# NORA: handover

This file was a local, untracked working note until 2026-10-29; it is now part of the
repository so that a fresh clone carries the whole history. The newest state is at the
top. The session log further down is kept as written, so local paths in it
(`/Users/...`, `~/.hermes/...`) refer to the maintainer's machine and will not exist in
your clone.

## Start here (state on 2026-10-29)

- Clone and check: `git clone https://github.com/Rayha33/nora-network.git && cd
  nora-network && make setup && make check`. Verified on 2026-10-29 from a clean clone
  of `main` (Python 3.14, Node for the JS tests): lint, validate, Python and JS tests
  and the build all pass. `make help` lists the rest.
- How the code fits together and the rules for changing it: [AGENTS.md](AGENTS.md),
  including the **display rules** for the network views, which are binding.
- Published from every merge to `main`:
  - GitHub Pages: https://rayha33.github.io/nora-network/
  - Mirror: https://factorlab.app/nora-network/. A systemd timer on that server
    (`nora-network-sync.timer`, script `/usr/local/bin/nora-network-sync`) pulls the
    built `gh-pages` branch every 10 minutes, without the PR previews, and swaps it in
    atomically. Nothing is built there and no credentials are involved.
- `main` is protected: branch, pull request, CI green, then merge. Several sessions
  merge often, so rebase onto `origin/main` and re-run `make check` before merging.
- Unmerged work from earlier sessions is on `archive/2026-10-29/*` branches, never
  reviewed and not meant to be merged as is:
  `wip-issue-3-entsog-live-source`, `wip-issue-18-js-harness`, `wip-latest-ui`,
  `wip-flow-endpoints`, `feat/compact-header`, `fix/readable-flow-overview`,
  `perf/map-frame`, `ops/live-single-load` and `stash-hermes-redesign-before-pr61`.
  Mine them for ideas; most of their intent has since shipped in other PRs.
  `hermes/unpushed-2026-10-28` holds the 28 October commits that shipped as #130/#134.
- The open issues are the roadmap.

# History

NORA (Network Operations and Realtime Analysis) is a networkx + pyvis model of the
North Sea gas infrastructure, co-editable on GitHub and hosted on GitHub Pages.

## Where things live

- Repo: https://github.com/Rayha33/nora-network (public). Default branch `main`.
  Rules: PRs required + status check "checks", but a repo admin can push straight to
  main (it prints "Bypassed rule violations" — that is fine).
- Live site: https://rayha33.github.io/nora-network/network.html (plus index.html).
  Pages deploys automatically on every merge to main; PR previews give a link per PR.
- Local clone: /Users/rayha/nora-network with venv at .venv (activate: `. .venv/bin/activate`).
  Tools: `nora {validate,stats,build,serve,live,stream}`; tests `python -m pytest -q` (38 tests).
- Local clone setup from scratch: `git clone https://github.com/Rayha33/nora-network && cd nora-network && uv venv .venv && . .venv/bin/activate && uv pip install -e . pytest`.

## Architecture (see AGENTS.md in the repo for the AI-assistant layout guide)

- `src/nora/` — Python package: data, graph, analysis, layout, render, site, stream, live.
  Templates in `src/nora/templates/` (app.html.j2, app.css, app.js, map.js, flow.js).
  map.js and flow.js are separate on purpose so people can work on either view alone.
- `data/nodes.csv` (60 assets) and `data/pipelines.csv` (66 pipelines) — the network.
- `data/streams/` — replayable datasets: `synthetic-week` (generated), `denmark-gas-energinet`
  (real, daily, Aug–Oct 2026), `norway-exports` (real, hourly, 13–20 Oct 2026),
  `norway-exports-daily` (real, per gas day, 1–28 Oct 2026, adds Easington).
  Adding a dataset is documented in data/streams/README.md (4 steps, `nora stream new`).
- CI on every PR; `Deploy site` workflow on merge; Pages build is GitHub's own.

## What is DONE (do not redo)

- Issue #1 CLOSED: every node and pipeline row now cites a source (commits baa7f3e,
  2defd99, merge 80d7588). Sources documented in data/README.md. Verified all non-source
  columns byte-identical. `nora validate`: OK 60 nodes, 66 pipelines, 3 streams.
- Issue #2 CLOSED (data/entsog-exports): every Norwegian landing that has a public
  measurement is in. The German operators report under their OWN point keys, not
  Gassco's (ITP-00208/209/210 are Gassco-only, hasData false): Dornum GASPOOL
  (ITP-00525 -> europipe_2_south, ~62 MSm3/d), Emden EPT1 OGE+GUD+GTS (ITP-00080/081/160
  -> the emden terminal, ~83; Norpipe was merged into EPT1 on 1 Oct 2015), plus Baltic
  Pipe's North Sea Entry (DK ITP-00630 -> baltic_pipe_ns, ~18). Pipe-in-pipe repeats
  (Thyssengas ITP-00105, Dornum / NETRA ITP-00126/188) are left out, following ENTSOG's
  dashboard list. The UK reports daily only, so Easington is in `norway-exports-daily`;
  St Fergus is "Norway+UK" and above Vesterled's capacity, so Vesterled, FLAGS and SAGE
  have no readings. Every query and reason: data/streams/README.md.
- Final visual check of the merged site: PASS (map tiles + assets + pipelines, pyvis flow
  diagram renders after ~5-8 s load, live replay with player/sparkline works, zero console
  errors). One blank-screenshot scare was a load-timing artifact, fine on reload.
  Note: vision_analyze (image input) is unavailable on the z-ai/glm-5.3-flash model in this
  profile — verify visually via browser DOM text (page_info / js innerText) instead.

## Brief for the next session

1. **Full code review first.** Review the whole package (`src/nora/`, `scripts/`, tests,
   workflows) and the data files as a structured audit: correctness, edge cases, security
   (the `nora live` SSE server and any path handling), performance (graph recompute on
   every step?), and frontend code in `templates/*.js`. Report findings ranked, with
   file:line references. Fix what is clearly broken (with tests), file issues for the rest.
2. **Then continue building.** Work the open issues in this order (each is scoped on GitHub):
   #3 connect a live source, #5 what-if mode, #6 plant capacity, #4 storage sites, #7 timeline.
   Land each as its own PR with CI green and a preview link; use the PR → review → merge
   flow so the co-editing model gets exercised. Update this file's "What is DONE" section
   as you go.

3. **New data sources to try.** Two datasets are on the wishlist (open a PR or a scoped
   issue for whichever works first — verify the endpoints live before writing the fetcher,
   and add a `scripts/fetch_*.py` + `data/streams/.../stream.toml` in the same shape as
   the ENTSOG/Energinet ones):
   - **SODIR (Norwegian Offshore Directorate)**: public open data on offshore fields,
     facilities and production. Their open datasets include gas production per field
     (monthly, MSm3) and a machine-readable field/facility register with coordinates.
     Start from https://www.norskpetroleum.no/en/factpages/ and the SODIR data portal
     (former NPD factpages: https://factpages.npd.no). Good fit for: adding/updating
     field nodes, per-field production streams, and correcting the asset coordinates.
     Note the license on each dataset before committing rows.
   - **Gassco's public map**: gassco.no has an interactive map of the Norwegian gas
     system (pipelines, terminals, fields). Check whether it is backed by an ArcGIS /
     Mapbox / GeoJSON endpoint (open DevTools → Network tab while the map loads, look
     for .json / FeatureServer / Query requests). If so, that gives an authoritative
     asset+pipeline geometry source to reconcile our nodes.csv/pipelines.csv against.
     If it is not machine-readable, screenshot/trace it manually and treat it as the
     ground truth for a data-correction PR instead.

# Open issues (next candidates)

- #3 Connect a live source: poll an API and serve it with `nora live`
- #4 Add gas storage sites
- #5 What-if mode: take assets offline on the chart
- #6 Model processing-plant capacity in the flow analysis
- #7 Show planned and decommissioned assets on a timeline

## Session log (append-only, newest first)

### 2026-10-28 ~10:40 — Hermes (claude-opus-5.5) continued Claude's handover

- Merged #57 (review fixes, rebased; liveBars part dropped), #66 (timeline: now in the
  middle, model to the right, `[screen] now_in_middle`), #67 (labels >= 11 px, badge
  numbers semibold). main = 8959c4f; 97 py / 46 JS tests; site/ rebuilt from main.
- `main` is checked out in another session's worktree
  (~/.hermes/cache/scratch/nora-dark-fix, #65), so this clone sits on detached
  origin/main. Build site/ with `git checkout --detach origin/main && nora build`.
- Gotcha: after `git stash` / `pop` within the same second, a same-size .py edit can
  hit a stale __pycache__; clear `src/**/__pycache__` if a test sees old values.
- Next from Claude's list: #59 display profiles, #38 Gassco schematic, then hub 3606/3607
  (clickable pigs/peaks). Follow-ups: Map numbers italic in model time; live-feed
  look-ahead; maybe loop autoplay round "now".

### 2026-10-27, second session (Hermes) — IN PROGRESS

- Picked up the brief above. Repo state at start: branch `main`, HEAD 80d7588, clean except
  this untracked HANDOVER.md (do NOT commit it — it is a working note, or commit it
  deliberately if we decide to keep it in-repo).
- Two read-only subagents were dispatched in parallel (delegation id
  `deleg_9d949796`, ids sa-0-fb549462 and sa-1-aa6722d5); live transcripts at
  `/Users/rayha/.hermes/cache/delegation/live/deleg_9d949796/task-0.log` (audit) and
  `task-1.log` (data sources). If you are a later session reading this and no results
  are recorded below, read those transcripts first — the work may already be done there.
- Subagent 1 (code audit): full structured review of `src/nora/`, scripts, tests,
  workflows, data files, templates (correctness, `nora live` SSE security, graph
  recompute performance, frontend JS, test quality). READ-ONLY, no commits.
  Pending: its ranked findings with file:line refs → fix what is clearly broken with
  tests, file issues for the rest.
- Subagent 2 (data sources, recon only, no repo writes): verify SODIR endpoints
  (factpages.npd.no / norskpetroleum.no / likely api.sodir.no) for the field/facility
  register with coordinates and monthly per-field gas production, plus license terms;
  and check whether gassco.no's map is backed by an ArcGIS/GeoJSON endpoint.
  Pending: its endpoint URLs, formats, licenses.
### Data-source recon RESULTS (2026-10-27, verified live by subagent)

- SODIR is machine-readable and NLOD-licensed (Norwegian Licence for Open Government
  Data, https://data.norge.no/nlod/en). factpages.npd.no 301-redirects to
  factpages.sodir.no (live). Worked endpoints:
  - Facility register w/ coordinates (CSV zip, WKT + lat/lon, ED50 datum, water depth,
    operator, status, startup date): https://factpages.sodir.no/downloads/csv/fclPoint.zip
  - Field register (polygons in WKT + operator + hc type):
    https://factpages.sodir.no/downloads/csv/fldArea.zip
  - Pipelines with geometry (WKT, from/to facility, medium, operator — main lines only):
    https://factpages.sodir.no/downloads/csv/pipLine.zip
  - Monthly per-field production (CSV via SSRS render; 28,564 rows verified;
    prfPrdGasNetBillSm3 = net gas billion Sm3):
    https://factpages.sodir.no/public?/Factpages/external/tableview/field_production_monthly&rs:Command=Render&rc:Toolbar=false&rc:Parameters=f&IpAddress=not_used&CultureCode=en&rs:Format=CSV&Top100=false
  - ArcGIS REST (facilities layer 307, pipelines layer 311, ED50 UTM32 wkid 23032):
    https://factmaps.sodir.no/api/rest/services/Factmaps/FactMapsED50UTM32/MapServer
    (folder queries 403 but direct layer /query works)
  - api.sodir.no: TCP timeout from this host — unverified, retest before ruling out.
  - Recon artifacts (sample CSVs etc.): /Users/rayha/.hermes/cache/scratch/
    (prod_monthly.csv, fclPoint/, fldArea/, pipLine/)
- Gassco: NOT machine-readable. gassco.no -> gassco.eu, map is a static inline SVG
  (WordPress ACF block; pixel coords, not geographic). Only usable as a named
  node/edge connectivity list (50 [data-pipeline], 37 [data-platform], 11 [data-terminal],
  3 [data-plant] with data-from/data-to). One real JSON endpoint exists:
  https://gassco.eu/wp-json/gassco/v1/realTimeGraphData (aggregate flows by receiving
  country — could feed a live stream, no geometry). Conclusion: use SODIR for geometry
  ground truth; treat the Gassco SVG as reference for a data-correction PR.

### Code-audit status

- First audit subagent came back shallow (only: 38 tests pass, validate OK, ENTSOG fix
  intact) — NOT a real review. Re-dispatched with per-file reading requirements;
  if that fails again, do the audit manually.

### Code-audit RESULTS and fixes (all landed 2026-10-27)

- Deep audit completed (second attempt; ranked findings with file:line evidence, 46
  tests were green at baseline). PR #12 "Fix findings from the full code review"
  MERGED (main = 8c39eed, gh-pages redeployed, live site verified to carry the fix).
  38 → 46 tests, validate OK, build OK.
- Fixed in PR #12: XSS (escape names in render.py + flow.js), replay() empty-stream
  busy-loop, fetch_entsog empty-result misdiagnosis + backoff-after-final-try,
  stream-name/raw-file path traversal, event time/capacity_factor validation,
  raw-CSV whitespace stripping, routed_flow min 1 kSm3/d, offline-map focus crash
  (setView guard + map.js null guards), connectFeed stale-event alarms, live-server
  test free port. CI gotchas: ruff check E501 (100 cols) and `ruff format --check`
  are enforced — run `uvx ruff@latest check . && uvx ruff format .` before pushing
  (the venv's ruff is too old to read the config).
- Filed as issues (design decisions / JS harness needed): #13 totalOf double-count,
  #14 deploy.yml lacks validate+pytest gating, #15 duplicate flows.csv row semantics,
  #16 SSE keepalive, #17 cmd_live double loads, #18 JS test harness.
- Issues list is now: #3 live source, #4 storage sites, #5 what-if, #6 plant capacity,
  #7 timeline, plus #13-#18 above (new, from the audit).

### NEXT (in order, one PR each, CI green, preview link)

### 2026-10-27 ~12:30 — Claude's HMI overhaul landed as PR #19 (MERGED, main = 676980a)

- Ray's directive to Claude: "the network view needs to be adaptable and configurable,
  minimalistic, ISO standards for colors." Claude built it in its own scratch clone
  (~/Library/Application Support/Claude/scratch-workspaces/.../scratch-2026-10-27-3b0f5c/nora,
  branch ops/plan-status-iso-hmi) and was cut off mid-task by a usage limit. Hermes picked
  up the uncommitted tree: fixed the one failing/stale test (north-to-south row order is no
  longer the layout's contract — the layered Sugiyama layout cuts crossings 112 -> 15 and
  the test now asserts spacing + a crossings ceiling), ran ruff format, verified in a real
  browser (all four screens: overview / unit map+flow / asset / diag; theme toggle; live
  replay ticking; no crashes), committed Claude's tree exactly as it stood, and merged
  PR #19. 47 tests green, validate now also checks nora.toml + units.
- What's in it: nora.toml config (display settings, ISO alarm thresholds, marker physics),
  four hash-routed screens, ISO alarm colours (amber/orange/red, greys otherwise),
  layered low-crossing flow layout, indicator cards with 4h trends, unit grouping,
  first-visit guide with "Next problem", autoplay on open, new modules
  config/units/ops/integrations + data/units.toml.
- IMPORTANT: Claude's session RESUMED and is actively working in its scratch clone on
  the NEXT feature (gas quality: H2S/CO2 excursions following the gas to exit points,
  editing nora.toml [quality], stream.py, config.py, synthetic-week stream.toml as of
  12:30). Its post-merge edits build on the merged 63b3bf1. Do NOT touch its scratch
  tree; it must pull main before its next PR. Hub note posted (project "nora", id 46567).
- Screenshots of the new UI: /Users/rayha/.hermes/cache/scratch/nora_{overview,flow,map}.png

### NEXT (in order, one PR each, CI green, preview link)

1. Support Claude's gas-quality work if asked; otherwise let Claude land its PR.
2. Land the SODIR source (verified live, see recon results above): a
   `scripts/fetch_sodir.py` for the monthly per-field production CSV + a
   `data/streams/.../stream.toml`, NLOD license noted; optionally a follow-up PR
   reconciling nodes.csv coordinates against fclPoint (ED50 datum — note ED50 vs
   WGS84 offset when using SODIR coordinates). Gassco realTimeGraphData
   (aggregate by receiving country) is a candidate for issue #3.
3. Then issues #3 → #5 → #6 → #4 → #7 as before.

## Gotchas learned this session

- ENTSOG TP is flaky: 502s on unscoped queries, 404 = "no result found". Query point by
  point, one point per request, short ranges, no parallel calls, with backoff — that is
  what scripts/fetch_entsog.py does. `nora stream new` scaffolds stream.toml but guesses
  the asset column wrong on ENTSOG's long layout (it picked periodTo); set
  `asset = "pointLabel"` by hand and map points to pipeline ids in [import.assets].
- `nora validate` and `python -m pytest -q` must pass before any push (CI enforces).
- Model routing: this session runs on z-ai/glm-5.3-flash (Ray's preferred model is
  GPT-5.6 Luna, but it was unavailable due to Claude/limit issues).
- If you delegate citation/data work, give each subagent its own clone or a separate
  branch and say so explicitly — two agents in one tree collide on git state.
