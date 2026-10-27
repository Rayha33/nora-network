/* Pigs and peaks travel routes: chains of pipelines in the downstream direction,
   picked at random weighted by the flow each line carries, deterministic per seed.
   Covers the two urgent board tasks (3605: playback speed + pig programme on every
   main line, 3610: multi-line routes, always downstream, some starting mid-network). */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, assertHealthy } from "./harness.mjs";

const HOUR = 3600;

test("routes: the app loads healthy with routes exported", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { routes } = loaded.App;
  assert.ok(routes, "App exposes its route helpers");
  for (const name of ["nextOut", "pigPlace", "peakPlace", "seeded"]) {
    assert.equal(typeof routes[name], "function", `routes.${name} is a function`);
  }
});

test("routes: seeded PRNG is deterministic", () => {
  const { routes } = loadApp().App;
  const a = routes.seeded("route-1"), b = routes.seeded("route-1"), c = routes.seeded("route-2");
  const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
  assert.deepEqual(sa, sb, "the same seed gives the same sequence");
  assert.notDeepEqual(sa, sc, "a different seed gives a different sequence");
  for (const v of [...sa, ...sc]) assert.ok(v >= 0 && v < 1, "the PRNG returns 0..1");
});

test("routes: a pig starts on its line, hands over downstream, and is deterministic", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App } = loaded;
  const { routes } = App;
  loadFirstHour(App, loaded.NORA);
  const pig = App.live.stream.pigs[0];
  assert.ok(pig, "the stream has at least one pig");

  assert.equal(routes.pigPlace(pig, pig.launch - 1), null, "no pig before launch");

  const just = routes.pigPlace(pig, pig.launch + 60);
  assert.ok(just, "a pig right after launch");
  assert.ok(App.pipeIds.includes(just.pid), "it sits on a real pipeline");
  assert.ok(just.along >= 0 && just.along <= 1, "along is within the line");

  const at = pig.launch + 10 * HOUR;
  assert.deepEqual(routes.pigPlace(pig, at), routes.pigPlace(pig, at), "routes are deterministic");

  // Far past its first line, it is either further down its route or at the receiver.
  const later = routes.pigPlace(pig, pig.launch + 200 * HOUR);
  assert.ok(later === null || (later.along >= 0 && later.along <= 1), "any pig stays within a line");
});

test("routes: a peak moves with the gas and leaves the network in the end", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App } = loaded;
  const { routes } = App;
  loadFirstHour(App, loaded.NORA);
  const stream = App.live.stream;
  const pid = stream.assets.find((id) => App.pipeIds.includes(id));
  assert.ok(pid, "the stream covers at least one pipeline");
  const peak = { id: pid, t0: stream.times[0], delta: 10, forward: true, level: 1 };

  const early = routes.peakPlace(peak, peak.t0 + 60);
  assert.ok(early, "the peak is on screen early on");
  assert.equal(early.pid, pid, "still on its first line");
  assert.ok(early.along >= 0 && early.along <= 1, "along is within the line");
  assert.ok(early.exitAt > peak.t0, "an exit time is set");

  assert.equal(routes.peakPlace(peak, peak.t0 + 400 * 24 * HOUR), null, "the peak is gone in the far future");
});

/* Put one real hour of the first stream into App.live, the way `start()` does,
   so the route helpers have flows to follow. */
function loadFirstHour(App, nora) {
  const stream = nora.streams.find((s) => s.pigs && s.pigs.length) || nora.streams[0];
  App.live.stream = stream;
  const flows = {};
  stream.assets.forEach((id, j) => { flows[id] = stream.values[0][j]; });
  App.live.frames = [{ t: stream.times[0], flows, metrics: stream.metrics || {}, plan: null }];
  App.live.index = 0;
  App.live.time = stream.times[0];
}
