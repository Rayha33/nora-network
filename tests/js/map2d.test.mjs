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

test("flow circles: each outgoing line's flow sits in the quadrant facing that line", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  // Positions as the Flow view lays them out: stages top to bottom, ranks left to right.
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 178, y: stage * 124 }]));
  let checked = 0;
  for (const id of App.nodeIds) {
    const q = App.views.flow.quadrants(id, pos);
    let out = 0;
    for (const pid of App.pipeIds) {
      const p = NORA.assets[pid], v = App.live.values[pid];
      if (!v || Math.abs(v) < 0.05 || App.pipeStyle(pid).hidden) continue;
      if ((p.from === id && v > 0) || (p.to === id && v < 0)) out += Math.abs(v);
    }
    const shown = Object.values(q).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(shown - out) < 1e-6, `${id}: every outgoing flow is written once`);
    for (const side of Object.keys(q)) assert.ok(["NE", "SE", "SW", "NW"].includes(side), "four quadrants");
    if (Object.keys(q).length) checked++;
  }
  assert.ok(checked > 10, "many nodes send gas out");
  // Drag a node to the other side of its outgoing line's far end: the number moves quadrant.
  const id = App.nodeIds.find((n) => Object.keys(App.views.flow.quadrants(n, pos)).length === 1);
  const [side] = Object.keys(App.views.flow.quadrants(id, pos));
  const [sx, sy] = [side[1] === "E" ? 1 : -1, side[0] === "S" ? 1 : -1];
  const flipped = { ...pos, [id]: { x: pos[id].x + sx * 9000, y: pos[id].y + sy * 9000 } };
  const [after] = Object.keys(App.views.flow.quadrants(id, flipped));
  assert.equal(after, `${side[0] === "S" ? "N" : "S"}${side[1] === "E" ? "W" : "E"}`, "dragged past it, the flow faces the line again");
});

test("exit circles: within-day delivery against the nominations, as a share", () => {
  const { App, NORA } = loadApp();
  const exit = "easington";
  const pipe = App.pipeIds.find((id) => NORA.assets[id].to === exit && NORA.assets[id].type !== "onshore");
  const day0 = Date.UTC(2026, 9, 20, 5) / 1000; // a gas day starting 05:00 UTC
  const frame = (h, delivered) => ({ t: day0 + h * HOUR, flows: { [pipe]: delivered }, metrics: { nomination_msm3d: { [exit]: 20 } }, plan: null });
  App.live.frames = [0, 1, 2, 3].map((h) => frame(h, 20));
  App.live.index = 3;
  assert.equal(App.dayDelivery(exit).share, 0, "delivered exactly as nominated: on plan");
  assert.equal(App.dayDelivery(exit).level, 0, "and no alarm");
  App.live.frames = [0, 1, 2, 3].map((h) => frame(h, 17));
  const short = App.dayDelivery(exit);
  assert.ok(Math.abs(short.share + 0.15) < 1e-9, "15 % short over the day so far");
  assert.equal(short.level, 3, "past the critical tolerance");
  App.live.frames = [frame(-2, 0), frame(0, 20), frame(1, 20)]; // the hour before 05:00 belongs to yesterday
  App.live.index = 2;
  assert.equal(App.dayDelivery(exit).share, 0, "only this gas day counts");
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
