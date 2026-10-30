/* Ray, 30 Oct: "the flow view should naturally fill a normal PC screen standard aspect
   ratio". The rows are spaced so the drawing has the window's shape. Only the nodes the
   Flow draws count: the Map's detail fields (map_min_zoom, #218) sit in rows far below,
   out of sight, and counted they squashed the drawing into a band across the middle. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function mountFlow(width, height) {
  let placed = [];
  const set = () => ({ update(list) { if (Array.isArray(list) && list.length && "x" in list[0]) placed = list; }, get: () => null, getIds: () => [] });
  class Network {
    constructor() { this.body = { nodes: {}, view: { scale: 0.3, translation: { x: 0, y: 0 } }, emitter: { emit() {} } }; }
    on() {} once() {} off() {} fit() {} setOptions() {} redraw() {} selectNodes() {} unselectAll() {}
    getScale() { return this.body.view.scale; } moveTo() {} getPositions() { return {}; } getViewPosition() { return { x: 0, y: 0 }; }
    DOMtoCanvas(p) { return p; } canvasToDOM(p) { return p; }
  }
  const loaded = loadApp({ globals: { vis: { Network }, nodes: set(), edges: set(), flowOptions: {} } });
  const { App, document, NORA } = loaded;
  const el = document.createElement("div");
  el.clientWidth = 100;
  el.clientHeight = 100;
  try { App.views.flow.mount(el); } catch (error) { /* drawing needs more of vis; layout does not */ }
  App.views.flow.ready = true;
  el.clientWidth = width;
  el.clientHeight = height;
  App.views.flow.resize(); // a new window size lays the rows out again
  const shown = new Set(Object.keys(NORA.grid).filter((id) => !(NORA.assets[id].min_zoom > 0) && !(NORA.config.flow.hide || []).includes(id)));
  const pts = placed.filter((p) => shown.has(p.id));
  const span = (key) => Math.max(...pts.map((p) => p[key])) - Math.min(...pts.map((p) => p[key]));
  return { NORA, pts, shape: span("y") / span("x") };
}

test("flow fill: on 16:9 and 16:10 screens the drawing has the window's shape", () => {
  for (const [w, h] of [[1440, 784], [1920, 964], [1280, 684], [2560, 1304]]) {
    const { pts, shape } = mountFlow(w, h);
    assert.ok(pts.length > 40, "the drawn nodes were laid out");
    const want = h / w;
    assert.ok(shape > want * 0.8 && shape < want * 1.1, `${w}x${h}: drawing ${shape.toFixed(3)} tall per wide, window ${want.toFixed(3)}`);
  }
});

test("flow fill: the Map's detail fields, in rows below the drawing, do not set the spacing", () => {
  const { NORA, pts } = mountFlow(1440, 784);
  const detail = Object.keys(NORA.grid).filter((id) => NORA.assets[id].min_zoom > 0);
  const drawn = new Set(pts.map((p) => p.id));
  const lowest = (ids) => Math.max(...ids.map((id) => NORA.grid[id][0]));
  assert.ok(detail.length > 50, "the grid has the map detail fields");
  assert.ok(lowest(detail) > lowest([...drawn]) * 1.5, "they sit in rows well below the drawing");
});

/* Seen on the filled Flow, 30 Oct: a line leaving Kollsnes and Kårstø straight down ran
   through their names. A name keeps off a line where it can and stays under its square:
   centred, else nudged beside the line; crossed everywhere under it, centred as before. */
test("flow names: a line straight down from the square: the name sits under it, beside the line", () => {
  const { App } = loadApp();
  const place = App.views.flow.overviewNamePlacement, at = { x: 100, y: 100 };
  const down = [[{ x: 100, y: 100 }, { x: 100, y: 400 }]];
  const got = place(at, 32, 1, 80, 16, [], { width: 400, height: 400 }, [], down);
  assert.ok(got.top >= 132, "under the square");
  assert.ok(got.left > 100 || got.left + 80 < 100, `beside the line: ${got.left}`);
  const plain = place(at, 32, 1, 80, 16, [], { width: 400, height: 400 }, [], []);
  assert.deepEqual([plain.left, plain.top], [60, 136], "no line: centred as before");
  const fan = [-60, -30, 0, 30, 60].map((dx) => [{ x: 100, y: 100 }, { x: 100 + dx * 4, y: 400 }]);
  const crossed = place(at, 32, 1, 80, 16, [], { width: 400, height: 400 }, [], fan);
  assert.deepEqual([crossed.left, crossed.top], [60, 136], "crossed everywhere under it: centred, never above or aside");
});

test("flow names: a name with no room next to its square is marked far, for its hairline", () => {
  const { App } = loadApp();
  const blockers = [[0, 20, 400, 190]]; // every spot within a row of the square is taken
  const got = App.views.flow.overviewNamePlacement({ x: 100, y: 100 }, 32, 1, 80, 16, blockers, { width: 400, height: 400 });
  assert.ok(got, "still placed");
  assert.equal(got.far, true, "and marked far");
  const near = App.views.flow.overviewNamePlacement({ x: 100, y: 100 }, 32, 1, 80, 16, [], { width: 400, height: 400 });
  assert.ok(!near.far, "a name next to its square needs no hairline");
});
