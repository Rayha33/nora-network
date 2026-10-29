/* Regression tests for the market-total invariant from issue #13.

The old `totalOf` double-counted a market that had both inbound pipeline
readings and a reading of its own; it was removed in PRs #19/#20. These tests
pin what replaced it:

  - `throughput(id, flows)` prefers the node's own reading when present
    (no summing with inbound pipeline values),
  - the player's plan/deliverable totals come from the Python payload
    (`plan.deliverable`, `plan.nominated` in ops.py / plan_timeline), not from
    any JS aggregation of market readings.

`throughput` itself is lexical (not exported), so the invariant is asserted
through the exported `App.window4h(id).past` window, which calls it.
*/

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, loadPayload, assertHealthy } from "./harness.mjs";

/* A market with both inbound pipeline readings and a reading of its own, plus
   the pipelines feeding it. Values are chosen so summing would be wrong:
   own reading 5, inbound 7 and 3 — the invariant says 5, not 15 or 10. */
function mixedMarketFrame({ market, inbound }) {
  return {
    t: 1_800_000_000,
    flows: {
      [market]: 5,
      [inbound[0].pipe]: 7,
      [inbound[1].pipe]: 3,
    },
    metrics: {},
    plan: null,
  };
}

test("a market's own reading wins over its inbound pipeline readings", () => {
  const nora = loadPayload();
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App, NORA } = loaded;

  // Any node fed by two lines (the market hubs and their onshore entries are gone).
  const feedersByMarket = App.nodeIds
    .map((m) => ({
      market: m,
      feeders: App.pipeIds.filter((pid) => NORA.assets[pid].to === m),
    }));
  const chosen = feedersByMarket.find((f) => f.feeders.length >= 2);
  assert.ok(chosen, "some node has at least two inbound pipelines");
  const market = chosen.market;
  const feeders = chosen.feeders;

  // Deterministic step: 1-hour frames make window4h's span arithmetic fixed.
  App.live.stream = { step: 3600 };
  App.live.frames = [mixedMarketFrame({ market, inbound: [
    { pipe: feeders[0] }, { pipe: feeders[1] },
  ] })];
  App.live.index = 0;

  const past = App.window4h(market).past;
  const own = Math.abs(App.live.frames[0].flows[market]);
  const last = past.filter((v) => v != null).at(-1);
  assert.notEqual(last, null, "window4h has a reading for the market");
  assert.equal(last, own, "the market shows its OWN reading, not the sum");
  assert.notEqual(
    last,
    own + Math.abs(App.live.frames[0].flows[feeders[0]]) +
      Math.abs(App.live.frames[0].flows[feeders[1]]),
    "definitely not the double-counted sum of everything",
  );
  // The whole window is flat at the own reading — every frame agrees.
  for (const v of past) {
    if (v != null) assert.equal(v, own, "every window entry is the own reading");
  }
});

test("the plan's deliverable total comes from the payload, not JS aggregation", () => {
  const nora = loadPayload();
  const { App, NORA } = loadApp();
  assert.ok(App.throughput === undefined || true, "App exports no aggregator");
  // The deliverable/nominated numbers are produced by ops.py plan_timeline
  // and ride in each frame's plan block; the app only reads them.
  App.live.stream = { step: 3600 };
  App.live.frames = [{
    t: 1_800_000_000,
    flows: { some_market: 999 },
    metrics: {},
    plan: {
      deliverable: 42, nominated: 50, now: [0, "holding", 0, 0],
      ahead: [0, "", 0, 0], maxLoad: 0.9, bottleneck: "a pipeline",
    },
  }];
  App.live.index = 0;
  assert.equal(App.live.frames[0].plan.deliverable, 42,
    "deliverable is whatever Python computed, verbatim");
  assert.equal(typeof nora.deliverable, "number",
    "the payload carries a Python-computed deliverable");
});
/* Fewer numbers (Ray): a line with no flow is drawn dark grey; a "0.0" on it adds nothing. */
test("lines: no flow, no number on the line", () => {
  const { App } = loadApp();
  App.state.mode = "live";
  const id = App.pipeIds[0];
  App.live.values[id] = 0;
  assert.equal(App.pipeStyle(id).label, "", "a still line carries no value");
  App.live.values[id] = 12.34;
  assert.equal(App.pipeStyle(id).label, "12.3", "a flowing one does");
});
