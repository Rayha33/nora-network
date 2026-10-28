/* The map's context card follows the same route state as the network view. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadApp } from "./harness.mjs";

test("map context names all units and the selected operating unit", () => {
  const { App, NORA, document } = loadApp();
  App.go({ screen: "unit", unit: "all" });
  assert.equal(document.getElementById("map-kicker").textContent, "All operating units");
  assert.equal(document.getElementById("map-unit").textContent, "North Sea gas network");

  const unit = NORA.units[0];
  App.go({ screen: "unit", unit: unit.id });
  assert.equal(document.getElementById("map-kicker").textContent, "Operating unit");
  assert.equal(document.getElementById("map-unit").textContent, unit.name);
});

test("live node style separates throughput and pressure for the Flow renderer", () => {
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0](
    { target: { value: NORA.streams[0].name } },
  );
  const id = App.nodeIds.find((node) => App.nodeStyle(node).pressure);
  assert.ok(id, "the fixture has a node with a live pressure reading");
  const style = App.nodeStyle(id);
  assert.ok(style.flow.length > 0, "throughput is available for the circle");
  assert.match(style.pressure, / bar$/, "pressure is a separate reading");
  assert.equal(style.sub, "", "the old combined flow/pressure subtitle is not repeated");
});

test("breadcrumb level markers meet the 11 px readability floor", () => {
  const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");
  const block = css.match(/\.crumbs \.level\s*\{[^}]+\}/s);
  assert.ok(block, "the level-marker style exists");
  assert.doesNotMatch(block[0], /(?:\s|:)9px(?:\s|\/|;)/, "the marker number is not below 11 px");
});

test("player space is reserved only when the player exists", () => {
  const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");
  const sidebar = css.match(/\.sidebar\s*\{[^}]+\}/s);
  const pop = css.match(/\.pop\s*\{[^}]+\}/s);
  assert.ok(sidebar && pop, "sidebar and popover base styles exist");
  assert.match(sidebar[0], /bottom:\s*0/, "no-player sidebars reach the viewport bottom");
  assert.doesNotMatch(pop[0], /var\(--player-h\)/, "no-player popovers do not reserve player space");
  assert.match(css, /\.has-player\s+\.sidebar\s*\{[^}]*bottom:\s*var\(--player-h\)/s);
  assert.match(css, /\.has-player\s+\.pop\s*\{[^}]*var\(--player-h\)/s);
});

/* Load mode on a calm network looked like Plain: every line one grey width. The width
   now shows how full each line is, so the full ones stand out without any colour. */
test("load mode: a fuller line is drawn thicker", () => {
  const { App, NORA } = loadApp();
  App.state.mode = "load";
  const lines = App.pipeIds.filter((id) => NORA.assets[id].utilization != null);
  const full = lines.find((id) => NORA.assets[id].utilization >= 0.95);
  const light = lines.find((id) => NORA.assets[id].utilization <= 0.5);
  assert.ok(full && light, "the model has full and lightly used lines");
  assert.ok(App.pipeStyle(full).width > App.pipeStyle(light).width + 1, "full lines are clearly thicker");
  assert.equal(App.pipeStyle(full).level, 0, "running full is normal: no alarm colour");
});

/* Ray: "white text on white background makes it unreadable". An offline node's circle
   is dark, so its inside ink is light; the name under it sits on the paper and must
   take the paper's ink, or it vanishes. */
test("flow: an offline node's name is written in the paper's ink", () => {
  const { App, NORA } = loadApp();
  App.state.mode = "whatif";
  App.whatif.toggle("kollsnes");
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (t) => ({ width: String(t).length * 6 });
      return (...args) => calls.push({ op: key, args, fill: target.fillStyle });
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  App.views.flow.card("kollsnes")({ ctx, x: 0, y: 0, state: { selected: false, hover: false } }).drawNode();
  const name = calls.find((c) => c.op === "fillText" && c.args[0] === NORA.assets.kollsnes.name);
  assert.ok(App.nodeStyle("kollsnes").inactive, "the node is offline");
  assert.equal(name.fill, App.colors.text, "its name is in the paper's ink");
});

test("what-if: no 0.0 on dead lines, and the chip never cuts twice", () => {
  const { App, NORA, document } = loadApp();
  App.state.mode = "whatif";
  App.whatif.toggle("kollsnes");
  for (const id of App.pipeIds) assert.notEqual(App.pipeStyle(id).label, "0.0", `${id} carries no 0.0`);
  App.go({ screen: "unit", unit: "all" });
  const chip = document.getElementById("plan-chip");
  const text = (chip.children || []).map((c) => c.textContent).join("");
  assert.match(text, /^What-if: [\d.,]+ of [\d.,]+ MSm³\/d · 1 offline · Restore all$/, text);
});
