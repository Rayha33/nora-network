/* Flow-square endpoint readings: one value for every visible connected line. */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const HOUR = 3600;

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
  App.live.values = { ...flows };
  App.state.mode = "live";
}

function gridPositions(NORA) {
  return Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
}

test("flow endpoints include every visible connected line, including zero flow", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const id = "bacton";
  const zero = App.pipeIds.find((pid) => NORA.assets[pid].from === id || NORA.assets[pid].to === id);
  App.live.values[zero] = 0;
  const positions = gridPositions(NORA);

  const rows = App.views.flow.flowConnections(id, positions);
  const expected = App.pipeIds.filter((pid) => {
    const p = NORA.assets[pid];
    return (p.from === id || p.to === id) && App.live.values[pid] != null && !App.pipeStyle(pid).hidden;
  }).sort();
  assert.deepEqual(Array.from(rows, (row) => row.pid).sort(), expected);

  const zeroRow = rows.find((row) => row.pid === zero);
  assert.equal(zeroRow.value, 0, "a connected zero-flow line still gets a reading");
  for (const row of rows) {
    const p = NORA.assets[row.pid], other = p.from === id ? p.to : p.from;
    const dx = positions[other].x - positions[id].x, dy = positions[other].y - positions[id].y;
    const length = Math.hypot(dx, dy);
    assert.ok(Math.abs(Math.hypot(row.ux, row.uy) - 1) < 1e-9, `${row.pid}: a unit direction`);
    assert.ok(row.ux * dx / length + row.uy * dy / length > 0.999999, `${row.pid}: faces its own connection`);
  }
});

test("flow squares draw each line's own value inside, near its connection, without overlap", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const id = "bacton";
  const positions = gridPositions(NORA);
  const connected = App.pipeIds.filter((pid) => NORA.assets[pid].from === id || NORA.assets[pid].to === id);
  connected.forEach((pid, index) => { App.live.values[pid] = index === 0 ? 0 : index + 2; });
  const rows = App.views.flow.flowConnections(id, positions);
  const half = App.views.flow.circleRadius(id, positions);
  const labels = [];
  const ctx = new Proxy({
    measureText: (text) => ({ width: String(text).length * 6 }),
    fillText: (text, x, y) => labels.push({ text: String(text), x, y, width: String(text).length * 6 }),
  }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set: (target, key, value) => { target[key] = value; return true; },
  });

  App.views.flow.drawQuadrants(ctx, 0, 0, id, App.colors.card.active, { total: null, r: half, positions });
  const values = labels.filter((label) => /M$/.test(label.text));
  assert.equal(values.length, rows.length, "one value per connected line, never a quadrant total");
  for (const row of rows) {
    const magnitude = Math.abs(row.value), text = `${App.fmt(magnitude, magnitude < 10 ? 1 : 0)}M`;
    const label = values.find((item) => item.text === text);
    assert.ok(label, `${row.pid}: missing its own ${text}`);
    const border = edgePoint(row, half);
    assert.ok(Math.hypot(label.x - border.x, label.y - border.y) <= half * 0.75,
      `${row.pid}: value stays close to where its line meets the square`);
  }
  for (const label of values) {
    assert.ok(Math.abs(label.x) + label.width / 2 + 2 <= half + 1e-9, `${label.text}: horizontally inside`);
    assert.ok(Math.abs(label.y) + 10 <= half + 1e-9, `${label.text}: vertically inside`);
  }
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    assert.ok(!textOverlap(values[i], values[j]), `${values[i].text} and ${values[j].text} must not overlap`);
  }
});

function edgePoint(row, half) {
  const gap = half / Math.max(Math.abs(row.ux), Math.abs(row.uy), 1e-6);
  return { x: row.ux * gap, y: row.uy * gap };
}

function textOverlap(a, b) {
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 4 && Math.abs(a.y - b.y) < 16;
}

test("every real node fits all of its connected line values without collisions", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const positions = gridPositions(NORA), half = App.views.flow.circleRadius();
  let checked = 0;
  for (const id of App.nodeIds) {
    const rows = App.views.flow.flowConnections(id, positions);
    if (!rows.length) continue;
    const labels = [];
    const ctx = new Proxy({
      measureText: (text) => ({ width: String(text).length * 6 }),
      fillText: (text, x, y) => labels.push({ text: String(text), x, y, width: String(text).length * 6 }),
    }, {
      get: (target, key) => key in target ? target[key] : () => {},
      set: (target, key, value) => { target[key] = value; return true; },
    });
    App.views.flow.drawQuadrants(ctx, 0, 0, id, App.colors.card.active, { total: null, r: half, positions });
    const values = labels.filter((label) => /M$/.test(label.text));
    assert.equal(values.length, rows.length, `${id}: every connected line gets a value`);
    for (const row of rows) {
      const magnitude = Math.abs(row.value), text = `${App.fmt(magnitude, magnitude < 10 ? 1 : 0)}M`;
      const border = edgePoint(row, half);
      const nearest = Math.min(...values.filter((label) => label.text === text).map((label) => Math.hypot(label.x - border.x, label.y - border.y)));
      assert.ok(nearest <= half * 0.9, `${id}/${row.pid}: value remains near its connection (${nearest})`);
    }
    for (const label of values) {
      assert.ok(Math.abs(label.x) + label.width / 2 + 2 <= half + 1e-9, `${id}/${label.text}: horizontally inside`);
      assert.ok(Math.abs(label.y) + 10 <= half + 1e-9, `${id}/${label.text}: vertically inside`);
    }
    for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
      assert.ok(!textOverlap(values[i], values[j]), `${id}: ${values[i].text} and ${values[j].text} overlap`);
    }
    checked++;
  }
  assert.ok(checked > 50, "the whole real network was exercised");
});

test("endpoint flow values do not cover pressure readings", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const positions = gridPositions(NORA), half = App.views.flow.circleRadius();
  let checked = 0;
  for (const id of App.nodeIds) {
    const now = App.reading(id);
    if (now.pressure == null || !App.views.flow.flowConnections(id, positions).length) continue;
    const labels = [];
    const ctx = new Proxy({
      measureText: (text) => ({ width: String(text).length * 6 }),
      fillText: (text, x, y) => labels.push({ text: String(text), x, y, width: String(text).length * 6 }),
    }, {
      get: (target, key) => key in target ? target[key] : () => {},
      set: (target, key, value) => { target[key] = value; return true; },
    });
    App.views.flow.drawSquare(ctx, 0, 0, id, App.colors.card.active, { half, now, day: null, positions });
    const flows = labels.filter((label) => /M$/.test(label.text));
    const pressure = labels.filter((label) => / bar$/.test(label.text));
    assert.equal(flows.length, App.views.flow.flowConnections(id, positions).length, `${id}: all endpoint values are rendered`);
    assert.ok(pressure.length <= 1, `${id}: one pressure reading`);
    for (const flow of flows) for (const other of pressure) {
      assert.ok(!textOverlap(flow, other), `${id}: ${flow.text} covers ${other.text}`);
    }
    checked++;
  }
  assert.ok(checked > 10, "many pressured nodes were exercised");
});

test("live squares have modest extra room for all per-line flow values", () => {
  const { App } = loadApp();
  App.state.mode = "live";
  const half = App.views.flow.circleRadius();
  assert.ok(half > 64 && half <= 72, "slightly enlarge crowded squares without changing the visual scale");
});

test("pressure endpoints cover both ends of every visible line", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const positions = gridPositions(NORA);
  const rows = App.views.flow.pressureConnections(positions);
  const visible = App.pipeIds.filter((pid) => {
    const p = NORA.assets[pid];
    return positions[p.from] && positions[p.to] && !App.pipeStyle(pid).hidden;
  });
  assert.equal(rows.length, visible.length * 2, "two endpoint pressures per visible line");
  for (const pid of visible) {
    const p = NORA.assets[pid];
    for (const [node, other] of [[p.from, p.to], [p.to, p.from]]) {
      const row = rows.find((item) => item.pid === pid && item.node === node);
      assert.ok(row, `${pid}: missing the ${node} end`);
      assert.equal(row.value, App.reading(node).pressure ?? null, `${pid}/${node}: uses that node's actual pressure`);
      const dx = positions[other].x - positions[node].x, dy = positions[other].y - positions[node].y;
      const length = Math.hypot(dx, dy);
      assert.ok(row.ux * dx / length + row.uy * dy / length > 0.999999, `${pid}/${node}: faces along the line`);
    }
  }
  const missing = rows.find((row) => row.node === "balgzand");
  assert.ok(missing, "a line connected to a node without a reading is still represented");
  assert.equal(missing.value, null, "missing pressure stays unknown; it is never invented");
});

test("endpoint pressures stay close outside the squares without overlapping", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const positions = gridPositions(NORA), half = App.views.flow.circleRadius();
  const ctx = new Proxy({ measureText: (text) => ({ width: String(text).length * 6 }) }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const expected = App.views.flow.pressureConnections(positions);
  const labels = App.views.flow.pressureLabelLayout(ctx, positions);
  assert.equal(labels.length, expected.length, "every line endpoint gets a pressure label");
  const expectedKeys = Array.from(expected, (row) => `${row.pid}:${row.node}`).sort();
  assert.deepEqual(Array.from(labels, (label) => `${label.pid}:${label.node}`).sort(), expectedKeys);
  const square = (point) => [point.x - half, point.y - half, point.x + half, point.y + half];
  const squares = Object.values(positions).map(square);
  const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  for (const label of labels) {
    assert.equal(label.text, `${App.fmt(label.value)} bar`, `${label.pid}/${label.node}: correct pressure text`);
    assert.ok(!overlaps(label.box, square(positions[label.node])), `${label.pid}/${label.node}: outside its own square`);
    for (const other of squares) assert.ok(!overlaps(label.box, other), `${label.pid}/${label.node}: outside every square`);
    const point = positions[label.node], gap = half / Math.max(Math.abs(label.ux), Math.abs(label.uy), 1e-6);
    const border = { x: point.x + label.ux * gap, y: point.y + label.uy * gap };
    assert.ok(Math.hypot(label.x - border.x, label.y - border.y) <= 96,
      `${label.pid}/${label.node}: stays close to its line's connection`);
  }
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    assert.ok(!overlaps(labels[i].box, labels[j].box), `${labels[i].pid}/${labels[i].node} overlaps ${labels[j].pid}/${labels[j].node}`);
  }
  assert.ok(labels.some((label) => label.text === "– bar"), "unknown pressures are labelled honestly");
});

test("exit target bar shows a visible target band and the current delivery position", () => {
  const { App } = loadApp();
  const fills = [], strokes = [];
  let path = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "beginPath") return () => { path = []; };
      if (key === "moveTo") return (x, y) => path.push([x, y]);
      if (key === "lineTo") return (x, y) => path.push([x, y]);
      if (key === "stroke") return () => strokes.push({ path, color: target.strokeStyle, width: target.lineWidth });
      if (key === "fillRect") return (x, y, width, height) => fills.push({ x, y, width, height, color: target.fillStyle, alpha: target.globalAlpha });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const look = { dim: "gray", ink: "black" };
  App.views.flow.drawDayBar(ctx, 100, 50, { share: 0, level: 0 }, look);
  const band = fills.find((fill) => fill.width > 0 && fill.height >= 8);
  assert.ok(band, "the on-target area is a visible filled band, not just two tick marks");
  const current = strokes.find((stroke) => stroke.color === "black" && stroke.width >= 2.4);
  assert.ok(current, "the current delivery position is prominent");
  assert.ok(current.path[0][0] >= band.x && current.path[0][0] <= band.x + band.width,
    "on-plan delivery sits inside the target band");

  strokes.length = 0;
  App.views.flow.drawDayBar(ctx, 100, 50, { share: 0.2, level: 2 }, look);
  assert.ok(strokes.some((stroke) => stroke.color === App.levelColor[2] && stroke.width >= 2.4),
    "off-target delivery uses its alarm colour");
});

test("all exit points keep the bottom target bar, including a no-data track", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const positions = gridPositions(NORA), half = App.views.flow.circleRadius(), bottom = half * 0.84;
  const exits = ["st_fergus", "zeebrugge", "easington", "dornum", "emden", "dunkirk"];
  function render(id, day) {
    const fills = [], labels = [], strokes = [];
    let path = [];
    const ctx = new Proxy({}, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
        if (key === "fillRect") return (x, y, width, height) => fills.push({ x, y, width, height });
        if (key === "fillText") return (text, x, y) => labels.push({ text: String(text), x, y, width: String(text).length * 6 });
        if (key === "beginPath") return () => { path = []; };
        if (key === "moveTo") return (x, y) => path.push([x, y]);
        if (key === "lineTo") return (x, y) => path.push([x, y]);
        if (key === "stroke") return () => strokes.push({ path });
        return () => {};
      },
      set(target, key, value) { target[key] = value; return true; },
    });
    App.views.flow.drawSquare(ctx, 0, 0, id, App.colors.card.active, { half, now: App.reading(id), day, positions });
    return { fills, labels, strokes };
  }
  for (const id of exits) {
    assert.equal(NORA.assets[id].type, "terminal", `${id} is an exit point`);
    const day = App.dayDelivery(id);
    assert.ok(day, `${id} has an end-of-day delivery reading`);
    const { fills, labels } = render(id, day);
    const band = fills.find((fill) => Math.abs(fill.y - (bottom - 5)) < 1e-9 && fill.height === 10);
    assert.ok(band, `${id} has its target band at the bottom of the square`);
    assert.ok(bottom + 6 <= half, `${id}: the whole bar stays inside the square`);
    for (const label of labels.filter((item) => /M$/.test(item.text))) {
      const box = [label.x - label.width / 2 - 2, label.y - 8, label.x + label.width / 2 + 2, label.y + 8];
      const overlap = box[0] < band.x + band.width && box[2] > band.x && box[1] < band.y + band.height && box[3] > band.y;
      assert.ok(!overlap, `${id}: ${label.text} does not cover the target band`);
    }
  }
  const noData = render("easington", null);
  assert.ok(noData.strokes.some((stroke) => stroke.path.length === 2
    && stroke.path[0][1] === bottom && stroke.path[1][1] === bottom
    && Math.abs(stroke.path[1][0] - stroke.path[0][0]) === 88),
  "an exit without nomination data still gets the neutral bottom track");
});

test("upstream field alarm badges do not cover connection flow values", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const id = "aasta_hansteen", half = App.views.flow.circleRadius();
  const positions = { [id]: { x: 0, y: 0 }, nyhamna: { x: 140, y: -140 } };
  const labels = [];
  const ctx = new Proxy({
    measureText: (text) => ({ width: String(text).length * 6 }),
    fillText: (text, x, y) => labels.push({ text: String(text), x, y, width: String(text).length * 6 }),
  }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set: (target, key, value) => { target[key] = value; return true; },
  });
  App.views.flow.drawSquare(ctx, 0, 0, id, App.colors.card.active, { half, now: App.reading(id), day: null, positions, level: 3 });
  const badge = [half - 10, -half - 6, half + 6, -half + 10];
  for (const label of labels.filter((item) => /M$/.test(item.text))) {
    const box = [label.x - label.width / 2 - 2, label.y - 8, label.x + label.width / 2 + 2, label.y + 8];
    const overlap = box[0] < badge[2] && box[2] > badge[0] && box[1] < badge[3] && box[3] > badge[1];
    assert.ok(!overlap, `${id}: ${label.text} must stay clear of the alarm badge`);
  }
});

test("upstream field alarm badges do not cover the rate readout", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const id = "aasta_hansteen", half = App.views.flow.circleRadius();
  const first = App.live.frames[0], second = { ...first, t: first.t + 3600, flows: { ...first.flows } };
  const pid = App.pipeIds.find((line) => (NORA.assets[line].from === id || NORA.assets[line].to === id) && second.flows[line] != null);
  if (second.flows[id] != null) second.flows[id] += 5;
  else second.flows[pid] = (second.flows[pid] || 0) + 5;
  App.live.frames = [first, second];
  App.live.index = 1;
  App.live.time = second.t;
  App.live.values = second.flows;
  const positions = { [id]: { x: 0, y: 0 }, nyhamna: { x: 140, y: -140 } };
  const labels = [];
  const ctx = new Proxy({
    measureText: (text) => ({ width: String(text).length * 6 }),
    fillText: (text, x, y) => labels.push({ text: String(text), x, y, width: String(text).length * 6, align: ctx.textAlign }),
  }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set: (target, key, value) => { target[key] = value; return true; },
  });
  App.views.flow.drawSquare(ctx, 0, 0, id, App.colors.card.active, { half, now: App.reading(id), day: null, positions, level: 3 });
  const rate = labels.find((label) => /\/h$/.test(label.text));
  assert.ok(rate, "the field has a rate readout");
  const left = rate.align === "right" ? rate.x - rate.width - 2 : rate.x - rate.width / 2 - 2;
  const right = rate.align === "right" ? rate.x + 2 : rate.x + rate.width / 2 + 2;
  const box = [left, rate.y - 8, right, rate.y + 8], badge = [half - 10, -half - 6, half + 6, -half + 10];
  const overlap = box[0] < badge[2] && box[2] > badge[0] && box[1] < badge[3] && box[3] > badge[1];
  assert.ok(!overlap, "the rate readout must move clear of the badge");
});

test("upstream field alarm badges stay clear of outside endpoint pressures", () => {
  const { App, NORA } = loadApp();
  loadFirstHour(App, NORA);
  const id = "aasta_hansteen", half = App.views.flow.circleRadius();
  App.live.levelOf[id] = 3;
  const positions = { [id]: { x: 0, y: 0 }, nyhamna: { x: 140, y: -140 } };
  const ctx = new Proxy({ measureText: (text) => ({ width: String(text).length * 6 }) }, {
    get: (target, key) => key in target ? target[key] : () => {},
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const labels = App.views.flow.pressureLabelLayout(ctx, positions);
  assert.ok(labels.length > 0, "the upstream line has an endpoint pressure");
  const badge = [half - 10, -half - 6, half + 6, -half + 10];
  for (const label of labels) {
    const overlap = label.box[0] < badge[2] && label.box[2] > badge[0] && label.box[1] < badge[3] && label.box[3] > badge[1];
    assert.ok(!overlap, `${label.text} must not sit under the alarm badge`);
  }
});
