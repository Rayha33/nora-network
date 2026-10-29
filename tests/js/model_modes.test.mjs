/* Review #49802: Risk mode painted the N-1 model answer with the alarm palette and
   shapes (15+ red and orange badges while the top bar counted 4 alarms), and Load did
   the same for full lines. Alarms belong to Live; the model modes show their answer by
   line weight, node size and the number. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

for (const mode of ["risk", "load"]) {
  test(`${mode} mode: no alarm badge or level on any asset`, () => {
    const { App } = loadApp();
    App.state.mode = mode;
    for (const id of App.pipeIds) assert.equal(App.pipeStyle(id).level, 0, `${id} has no alarm level`);
    for (const id of App.nodeIds) assert.equal(App.nodeStyle(id).level, 0, `${id} has no alarm level`);
  });
}

test("risk mode: the line that loses most is drawn heaviest, and keeps its number", () => {
  const { App, NORA } = loadApp();
  App.state.mode = "risk";
  const pipes = App.pipeIds.filter((id) => NORA.assets[id].type !== "onshore" && NORA.assets[id].lost > 0);
  const byLoss = [...pipes].sort((a, b) => NORA.assets[b].lost - NORA.assets[a].lost);
  const [big, small] = [byLoss[0], byLoss[byLoss.length - 1]];
  assert.ok(NORA.assets[big].lost > NORA.assets[small].lost);
  assert.ok(App.pipeStyle(big).width > App.pipeStyle(small).width, "heavier line, bigger loss");
  assert.match(App.pipeStyle(big).label, /^−\d/);
  const node = App.nodeIds.filter((id) => NORA.assets[id].lost > 0).sort((a, b) => NORA.assets[b].lost - NORA.assets[a].lost)[0];
  assert.match(App.nodeStyle(node).sub, /if it trips/);
});

/* Review #49802: "Load mode unreadable at overview zoom". The map thinned every line to
   0.45 of its weight there and wrote no numbers; Load and Risk now keep both. */
function canvasMap(mode) {
  const texts = [], widths = [];
  const Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  const loaded = loadApp({ globals: { Path2D } });
  const { App, document, NORA } = loaded;
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      if (key === "fillText") return (text) => texts.push({ text: String(text), font: target.font });
      if (key === "stroke") return () => widths.push(target.lineWidth);
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
  App.state.mode = mode;
  App.go({ screen: "unit", unit: "all" });
  texts.length = 0;
  widths.length = 0;
  App.views.map.restyle();
  return { App, NORA, texts, widths };
}

test("load mode at overview zoom: the map writes how full the lines are, in the model's italic", () => {
  const { texts } = canvasMap("load");
  const shares = texts.filter((t) => /^\d+%$/.test(t.text));
  assert.ok(shares.length >= 5, `${shares.length} line shares written at the overview zoom`);
  assert.ok(shares.every((t) => /italic/.test(t.font)), "model numbers are italic");
  assert.ok(!canvasMap("live").texts.some((t) => /^\d+%$/.test(t.text)), "Live writes no model shares");
});

test("load mode keeps the line weight at overview zoom", () => {
  const heaviest = (mode) => Math.max(...canvasMap(mode).widths);
  assert.ok(heaviest("load") >= 2.5, `the fullest line is ${heaviest("load").toFixed(2)} px wide, not a hairline`);
});

test("risk mode at overview zoom writes what a trip would cost", () => {
  const { texts } = canvasMap("risk");
  assert.ok(texts.filter((t) => /^−\d/.test(t.text)).length >= 3);
});

test("the map's coordinate readout sits in a corner, not over the network", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");
  const rule = css.match(/\.coord-readout\s*\{([^}]*)\}/)[1];
  assert.doesNotMatch(rule, /left:\s*50%/, "at the bottom centre it covered Dunkirk at the default fit");
  assert.match(rule, /right:\s*\d+px/);
});
