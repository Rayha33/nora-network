/* app.js under the DOM-less harness: the pure logic both views share — formatting,
   the player's per-market total (#13), stream preparation, and the alarm logic
   behind `evaluate` (trips, nomination deviations, pressure margins, plan risk). */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const { App } = await loadApp();

test("fmt renders numbers en-GB and a dash for missing values", () => {
  assert.equal(App.fmt(null), "–");
  assert.equal(App.fmt(1234.56, 1), "1,234.6");
  assert.equal(App.fmt(0), "0");
});

test("esc escapes everything data-derived that reaches markup", () => {
  assert.equal(App.esc(`<"A&B'>`), "&#60;&#34;A&#38;B&#39;&#62;");
});

test("totalOf counts each market once in a mixed dataset (own reading wins)", () => {
  // a_entry and b_entry both deliver into `market`, which also has its own reading.
  // The old sum (pipeline readings + the node reading) would report 18.
  const mixed = App.totalOf({ a_entry: 5, b_entry: 6, market: 7 });
  assert.equal(mixed.label, "delivered to markets");
  assert.equal(mixed.value, 7);
});

test("totalOf sums the pipeline readings reaching each market", () => {
  assert.equal(App.totalOf({ a_entry: 5, b_entry: 6 }).value, 11);
  // reverse flow on a market's `from` end is gas the market receives
  assert.equal(App.totalOf({ b_entry: -3 }).value, 3);
  assert.equal(App.totalOf({ market: 7 }).value, 7);
});

test("totalOf falls back to the sum across points when no market is read", () => {
  const total = App.totalOf({ feed: 60, pipe_a: 20 });
  assert.equal(total.label, "across these points");
  assert.equal(total.value, 80);
});

test("throughput prefers a node's own reading over the pipelines around it", () => {
  assert.equal(App.throughput("market", { market: 9 }), 9);
  assert.equal(App.throughput("a_terminal", { pipe_a: 4 }), 4);
  assert.equal(App.throughput("hub", { feed: 60, pipe_a: 20, pipe_b: 30 }), 60);
});

test("prepare turns a stream payload into frames, medians and a step", () => {
  const stream = {
    times: [0, 3600],
    assets: ["feed", "pipe_a"],
    values: [[10, 20], [null, 24]],
    metrics: { pressure_bar: { assets: ["hub"], values: [[60], [70]] } },
  };
  App.prepare(stream);
  assert.equal(stream.frames.length, 2);
  assert.deepEqual(stream.frames[0].flows, { feed: 10, pipe_a: 20 });
  assert.deepEqual(stream.frames[1].flows, { pipe_a: 24 }); // null: no reading
  assert.equal(stream.frames[1].metrics.pressure_bar.hub, 70);
  assert.deepEqual(stream.typical, { feed: 10, pipe_a: 24 }); // column medians
  assert.equal(stream.maxAbs, 24);
  assert.equal(stream.step, 3600);
});

function play(frames) {
  App.live.frames = frames;
  App.live.index = frames.length - 1;
  App.live.time = frames.at(-1).t;
  App.live.stream = null;
  App.live.feedEvents = [];
  App.evaluate();
  return App.live.conditions;
}

test("evaluate raises a trip when a line's flow collapses", () => {
  App.live.down = { pipe_a: true };
  const conditions = play([{ t: 0, flows: { pipe_a: 1, feed: 60 }, metrics: {}, plan: null }]);
  const trip = conditions.find((c) => c.id === "pipe_a");
  assert.equal(trip.kind, "trip");
  assert.equal(trip.level, 2);
  App.live.down = {};
});

test("evaluate rates exit points against nomination and booked capacity", () => {
  const frame = {
    t: 0,
    flows: { pipe_a: 13 },
    metrics: { nomination_msm3d: { a_terminal: 10 }, booked_msm3d: { a_terminal: 10 } },
    plan: null,
  };
  const conditions = play([frame]);
  const nom = conditions.find((c) => c.id === "a_terminal" && c.kind === "nomination");
  assert.equal(nom.level, 3); // 30% over: warning, medium and critical bands
  const booking = conditions.find((c) => c.id === "a_terminal" && c.kind === "booking");
  assert.equal(booking.level, 2); // booked exactly: warning band only
});

test("evaluate flags a pressure inside its window but near the edge", () => {
  // market window is 45-80 bar (nora.toml defaults): 46 bar is 1 bar off the minimum.
  const frame = { t: 0, flows: {}, metrics: { pressure_bar: { market: 46 } }, plan: null };
  const conditions = play([frame]);
  const pressure = conditions.find((c) => c.id === "market" && c.kind === "pressure");
  assert.equal(pressure.level, 2); // inside the medium, outside the critical margin
});

test("nextProblem jumps to the next hour where the plan is at risk", () => {
  const plan = (lvl) => ({ now: [lvl, ""], ahead: [lvl, "", 0, 0] });
  App.live.frames = [{ t: 0 }, { t: 1, plan: plan(0) }, { t: 2, plan: plan(2) }, { t: 3, plan: plan(0) }];
  App.live.index = 0;
  assert.equal(App.nextProblem(0), 2); // first risky hour after now
  assert.equal(App.nextProblem(2), null); // nothing risky after it
  App.live.frames = [{ t: 0 }, { t: 1 }, { t: 2 }];
  assert.equal(App.nextProblem(0), null); // plan holds throughout
});