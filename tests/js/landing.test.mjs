/* Ray, 30 Oct: "flow should be the default landing page". A fresh visit opens the whole
   network in the Flow view (nora.toml [screen] start = "network", network_view = "flow"),
   and Back to the first page lands on the Flow view again, not the overview. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

// Just enough of vis-network for the Flow view to mount.
function fakeVis() {
  const set = () => ({ update() {}, get: () => null, getIds: () => [] });
  class Network {
    constructor() { this.body = { nodes: {}, view: { scale: 0.3, translation: { x: 0, y: 0 } }, emitter: { emit() {} } }; }
    on() {} once() {} off() {} fit() {} setOptions() {} redraw() {} selectNodes() {} unselectAll() {}
    getScale() { return this.body.view.scale; }
    moveTo() {}
    getPositions() { return {}; }
    getViewPosition() { return { x: 0, y: 0 }; }
    DOMtoCanvas(p) { return p; }
    canvasToDOM(p) { return p; }
  }
  return { vis: { Network }, nodes: set(), edges: set(), flowOptions: {} };
}

test("landing: a fresh visit opens the whole network in the Flow view", () => {
  const { App, NORA, window, document } = loadApp({ shipped: true, globals: fakeVis() });
  document.getElementById("speed").options = [{ value: "600" }];
  App.start();
  assert.equal(NORA.config.screen.start, "network");
  assert.deepEqual([App.route.screen, App.route.unit], ["unit", "all"], "the whole network");
  assert.equal(App.state.view, "flow", "in the Flow view");
  App.go({ screen: "overview" });
  window.location.hash = "";
  for (const fn of window._listeners.popstate || []) fn({});
  assert.deepEqual([App.route.screen, App.route.unit], ["unit", "all"], "Back to the first page: the Flow view again");
});
