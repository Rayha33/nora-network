/* Ray, 28 Oct: "if i zoom in to areas on the map view more details should appear like
   pipeline diameter, pipline length". Zoomed in, a named line's diameter and laid
   length show above its name; at the overview zoom only the name. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

function canvasMap() {
  const texts = [];
  const Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  const loaded = loadApp({ globals: { Path2D } });
  const { App, document, NORA } = loaded;
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      if (key === "fillText") return (text) => texts.push(String(text));
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    if (String(tag).toLowerCase() === "canvas") node.getContext = (type) => (type === "2d" ? ctx : null);
    return node;
  };
  const el = document.getElementById("view-map");
  el.clientWidth = 1200;
  el.clientHeight = 800;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  App.state.view = "map";
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const redraw = () => { texts.length = 0; App.views.map.restyle(); return [...texts]; };
  return { App, NORA, view: App.views.map, redraw };
}

test("a named line's diameter and length come from pipelines.csv", () => {
  const { App, NORA } = loadApp();
  const d = NORA.assets.europipe_2_north;
  assert.equal(App.pipeDetail("europipe_2_north"), `${d.diameter}″ · ${d.length} km`);
  const unknown = App.pipeIds.find((id) => !NORA.assets[id].diameter && !NORA.assets[id].length);
  if (unknown) assert.equal(App.pipeDetail(unknown), "");
});

test("the map shows them zoomed in, not at the overview zoom", () => {
  const { App, view, redraw } = canvasMap();
  const details = (texts) => texts.filter((t) => /″|\d km$/.test(t));
  assert.deepEqual(details(redraw()), [], "the overview shows names only");
  view.focus("karsto", false);
  const near = details(redraw());
  assert.ok(near.length >= 1, `zoomed in: ${near.join(", ")}`);
  assert.ok(near.some((t) => t.includes("″") && t.includes(" km")), "diameter and length together");
  assert.ok(App.detailZoom >= 6);
});
