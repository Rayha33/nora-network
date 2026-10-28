/* The map's context card follows the same route state as the network view. */
import test from "node:test";
import assert from "node:assert/strict";
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
  assert.ok(style.flow.length > 0, "throughput is available for the inside-node label");
  assert.match(style.pressure, / bar$/, "pressure is a separate outside-node label");
  assert.equal(style.sub, "", "the old combined flow/pressure subtitle is not repeated");
});
