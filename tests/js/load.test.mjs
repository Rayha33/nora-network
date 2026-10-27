/* The templates must load: app.js, map.js and flow.js evaluate in a bare vm context
   (DOM stubs + the real payload fixture) without a browser, jsdom or any network
   fetch, and App comes out with both views registered and its id lists intact. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, loadPayload, assertHealthy } from "./harness.mjs";

test("templates load in a vm context with only DOM stubs", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
});

test("payload fixture is the same shape render.py ships", () => {
  const nora = loadPayload();
  for (const key of ["assets", "geo", "grid", "units", "iconSets", "config",
    "nodeTypes", "pipelineTypes", "short", "plural", "deliverable", "worstOutage",
    "streams", "links"]) {
    assert.ok(nora[key] !== undefined, `payload has a ${key} block`);
  }
  assert.ok(nora.streams.length > 0, "at least one stream is embedded");
  assert.equal(
    nora.geo.nodes.features.length,
    Object.values(nora.assets).filter((a) => a.kind === "node").length,
    "GeoJSON node features match the assets",
  );
});

test("loaded App agrees with the payload about nodes and pipelines", () => {
  const { App, NORA } = loadApp();
  const nodes = Object.keys(NORA.assets).filter((id) => NORA.assets[id].kind === "node").sort();
  const pipes = Object.keys(NORA.assets).filter((id) => NORA.assets[id].kind === "pipeline").sort();
  assert.deepEqual(App.nodeIds, nodes, "App.nodeIds matches the payload's node assets");
  assert.deepEqual(App.pipeIds, pipes, "App.pipeIds matches the payload's pipeline assets");
});

test("?embed=1 is read from location.search and breaks nothing", () => {
  const { App } = loadApp({ search: "?embed=1" });
  assert.equal(App.embed, true, "embed flag is read from location.search");
});
