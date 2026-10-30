/* Fixes from the full review (Ray, 30 Oct: "you see any obvious improvements? do a full
   review of the full application"): no pressure tag on another, honest source notes, no
   "−0.0". */
import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

function mountFlow() {
  const set = () => ({ update() {}, get: () => null, getIds: () => [] });
  class Network {
    constructor() { this.body = { nodes: {}, view: { scale: 0.34, translation: { x: 0, y: 0 } }, emitter: { emit() {} } }; }
    on() {} once() {} off() {} fit() {} setOptions() {} redraw() {} selectNodes() {} unselectAll() {}
    getScale() { return this.body.view.scale; }
    moveTo({ scale }) { if (scale != null) this.body.view.scale = scale; }
    getPositions() { return this.positions || {}; }
    getViewPosition() { return { x: 0, y: 0 }; }
    DOMtoCanvas(p) { return p; }
    canvasToDOM(p) { return p; }
  }
  const loaded = loadApp({ globals: { vis: { Network }, nodes: set(), edges: set(), flowOptions: {} } });
  const { App, document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  const el = document.createElement("div");
  el.clientWidth = 1484;
  el.clientHeight = 880;
  App.state.mode = "live";
  try { App.views.flow.mount(el); } catch { /* the rest of the mount needs more of vis */ }
  const network = App.views.flow.network;
  // the shipped layout at the fitted overview's spacing (one step across 246, a row 192)
  network.positions = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 246, y: stage * 192 }]));
  return { ...loaded, network };
}

test("review: no pressure tag on another, a neighbour's included, at any zoom", () => {
  // Sleipner's side tags met where a corner pushed one onto the next; Kvitebjørn's met
  // Visund's across their short line (text over text).
  const { App, network } = mountFlow();
  const overlap = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  for (const scale of [0.34, 0.6, 1, 1.5]) {
    network.moveTo({ scale });
    const tags = App.frame.run(() => App.nodeIds.flatMap((id) => App.views.flow.tagsAt(id, network.getPositions()).map((t) => ({ id, box: t.box }))));
    assert.ok(tags.length > 40, `tags at ${scale}`);
    const met = [];
    for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) if (overlap(tags[i].box, tags[j].box)) met.push(`${tags[i].id}/${tags[j].id}`);
    assert.deepEqual(met, [], `no two tags meet at zoom ${scale}`);
    const at = (id) => App.frame.run(() => App.views.flow.tagsAt(id, network.getPositions())).length;
    assert.ok(at("kvitebjorn") > 0 && at("visund") > 0, "both ends of a short line keep a tag");
  }
});

test("review: a dataset's nominations are not called Origo's; no −0.0", () => {
  const { App, document } = mountFlow();
  App.go({ screen: "overview" });
  const text = document.getElementById("screen-overview").textContent;
  assert.ok(text.includes("Synthetic, from the dataset."), "synthetic says so");
  assert.ok(!/live, from Origo/.test(text), "no claim of a live source");
  assert.equal(App.signed(-0.04, 1), "±0.0", "a change that rounds to nothing has no sign");
  assert.equal(App.signed(0.06, 1), "+0.1");
  assert.equal(App.signed(-1.25, 1), "−1.3");
});
