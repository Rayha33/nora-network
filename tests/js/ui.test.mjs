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

/* The top bar never changes (Ray). The plan chip used to vanish for datasets without
   nominations and come back in What-if; it now says there is no plan to check. */
test("top bar: the plan chip is always there, also without nominations", () => {
  const { App, document } = loadApp();
  App.live.frames = [{ t: 3600, flows: {}, metrics: {}, plan: null }];
  App.live.index = 0;
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const chip = document.getElementById("plan-chip");
  assert.equal(chip.hidden, false, "the chip stays");
  assert.match(chip.textContent, /No plan to check/);
});

test("overview: an hour without nominations says so, never 'null'", () => {
  const { App, document } = loadApp();
  const plan = { now: [0, "No nominations", null], ahead: [0, "No nominations", null, 0], nominated: 0, deliverable: 0, maxLoad: 0, bottleneck: null };
  App.live.frames = [{ t: 3600, flows: {}, metrics: {}, plan }];
  App.live.index = 0;
  App.go({ screen: "overview" });
  const text = document.getElementById("screen-overview").textContent;
  assert.match(text, /No nominations at this hour/);
  assert.doesNotMatch(text, /null|Plan holds/);
});

test("asset facts: a position west of Greenwich reads °W", () => {
  const { App, document } = loadApp();
  App.go({ screen: "asset", asset: "teesside" });
  const text = document.getElementById("screen-asset").textContent;
  assert.match(text, /\d\.\d{4}°W/);
  assert.doesNotMatch(text, /-\d+\.\d{4}°E/);
});

/* Review finding: the Flow right-click subtracted a circle's radius in canvas units
   from a distance in screen pixels, so zoomed out a node won clicks right on a line. */
test("flow: the hit test measures circles and lines in screen pixels at any zoom", () => {
  const { App, NORA } = loadApp();
  App.state.mode = "live";
  const pid = App.pipeIds.find((id) => NORA.assets[id].type === "trunk");
  const { from, to } = NORA.assets[pid];
  App.live.values[pid] = 20; // flowing: the end circles are the large live ones
  const positions = { [from]: { x: 0, y: 0 }, [to]: { x: 1000, y: 0 } };
  const scale = 0.3, toDOM = (p) => ({ x: p.x * scale, y: p.y * scale });
  const flow = App.views.flow;
  assert.ok(flow.circleRadius(from, positions) * scale < 40, "zoomed out, the circle is small on screen");
  assert.equal(flow.hitTest({ x: 40, y: 0 }, positions, toDOM, scale), pid, "a click on the line, clear of the circle, is the line");
  assert.equal(flow.hitTest({ x: 5, y: 0 }, positions, toDOM, scale), from, "a click in the circle is the node");
  assert.equal(flow.hitTest({ x: 150, y: 80 }, positions, toDOM, scale), null, "empty paper is nothing");
});

/* Ray, 28 Oct: "still performs bad, with a lot of stutter". The player restyles four
   times a second, and vis-network re-read every node and line it was handed (about
   28 ms, changed or not). Now a step hands it only looks that changed: a new value on
   a line is drawn by the overlay, and widths move in quarter pixels. */
test("flow: replaying the data hands vis-network only what changed", () => {
  const { App } = loadApp();
  App.state.mode = "live";
  const flow = App.views.flow, pid = App.pipeIds[0];
  App.live.maxAbs = 100;
  App.live.values = { [pid]: 20 };
  const first = flow.changes();
  assert.equal(first.nodes.length, App.nodeIds.length, "the first time, everything");
  assert.equal(first.lines.length, App.pipeIds.length);
  App.live.values = { [pid]: 20.3 }; // the next step: a new value, the same quarter-pixel width
  const next = flow.changes();
  assert.equal(next.nodes.length, 0, "no node is re-sent");
  assert.equal(next.lines.length, 0, "no line is re-sent for a new value");
  App.live.values = { [pid]: 0 }; // the line stops: its look changes
  assert.deepEqual(Array.from(flow.changes().lines, (line) => line.id), [pid], "only that line");
});
