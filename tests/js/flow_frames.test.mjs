/* The Flow view's moving layer (pigs, peaks, gas quality) is repainted by the frame loop
   only when something on it moved. Without WebGL the CPU repaints every pixel, and doing
   it 60 times a second took 30 % of a core on a retina window while, in real time, a pig
   crosses a pixel every few minutes (Ray, 29 Oct: "make it run more smoothly"). */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

function setup() {
  const counts = {};
  const recorder = () => new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      return () => { counts[key] = (counts[key] || 0) + 1; };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  class Network {
    constructor() {
      this.body = { nodes: {}, view: { scale: 0.3, translation: { x: 0, y: 0 } }, emitter: { emit() {} } };
      this.handlers = {};
    }
    on(type, fn) { (this.handlers[type] ??= []).push(fn); }
    once() {}
    off() {}
    getScale() { return this.body.view.scale; }
    moveTo({ scale }) { if (scale != null) this.body.view.scale = scale; }
    fit() {}
    getPositions() { return this.positions || {}; }
    getViewPosition() { return { x: 0, y: 0 }; }
    DOMtoCanvas(p) { return p; }
    canvasToDOM(p) { return p; }
    setOptions() {}
    redraw() { for (const type of ["beforeDrawing", "afterDrawing"]) for (const fn of this.handlers[type] || []) fn(recorder()); }
    selectNodes() {}
    unselectAll() {}
  }
  const lines = new Map();
  const edges = { update() {}, get: (id) => lines.get(id) || null, getIds: () => [...lines.keys()], forEach(fn) { lines.forEach(fn); } };
  const nodes = { update() {}, get: () => null, getIds: () => [], forEach() {} };
  const loaded = loadApp({ globals: { vis: { Network }, nodes, edges, flowOptions: {} } });
  const { App, document, NORA } = loaded;
  for (const id of App.pipeIds) lines.set(id, { id, from: NORA.assets[id].from, to: NORA.assets[id].to });
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } }); // pigs
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    if (String(tag).toLowerCase() === "canvas") node.getContext = (kind) => (kind === "2d" ? recorder() : null);
    return node;
  };
  const el = document.createElement("div");
  el.clientWidth = 1200;
  el.clientHeight = 800;
  App.state.mode = "live";
  try { App.views.flow.mount(el); } catch { /* the rest of the mount needs more of vis */ }
  const network = App.views.flow.network;
  network.positions = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: stage * 300, y: rank * 200 }]));
  network.redraw(); // vis draws: the network, then the moving layer over it
  return { App, counts, network };
}

test("flow frames: playing, the moving layer is repainted only when something on it moved", () => {
  const { App, counts } = setup();
  assert.ok(App.markers().length > 0, "the synthetic week has pigs on the lines");
  App.live.playing = true;
  const view = App.views.flow;
  const repaints = (fn) => { const before = counts.clearRect || 0; fn(); return (counts.clearRect || 0) - before; };
  assert.equal(repaints(() => { for (let i = 0; i < 5; i++) view.draw(); }), 0, "nothing moved: nothing repainted");
  assert.equal(repaints(() => { for (let i = 0; i < 3; i++) { App.live.time += 1800; view.draw(); } }), 3, "the markers moved: each frame repaints them");
});

test("flow frames: a redraw vis asks for always repaints the moving layer", () => {
  const { counts, network } = setup();
  const before = counts.clearRect || 0;
  network.redraw();
  assert.equal((counts.clearRect || 0) - before, 1, "after the network, the layer over it");
});
