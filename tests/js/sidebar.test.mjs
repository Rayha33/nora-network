/* The asset sidebar: clicking a field, plant or icon slides a detail column in
   from the right instead of taking over the page. It opens with the asset's
   name, closes on demand, follows the data while open, and stays out of the way
   on the other screens. Ray, 27 Oct: "when I click on one field or icon a
   sidebar should elegantly slide in on the right side with all the info I need". */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, assertHealthy } from "./harness.mjs";

test("sidebar: opens with the asset, closes on demand, and hides off-screen", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App, document } = loaded;
  const $ = (id) => document.getElementById(id);
  assert.ok(App.sidebar, "App exposes its sidebar controller");

  const id = App.nodeIds[0];
  assert.ok(id, "the network has at least one node");

  // Closed to start with: nothing selected, the panel not open.
  assert.equal(App.sidebar.id(), null, "no asset open to start with");
  assert.ok($("asset-side").getAttribute("aria-hidden") !== "false", "the panel starts closed");

  // A click only opens the panel on the unit screen (Map/Flow), like in the app.
  App.go({ screen: "unit", unit: "all" });

  // Selecting an asset on the unit screen slides it in rather than navigating.
  App.select(id);
  assert.equal(App.sidebar.id(), id, "the clicked asset is the open asset");
  assert.equal($("asset-side").getAttribute("aria-hidden"), "false", "the panel slides open");
  assert.equal($("side-title").textContent, App.nameOf(id), "the header names the asset");

  // Closing returns to a clean map.
  App.sidebar.close();
  assert.equal(App.sidebar.id(), null, "close clears the open asset");
  assert.equal($("asset-side").getAttribute("aria-hidden"), "true", "the panel slides away again");

  // Opening by id directly is the same as a click.
  App.sidebar.open(id);
  assert.equal(App.sidebar.id(), id, "open(id) selects the asset");
  assert.equal($("asset-side").getAttribute("aria-hidden"), "false", "and slides it in");
  App.sidebar.close();

  // Leaving the unit screen closes the panel: no orphaned overlay on other pages.
  App.sidebar.open(id);
  App.go({ screen: "asset", asset: id });
  assert.equal(App.sidebar.id(), null, "navigating away closes the panel");
  assert.equal($("asset-side").getAttribute("aria-hidden"), "true", "and hides it again");
});

test("sidebar: pipelines open too, and staying on the unit keeps it open", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App } = loaded;
  const id = App.pipeIds[0];
  assert.ok(id, "the network has pipelines");
  App.sidebar.open(id);
  assert.equal(App.sidebar.id(), id, "a pipeline opens in the panel");
  // Staying on the unit screen keeps the panel open.
  App.go({ screen: "unit", unit: "all" });
  assert.equal(App.sidebar.id(), id, "the panel survives a unit change");
  App.sidebar.close();
  assert.equal(App.sidebar.id(), null, "closed again");
});