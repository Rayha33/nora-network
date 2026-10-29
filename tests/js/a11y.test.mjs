/* Hub 3615: usable without a mouse, without sight of the canvases, and without motion.
   A skip link to the alarms; new alarms announced to a screen reader at most once per
   hour of data; the Map and Flow assets as a list with their state; with reduced motion
   nothing plays by itself and markers move in the data's own steps. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, loadPayload } from "./harness.mjs";

const CAPACITY = Object.fromEntries(Object.entries(loadPayload().assets).map(([id, a]) => [id, a.capacity || 0]));
const T0 = 1_800_000_000;
function overload(App, pid, k, share) { App.feed.frame({ t: T0 + k * 3600, values: { [pid]: share * CAPACITY[pid] }, metrics: {} }); }

test("a11y: the skip link opens the alarm list and puts focus in it", () => {
  const { document } = loadApp();
  const skip = document.getElementById("skip-alarms");
  assert.ok(skip, "the page starts with a skip link");
  let prevented = false;
  skip._listeners.click[0]({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
  assert.equal(document.getElementById("alarms").hidden, false, "the list is open");
  assert.equal(document.getElementById("alarms").getAttribute("tabindex"), "-1", "and can take focus");
});

test("a11y: new alarms are announced, at most once per hour of data", () => {
  const { App, document } = loadApp();
  const [a, b] = App.pipeIds.filter((id) => CAPACITY[id] > 10);
  const said = () => document.getElementById("announce").textContent;
  overload(App, a, 0, 0.5);
  overload(App, a, 1, 1.2);
  assert.match(said(), /^\d+ new alarms?\. Critical, priority 1: .* of capacity/);
  const first = said();
  App.feed.frame({ t: T0 + 1.5 * 3600, values: { [a]: 1.2 * CAPACITY[a], [b]: 1.2 * CAPACITY[b] }, metrics: {} });
  assert.equal(said(), first, "half an hour later: still the same message");
  App.feed.frame({ t: T0 + 2.5 * 3600, values: { [a]: 1.2 * CAPACITY[a], [b]: 1.2 * CAPACITY[b] }, metrics: {} });
  assert.notEqual(said(), first, "an hour on, the new one is announced");
  assert.ok(said().includes(App.nameOf(b)));
});

test("a11y: the view's assets as a list, with their state", () => {
  const { App, document } = loadApp();
  const a = App.pipeIds.find((id) => CAPACITY[id] > 10);
  App.go({ screen: "unit", unit: "all" });
  overload(App, a, 0, 0.5);
  const list = document.getElementById("view-list");
  assert.match(list.textContent, /assets/);
  assert.match(list.textContent, /: normal/);
});

test("a11y: with reduced motion nothing plays by itself, and time moves in whole steps", () => {
  const matchMedia = (q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const { App, document, NORA } = loadApp({ globals: { matchMedia } });
  assert.equal(App.reduceMotion, true);
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  assert.equal(App.live.playing, false, "no autoplay");
  const s = App.live.stream, scrub = document.getElementById("scrub");
  scrub.value = String(s.step * 0.5); // half a step on
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  assert.equal(App.live.time, s.times[App.live.index], "the time shown is a step's own");
});
