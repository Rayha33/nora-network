import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadApp } from "./harness.mjs";

const html = readFileSync(new URL("../../src/nora/templates/app.html.j2", import.meta.url), "utf8");
const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");
const js = readFileSync(new URL("../../src/nora/templates/app.js", import.meta.url), "utf8");

test("top bar is one compact row without overview, unit breadcrumbs, or year slider", () => {
  assert.doesNotMatch(html, /id="crumb-(?:overview|unit|asset|diag)"/, "no Overview, unit, asset or diagnostic breadcrumb controls");
  assert.doesNotMatch(html, /class="crumbs"/, "the breadcrumb row is gone");
  assert.doesNotMatch(html, /class="bar-secondary"/, "there is no second toolbar row");
  assert.doesNotMatch(html, /id="(?:year|year-wrap|year-out)"/, "the Network year slider is removed");
  assert.doesNotMatch(js, /yearInput|yearOut/, "no obsolete year-slider wiring remains");
  assert.match(html, /North Sea · all units/, "the fixed network scope is named once beside the brand");
  assert.match(css, /--bar-h:\s*52px/, "the single row is compact");
});

test("network navigation always keeps all units selected", () => {
  const { App, NORA, document } = loadApp();
  for (const unit of NORA.units.slice(0, 2)) {
    App.go({ screen: "unit", unit: unit.id });
    assert.equal(App.route.unit, "all", `${unit.id} cannot narrow the network`);
    assert.equal(document.getElementById("map-kicker").textContent, "All operating units");
    assert.equal(document.getElementById("map-unit").textContent, "North Sea gas network");
  }
});
