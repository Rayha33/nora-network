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

test("peaks: the band and head follow every bend in the pipeline path", () => {
  const { App } = loadApp();
  const lines = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "createLinearGradient") return () => ({ addColorStop: () => {} });
      if (key === "lineTo") return (x, y) => lines.push([x, y]);
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  App.drawBand(ctx, { kind: "peak" }, { x: 0, y: 0 }, { x: 100, y: 100 }, 8, [{ x: 0, y: 0 }, { x: 50, y: 60 }, { x: 100, y: 100 }]);
  assert.ok(lines.some(([x, y]) => x === 50 && y === 60), "the casing and band pass through the pipeline bend");
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

test("flow circles: incoming and outgoing totals share space dynamically", () => {
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

test("flow circles: a mixed quadrant renders separate incoming and outgoing labels", () => {
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
  const ctx = new Proxy({
    measureText: (t) => ({ width: String(t).length * 6 }),
    fillText: (text, x, y) => labels.push({ text, x, y }),
  }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set(target, key, value) { target[key] = value; return true; },
  });
  App.views.flow.drawQuadrants(ctx, 0, 0, id, App.colors.card.active, { day: null, total: null, r: 44, positions: pos });
  const incoming = labels.find((label) => label.text.startsWith("in "));
  const outgoing = labels.find((label) => label.text.startsWith("out ") && label.x === incoming?.x && Math.abs(label.y - incoming.y) === 14);
  assert.ok(incoming && outgoing, `both directions are written on separate lines: ${JSON.stringify(labels)}`);
  assert.notEqual(incoming.y, outgoing.y, "the two readings have their own lines");
});

test("flow circles: animated overlays stay outside enlarged nodes", () => {
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
  App.settings().animation = true;
  App.live.playing = true;
  App.reduceMotion = false;
  assert.equal(App.views.flow.animateStubs(0.1), false, "decorative strokes are disabled when neighbouring nodes are too dense");
  assert.equal(App.views.flow.animateStubs(0.8), true, "animation returns when the drawing has room");
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

test("flow circles: pressure is outside while flow stays inside", () => {
  const loaded = loadApp();
  const { App } = loaded;
  loadFirstHour(App, loaded.NORA);
  App.state.mode = "live";
  const id = App.nodeIds.find((node) => App.reading(node).pressure != null);
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
  const pressure = `${App.fmt(App.reading(id).pressure)} bar`;
  const label = calls.find((c) => c.op === "fillText" && c.args[0] === pressure);
  assert.ok(label, "the measured pressure is written");
  assert.ok(label.args[2] > 30, "pressure sits below the circle, not inside it");
  const flows = calls.filter((c) => c.op === "fillText" && /M$/.test(c.args[0]));
  assert.ok(flows.length > 0, "flow readings are present");
  for (const flow of flows) assert.ok(Math.abs(flow.args[2]) <= 30, "flow remains inside the circle");
});

test("flow circles: every reading is at least 11 px", () => {
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
test("flow circles: no line runs through a node's name", () => {
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
