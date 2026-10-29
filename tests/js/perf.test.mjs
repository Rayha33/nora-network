/* Ray, 28 Oct: "when i go to flow page, the page becomes very slow". The Flow view
   formats thousands of numbers a frame, and fmt() called toLocaleString with options,
   which builds a new Intl.NumberFormat every time: the page ran at 3 frames a second.
   fmt now keeps one formatter per digit count. These tests pin the output (identical to
   toLocaleString) and the cost (one formatter per digit count, not one per number). */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, assertHealthy } from "./harness.mjs";

const VALUES = [0, 0.04, 0.05, 1, 9.95, 12.345, 34, 1234.5, 1234567.891, -3.5];

test("fmt prints exactly what toLocaleString printed", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App } = loaded;
  for (const v of VALUES) {
    for (const digits of [0, 1, 2]) {
      const before = Number(v).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
      assert.equal(App.fmt(v, digits), before, `fmt(${v}, ${digits})`);
    }
  }
  assert.equal(App.fmt(null), "–");
  assert.equal(App.fmt(NaN), "–");
});

/* The cost, counted instead of timed: a timed ratio failed whenever the machine was
   busy (review, 29 Oct: 132 ms against 19 ms with the other test files running in
   parallel). What made the page slow was a new Intl.NumberFormat per number, so count
   those: one per digit count, however many numbers are formatted. */
test("fmt builds one number format per digit count, however many numbers it formats", () => {
  let built = 0;
  class CountingNumberFormat extends Intl.NumberFormat {
    constructor(...args) { super(...args); built += 1; }
  }
  const { App } = loadApp({ globals: { Intl: { ...Intl, NumberFormat: CountingNumberFormat } } });
  const before = built;
  for (let i = 0; i < 20000; i++) App.fmt(i * 0.37, i % 3);
  assert.equal(built - before, 3, "20,000 numbers in 0, 1 and 2 digits: three formats");
});

test("the player clock reads as before", () => {
  const { App, document, NORA } = loadApp();
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[1].name } });
  const t = App.live.time;
  const before = new Date(t * 1000).toLocaleString("en-GB",
    { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";
  assert.equal(document.getElementById("clock").textContent, before);
});

/* The frame cache: inside one frame a style is computed once; outside a frame nothing is
   cached, so a change of mode (or anything else) shows on the very next call. */
test("styles are cached within a frame and never outside one", () => {
  const { App } = loadApp();
  const id = App.pipeIds[0];
  assert.notEqual(App.pipeStyle(id), App.pipeStyle(id), "outside a frame: computed fresh");
  App.frame.run(() => {
    assert.equal(App.pipeStyle(id), App.pipeStyle(id), "inside a frame: computed once");
    assert.equal(App.nodeStyle(App.nodeIds[0]), App.nodeStyle(App.nodeIds[0]));
  });
  App.state.mode = "live";
  const live = App.pipeStyle(id);
  App.state.mode = "plain";
  assert.equal(App.pipeStyle(id).label, "", "the new mode shows at once after a frame");
  assert.ok(live !== App.pipeStyle(id));
  assert.throws(() => App.frame.run(() => { throw new Error("draw failed"); }));
  assert.notEqual(App.pipeStyle(id), App.pipeStyle(id), "a failed frame does not leave the cache on");
});
