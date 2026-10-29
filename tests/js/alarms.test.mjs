/* One alarm, one priority, one start time (review, 29 Oct). A gas quality slug drawn
   red "1" on the Map and in the Flow was listed as an amber "3" warning in the alarm
   list and the counts, and every alarm in the list showed the playhead's time instead
   of when it began. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, loadPayload } from "./harness.mjs";

const CAPACITY = Object.fromEntries(Object.entries(loadPayload().assets).map(([id, a]) => [id, a.capacity || 0]));

function play(stream = 0) {
  const loaded = loadApp();
  const { document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[stream].name } });
  return loaded;
}
// Move the playhead, through the player's own scrub control.
function scrubSeconds(document, seconds) {
  const scrub = document.getElementById("scrub");
  scrub.value = String(seconds);
  scrub._listeners.input[0]({ target: { value: scrub.value } });
}
const scrubHours = (document, hours) => scrubSeconds(document, hours * 3600);
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

test("a gas quality marker carries the priority its alarm has, at every hour of the week", () => {
  const { App, document } = play();
  scrubHours(document, -400); // clamps to the first frame
  assert.equal(App.live.index, 0);
  const last = App.live.stream.times.length - 1;
  let compared = 0;
  for (let i = 0; i < last; i++) {
    const onMap = App.markers().filter((m) => m.kind === "quality" && m.lead && m.level).map((m) => m.level).sort();
    const listed = App.live.conditions.filter((c) => c.kind === "quality").map((c) => c.level).sort();
    assert.deepEqual(onMap, listed, `hour ${i}: markers ${onMap} but alarm list ${listed}`);
    compared += onMap.length;
    scrubHours(document, 1);
  }
  assert.ok(compared > 50, "the synthetic week has gas quality alarms to compare");
});

test("the alarm list says when an alarm began, not what time it is now", () => {
  const { App, NORA, document } = play();
  const outage = App.live.stream.events.find((e) => !e.planned);
  assert.ok(outage, "the synthetic week has an unplanned outage");
  // Three hours into the outage: the playhead reads 09:00, the outage began at 06:00.
  const target = App.live.stream.times.findIndex((t) => t >= outage.start + 3 * 3600);
  scrubSeconds(document, (target - App.live.playhead) * App.live.stream.step);
  assert.equal(App.live.time, outage.start + 3 * 3600);
  App.go({ screen: "overview" });
  let item = null;
  walk(document.getElementById("screen-overview"), (node) => {
    if (node.tagName === "LI" && node.textContent.includes(outage.label)) item = node;
  });
  assert.ok(item, "the outage is in the alarm list");
  let time = null;
  walk(item, (node) => { if (node.tagName === "TIME") time = node.textContent; });
  assert.match(time, /06:00/, `the outage began at 06:00 UTC, the list says ${time}`);
  assert.ok(NORA.streams[0].events.length > 0);
});

test("an alarm that appears while data arrives keeps the time it began", () => {
  const { App } = loadApp();
  const pid = App.pipeIds.find((id) => CAPACITY[id] > 10);
  const cap = CAPACITY[pid], t0 = 1_800_000_000;
  const frame = (k, share) => App.feed.frame({ t: t0 + k * 3600, values: { [pid]: share * cap }, metrics: {} });
  frame(0, 0.5);
  frame(1, 0.5);
  frame(2, 1.2); // 120 % of capacity: the load alarm begins here
  frame(3, 1.2);
  frame(4, 1.2);
  const load = App.live.conditions.find((c) => c.kind === "load" && c.id === pid);
  assert.ok(load, "the overloaded line is in the alarm list");
  assert.equal(load.since.t, t0 + 2 * 3600, "it began with the third frame");
  assert.equal(load.since.before, false);
});

test("an alarm already active when the data starts is marked as possibly older", () => {
  const { App } = loadApp();
  const pid = App.pipeIds.find((id) => CAPACITY[id] > 10);
  const cap = CAPACITY[pid], t0 = 1_800_000_000;
  App.feed.frame({ t: t0, values: { [pid]: 1.2 * cap }, metrics: {} });
  App.feed.frame({ t: t0 + 3600, values: { [pid]: 1.2 * cap }, metrics: {} });
  const load = App.live.conditions.find((c) => c.kind === "load" && c.id === pid);
  assert.equal(load.since.t, t0, "first seen with the first frame");
  assert.equal(load.since.before, true, "it may have begun before the data did");
});
