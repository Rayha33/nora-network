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
