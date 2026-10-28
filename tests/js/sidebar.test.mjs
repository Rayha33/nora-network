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
/* Ray, 28 Oct: "the text in sidebar should not be bold because i can barely read it".
   The global `svg` rule outlines shapes; the asset picture's labels must never inherit it,
   whatever the stylesheet says, so each label carries stroke:none and a regular weight. */
test("sidebar: the asset picture's labels are never outlined or bold", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App, document } = loaded;
  App.go({ screen: "unit", unit: "all" });
  for (const id of ["draupner_e", "europipe_1"]) {
    App.select(id);
    const markup = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node._innerHTML) markup.push(node._innerHTML);
      for (const child of node.children || []) walk(child);
    };
    walk(document.getElementById("side-body"));
    const labels = markup.join("").match(/<text[^>]*>/g) || [];
    assert.ok(labels.length >= 2, `${id}: the picture has labels`);
    for (const tag of labels) {
      assert.match(tag, /stroke:none/, `${id}: a label is never outlined`);
      assert.doesNotMatch(tag, /font-weight="(6|7)00"|font-weight:\s*(7|8|9)00/, `${id}: and never bold`);
    }
  }
});

/* Ray, 28 Oct: "cant even read the text". With several lines in or out, the labels of
   the asset picture were spread across one row and ran into each other. Now every line
   has its own row: no two names share a row, and every line starts right of the text. */
test("sidebar: the asset picture gives every line its own row, clear of the lines", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App, document } = loaded;
  App.go({ screen: "unit", unit: "all" });
  for (const id of ["ttf", "sleipner", "draupner_s", "karsto"]) {
    App.select(id);
    const markup = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (node._innerHTML) markup.push(node._innerHTML);
      for (const child of node.children || []) walk(child);
    };
    walk(document.getElementById("side-body"));
    const svg = markup.join("");
    const names = [...svg.matchAll(/<text x="18" y="([\d.]+)"(?![^>]*dimtext)/g)].map((m) => Number(m[1]));
    assert.ok(names.length >= 3, `${id}: one row per line (${names.length})`);
    const ys = [...names].sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 18, `${id}: rows ${ys[i - 1]} and ${ys[i]} do not overlap`);
    for (const m of svg.matchAll(/<line x1="([\d.]+)"/g)) assert.ok(Number(m[1]) >= 240, `${id}: a line starts right of the names`);
  }
});

test("sidebar: flow stays in the circle and pressure sits outside at 11 px", () => {
  const loaded = loadApp();
  const { App, document } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0](
    { target: { value: loaded.NORA.streams[0].name } },
  );
  App.go({ screen: "unit", unit: "all" });
  const id = App.nodeIds.find((node) => App.nodeStyle(node).pressure);
  App.select(id);
  const markup = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node._innerHTML) markup.push(node._innerHTML);
    for (const child of node.children || []) walk(child);
  };
  walk(document.getElementById("side-body"));
  const svg = markup.join("");
  const circle = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/);
  const pressure = svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([\d.]+) bar<\/text>/);
  assert.ok(circle && pressure, "the picture has a node circle and a pressure label");
  const distance = Math.hypot(Number(pressure[1]) - Number(circle[1]), Number(pressure[2]) - Number(circle[2]));
  assert.ok(distance > Number(circle[3]), "pressure is outside the circle");
  assert.match(pressure[0], /font-size:11px/, "pressure is readable");
});

test("sidebar: a row alarm badge sits beside its own pipeline", () => {
  const loaded = loadApp();
  const { App, NORA, document } = loaded;
  const pid = App.pipeIds[0], node = NORA.assets[pid].from;
  App.live.levelOf[pid] = 2;
  App.live.values[pid] = 1;
  App.go({ screen: "unit", unit: "all" });
  App.select(node);
  const markup = [];
  const walk = (item) => {
    if (!item || typeof item !== "object") return;
    if (item._innerHTML) markup.push(item._innerHTML);
    for (const child of item.children || []) walk(child);
  };
  walk(document.getElementById("side-body"));
  const badge = markup.join("").match(/<g transform="translate\(([\d.]+) [^)]+\) scale\(0\.9\)">/);
  assert.ok(badge, "the levelled row has a badge");
  assert.ok(Math.abs(Number(badge[1]) - 236) <= 10, "the badge is beside the line start, not the page margin");
});
