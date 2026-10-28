/* The map without WebGL, peaks with a head and a tail, and the live numbers inside the
   Flow circles. Ray, 28 Oct: "This browser has no WebGL, so the map cannot draw" -
   "fix this"; "still cant see colored opaque area along the pipeline with the dot as
   the peak in the middle of the area, showing the head and tail of the peak"; "dont use
   icons inside the node circles ... live flow values and pressures". */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, assertHealthy } from "./harness.mjs";

const HOUR = 3600;

test("map: without WebGL (or MapLibre) the Map view draws on a plain canvas instead", () => {
  const loaded = loadApp(); // the harness has neither WebGL nor MapLibre
  assertHealthy(assert, loaded);
  const { App } = loaded;
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  const view = App.views.map;
  assert.equal(view.canvasMap, true, "the canvas map took over the Map view");
  assert.equal(view.ready, true, "and it is ready");
  for (const name of ["restyle", "draw", "setUnit", "highlight", "focus", "fit", "resize", "theme", "applySettings"]) {
    assert.equal(typeof view[name], "function", `it implements view.${name}`);
  }
  assert.doesNotThrow(() => { view.restyle(); view.draw(); view.resize(); view.focus(App.nodeIds[0], false); });
});

test("map: the page carries the coastline the canvas map fills as land", () => {
  const { NORA } = loadApp();
  assert.ok(NORA.land && NORA.land.rings.length > 10, "land rings are in the payload");
  for (const ring of NORA.land.rings.slice(0, 5)) {
    assert.ok(ring.length >= 4, "each ring is a polygon");
    for (const [lon, lat] of ring) assert.ok(lon >= -14 && lon <= 24 && lat >= 46 && lat <= 71, "inside the network's box");
  }
});

test("peaks: a band from tail to head around the dot, ahead in the direction of travel", () => {
  const loaded = loadApp();
  const { App } = loaded;
  loadFirstHour(App, loaded.NORA);
  const stream = App.live.stream;
  const pid = stream.assets.find((id) => App.pipeIds.includes(id) && App.live.frames[0].flows[id] > 1);
  for (const forward of [true, false]) {
    App.live.peaks = [{ id: pid, t0: stream.times[0], delta: 20, forward, level: 0 }];
    App.live.time = stream.times[0] + 0.5 * HOUR;
    const peak = App.markers().find((m) => m.kind === "peak");
    assert.ok(peak, "the peak is on screen");
    const [tail, head] = peak.extent;
    for (const x of [tail, head]) assert.ok(x >= 0 && x <= 1, "the band stays on its line");
    const lo = Math.min(tail, head), hi = Math.max(tail, head);
    assert.ok(lo <= peak.along && peak.along <= hi, "the dot sits inside its band");
    assert.ok(forward ? head >= tail : head <= tail, "the head is ahead of the tail, the way the gas flows");
    assert.ok(hi - lo > 0, "the band has a length");
  }
  assert.equal(typeof App.drawBand, "function", "views draw the band with App.drawBand");
});

test("flow circles: live flow (MSm³/d) and pressure (bar) for each node", () => {
  const loaded = loadApp();
  const { App } = loaded;
  loadFirstHour(App, loaded.NORA);
  const readings = App.nodeIds.map((id) => App.reading(id));
  assert.ok(readings.some((r) => r.flow > 0), "nodes carry a live flow");
  assert.ok(readings.some((r) => r.pressure > 0), "and a pressure where it is measured");
});

/* One real hour of the first stream with pressures, the way `start()` loads it. */
function loadFirstHour(App, nora) {
  const stream = nora.streams.find((s) => s.metrics && s.metrics.pressure_bar) || nora.streams[0];
  App.live.stream = stream;
  stream.step = stream.times.length > 1 ? stream.times[1] - stream.times[0] : HOUR;
  const flows = {};
  stream.assets.forEach((id, j) => { if (stream.values[0][j] != null) flows[id] = stream.values[0][j]; });
  const metrics = {};
  for (const [name, block] of Object.entries(stream.metrics || {})) {
    metrics[name] = {};
    block.assets.forEach((id, j) => { if (block.values[0][j] != null) metrics[name][id] = block.values[0][j]; });
  }
  App.live.frames = [{ t: stream.times[0], flows, metrics, plan: null }];
  App.live.index = 0;
  App.live.time = stream.times[0];
}
