# Browser smoke check

`smoke.mjs` builds the site, serves it on a free port and opens `network.html` in
headless Chromium (playwright-core). It catches what pytest and the Node `vm` tests in
`tests/js` cannot: an exception on load, a screen that renders nothing, a theme toggle
that does nothing, "[object …]" in the page, text too faint to read.

## Run

```bash
npm ci --prefix tests/browser                                    # once
tests/browser/node_modules/.bin/playwright-core install chromium # once
make smoke                                                       # or: node tests/browser/smoke.mjs
```

`NORA="python -m nora"` picks another way to run `nora build`; `--site DIR` checks an
existing build instead; `--shots DIR` moves the screenshots (default
`tests/browser/screenshots`, ignored by git). It exits 1 and lists every failed check.

## What it checks

- no console errors or uncaught exceptions, on load (playing) and while it clicks around
- the Guide opens on the first visit and not on the second
- the theme toggle flips `data-theme` and the palette
- each screen renders: `#/overview`, `#/unit/all` on Map and Flow, `#/unit/hubs`,
  `#/asset/easington`, `#/asset/sleipner`, `#/diag/easington` (the ids are checked
  against `data/nodes.csv` and `data/units.toml` first)
- the Map (on its 2D canvas, without WebGL) and Flow draw the network: the canvas
  redrawn with every asset hidden must differ from the canvas as it is
- the asset Facts list and pages contain no "[object", `undefined` or `NaN`
- `App.markers()` returns a pig and an H₂S or CO₂ peak at some hour of the opening stream
- every piece of Overview text has a contrast of at least 4.5:1, in light and dark
- screenshots of Overview, Map and Flow in light and dark (a CI artifact)

## Offline and repeatable

Every request that leaves the local server is blocked (MapLibre, map tiles, Google
fonts), and WebGL is off, so the Map draws on its 2D canvas (`map2d.js`) with the
coastline inside the page. The page's clock is fixed, and after the first load the data
stays paused, so every run sees the same hour.

## Known failures

`KNOWN` at the top of `smoke.mjs` lists contrast failures already on `main`, each with
the board task that fixes it. The list is strict: when a known failure stops happening
the run fails and asks for its entry to be deleted, so fix and entry go in one change.
