/* "Now" in the middle of the timeline: a synthetic stream is re-timed in the browser
   (by whole days) so the wall clock sits near its middle, the player opens at now, and
   anything right of now is labelled as the model's. Recorded real data keeps its dates. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { TEMPLATES, loadPayload, assertHealthy } from "./harness.mjs";
import { makeDom, makeSandbox } from "./stub.mjs";

const HOUR = 3600, DAY = 86400;
const wall = () => Date.now() / 1000;

function load(mutate = () => {}) {
  const nora = loadPayload();
  mutate(nora);
  const document = makeDom();
  const context = vm.createContext(makeSandbox({ nora, document }), { name: "nora-dom" });
  for (const name of ["app.js", "map2d.js", "map.js", "flow.js"]) {
    vm.runInContext(readFileSync(path.join(TEMPLATES, name), "utf8"), context, { filename: name });
  }
  const App = vm.runInContext("App", context);
  assertHealthy(assert, { App, NORA: nora });
  document.getElementById("speed").options = [{ value: "60" }]; // setStream reads them
  const choose = (name) => document.getElementById("stream-select")._listeners.change[0]({ target: { value: name } });
  const scrubTo = (index) => {
    const scrub = document.getElementById("scrub");
    while (App.live.index !== index) {
      const remaining = (index - App.live.index) * App.live.stream.step;
      scrub.value = String(Math.sign(remaining) * Math.min(Math.abs(remaining), 4 * HOUR));
      scrub._listeners.input[0]({ target: scrub });
    }
  };
  return { App, NORA: nora, document, choose, scrubTo, $: (id) => document.getElementById(id) };
}

const synthetic = (nora) => nora.streams.find((s) => s.synthetic);
const recorded = (nora) => nora.streams.find((s) => !s.synthetic);

test("a synthetic stream is re-timed by whole days, with now near its middle", () => {
  const original = synthetic(loadPayload());
  const { App, NORA, choose } = load();
  const s = synthetic(NORA);
  choose(s.name);
  assert.equal(App.live.stream, s);
  assert.equal(s.offset % DAY, 0, "shifted by whole days: hours of the day stay true");
  assert.deepEqual([...s.times], original.times.map((t) => t + s.offset), "every time moved by the offset");
  const middle = (s.times[0] + s.times[s.times.length - 1]) / 2;
  assert.ok(Math.abs(wall() - middle) <= 12 * HOUR, "now lies within half a day of the middle");
  s.events.forEach((e, i) => {
    assert.equal(e.start, original.events[i].start + s.offset, "events move with the data");
    assert.equal(e.end, original.events[i].end + s.offset);
  });
  s.pigs.forEach((p, i) => assert.equal(p.launch, original.pigs[i].launch + s.offset, "pig launches move too"));
  assert.ok(s.frames.every((f, i) => f.t === s.times[i]), "the frames carry the new times");
});

test("the player opens at now and says so", () => {
  const { App, NORA, choose, $ } = load();
  choose(synthetic(NORA).name);
  assert.ok(Math.abs(App.live.time - wall()) < 5, "the playhead starts at the wall clock");
  const ts = App.timeState();
  assert.ok(ts && !ts.model, "at now nothing is the model's yet");
  assert.equal($("when").hidden, false);
  assert.equal($("when").textContent, "Now");
  const window = App.timelineWindow(), s = App.live.stream;
  assert.deepEqual([window.start, window.end], [s.times[0], s.times[s.times.length - 1]], "the ruler holds the whole week, now inside it");
  assert.ok(window.start < App.live.time && App.live.time < window.end);
});

test("right of now is the model, left of it history", () => {
  const { App, NORA, choose, scrubTo, $ } = load();
  choose(synthetic(NORA).name);
  const here = App.live.index;
  scrubTo(here + 7);
  assert.equal(App.timeState().model, true, "six hours and more ahead is a model value");
  assert.match($("when").textContent, /^Model · in \d+ h$/);
  scrubTo(here - 3);
  assert.equal(App.timeState().model, false);
  assert.match($("when").textContent, /^\d+ h ago$/);
});

test("choosing a stream again never shifts it twice", () => {
  const { NORA, choose } = load();
  const s = synthetic(NORA);
  choose(s.name);
  const offset = s.offset, first = s.times[0];
  choose(recorded(NORA).name);
  choose(s.name);
  assert.equal(s.offset, offset);
  assert.equal(s.times[0], first);
});

test("recorded real data keeps its own dates and has no now", () => {
  const original = recorded(loadPayload());
  const { App, NORA, choose, $ } = load();
  const s = recorded(NORA);
  choose(s.name);
  assert.equal(s.offset, undefined);
  assert.deepEqual([...s.times], original.times, "real readings are never re-dated");
  assert.equal(App.live.index, 0, "a recording plays from its start");
  assert.equal(App.timeState(), null);
  assert.equal($("when").hidden, true);
  assert.equal(App.timelineWindow().start, s.times[0], "the ruler starts at its first reading");
  assert.equal($("tl-now").textContent, "Selected time · UTC", "a recording is not real time");
});

test("[screen] now_in_middle = false plays synthetic data at its own dates", () => {
  const original = synthetic(loadPayload());
  const { App, NORA, choose } = load((nora) => { nora.config.screen.now_in_middle = false; });
  const s = synthetic(NORA);
  choose(s.name);
  assert.equal(s.offset, undefined);
  assert.deepEqual([...s.times], original.times);
  assert.equal(App.live.index, 0);
  assert.equal(App.timeState(), null);
});

test("away from now, the chip beside the clock takes you back to now", () => {
  // Ray, 29 Oct: "make up your own version and improve it" (the timeline).
  const { App, NORA, choose, scrubTo, $ } = load();
  choose(synthetic(NORA).name);
  const here = App.live.index;
  assert.equal($("when").getAttribute("role"), "status", "at now it only says so");
  scrubTo(here + 7);
  assert.equal($("when").getAttribute("role"), "button");
  assert.equal($("when").title, "Back to now");
  $("when")._listeners.click[0]();
  assert.ok(Math.abs(App.live.time - wall()) < 5, "back at the wall clock");
  assert.equal($("when").textContent, "Now");
});
