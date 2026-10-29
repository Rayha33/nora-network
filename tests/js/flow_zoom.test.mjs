/* Ray, 29 Oct: "i cant zoom in and out on flow view". He was on the home page, where
   the app sits in a frame (?embed=1) and the Flow view had zooming switched off. Now
   it zooms there as the Map does: a plain wheel scrolls the page, Ctrl or ⌘ with it
   (a trackpad pinch sends Ctrl) zooms; and + and − buttons zoom anywhere. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

// Just enough of vis-network to mount the Flow view: it records the view's scale.
function fakeVis() {
  const set = () => ({ update() {}, get: () => null, getIds: () => [] });
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
    redraw() {}
    selectNodes() {}
    unselectAll() {}
  }
  return { vis: { Network }, nodes: set(), edges: set(), flowOptions: {} };
}
function mountFlow(search) {
  const loaded = loadApp({ search, globals: fakeVis() });
  const { App, document } = loaded;
  const el = document.createElement("div");
  el.clientWidth = 1200;
  el.clientHeight = 800;
  try { App.views.flow.mount(el); } catch (error) { /* drawing needs more of vis; the zoom is wired first */ }
  const [a, b] = Object.keys(loaded.NORA.grid).filter((id) => !loaded.NORA.config.flow.hide.includes(id)); // a drawing 3000 by 1800
  App.views.flow.network.positions = { [a]: { x: 0, y: 0 }, [b]: { x: 3000, y: 1800 } };
  const find = (node, cls) => (String(node.className || "").includes(cls) ? node : (node.children || []).map((c) => find(c, cls)).find(Boolean) || null);
  return { ...loaded, el, network: App.views.flow.network, buttons: find(el, "flow-zoom") };
}
const wheel = (el, keys = {}) => {
  let stopped = false;
  for (const fn of el._listeners.wheel || []) fn({ ctrlKey: false, metaKey: false, deltaY: -100, ...keys, stopPropagation: () => { stopped = true; } });
  return stopped;
};

test("flow zoom: in the home page's frame a plain wheel scrolls the page; Ctrl or ⌘ zooms", () => {
  const { el } = mountFlow("?embed=1");
  assert.equal(wheel(el), true, "a plain wheel never reaches vis: the page scrolls");
  assert.equal(wheel(el, { ctrlKey: true }), false, "Ctrl (and a trackpad pinch) zooms");
  assert.equal(wheel(el, { metaKey: true }), false, "⌘ zooms");
});

test("flow zoom: in the app the wheel always zooms", () => {
  const { el } = mountFlow("");
  assert.equal(wheel(el), false);
});

test("flow zoom: + and − buttons, as on the Map, within the zoom limits", () => {
  const { buttons, network } = mountFlow("?embed=1");
  assert.ok(buttons, "the Flow view has zoom buttons");
  const [plus, minus] = buttons.children;
  assert.deepEqual([plus.textContent, minus.textContent, plus.title, minus.title], ["+", "−", "Zoom in", "Zoom out"]);
  const start = network.getScale();
  plus._listeners.click[0]();
  assert.ok(network.getScale() > start, `zoomed in: ${start} -> ${network.getScale()}`);
  for (let i = 0; i < 20; i++) plus._listeners.click[0]();
  assert.equal(network.getScale(), 1.75, "no closer than the wheel allows");
  for (let i = 0; i < 40; i++) minus._listeners.click[0]();
  assert.ok(network.getScale() < start && network.getScale() > 0.05, `out to the whole network, no further: ${network.getScale()}`);
});
