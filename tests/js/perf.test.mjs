/* Ray, 28 Oct: "when i go to flow page, the page becomes very slow". The Flow view
   formats thousands of numbers a frame, and fmt() called toLocaleString with options,
   which builds a new Intl.NumberFormat every time: the page ran at 3 frames a second.
   fmt now keeps one formatter per digit count. These tests pin the output (identical to
   toLocaleString) and the cost (close to a cached formatter, not 40× slower). */

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

test("fmt costs about what a cached formatter costs", () => {
  const { App } = loadApp();
  const cached = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const time = (fn) => {
    for (let i = 0; i < 2000; i++) fn(i * 0.37); // warm up
    const start = performance.now();
    for (let i = 0; i < 20000; i++) fn(i * 0.37);
    return performance.now() - start;
  };
  const direct = time((v) => cached.format(v));
  const ours = time((v) => App.fmt(v, 1));
  // toLocaleString with options was about 40× the cached formatter; allow 5× for noise.
  assert.ok(ours < Math.max(5 * direct, 25), `fmt: ${ours.toFixed(1)} ms for 20k numbers, a cached formatter ${direct.toFixed(1)} ms`);
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
