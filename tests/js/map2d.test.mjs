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
  view.zoomAt(100, 100, 0.000001); // reach the minimum zoom at the centre
  const before = view.camera();
  view.zoomAt(400, 30, 0.5); // another zoom-out gesture away from the centre
  assert.deepEqual(view.camera(), before, "zooming beyond the limit does not slide the camera");
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
  assert.equal(App.pipeMapName("iuk"), "Interconnector (IUK)");
  assert.equal(App.pipeMapName("ogt"), "Oseberg Gas Transport");
  assert.equal(App.pipeMapName("troll_kollsnes"), "", "small feeders stay quiet");
  assert.equal(App.pipeMapName("bacton_nbp"), "", "notional grid entries stay quiet");
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

test("flow nodes: lines sharing a quadrant keep separate numeric readings without prefixes", () => {
  const loaded = loadApp();
  const { App, NORA } = loaded;
  loadFirstHour(App, NORA);
  App.state.mode = "live";
  App.live.values = App.live.frames[0].flows;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 178, y: stage * 124 }]));
  let id, pair;
  outer: for (const node of App.nodeIds) {
    const sides = {};
    for (const pid of App.pipeIds) {
      const p = NORA.assets[pid];
      if (p.from !== node && p.to !== node || App.pipeStyle(pid).hidden) continue;
      const other = p.from === node ? p.to : p.from;
      const side = `${pos[other].y - pos[node].y > 0 ? "S" : "N"}${pos[other].x - pos[node].x >= 0 ? "E" : "W"}`;
      (sides[side] = sides[side] || []).push(pid);
      if (Object.values(sides).some((lines) => lines.length > 1)) { id = node; pair = Object.values(sides).find((lines) => lines.length > 1); break outer; }
    }
  }
  for (const [index, pid] of pair.slice(0, 2).entries()) {
    const p = NORA.assets[pid], outgoing = index === 0;
    App.live.values[pid] = ((p.from === id) === outgoing ? 1 : -1) * 5;
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
  const own = labels.filter((label) => label.text === "5.0M");
  assert.equal(own.length, 2, `the two connected lines keep their own readings: ${JSON.stringify(labels)}`);
  assert.ok(labels.every((label) => !/^(in|out)\s/.test(label.text)), "position alone communicates direction");
  assert.equal(quadrantStrokes, 0, "no quadrant divider lines are drawn inside the node");
  assert.ok(own[0].x !== own[1].x || own[0].y !== own[1].y, "the two readings have their own positions");
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
  const half = App.views.flow.circleRadius();
  assert.equal(App.views.flow.stubClear({ x: half + 8, y: 0 }, { x: half + 16, y: 0 }, spaced, 1), true, "a stroke with clear space is drawn");
  const crowded = { own: { x: 0, y: 0 }, neighbour: { x: 100, y: 0 } };
  assert.equal(App.views.flow.stubClear({ x: half + 8, y: 0 }, { x: half + 16, y: 0 }, crowded, 1), false, "a stroke stops rather than entering a neighbouring node");
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

test("exit nodes: gray target bounds and one prominent current-delivery line", () => {
  const { App } = loadApp();
  const strokes = [];
  let path = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "beginPath") return () => { path = []; };
      if (key === "moveTo") return (x, y) => path.push([x, y]);
      if (key === "lineTo") return (x, y) => path.push([x, y]);
      if (key === "stroke") return () => strokes.push({ path, color: target.strokeStyle, width: target.lineWidth });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const look = { dim: "gray", ink: "black" };
  App.views.flow.drawDayBar(ctx, 100, 50, { share: 0.02, level: 0 }, look);
  const vertical = strokes.filter((s) => s.path.length === 2 && s.path[0][0] === s.path[1][0]);
  assert.equal(vertical.length, 3, "minimum, maximum and current are the three vertical markers");
  const tolerance = App.thresholds.nomination[0];
  const half = 44, full = App.thresholds.nomination[2] * 1.2;
  const positions = vertical.map((s) => s.path[0][0]).sort((a, b) => a - b);
  const expected = [100 - tolerance / full * half, 100 + 0.02 / full * half, 100 + tolerance / full * half].sort((a, b) => a - b);
  positions.forEach((x, i) => assert.ok(Math.abs(x - expected[i]) < 1e-9));
  assert.equal(vertical.filter((s) => s.color === "gray").length, 2, "the target bounds are gray");
  const current = vertical.find((s) => s.color === "black");
  assert.ok(current && current.width > Math.max(...vertical.filter((s) => s.color === "gray").map((s) => s.width)), "the current line is more prominent");
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

/* Ray, 28 Oct: "we want to use squares instead of circles as nodes as we can pack in
   more information and numbers". A live node is a square holding its pressure, its
   rate of change, the flow on each line and its trend; the name sits below it. */
test("flow squares: pressure, rate, flows and trend sit inside the square, the name below", () => {
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
  assert.ok(pressure && inside(pressure), "the pressure is inside the square");
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
  const labelAt = (taken) => {
    texts.length = 0;
    App.drawMarker(ctx, peak, 100, 100, 0, 6.5, 1, taken);
    return texts.length ? texts[0] : null;
  };
  const free = labelAt([]);
  assert.ok(free.x > 100 && free.y < 100, "with room, the label sits up and to the right");
  const name = [100, 80, 200, 99]; // a node name where that label would go
  const moved = labelAt([name]);
  assert.ok(moved, "a blocked corner moves the label");
  assert.ok(!(moved.x < name[2] && moved.x + 60 > name[0] && moved.y > name[1] && moved.y < name[3]), "off the name");
  assert.equal(labelAt([[0, 0, 300, 300]]), null, "with no clear corner the label is left out");
  const taken = [];
  const first = labelAt(taken), second = labelAt(taken);
  assert.ok(second && (second.x !== first.x || second.y !== first.y), "a second peak at the same spot labels elsewhere");
});

/* Review finding: the canvas map cleared its whole container, which holds the page's
   map card, and every later navigation wrote to the card's missing labels and threw.
   It must keep the card, so navigation and the card's words keep working. */
test("map: the canvas map keeps the map card, so navigation keeps working", () => {
  const { App, NORA, document } = loadApp();
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  assert.equal(App.views.map.canvasMap, true, "the canvas map took over");
  const unit = NORA.units[1];
  assert.doesNotThrow(() => App.go({ screen: "unit", unit: unit.id }), "navigating after the fallback");
  assert.equal(document.getElementById("map-unit").textContent, "North Sea gas network", "the card keeps the fixed all-units scope");
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
  const { App, document } = loadApp({ globals: { Path2D: class { moveTo() {} lineTo() {} closePath() {} } } });
  drawableCanvas(document, counts);
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  const view = App.views.map;
  App.live.playing = false;
  const paused = counts.fillRect || 0;
  view.draw(); view.draw(); view.draw();
  assert.equal(counts.fillRect || 0, paused, "paused: no redraw per frame");
  App.live.playing = true;
  view.draw();
  assert.ok((counts.fillRect || 0) > paused, "playing: each frame redraws");
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
