/* The map without WebGL, peaks with a head and a tail, and the live numbers inside the
   Flow circles. Ray, 28 Oct: "This browser has no WebGL, so the map cannot draw" -
   "fix this"; "still cant see colored opaque area along the pipeline with the dot as
   the peak in the middle of the area, showing the head and tail of the peak"; "dont use
   icons inside the node circles ... live flow values and pressures". */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  view.zoomAt(100, 100, 0.000001); // reach the minimum zoom at the centre
  const before = view.camera();
  view.zoomAt(400, 30, 0.5); // another zoom-out gesture away from the centre
  assert.deepEqual(view.camera(), before, "zooming beyond the limit does not slide the camera");
});

test("map: the page carries the coastline the canvas map fills as land, and its box", () => {
  const { NORA } = loadApp();
  assert.ok(NORA.land && NORA.land.rings.length > 10, "land rings are in the payload");
  const [w, s, e, n] = NORA.land.box;
  const [[bw, bs], [be, bn]] = NORA.config.map.bounds;
  assert.ok(w < bw && s < bs && e > be && n > bn, "the box holds the whole network");
  for (const ring of NORA.land.rings) {
    assert.ok(ring.length >= 4, "each ring is a polygon");
    for (const [lon, lat] of ring) assert.ok(lon >= w && lon <= e && lat >= s && lat <= n, "inside the box");
  }
});

/* The land is clipped to its box, so a view past the box showed land cut off in a straight
   line, and the sea beyond it (Ray, 29 Oct: "map seem to be glitched"). */
function canvasMap(width, height) {
  const loaded = loadApp({ globals: { Path2D: class { moveTo() {} lineTo() {} closePath() {} } } });
  const { App, document } = loaded;
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  const host = Object.assign(document.createElement("div"), { clientWidth: width, clientHeight: height });
  const view = App.views.map;
  view.mount(host);
  const canvas = host.children.find((c) => c.className === "map2d");
  canvas.setPointerCapture = () => {};
  const fire = (type, e) => { for (const fn of canvas._listeners[type] || []) fn({ pointerId: 1, button: 0, ...e }); };
  const drag = (dx, dy) => {
    fire("pointerdown", { offsetX: width / 2, offsetY: height / 2 });
    fire("pointermove", { offsetX: width / 2 + dx, offsetY: height / 2 + dy });
    fire("pointerup", { offsetX: width / 2 + dx, offsetY: height / 2 + dy });
  };
  // What the view shows, in degrees: Web Mercator back to longitude and latitude.
  const shown = () => {
    const { x, y, k } = view.camera();
    const lon = (mx) => mx * 360 - 180, lat = (my) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
    return { west: lon(x - width / 2 / k), east: lon(x + width / 2 / k), north: lat(y - height / 2 / k), south: lat(y + height / 2 / k) };
  };
  return { App, view, drag, shown, land: loaded.NORA.land.box, bounds: loaded.NORA.config.map.bounds };
}

test("map: zoomed out and dragged to any side, the canvas map stays over its land", () => {
  for (const [width, height] of [[1280, 800], [1600, 700], [1000, 700]]) {
    const { view, drag, shown, land: [w, s, e, n] } = canvasMap(width, height);
    view.zoomAt(width / 2, height / 2, 1e-6); // as far out as it goes
    for (const [dx, dy] of [[5000, 0], [-5000, 0], [0, 5000], [0, -5000], [4000, 4000], [-4000, -4000]]) {
      drag(dx, dy);
      const v = shown(), at = `${width}x${height} dragged ${dx},${dy}`;
      assert.ok(v.west >= w - 1e-6 && v.east <= e + 1e-6, `${at}: ${v.west.toFixed(1)}..${v.east.toFixed(1)} E within the land`);
      assert.ok(v.south >= s - 1e-6 && v.north <= n + 1e-6, `${at}: ${v.south.toFixed(1)}..${v.north.toFixed(1)} N within the land`);
    }
  }
});

test("map: on a very wide wall the whole network still fits, before the land's edge", () => {
  const { view, shown, bounds: [[bw, bs], [be, bn]] } = canvasMap(5000, 700);
  view.zoomAt(2500, 350, 1e-6);
  const v = shown();
  assert.ok(v.west <= bw && v.east >= be && v.south <= bs && v.north >= bn, "Aasta Hansteen to Poland is in view");
});

test("peaks: the band and head follow every bend in the pipeline path", () => {
  const { App } = loadApp();
  const lines = [], curves = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient") return () => ({ addColorStop: () => {} });
      if (key === "lineTo") return (x, y) => lines.push([x, y]);
      if (key === "quadraticCurveTo") return (cx, cy, x, y) => curves.push([cx, cy, x, y]);
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  App.drawBand(ctx, { kind: "peak" }, { x: 0, y: 0 }, { x: 100, y: 100 }, 8, [{ x: 0, y: 0 }, { x: 50, y: 60 }, { x: 100, y: 100 }]);
  assert.ok(lines.some(([x, y]) => x === 50 && y === 60), "the body passes through the actual pipeline vertex");
  assert.equal(curves.length, 0, "no smoothing curve may cut across the pipeline bend");
});

test("peaks: band sampling includes route vertices between head and tail", () => {
  const { App } = loadApp();
  assert.equal(typeof App.bandStops, "function");
  const forward = App.bandStops([0.1, 0.9], [0.1, 0.35, 0.55, 0.9]);
  assert.ok(forward.includes(0.35) && forward.includes(0.55), "neither bend is skipped");
  assert.equal(forward[0], 0.1);
  assert.equal(forward.at(-1), 0.9);
  const reverse = App.bandStops([0.9, 0.1], [0.1, 0.35, 0.55, 0.9]);
  assert.ok(reverse.every((value, i) => i === 0 || reverse[i - 1] > value), "reverse flow keeps head after tail");
  assert.ok(reverse.includes(0.35) && reverse.includes(0.55));
  const trimmed = App.bandStops([0.05, 0.95], [0, 0.23, 0.51, 0.77, 1], [0.1, 0.9]);
  assert.ok(trimmed.some((value) => Math.abs(value - 0.1625) < 1e-9),
    "a raw route vertex is converted into the same node-trimmed coordinates as the marker");
});

test("peaks: pipeline names stay above moving bands and peak markers", () => {
  const operations = [];
  const Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  const loaded = loadApp({ globals: { Path2D } });
  const { App, document, NORA } = loaded;
  const context = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      if (key === "fillText" || key === "strokeText") return (text) => operations.push({ op: key, text });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    if (String(tag).toLowerCase() === "canvas") node.getContext = (type) => (type === "2d" ? context : null);
    return node;
  };
  const el = document.getElementById("view-map");
  el.clientWidth = 1000;
  el.clientHeight = 700;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  App.state.view = "map";
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const view = App.views.map;
  assert.equal(view.canvasMap, true);
  const drawBand = App.drawBand;
  App.drawBand = (...args) => { operations.push({ op: "band" }); drawBand(...args); };
  const drawMarker = App.drawMarker;
  App.drawMarker = (...args) => { operations.push({ op: "marker" }); return drawMarker(...args); };
  operations.length = 0;
  view.restyle();
  const band = operations.findIndex((op) => op.op === "band");
  const marker = operations.findIndex((op) => op.op === "marker");
  const pipelineName = operations.findIndex((op) => op.op === "fillText" && App.pipeIds.some((id) => App.pipeMapName(id) === op.text));
  assert.ok(band >= 0, "a moving band is drawn");
  assert.ok(marker > band, "a peak marker crosses the route after its band");
  assert.ok(pipelineName > band, "pipeline names are drawn on top of the band");
  assert.ok(pipelineName > marker, "pipeline names are also drawn on top of the peak marker");
});

test("peaks: opaque ends taper to a quieter centre behind the dot", () => {
  const { App } = loadApp();
  const stops = [];
  const gradient = { addColorStop: (offset, color) => stops.push({ offset, color }) };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient") return () => gradient;
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  App.drawBand(ctx, { kind: "peak" }, { x: 0, y: 0 }, { x: 100, y: 0 });
  assert.ok(stops.length >= 3, "the band has end and centre opacity stops");
  const alpha = (stop) => parseInt(stop.color.slice(-2), 16);
  assert.equal(alpha(stops[0]), 255, "the tail is fully opaque");
  assert.equal(alpha(stops.at(-1)), 255, "the head is fully opaque");
  assert.ok(alpha(stops[Math.floor(stops.length / 2)]) < 128, "the centre lets the dot stand out");
});

test("peaks: Flow samples the pipeline path instead of joining only head and tail", () => {
  const { App, NORA } = loadApp();
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const edge = Object.values(NORA.assets).find((asset) => asset.from && asset.to && App.nodeIds.includes(asset.from) && App.nodeIds.includes(asset.to));
  const extent = [0.2, 0.8];
  const path = App.views.flow.bandPath(edge, extent, pos);
  assert.ok(path.length >= 5, "the moving body follows several points on the visible line");
  assert.deepEqual(path[0], App.views.flow.pointAlong(edge, extent[0], pos));
  assert.deepEqual(path.at(-1), App.views.flow.pointAlong(edge, extent[1], pos));
});

test("flow nodes: the fitted overview stays simple until labels are readable", () => {
  const { App } = loadApp();
  assert.equal(App.views.flow.detailedFlow(0.24), false, "the whole-network fit uses clean totals, not tiny labels");
  assert.equal(App.views.flow.detailedFlow(1), true, "full labels appear at 100% zoom");
  assert.equal(App.views.flow.overviewReading(0.24, 62), true, "a total appears when the circle can contain it");
  assert.equal(App.views.flow.overviewReading(0.08, 62), false, "tiny nodes stay clean dots without spilled text");
  assert.deepEqual(Array.from(App.views.flow.overviewNameLines("Oseberg")), ["Oseberg"], "short node names stay on one line");
  assert.deepEqual(Array.from(App.views.flow.overviewNameLines("Zeebrugge terminal")), ["Zeebrugge", "terminal"], "long names wrap instead of shrinking");
});

test("flow overview: a blocked node name moves instead of disappearing", () => {
  const { App } = loadApp();
  const blockers = [[60, 136, 140, 166]]; // exactly where the name would normally sit
  const placement = App.views.flow.overviewNamePlacement({ x: 100, y: 100 }, 32, 1, 80, 30, blockers);
  assert.ok(placement, "a clear nearby placement is always found");
  const box = [placement.left, placement.top, placement.left + 80, placement.top + 30];
  assert.ok(!blockers.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]), "the moved name is collision-free");
});

/* Ray, 30 Oct: the Draupner names were "too far away from under the node ... make a bit
   more space and make it more oraganised". A name sits centred under its own square, 4 px
   clear; the node's own tag under the square pushes it straight down, never aside or up. */
test("flow overview: a name sits centred under its square, below its own tags", () => {
  const { App } = loadApp();
  const place = App.views.flow.overviewNamePlacement;
  const plain = place({ x: 100, y: 100 }, 32, 1, 80, 16, [], { width: 400, height: 400 });
  assert.deepEqual([plain.left, plain.top], [60, 136], "centred, 4 px under the square");
  const tag = [110, 132, 150, 160]; // the node's own tag under the square's bottom-right corner
  const under = place({ x: 100, y: 100 }, 32, 1, 80, 16, [tag], { width: 400, height: 400 }, [tag]);
  assert.deepEqual([under.left, under.top], [60, 164], "still centred, 4 px under its own tag");
});

test("flow overview: a name near the bottom stays inside the canvas", () => {
  const { App } = loadApp();
  const placement = App.views.flow.overviewNamePlacement({ x: 100, y: 100 }, 32, 1, 80, 30, [], { width: 200, height: 150 });
  assert.ok(placement, "an in-canvas placement is found");
  assert.ok(placement.left >= 0 && placement.top >= 0, "the name does not leave the top or left edge");
  assert.ok(placement.left + 80 <= 200 && placement.top + 30 <= 150, "the name does not leave the bottom or right edge");
});

test("flow overview: a name uses a shifted side slot when vertical slots are full", () => {
  const { App } = loadApp();
  const blockers = [[60, 0, 135, 250], [138, 85, 218, 115]];
  const placement = App.views.flow.overviewNamePlacement({ x: 100, y: 100 }, 32, 1, 80, 30, blockers, { width: 250, height: 250 });
  assert.ok(placement, "a shifted side slot prevents the name from disappearing");
  const box = [placement.left, placement.top, placement.left + 80, placement.top + 30];
  assert.ok(!blockers.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]), "the side slot is collision-free");
});

test("flow overview: flow in above, flow out below, under the pressure tag", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: stage * 250, y: rank * 72 }]));
  const labels = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "fillText") return (text, x, y) => labels.push({ text, x, y, font: target.font });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const half = 60, scale = 0.4;
  const id = App.nodeIds.find((node) => {
    const lines = App.views.flow.lineReadings(node, pos);
    return lines.some((line) => line.direction === "in") && lines.some((line) => line.direction === "out");
  });
  assert.ok(id, "the fixture has a node with both incoming and outgoing gas");
  const tag = { box: [-30, -76, 30, -44] };
  App.views.flow.drawOverviewFlows(ctx, 0, 0, id, App.colors.card.active, { half, total: 50, tag, positions: pos, scale });
  // Ray, 29 Oct: "when zoomed out i should still be able to see flow in and out of a
  // node, in above and out below"
  assert.equal(labels.length, 2, "flow in and flow out");
  assert.ok(labels.every((label) => /^[\d.,]+M$/.test(label.text)), "the numbers alone: no in or out text");
  const [first, second] = [...labels].sort((a, b) => a.y - b.y);
  const lines = App.views.flow.lineReadings(id, pos), sum = (dir) => lines.filter((l) => l.direction === dir && l.value >= 0.05).reduce((t, l) => t + l.value, 0);
  assert.equal(first.text, `${App.fmt(sum("in"), sum("in") < 10 ? 1 : 0)}M`, "in above");
  assert.equal(second.text, `${App.fmt(sum("out"), sum("out") < 10 ? 1 : 0)}M`, "out below");
  assert.ok(first.y > tag.box[3] && second.y < half, "under the pressure tag, inside the square");
  assert.ok(labels.every((label) => parseFloat(label.font) >= 11), "overview flows meet the readability floor");
});

test("flow overview: a square fits its cell, with room for its name", () => {
  const { App } = loadApp();
  const flow = App.views.flow;
  assert.ok(flow.overviewSquareHalf(0.27) * 0.27 >= 22, "at least 22 px a half on screen when there is room");
  const cell = { down: 215, across: 246 }, scale = 0.34;
  const half = flow.overviewSquareHalf(scale, cell) * scale;
  assert.ok(2 * half + 30 <= cell.down * scale + 1e-9, "square and name fit between two rows (they overlapped)");
  assert.ok(2 * half + 16 <= cell.across * scale + 1e-9, "and between neighbours");
  assert.equal(flow.overviewSquareHalf(1), 64, "the established detailed square size is unchanged");
  assert.equal(flow.overviewSquareHalf(1.1), 64, "zooming in keeps the detailed size");
});

test("flow pressures: endpoint labels remain visible when zoomed out", () => {
  const { App } = loadApp();
  assert.equal(App.views.flow.pressureVisibility("live", 0.25), true, "live pressures do not disappear below the detail zoom");
  assert.equal(App.views.flow.pressureVisibility("load", 0.25), false, "non-live modes still have no live pressure labels");
});

/* Ray, 29 Oct: "pressures need to be like this at every end of lines but they should
   be inside their own small rectangle where the line comes in or leaves". */
function busiest(App, pos) {
  return App.nodeIds.reduce((best, id) => (App.views.flow.lineReadings(id, pos).length > App.views.flow.lineReadings(best, pos).length ? id : best));
}
const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

test("flow pressures: a tag on the square's edge at every line end, zoomed in", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const flow = App.views.flow, half = 64;
  for (const id of App.nodeIds) {
    const p = pos[id], tags = flow.pressureTags(id, pos, 1.1, half), lines = flow.lineReadings(id, pos);
    assert.equal(tags.length, lines.length, `${id}: one tag per line end`);
    for (const tag of tags) {
      const [x0, y0, x1, y1] = tag.box;
      const onEdge = [y1 - (p.y - half), y0 - (p.y + half), x0 - (p.x + half), x1 - (p.x - half)].some((d) => Math.abs(d) < 1e-6);
      assert.ok(onEdge, `${id}: the tag sits on the square's edge`);
      assert.match(tag.text, /^(\d[\d.,]*|–) bar$/, "the node's pressure, with its unit");
    }
    for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
      assert.ok(!overlap(tags[i].box, tags[j].box), `${id}: tags ${i} and ${j} do not overlap`);
    }
  }
  const id = busiest(App, pos);
  assert.ok(flow.pressureTags(id, pos, 1.1, half).length >= 5, "a busy hub has a tag at each of its lines");
});

test("flow pressures: zoomed out, a tag at every line end too, the number alone", () => {
  // Ray, 29 Oct: "we need these small squares with pressure values at each end the node
  // is connected to a line, and where the line comes and enter"
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const id = App.nodeIds.find((node) => App.reading(node).pressure != null && App.views.flow.lineReadings(node, pos).length >= 2 && !NORA.config.flow.watch.includes(node));
  const tags = App.views.flow.pressureTags(id, pos, 0.6, 64);
  assert.equal(tags.length, App.views.flow.lineReadings(id, pos).length, "one per line end");
  assert.ok(tags.every((t) => t.text === App.fmt(App.reading(id).pressure) && t.small), "the number alone, in the smaller type");
  assert.equal(App.views.flow.pressureTags(id, pos, 0.2, 20).length, 0, "none on a square too small to read");
});

test("flow pressures: a line ends at its tag, so the arrow touches it", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  const flow = App.views.flow, pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const id = busiest(App, pos), p = pos[id];
  for (const line of flow.lineReadings(id, pos)) {
    const d = flow.portDistance(id, line.ux, line.uy, pos), x = p.x + line.ux * d, y = p.y + line.uy * d;
    const tag = flow.pressureTags(id, pos, 1, 64).find((t) => x >= t.box[0] - 1e-6 && x <= t.box[2] + 1e-6 && y >= t.box[1] - 1e-6 && y <= t.box[3] + 1e-6);
    assert.ok(tag, `${line.pid}: the line ends on a tag`);
    const beyond = { x: p.x + line.ux * (d + 0.5), y: p.y + line.uy * (d + 0.5) };
    assert.ok(!(beyond.x > tag.box[0] && beyond.x < tag.box[2] && beyond.y > tag.box[1] && beyond.y < tag.box[3]), `${line.pid}: at its outer side`);
  }
});

test("flow nodes: live flow (MSm³/d) and pressure (bar) for each node", () => {
  const loaded = loadApp();
  const { App } = loaded;
  loadFirstHour(App, loaded.NORA);
  const readings = App.nodeIds.map((id) => App.reading(id));
  assert.ok(readings.some((r) => r.flow > 0), "nodes carry a live flow");
  assert.ok(readings.some((r) => r.pressure > 0), "and a pressure where it is measured");
});

test("map: major pipelines have concise persistent names", () => {
  const { App } = loadApp();
  assert.equal(App.pipeMapName("europipe_1"), "Europipe I");
  assert.equal(App.pipeMapName("europipe_2_north"), "Europipe II");
  assert.equal(App.pipeMapName("europipe_2_south"), "Europipe II");
  assert.equal(App.pipeMapName("franpipe"), "Franpipe");
  assert.equal(App.pipeMapName("zeepipe_1"), "Zeepipe I");
  assert.equal(App.pipeMapName("langeled_south"), "Langeled");
  // Ray, 29 Oct: "there is no Heimdal anymore, it is just a T connection now and the line
  // is called Heimskringla going from Oseberg to St. Fergus and Draupner".
  for (const id of ["ogt", "vesterled", "statpipe_heimdal"]) assert.equal(App.pipeMapName(id), "Heimskringla", id);
  assert.equal(App.nameOf("heimdal"), "Heimskringla tie-in");
  assert.equal(App.pipeMapName("troll_kollsnes"), "", "small feeders stay quiet");
});

test("pipelines: alarms never recolor the whole route", () => {
  const loaded = loadApp();
  const { App } = loaded;
  loadFirstHour(App, loaded.NORA);
  App.live.values = App.live.frames[0].flows;
  const pid = App.pipeIds.find((id) => Math.abs(App.live.values[id] || 0) >= 0.05);
  App.live.levelOf[pid] = 3;
  const style = App.pipeStyle(pid);
  assert.equal(style.level, 3, "the pipeline still carries its alarm badge");
  assert.equal(style.color, App.colors.active, "the whole pipeline stays in the active gray palette");
  assert.notEqual(style.color, App.levelColor[3], "critical red is not used for the route");
});

test("flow nodes: each outgoing line's flow sits in the quadrant facing that line", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  // Positions as the Flow view lays them out: stages top to bottom, ranks left to right.
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 178, y: stage * 124 }]));
  const mapOnly = new Set(NORA.config.flow.hide);
  let checked = 0;
  for (const id of App.nodeIds) {
    const q = App.views.flow.quadrants(id, pos);
    let out = 0;
    for (const pid of App.pipeIds) {
      const p = NORA.assets[pid], v = App.live.values[pid];
      if (!v || Math.abs(v) < 0.05 || App.pipeStyle(pid).hidden) continue;
      if (mapOnly.has(p.from) || mapOnly.has(p.to)) continue; // not in the Flow view (Poland VTP)
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

test("flow nodes: incoming and outgoing totals share space dynamically", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 178, y: stage * 124 }]));
  let checkedIn = 0, checkedOut = 0, mixed = null;
  for (const id of App.nodeIds) {
    const q = App.views.flow.flowQuadrants(id, pos);
    for (const [side, cell] of Object.entries(q)) {
      let incoming = 0, outgoing = 0;
      for (const pid of App.pipeIds) {
        const p = NORA.assets[pid], v = App.live.values[pid];
        if (!v || Math.abs(v) < 0.05 || (p.from !== id && p.to !== id)) continue;
        const otherId = p.from === id ? p.to : p.from;
        const otherSide = `${pos[otherId].y - pos[id].y > 0 ? "S" : "N"}${pos[otherId].x - pos[id].x >= 0 ? "E" : "W"}`;
        if (side !== otherSide) continue;
        if ((p.from === id) === (v > 0)) outgoing += Math.abs(v); else incoming += Math.abs(v);
      }
      assert.ok(Math.abs(cell.in - incoming) < 1e-6, `${id} ${side}: incoming flow is included`);
      assert.ok(Math.abs(cell.out - outgoing) < 1e-6, `${id} ${side}: outgoing flow is included`);
      if (incoming) checkedIn++;
      if (outgoing) checkedOut++;
      if (incoming && outgoing && !mixed) mixed = { id, radius: App.views.flow.circleRadius(id, pos) };
    }
  }
  assert.ok(checkedIn > 0, "incoming lines have readings");
  assert.ok(checkedOut > 0, "outgoing lines keep their readings");
  if (!mixed) {
    // Force two real connected lines into opposite directions on the same side.
    outer: for (const id of App.nodeIds) {
      const sides = {};
      for (const pid of App.pipeIds) {
        const p = NORA.assets[pid];
        if (p.from !== id && p.to !== id) continue;
        const otherId = p.from === id ? p.to : p.from;
        const side = `${pos[otherId].y - pos[id].y > 0 ? "S" : "N"}${pos[otherId].x - pos[id].x >= 0 ? "E" : "W"}`;
        (sides[side] = sides[side] || []).push(pid);
      }
      const pair = Object.values(sides).find((lines) => lines.length > 1);
      if (!pair) continue;
      for (const [index, pid] of pair.slice(0, 2).entries()) {
        const p = NORA.assets[pid], outgoing = index === 0;
        App.live.values[pid] = ((p.from === id) === outgoing ? 1 : -1) * 5;
      }
      mixed = { id, radius: App.views.flow.circleRadius(id, pos) };
      break outer;
    }
  }
  assert.ok(mixed, "a quadrant can contain both directions");
  assert.ok(mixed.radius > 30, "the mixed-direction circle expands for two stacked readings");
});

test("flow squares: every connected pipeline gets its own flow value inside the square", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const id = busiest(App, pos); // many connected lines: the case quadrant totals cannot represent
  const expected = App.pipeIds.filter((pid) => {
    const p = NORA.assets[pid];
    return (p.from === id || p.to === id) && !App.pipeStyle(pid).hidden;
  });
  assert.ok(expected.length >= 5);
  const labels = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "fillText") return (text, x, y) => labels.push({ text, x, y });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const half = App.views.flow.circleRadius(id);
  App.views.flow.drawQuadrants(ctx, 0, 0, id, App.colors.card.active, { total: null, r: half, positions: pos });
  assert.equal(labels.length, expected.length, "one reading per line, never a quadrant sum or a dropped zero");
  assert.ok(labels.every((label) => Math.abs(label.x) <= half && Math.abs(label.y) <= half), "every flow is inside the square");
  assert.ok(labels.every((label) => /M$|^–$/.test(label.text)), "every label is a flow value or an explicit missing value");
});

test("flow nodes: each line's reading sits by its own line, without prefixes", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 178, y: stage * 124 }]));
  let id, pair; // two lines the Flow view draws on the same side of one square
  for (const node of App.nodeIds) {
    const sides = {};
    for (const line of App.views.flow.lineReadings(node, pos)) (sides[line.side] = sides[line.side] || []).push(line.pid);
    pair = Object.values(sides).find((lines) => lines.length > 1);
    if (pair) { id = node; break; }
  }
  for (const [index, pid] of pair.slice(0, 2).entries()) {
    const p = NORA.assets[pid], outgoing = index === 0;
    App.live.values[pid] = ((p.from === id) === outgoing ? 1 : -1) * (5 + 2 * index); // 5.0M out, 7.0M in
  }
  const labels = [];
  let quadrantStrokes = 0;
  const ctx = new Proxy({
    measureText: (t) => ({ width: String(t).length * 6 }),
    fillText: (text, x, y) => labels.push({ text, x, y }),
    stroke: () => { quadrantStrokes++; },
  }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set(target, key, value) { target[key] = value; return true; },
  });
  App.views.flow.drawQuadrants(ctx, 0, 0, id, App.colors.card.active, { day: null, total: null, r: 44, positions: pos });
  // Ray, 29 Oct: "sometimes its difficult to see what flow value belongs to what edge
  // (line) because it seems to just be clumped up in the center of the node square".
  const tags = App.views.flow.pressureTags(id, pos, 1, 44), here = pos[id];
  for (const [index, pid] of pair.slice(0, 2).entries()) {
    const label = labels.find((l) => l.text === `${5 + 2 * index}.0M`);
    assert.ok(label, `the reading of ${pid} is drawn: ${JSON.stringify(labels)}`);
    const centre = (t) => [(t.box[0] + t.box[2]) / 2 - here.x, (t.box[1] + t.box[3]) / 2 - here.y];
    const nearest = tags.slice().sort((p, q) => Math.hypot(...centre(p).map((v, k) => v - [label.x, label.y][k])) - Math.hypot(...centre(q).map((v, k) => v - [label.x, label.y][k])))[0];
    assert.equal(nearest.pid, pid, `${label.text} sits by its own line's tag`);
    assert.ok(Math.abs(label.x) <= 44 && Math.abs(label.y) <= 44, "inside the square");
  }
  assert.ok(labels.every((label) => !/^(in|out)\s/.test(label.text)), "position alone communicates direction");
  assert.equal(quadrantStrokes, 0, "no quadrant divider lines are drawn inside the node");
});

test("markers: pipeline endpoints stop outside node circles", () => {
  const { App } = loadApp();
  assert.deepEqual(Array.from(App.visibleRange(100, 10)), [0.1, 0.9], "ten percent is clear at each end");
  assert.deepEqual(Array.from(App.visibleRange(20, 10)), [0.45, 0.55], "even a short line keeps a usable visible segment");
  assert.deepEqual(Array.from(App.visibleRange(0, 10)), [0, 1], "a degenerate line cannot produce NaN positions");
});

test("flow nodes: animated overlays stay outside enlarged nodes", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const edge = Object.values(NORA.assets).find((asset) => asset.from && asset.to && App.nodeIds.includes(asset.from) && App.nodeIds.includes(asset.to));
  for (const [along, node] of [[0, edge.from], [1, edge.to]]) {
    const point = App.views.flow.pointAlong(edge, along, pos);
    const radius = App.views.flow.circleRadius(node, pos);
    assert.ok(Math.hypot(point.x - pos[node].x, point.y - pos[node].y) > radius, "route markers stop beyond the circle");
  }
  assert.ok(App.views.flow.stubDistance(edge.from, 0, 1, pos) > App.views.flow.circleRadius(edge.from, pos), "animated flow strokes start outside the circle");
  const spaced = { own: { x: 0, y: 0 }, neighbour: { x: 300, y: 0 } };
  assert.equal(App.views.flow.stubClear({ x: 72, y: 0 }, { x: 80, y: 0 }, spaced, 1), true, "a stroke with clear space is drawn");
  const crowded = { own: { x: 0, y: 0 }, neighbour: { x: 100, y: 0 } };
  assert.equal(App.views.flow.stubClear({ x: 72, y: 0 }, { x: 80, y: 0 }, crowded, 1), false, "a stroke stops rather than entering a neighbouring node");
  App.settings().animation = true;
  App.live.playing = true;
  App.reduceMotion = false;
  assert.equal(App.views.flow.animateStubs(0.1), false, "decorative strokes are disabled when neighbouring nodes are too dense");
  assert.equal(App.views.flow.animateStubs(0.8), true, "animation returns when the drawing has room");
});

test("exit nodes: within-day delivery against the nominations, as a share", () => {
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

/* Ray, 29 Oct, with a photo of exit cards: "this is an example of how the bars could
   look like when it comes to end of day target". A track, the target band on it, and a
   mark where the day stands, coloured only outside the band. */
test("exit nodes: the end-of-day bar is a scale, a target band, the day so far and a mark", () => {
  // Ray, 29 Oct: "improve how the end of day target bar looks".
  const { App } = loadApp();
  const rects = [], strokes = [];
  let path = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "fillRect") return (x, y, w, h) => rects.push({ x, y, w, h, fill: target.fillStyle, alpha: target.globalAlpha });
      if (key === "beginPath") return () => { path = []; };
      if (key === "moveTo") return (x, y) => path.push([x, y]);
      if (key === "stroke") return () => strokes.push({ path: path.slice(), color: target.strokeStyle });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const look = { dim: "gray", ink: "black" }, half = 40;
  const T = App.thresholds.nomination, full = T[2] * 1.2, at = (share) => 100 + (share / full) * half;
  App.views.flow.drawDayBar(ctx, 100, 50, { share: 0.02, level: 0 }, look, 1, half);
  const [band, scale, sofar, mark] = rects;
  assert.ok(Math.abs(band.x - at(-T[0])) < 1e-9 && Math.abs(band.w - (at(T[0]) - at(-T[0]))) < 1e-9, "the target band is the tolerance");
  assert.ok(band.alpha < 1 && band.h > scale.h, "a soft band over a hairline scale");
  assert.equal(scale.w, 2 * half, "the scale spans the bar");
  const ticks = strokes.filter((s) => s.color === "gray").flatMap((s) => s.path.map(([x]) => x)).sort((a, b) => a - b);
  for (const share of [-T[2], -T[1], T[1], T[2]]) assert.ok(ticks.some((x) => Math.abs(x - at(share)) < 1e-9), `a tick at the ${share > 0 ? "+" : ""}${share * 100} % limit`);
  assert.ok(strokes.some((s) => s.color === "black" && s.path[0][0] === 100), "the nomination is marked at the centre");
  assert.ok(Math.abs(sofar.x - 100) < 1e-9 && Math.abs(sofar.w - (at(0.02) - 100)) < 1e-9, "the day so far runs from the nomination to where it stands");
  assert.equal(mark.fill, "black", "inside the band it is plain ink");
  assert.ok(Math.abs(mark.x + mark.w / 2 - at(0.02)) < 1e-9, "the mark is where the day stands");
  rects.length = 0;
  App.views.flow.drawDayBar(ctx, 100, 50, { share: -0.2, level: 2 }, look, 1, half);
  assert.equal(rects[3].fill, App.levelColor[2], "outside the band it takes the alarm colour");
  assert.ok(Math.abs(rects[2].x - (100 - half)) < 1e-9, "short: the bar runs left, held at the scale's end");
});

test("exit nodes: zoomed out the box shows the day bar and the next 6 hours of nominations", () => {
  // Ray, 29 Oct: "i should be able to see nomination graph when zoomed out as well".
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const stream = App.live.stream, frameAt = (k) => { // the hours ahead, as the player keeps them
    const metrics = {};
    for (const [name, block] of Object.entries(stream.metrics || {})) {
      metrics[name] = {};
      block.assets.forEach((id, j) => { if (block.values[k][j] != null) metrics[name][id] = block.values[k][j]; });
    }
    const flows = {};
    stream.assets.forEach((id, j) => { if (stream.values[k][j] != null) flows[id] = stream.values[k][j]; });
    return { t: stream.times[k], flows, metrics, plan: null };
  };
  const ahead = (6 * 3600) / stream.step; // six hours of the stream's data steps
  for (let k = 1; k <= ahead; k++) App.live.frames.push(frameAt(k));
  const exit = Object.keys(NORA.assets).find((id) => NORA.assets[id].exit && NORA.grid[id] && App.rampAhead(id)
    && App.rampAhead(id).hours.filter((h) => h.value != null).length > 3);
  assert.ok(exit, "an exit with nominations ahead");
  const draw = (scale) => {
    const lines = [];
    let path = [];
    const ctx = new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "beginPath") return () => { path = []; };
        if (key === "moveTo" || key === "lineTo") return (x, y) => path.push([x, y]);
        if (key === "stroke") return () => lines.push(path.slice());
        if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
        return () => {};
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    App.views.flow.drawOverviewFlows(ctx, 0, 0, exit, App.colors.card.active, { half: 60, total: 10, day: { share: 0, level: 0 }, scale });
    return lines.filter((l) => l.length > 9); // the steps: two points an hour (the limit ticks are 8)
  };
  assert.equal(draw(0.6).length, 1, "a box big enough on screen draws the steps");
  assert.equal(draw(0.3).length, 0, "too small: the bar alone");
});

test("exit nodes: the day bar fits inside the square and covers no flow value", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const half = App.views.flow.circleRadius(), y = -half * 0.52; // across the top (IMG_3589)
  const exits = Object.keys(NORA.assets).filter((id) => NORA.assets[id].exit && NORA.grid[id]);
  assert.ok(exits.length > 0);
  for (const id of exits) {
    const labels = [], fills = [];
    const ctx = new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
        if (key === "fillText") return (text, x, ty) => labels.push({ text: String(text), x, y: ty });
        if (key === "fillRect") return (x, fy, width, height) => fills.push({ x, y: fy, width, height });
        return () => {};
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    App.views.flow.drawSquare(ctx, 0, 0, id, App.colors.card.active, { half, now: App.reading(id), day: App.dayDelivery(id) || { share: 0, level: 0 } });
    assert.ok(labels.length > 0, `${id}: its flow is written in the square`);
    const bar = fills.filter((f) => Math.abs(f.y + f.height / 2 - y) < 1e-9); // track, band and mark
    assert.ok(bar.length >= 3, `${id}: the bar is drawn`);
    for (const f of bar) {
      assert.ok(f.x >= -half && f.x + f.width <= half && f.y >= -half && f.y + f.height <= half, `${id}: inside the square`);
      for (const l of labels) {
        const w = l.text.length * 6, box = [l.x - w / 2 - 2, l.y - 8, l.x + w / 2 + 2, l.y + 8];
        assert.ok(!(box[0] < f.x + f.width && box[2] > f.x && box[1] < f.y + f.height && box[3] > f.y),
          `${id}: "${l.text}" does not cover the day bar`);
      }
    }
  }
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

/* A live node is a square holding one flow value per line, with pressure in a tag at
   every line end; the rate and trend remain where there is room, and the name sits below. */
test("flow squares: rate, flows and trend sit inside, pressure moves to the line ends", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, loaded.NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  const id = App.nodeIds.find((node) => App.reading(node).pressure != null && App.reading(node).flow > 1);
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
      return (...args) => calls.push({ op: key, args, font: target.font });
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  App.views.flow.card(id)({ ctx, x: 0, y: 0, state: { selected: false, hover: false } }).drawNode();
  const half = App.views.flow.circleRadius(id);
  assert.ok(calls.some((c) => c.op === "roundRect" || c.op === "rect"), "the node is drawn as a square");
  assert.ok(!calls.some((c) => c.op === "arc"), "not as a circle");
  const inside = (c) => Math.abs(c.args[1]) <= half && Math.abs(c.args[2]) <= half;
  const pressure = calls.find((c) => c.op === "fillText" && c.args[0] === `${App.fmt(App.reading(id).pressure)} bar`);
  assert.equal(pressure, undefined, "pressure is no longer drawn inside the square");
  const flows = calls.filter((c) => c.op === "fillText" && /M$/.test(c.args[0]));
  assert.ok(flows.length > 0 && flows.every(inside), "the flow readings are inside the square");
  const name = calls.find((c) => c.op === "fillText" && c.args[0] === NORA.assets[id].name);
  assert.ok(name && name.args[2] > half, "the name sits below the square");
  for (const other of App.nodeIds) assert.equal(App.views.flow.circleRadius(other), half, "every live square is one size");
});

test("flow squares: lines and markers leave a square at its edge, corners too", () => {
  const { App } = loadApp();
  App.state.mode = "live";
  const half = App.views.flow.circleRadius();
  const edge = { from: "a", to: "b" };
  const diagonal = App.views.flow.pointAlong(edge, 0, { a: { x: 0, y: 0 }, b: { x: 1000, y: 1000 } });
  assert.ok(Math.max(Math.abs(diagonal.x), Math.abs(diagonal.y)) > half, "a marker on a diagonal line starts outside the square's corner");
  const straight = App.views.flow.pointAlong(edge, 0, { a: { x: 0, y: 0 }, b: { x: 0, y: 1000 } });
  assert.ok(straight.y > half && straight.y < half * 1.5, "and just below a square's edge on a straight one");
});

test("flow nodes: every reading is at least 11 px", () => {
  const loaded = loadApp();
  const { App } = loaded;
  loadFirstHour(App, loaded.NORA);
  App.state.mode = "live";
  const id = App.nodeIds.find((node) => App.reading(node).pressure != null);
  const fonts = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
      return (...args) => { if (key === "fillText") fonts.push(target.font); };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  App.views.flow.card(id)({ ctx, x: 0, y: 0, state: { selected: false, hover: false } }).drawNode();
  assert.ok(fonts.length > 0, "the circle has readings");
  for (const font of fonts) assert.ok(parseFloat(font) >= 11, `readable label: ${font}`);
});

/* Ray, 28 Oct: "the line shouldn't go over the text". Lines leave a Flow node
   downwards, straight through where its name is written, so the name, rate and trend
   sit on a paper backing drawn before the text, at full opacity. */
test("flow nodes: no line runs through a node's name", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, loaded.NORA);
  App.state.mode = "live";
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
      return (...args) => calls.push({ op: key, args, fill: target.fillStyle, alpha: target.globalAlpha });
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  for (const id of ["kvitebjorn", "sleipner"]) {
    calls.length = 0;
    App.views.flow.card(id)({ ctx, x: 0, y: 0, state: { selected: false, hover: false } }).drawNode();
    const name = calls.findIndex((c) => c.op === "fillText" && c.args[0] === NORA.assets[id].name);
    assert.ok(name >= 0, `${id}: the name is written below the circle`);
    const [, nx, ny] = calls[name].args;
    const backing = calls.slice(0, name).find((c) => c.op === "fillRect" && c.fill === App.colors.paper);
    assert.ok(backing, `${id}: a paper backing is drawn before the name`);
    assert.equal(backing.alpha, 1, `${id}: and it is opaque`);
    const [bx, by, bw, bh] = backing.args, width = String(calls[name].args[0]).length * 6;
    assert.ok(bx <= nx - width / 2 && bx + bw >= nx + width / 2, `${id}: it covers the name's width`);
    assert.ok(by <= ny - 10 && by + bh >= ny + 3, `${id}: and its height, descenders too`);
  }
});

/* Ray: no text over text. A peak's value and ETA go in the first corner beside its dot
   that is clear of the node circles and names (and of labels already placed); with no
   clear corner the label is left out, and hovering the dot still shows it. */
test("marker labels: never over a node name or another label", () => {
  const { App } = loadApp();
  const texts = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
      if (key === "fillText") return (t, x, y) => texts.push({ t, x, y });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const peak = { kind: "peak", value: "H₂S 3.2", eta: "09:30", id: "p" };
  const labelAt = (taken, marker = peak) => {
    texts.length = 0;
    App.drawMarker(ctx, marker, 100, 100, 0, 6.5, 1, taken);
    return texts.length ? texts[0] : null;
  };
  const free = labelAt([]);
  assert.ok(free.x > 100 && free.y < 100, "with room, the label sits up and to the right");
  const name = [100, 80, 200, 99]; // a node name where that label would go
  const moved = labelAt([name]);
  assert.ok(moved, "a blocked corner moves the label");
  assert.ok(!(moved.x < name[2] && moved.x + 60 > name[0] && moved.y > name[1] && moved.y < name[3]), "off the name");
  assert.equal(labelAt([[0, 0, 300, 300]]), null, "with no clear corner the label is left out");
  const taken = []; // two other peaks at one spot (each label remembers its own corner)
  const first = labelAt(taken, { ...peak, id: "p2" }), second = labelAt(taken, { ...peak, id: "p3" });
  assert.ok(second && (second.x !== first.x || second.y !== first.y), "a second peak at the same spot labels elsewhere");
});

/* Review finding: the canvas map cleared its container, which then held the page's map
   card, and every later navigation threw. Navigation must keep working after it. */
test("map: navigation keeps working after the canvas map takes over", () => {
  const { App, NORA, document } = loadApp();
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  assert.equal(App.views.map.canvasMap, true, "the canvas map took over");
  const unit = NORA.units[1];
  assert.doesNotThrow(() => App.go({ screen: "unit", unit: unit.id }), "navigating after the fallback");
  assert.equal(document.getElementById("crumb-unit"), null, "no unit menu: every unit is always on (Ray, 29 Oct)");
  assert.doesNotThrow(() => App.go({ screen: "overview" }), "and on to the overview");
});

// A canvas whose 2D context counts what is drawn, and a map container with a size.
function drawableCanvas(document, counts) {
  const make = document.createElement;
  document.createElement = (tag) => {
    const node = make(tag);
    if (tag === "canvas") {
      node.getContext = (kind) => (kind !== "2d" ? null : new Proxy({}, {
        get(target, key) {
          if (key in target) return target[key];
          if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
          return () => { counts[key] = (counts[key] || 0) + 1; };
        },
        set(target, key, value) { target[key] = value; return true; },
      }));
    }
    return node;
  };
  Object.assign(document.getElementById("view-map"), { clientWidth: 800, clientHeight: 600 });
}

/* Review finding: the canvas map (the one for machines without a GPU) redrew the
   whole map every animation frame even while paused. It redraws only while playing. */
test("map: the canvas map draws each frame only while the data plays", () => {
  const counts = {};
  const { App, document, NORA } = loadApp({ globals: { Path2D: class { moveTo() {} lineTo() {} closePath() {} } } });
  drawableCanvas(document, counts);
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } }); // pigs to move
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  const view = App.views.map;
  App.live.playing = false;
  const paused = counts.drawImage || 0;
  view.draw(); view.draw(); view.draw();
  assert.equal(counts.drawImage || 0, paused, "paused: no redraw per frame");
  App.live.playing = true;
  App.live.time += 1800; // the markers move on
  view.draw();
  assert.ok((counts.drawImage || 0) > paused, "playing: a frame where the markers moved redraws");
});

/* Review finding: after the online map style failed and the map fell back to raster
   tiles, a theme switch reloaded the online style that had failed, and the map came
   back empty. The theme switch reloads the style in use. */
test("map: a theme switch keeps the fallback basemap", () => {
  class FakeMap {
    constructor() { this.handlers = {}; this.styles = []; this.touchZoomRotate = { disableRotation() {} }; maplibregl.last = this; }
    getCanvas() { return { addEventListener() {}, style: {} }; }
    getContainer() { return { clientWidth: 800, clientHeight: 600 }; }
    once() {}
    on(type, a, b) { (this.handlers[type] ??= []).push(b || a); }
    addControl() {}
    setStyle(style) { this.styles.push(style); }
    fire(type, event) { for (const fn of this.handlers[type] || []) fn(event); }
  }
  const maplibregl = {
    Map: FakeMap, ScaleControl: class {}, NavigationControl: class {},
    Popup: class { setLngLat() { return this; } setText() { return this; } addTo() { return this; } remove() {} },
  };
  const { App, document } = loadApp({ globals: { maplibregl } });
  const make = document.createElement;
  document.createElement = (tag) => { const node = make(tag); if (tag === "canvas") node.getContext = (kind) => (kind.startsWith("webgl") ? { getExtension: () => null } : null); return node; };
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  const map = maplibregl.last;
  assert.ok(map, "the WebGL map mounted");
  map.fire("error", { error: { message: "style unreachable" } }); // the online style never loaded
  const fallback = map.styles.at(-1);
  assert.ok(fallback && fallback.sources && fallback.sources.osm, "it fell back to raster tiles");
  App.views.map.theme();
  assert.equal(map.styles.at(-1), fallback, "the theme switch reloads the raster style, not the one that failed");
});

test("flow: Poland VTP is on the Map only (Ray, 29 Oct: \"remove poland vtp from flow only\")", () => {
  const { App, NORA } = loadApp();
  assert.ok(Array.from(NORA.config.flow.hide).includes("pl_vtp"), "nora.toml [flow] hide names it");
  const { nodes, lines } = App.views.flow.changes();
  assert.equal(nodes.find((n) => n.id === "pl_vtp").hidden, true, "not drawn in the Flow view");
  const into = App.pipeIds.filter((pid) => NORA.assets[pid].to === "pl_vtp" || NORA.assets[pid].from === "pl_vtp");
  assert.ok(into.length && into.every((pid) => lines.find((l) => l.id === pid).hidden), "nor the lines to it");
  assert.equal(App.nodeStyle("pl_vtp").hidden, false, "the Map still shows it");
  const pos = { nybro: { x: 0, y: 0 }, pl_vtp: { x: 0, y: 300 } };
  assert.ok(!App.views.flow.lineReadings("nybro", pos).some((l) => l.otherId === "pl_vtp"), "Nybro has no reading or tag for it");
});

test("flow: no zooming in past a square about 220 px wide (Ray, 29 Oct)", () => {
  const { App } = loadApp();
  const side = 2 * App.views.flow.circleRadius() * App.views.flow.maxScale;
  App.state.mode = "live";
  assert.ok(App.views.flow.maxScale >= 1.5 && App.views.flow.maxScale <= 2, "about the zoom Ray showed");
  assert.ok(side > 150, "a live square still has room for its readings");
});

test("flow: the camera stays over the network (Ray, 29 Oct)", () => {
  const { App } = loadApp();
  const bounds = App.views.flow.viewBounds;
  // a drawing 0..1000 wide in a 400-wide window: the window's centre stays 200..800 (+ margin)
  assert.deepEqual(Array.from(bounds(0, 1000, 400, 10)), [190, 810]);
  // a drawing 0..300 wide in a 1000-wide window: held in the middle, so zooming out
  // past the whole network cannot slide it to one side (Ray, 29 Oct)
  assert.deepEqual(Array.from(bounds(0, 300, 1000, 10)), [150, 150]);
});

test("markers grow as the view zooms in, to twice their size (Ray, 29 Oct)", () => {
  const { App } = loadApp();
  const base = App.markerSize("pig");
  assert.equal(App.markerSize("pig", 1), 2 * base, "zoomed all the way in: twice");
  assert.equal(App.markerSize("pig", 5), 2 * base, "never more");
  assert.equal(App.markerSize("pig", -1), base, "never less");
});

test("exit nodes: zoomed in, each of the next 6 hours' nominations has its number", () => {
  // Ray, 29 Oct: "when i zoom in the nomination graph should be become more detailed where
  // i can see the actual number for each of the next 6 hours".
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const stream = App.live.stream;
  for (let k = 1; k <= (6 * 3600) / stream.step; k++) { // six hours of data steps
    const metrics = {};
    for (const [name, block] of Object.entries(stream.metrics || {})) {
      metrics[name] = {};
      block.assets.forEach((id, j) => { if (block.values[k][j] != null) metrics[name][id] = block.values[k][j]; });
    }
    App.live.frames.push({ t: stream.times[k], flows: {}, metrics, plan: null });
  }
  const id = Object.keys(NORA.assets).find((a) => NORA.assets[a].exit && App.rampAhead(a) && App.rampAhead(a).hours.every((h) => h.value != null));
  const draw = (scale) => {
    const texts = [];
    const ctx = new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
        if (key === "fillText") return (text) => texts.push(String(text));
        return () => {};
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    App.views.flow.drawNominationSteps(ctx, id, 0, 0, 110, 20, App.colors.card.active, 1, scale);
    return texts;
  };
  const hours = Array.from(App.rampAhead(id).hours, (h) => App.fmt(h.value, h.value < 10 ? 1 : 0));
  assert.deepEqual(draw(1.75), hours, "zoomed in: the six numbers, in order");
  assert.deepEqual(draw(1), [], "a step under 24 px: the line alone");
});

test("map: no alarm badges on the map; pigs and peaks stay", () => {
  // Ray, 29 Oct: "remove all warning triangles from the map", "but keep pig and peaks".
  const source = (name) => readFileSync(new URL(`../../src/nora/templates/${name}`, import.meta.url), "utf8");
  assert.doesNotMatch(source("map2d.js"), /drawBadge/, "the canvas map draws no badge");
  assert.doesNotMatch(source("map.js"), /nora-node-alarms|nora-alarm-|shapeMarkup/, "MapLibre has no badge layer");
  assert.match(source("map.js"), /drawMarker/, "pigs and peaks are still drawn");
  assert.match(source("map2d.js"), /drawMarker/);
});

test("map: an interconnector shows which way its gas goes, and how much", () => {
  // Ray, 29 Oct: "should be able to subtle see which way the gas is flowing for the
  // interconnector and what quantities are going which way". The IUK went with Bacton;
  // any line typed interconnector in pipelines.csv draws it (a stand-in here).
  const { App, NORA } = loadApp();
  App.state.mode = "live";
  const id = "franpipe";
  NORA.assets[id].type = "interconnector";
  const draw = (v) => {
    App.live.values[id] = v;
    const texts = [], strokes = [];
    let path = [];
    const ctx = new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
        if (key === "fillText") return (t) => texts.push(String(t));
        if (key === "beginPath") return () => { path = []; };
        if (key === "moveTo" || key === "lineTo") return (x, y) => path.push([x, y]);
        if (key === "stroke") return () => strokes.push(path.slice());
        return () => {};
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    App.drawFlowDirection(ctx, id, (t) => ({ x: 100 * t, y: 0, angle: 0 }), 1, []);
    return { texts, chevrons: strokes.filter((s) => s.length === 3) };
  };
  const d = NORA.assets[id], east = draw(12.3), west = draw(-4);
  assert.deepEqual(east.texts, [`12.3 to ${NORA.assets[d.to].name}`]);
  assert.deepEqual(west.texts, [`4.0 to ${NORA.assets[d.from].name}`]);
  assert.equal(east.chevrons.length, 4, "chevrons along the line");
  assert.ok(east.chevrons.every(([a, tip]) => a[0] < tip[0]), "pointing with the flow");
  assert.ok(west.chevrons.every(([a, tip]) => a[0] > tip[0]), "and the other way when it reverses");
  assert.deepEqual(draw(0).texts, ["no flow"]);
  assert.equal(draw(0).chevrons.length, 0);
});

test("flow: a tie-in is a dot where the lines meet, with no square, tags or name", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const ops = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
      return (...args) => ops.push({ op: key, args });
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  App.views.flow.card("ekofisk_tee")({ ctx, x: 0, y: 0, state: { selected: false, hover: false } }).drawNode();
  assert.ok(ops.some((o) => o.op === "arc"), "a dot");
  assert.ok(!ops.some((o) => o.op === "fillText"), "no name, no numbers");
  assert.equal(App.views.flow.portDistance("ekofisk_tee", 1, 0, pos), 6, "lines meet at the dot");
  const source = (name) => readFileSync(new URL(`../../src/nora/templates/${name}`, import.meta.url), "utf8");
  assert.match(source("map.js"), /\["!=", \["get", "type"\], "tee"\]/, "no dot on the MapLibre map");
  assert.match(source("map2d.js"), /type === "tee"/, "nor on the canvas map");
});

test("exit nodes: the day bar stays at the same place in the square as you zoom", () => {
  // Ray, 29 Oct: "the end of day target flow bar shifts when i zoom in and out".
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const id = Object.keys(NORA.assets).find((a) => NORA.assets[a].exit && NORA.grid[a]);
  const barY = (draw) => {
    const fills = [];
    const ctx = new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
        if (key === "fillRect") return (x, y, w, h) => fills.push({ y: y + h / 2, h });
        return () => {};
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    draw(ctx);
    return fills.find((f) => f.h > 0)?.y; // the band, centred on the bar
  };
  const day = { share: 0.01, level: 0 }, half = 60;
  const out = barY((ctx) => App.views.flow.drawOverviewFlows(ctx, 0, 0, id, App.colors.card.active, { half, total: 10, day, scale: 0.6 }));
  const near = barY((ctx) => App.views.flow.drawSquare(ctx, 0, 0, id, App.colors.card.active, { half, now: App.reading(id), day }));
  assert.ok(Math.abs(out - near) < 1e-9 && Math.abs(near + half * 0.52) < 1e-9, `zoomed out ${out}, zoomed in ${near}`);
});

test("flow: a line's values sit beside it, a hairline back to its centre", () => {
  // Ray, 29 Oct: "settle out and pack rate covers too much of the pipeline ... have it just
  // outisde the pipeline with a thin line pointing to the center of the pipe".
  const { App } = loadApp();
  const spot = App.views.flow.labelSpot({ x: 0, y: 0 }, { x: 200, y: 0 }, 40, 32, []);
  assert.deepEqual([spot.at.x, spot.at.y], [100, 0], "anchored at the line's middle");
  assert.ok(spot.box[1] > 0 || spot.box[3] < 0, "the box clear of the line itself");
  assert.ok(Math.abs(spot.cy) >= 16 + 12, "a gap for the hairline");
  const other = App.views.flow.labelSpot({ x: 0, y: 0 }, { x: 200, y: 0 }, 40, 32, [spot.box]);
  assert.ok(Math.sign(other.cy) !== Math.sign(spot.cy) || other.at.x !== 100, "taken: the other side, or further along");
});

test("flow: a line's values keep off other lines, and no leader crosses another", () => {
  // Ray, 29 Oct: "settle out and packing rate are overwriting eachother, find a solution".
  const { App } = loadApp();
  const spot = App.views.flow.labelSpot, line = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
  const first = spot(...line, 40, 32, []);
  // Another line running right through where the values would go.
  const crossing = [{ x: first.cx - 60, y: first.cy - 4 }, { x: first.cx + 60, y: first.cy + 4 }];
  const moved = spot(...line, 40, 32, [], [crossing]);
  const hits = (box, [a, b]) => [0, 0.25, 0.5, 0.75, 1].some((t) => {
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    return x > box[0] && x < box[2] && y > box[1] && y < box[3];
  });
  assert.ok(!hits(moved.box, crossing), "the values move off the other line");
  // A leader already placed: the next one may not cross it.
  const placed = spot(...line, 40, 32, [], [], [[{ x: 100, y: -40 }, { x: 100, y: 40 }]]);
  assert.ok(placed.at.x !== 100, "not along the other leader");
  assert.ok(placed.leader[0].y * placed.leader[1].y >= 0 || placed.at.x !== 100, "and not across it");
});
