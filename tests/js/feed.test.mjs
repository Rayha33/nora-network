/* The live feed (`?live=`): frames must rise in time, and a feed in trouble is shown
   as stale, never as live. Review findings, 28 Oct. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

const frame = (t, values = {}) => ({ t, values, metrics: {} });

test("live feed: a frame older than the last starts a new timeline", () => {
  const { App } = loadApp();
  for (const t of [3600, 7200, 10800]) App.feed.frame(frame(t));
  assert.deepEqual(Array.from(App.live.frames, (f) => f.t), [3600, 7200, 10800]);
  App.feed.frame(frame(3600)); // `nora live` looped, or the server restarted and the browser reconnected
  assert.deepEqual(Array.from(App.live.frames, (f) => f.t), [3600], "a new timeline, never times out of order");
  App.feed.frame(frame(3600, { troll_kollsnes: 20 })); // the same reading again (a poll that saw no update)
  assert.equal(App.live.frames.length, 1, "a frame with the same time replaces the last one");
  assert.equal(App.live.frames[0].flows.troll_kollsnes, 20);
});

test("live feed: trouble marks the data stale and raises it; fresh data clears it", () => {
  const { App, document } = loadApp();
  App.live.feed = { close() {} }; // as connectFeed leaves it
  App.feed.frame(frame(3600));
  App.feed.trouble("Gassco real-time exports: HTTP Error 503");
  const raised = App.live.conditions.find((c) => c.kind === "feed");
  assert.ok(raised && raised.level >= 2, "a stale feed is an abnormal condition, with its level");
  assert.match(raised.text, /stale.*503/, "saying why");
  const when = document.getElementById("when");
  assert.equal(when.hidden, false);
  assert.equal(when.textContent, "Stale", "the chip beside the clock says so");
  App.feed.frame(frame(7200));
  assert.ok(!App.live.conditions.some((c) => c.kind === "feed"), "fresh data clears it");
  assert.equal(when.hidden, true);
});
