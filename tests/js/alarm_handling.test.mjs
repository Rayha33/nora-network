/* Alarm handling (hub 3612, ISA-18.2 style): an operator acknowledges an alarm, and
   can shelve one for a while with a reason. An acknowledged alarm dims; when it clears
   and comes back it is unacknowledged again. A shelved alarm leaves the counts and the
   views until its time is up. Both survive a reload, in this browser only. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, loadPayload } from "./harness.mjs";

const CAPACITY = Object.fromEntries(Object.entries(loadPayload().assets).map(([id, a]) => [id, a.capacity || 0]));
const T0 = 1_800_000_000;

// A browser's storage that outlives one page load.
function storage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), clear: () => data.clear() };
}
// A line run over its capacity from the third hour: a load alarm, and a flow-peak alarm
// for the step itself.
function overloaded(localStorage = storage()) {
  const loaded = loadApp({ globals: { localStorage } });
  const pid = loaded.App.pipeIds.find((id) => CAPACITY[id] > 10);
  const frame = (k, share) => loaded.App.feed.frame({ t: T0 + k * 3600, values: { [pid]: share * CAPACITY[pid] }, metrics: {} });
  frame(0, 0.5);
  frame(1, 0.5);
  frame(2, 1.2);
  frame(3, 1.2);
  const alarm = () => loaded.App.live.conditions.find((c) => c.kind === "load" && c.id === pid) || null;
  const onLine = () => loaded.App.live.conditions.filter((c) => c.id === pid);
  return { ...loaded, pid, frame, alarm, onLine, localStorage };
}
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
const find = (root, test) => { let hit = null; walk(root, (n) => { if (!hit && test(n)) hit = n; }); return hit; };
const click = (button) => button._listeners.click[0]({ stopPropagation() {} });

test("alarm handling: Ack in the Overview acknowledges the alarm and stays on the Overview", () => {
  const { App, document, onLine } = overloaded();
  App.go({ screen: "overview" });
  assert.deepEqual(Array.from(onLine(), (c) => c.acked), [false, false], "raised unacknowledged");
  const overview = document.getElementById("screen-overview");
  const summary = () => find(overview, (n) => n.className === "alarm-summary").textContent;
  assert.match(summary(), /^2 unacknowledged, oldest/);
  const ack = find(overview, (n) => n.tagName === "BUTTON" && n.className === "ack" && n.textContent === "Ack");
  assert.ok(ack, "each unacknowledged alarm has an Ack button");
  click(ack);
  assert.equal(onLine().filter((c) => c.acked).length, 1);
  assert.equal(App.route.screen, "overview", "acknowledging never opens the asset under the button");
  assert.match(summary(), /^1 unacknowledged/);
  click(find(overview, (n) => n.tagName === "BUTTON" && n.textContent === "Acknowledge all"));
  assert.match(summary(), /All acknowledged/);
  const counts = document.getElementById("alarm-counts");
  assert.ok(find(counts, (n) => n.className === "acked"), "the count dims once all of its level is acknowledged");
});

test("alarm handling: an alarm that clears and comes back is unacknowledged again", () => {
  const { App, frame, alarm } = overloaded();
  App.alarmHandling.ack([alarm()]);
  frame(4, 1.2);
  assert.equal(alarm().acked, true, "still the same occurrence");
  frame(5, 0.5);
  assert.equal(alarm(), null, "cleared");
  frame(6, 1.2);
  assert.equal(alarm().acked, false, "a new occurrence");
});

test("alarm handling: a shelved alarm leaves the counts and views until its time is up", () => {
  const { App, frame, alarm, onLine, pid } = overloaded();
  const now = Date.now();
  for (const c of onLine()) App.alarmHandling.shelve(c, "Maintenance", 1, now);
  frame(4, 1.2);
  assert.equal(alarm(), null, "out of the active list");
  assert.equal(App.levelOf(pid), 0, "no badge on the line in the views");
  const shelved = App.live.shelved.find((c) => c.kind === "load" && c.id === pid);
  assert.equal(shelved.shelf.reason, "Maintenance");
  assert.equal(shelved.shelf.until, now + 3600e3);
  App.alarmHandling.shelve(shelved, "Maintenance", 1, now - 2 * 3600e3); // shelved two hours ago
  frame(5, 1.2);
  assert.ok(alarm(), "back by itself at the expiry");
  assert.ok(!App.live.shelved.some((c) => c.kind === "load"));
});

test("alarm handling: the alarm list shelves with a reason and a time, and unshelves", () => {
  const { App, document, alarm, pid } = overloaded();
  const panel = document.getElementById("alarms");
  panel.hidden = false; // opened from the counts in the top bar
  App.buildAlarms();
  const shelve = () => find(panel, (n) => n.tagName === "BUTTON" && n.textContent === "Shelve");
  assert.ok(shelve(), "each alarm has Shelve");
  click(shelve()); // the first row's
  const reason = find(panel, (n) => n.tagName === "SELECT" && n.getAttribute && n.getAttribute("aria-label") === "Reason");
  const hours = find(panel, (n) => n.tagName === "SELECT" && n.getAttribute && n.getAttribute("aria-label") === "For");
  assert.ok(reason && hours, "Shelve asks why and for how long");
  reason.value = "Nuisance";
  hours.value = "8";
  click(shelve());
  assert.equal(alarm(), null);
  assert.match(panel.textContent, /Shelved · 1/);
  assert.match(panel.textContent, /Nuisance/);
  assert.equal(App.live.shelved[0].shelf.until - App.live.shelved[0].shelf.since, 8 * 3600e3);
  click(find(panel, (n) => n.tagName === "BUTTON" && n.textContent === "Unshelve"));
  assert.ok(App.live.conditions.some((c) => c.id === pid), "back in the active list");
});

test("alarm handling: acknowledgements and shelves survive a reload", () => {
  const first = overloaded();
  first.App.alarmHandling.ack([first.alarm()]);
  const second = overloaded(first.localStorage);
  assert.equal(second.alarm().acked, true, "the same occurrence, acknowledged before the reload");
  second.App.alarmHandling.shelve(second.alarm(), "Known cause", 12);
  const third = overloaded(first.localStorage);
  assert.equal(third.alarm(), null);
  assert.equal(third.App.live.shelved[0].shelf.reason, "Known cause");
});
