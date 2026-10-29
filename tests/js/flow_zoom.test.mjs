/* Ray, 29 Oct: "i cant zoom in and out on flow view"; "zooming in and out should be
   seamless, should [not] have to hold ctrl ... regardless of browser". The wheel zooms
   about the pointer with no key held, a pinch zooms (Safari's gesture events too), and
   + and − buttons zoom as on the Map. */
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
const wheel = (el, deltaY, keys = {}) => {
  let prevented = false, stopped = false;
  const event = { ctrlKey: false, metaKey: false, deltaY, deltaMode: 0, clientX: 600, clientY: 400, ...keys,
    preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } };
  for (const fn of el._listeners.wheel || []) fn(event);
  return { prevented, stopped };
};

test("flow zoom: the wheel zooms with no key held, in the app and in a frame, a little per notch", () => {
  for (const search of ["", "?embed=1"]) {
    const { el, network } = mountFlow(search), start = network.getScale();
    const { prevented, stopped } = wheel(el, -100);
    assert.ok(prevented && stopped, "the page does not scroll, and vis does not jump its 6 %");
    const step = network.getScale() / start;
    assert.ok(step > 1.1 && step < 1.25, `one notch in: x${step.toFixed(3)}`);
    for (let i = 0; i < 30; i++) wheel(el, -3); // a trackpad: many small steps
    assert.ok(network.getScale() > start * step, "small steps zoom smoothly");
    wheel(el, 400);
    assert.ok(network.getScale() < start * step * 1.2, "and back out");
  }
});

test("flow zoom: a pinch zooms, Ctrl + wheel elsewhere and gesture events in Safari", () => {
  const { el, network } = mountFlow(""), start = network.getScale();
  wheel(el, -10, { ctrlKey: true });
  assert.ok(network.getScale() > start * 1.08, "Chrome and Firefox pinch: Ctrl + small wheel steps");
  const at = network.getScale();
  const gesture = (type, scale) => (el._listeners[type] || []).forEach((fn) => fn({ scale, clientX: 600, clientY: 400, preventDefault() {} }));
  gesture("gesturestart", 1);
  gesture("gesturechange", 1.2);
  gesture("gesturechange", 1.5);
  gesture("gestureend", 1.5);
  assert.ok(Math.abs(network.getScale() / at - 1.5) < 1e-9, `Safari's pinch to 1.5x: x${network.getScale() / at}`);
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
