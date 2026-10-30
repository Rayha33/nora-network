/* Ray, 30 Oct: "the map loads slowly". A visit opens on the Flow; once the page is idle
   the Map is mounted out of sight (its style, fonts and first tiles load), so switching
   to it needs no wait, and it never shows or takes a click before it is chosen. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function fakeVis() {
  const set = () => ({ update() {}, get: () => null, getIds: () => [] });
  class Network {
    constructor() { this.body = { nodes: {}, view: { scale: 0.3, translation: { x: 0, y: 0 } }, emitter: { emit() {} } }; }
    on() {} once() {} off() {} fit() {} setOptions() {} redraw() {} selectNodes() {} unselectAll() {}
    getScale() { return 0.3; } moveTo() {} getPositions() { return {}; } getViewPosition() { return { x: 0, y: 0 }; }
    DOMtoCanvas(p) { return p; } canvasToDOM(p) { return p; }
  }
  return { vis: { Network }, nodes: set(), edges: set(), flowOptions: {} };
}

test("map warm-up: opening on the Flow, the Map mounts out of sight once the page is idle", () => {
  const idle = [];
  const { App, document, window } = loadApp({ shipped: true, globals: fakeVis() });
  window.requestIdleCallback = (fn) => idle.push(fn);
  document.getElementById("speed").options = [{ value: "600" }];
  App.start();
  const map = document.getElementById("view-map");
  assert.equal(App.state.view, "flow");
  assert.ok(!App.views.map.mounted, "not before the page is idle");
  assert.equal(idle.length, 1, "it waits for the page to be idle");
  idle[0]();
  assert.ok(App.views.map.mounted, "the Map is mounted");
  assert.equal(map.hidden, true, "and hidden again: the Flow is what shows");
  assert.equal(map.style.visibility || "", "", "with nothing left half-shown");
  assert.equal(App.state.view, "flow");
});

test("map warm-up: opening on the Map there is nothing to warm", () => {
  const idle = [];
  const { App, document, window } = loadApp({ globals: fakeVis() });
  window.requestIdleCallback = (fn) => idle.push(fn);
  document.getElementById("speed").options = [{ value: "600" }];
  App.start();
  App.go({ screen: "unit", unit: "all" });
  for (const fn of idle) fn();
  assert.ok(App.views.map.mounted, "mounted because it is shown");
  assert.equal(document.getElementById("view-map").hidden, false, "and showing");
});
