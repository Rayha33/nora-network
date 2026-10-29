/* `nora live --now` sends a frame an hour, re-timed to the wall clock (#182). Between
   frames the app's clock runs on at the feed's speed, so pigs and peaks glide instead of
   jumping once an hour, and it never runs past the next frame's time. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const T0 = 1_800_000_000;
function feed(retimed) {
  const { App } = loadApp();
  App.feed.meta({ title: "Synthetic (re-timed to now)", events: [], pigs: [], ...(retimed ? { retimed } : {}) });
  App.feed.frame({ t: T0, values: {}, metrics: {} });
  App.feed.frame({ t: T0 + 3600, values: {}, metrics: {} });
  return App;
}

test("live feed glide: a re-timed feed's clock runs on between frames at its speed", () => {
  const App = feed({ origin: T0, speed: 1, loop: 0 });
  assert.equal(App.live.time, T0 + 3600);
  App.feed.glide(0.25);
  assert.equal(App.live.time, T0 + 3600.25, "a quarter of a second later");
  for (let i = 0; i < 20000; i++) App.feed.glide(0.25);
  assert.equal(App.live.time, T0 + 7200, "never past the next frame, an hour on");
  App.feed.frame({ t: T0 + 7200, values: {}, metrics: {} });
  assert.equal(App.live.time, T0 + 7200, "the next frame takes over");
});

test("live feed glide: speed 60 runs a data minute a second", () => {
  const App = feed({ origin: T0, speed: 60, loop: 0 });
  App.feed.glide(1);
  assert.equal(App.live.time, T0 + 3660);
});

test("live feed glide: a feed that is not re-timed keeps its frame's time", () => {
  const App = feed(null);
  assert.equal(App.feed.glide(1), false);
  assert.equal(App.live.time, T0 + 3600);
});
