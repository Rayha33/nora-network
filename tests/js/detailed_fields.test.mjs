import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const DETAILED = ["mikkel", "morvin", "trestakk", "smorbukk_nord", "skarv", "draugen", "aerfugl", "tordis", "gullfaks_sor"];

test("minor North Sea fields carry a detailed-map zoom threshold", () => {
  const { NORA } = loadApp();
  for (const id of DETAILED) {
    assert.ok(NORA.assets[id], `${id} is present`);
    assert.equal(NORA.assets[id].min_zoom, 5.5, `${id} is detailed-only map content`);
  }
  const mikkel = NORA.geo.nodes.features.find((feature) => feature.properties.asset === "mikkel");
  assert.equal(mikkel.properties.minZoom, 5.5, "MapLibre receives the same threshold");
});

test("canvas map hides a minor field at overview and shows it when focused", () => {
  const operations = [];
  const Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  const { App, document, NORA } = loadApp({ globals: { Path2D } });
  const context = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      if (key === "fillText") return (text) => operations.push(String(text));
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    if (String(tag).toLowerCase() === "canvas") node.getContext = (type) => (type === "2d" ? context : null);
    return node;
  };
  const el = document.getElementById("view-map");
  el.clientWidth = 1200;
  el.clientHeight = 800;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  const view = App.views.map;
  assert.equal(view.canvasMap, true);
  operations.length = 0;
  view.repaint();
  assert.ok(!operations.includes("Mikkel"), "the overview stays uncluttered");
  view.focus("mikkel", false);
  operations.length = 0;
  view.repaint();
  assert.ok(operations.includes("Mikkel"), "the real field appears at detailed zoom");
});
