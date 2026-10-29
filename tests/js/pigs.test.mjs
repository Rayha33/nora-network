/* Ray, 27 Oct: "i should be able to click a pig to see more information like ETA, tag
   number, if message has been sent to receiving station, last updated ETA sent to
   receiving station etc". A pig's speed follows the gas; NORA writes the (synthetic)
   messages to the receiving station; an ETA that drifts from the last one sent is an
   alarm. The message and alarm rules are stream.py's: tests/data/pig_messages.json holds
   runs both must answer the same way (tests/test_pigs.py reads it too). */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { loadApp } from "./harness.mjs";

const CASES = JSON.parse(fs.readFileSync(new URL("../data/pig_messages.json", import.meta.url), "utf8"));
const HOUR = 3600;

const step = (samples) => (t) => {
  let value = samples[0][1];
  for (const [when, v] of samples) if (when <= t) value = v;
  return value;
};

// The synthetic week, loaded the way the page loads it.
function week() {
  const loaded = loadApp();
  const { App, NORA, document } = loaded;
  document.getElementById("speed").options = [{ value: "600" }];
  const stream = NORA.streams.find((s) => s.synthetic);
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: stream.name } });
  App.state.mode = "live";
  return { ...loaded, stream: App.live.stream };
}
const panel = (document) => `${document.getElementById("side-title").textContent} | ${document.getElementById("side-sub").textContent} | ${document.getElementById("side-body").textContent}`;
const find = (el, ok) => (ok(el) ? el : (el.children || []).map((c) => (c && typeof c === "object" ? find(c, ok) : null)).find(Boolean) || null);

test("pigs: the message schedule matches stream.pig_messages on every shared case", () => {
  const { App } = loadApp();
  for (const c of CASES.cases) {
    const log = App.pigs.pigMessages(c.launch, c.arrival, c.notify, c.checks, step(c.eta), c.receiver);
    assert.deepEqual(JSON.parse(JSON.stringify(log)), c.messages, c.name); // across the vm realm
  }
});

test("pigs: the drift alarm matches stream.pig_alarm on every shared case", () => {
  const { App } = loadApp();
  for (const c of CASES.alarms) {
    const a = App.pigs.pigAlarm(c.now, c.launch, c.arrival, c.notify, c.messages, c.eta_now);
    assert.deepEqual([a.level, a.what, a.drift], [c.level, c.what, c.drift], c.name);
  }
});

test("pigs: speed follows the gas, 0.3 to 1.5 times its set speed", () => {
  const { App } = loadApp();
  const { pigSpeed } = App.pigs;
  assert.equal(pigSpeed(4, 50, 50), 4);
  assert.equal(pigSpeed(4, -25, 50), 2);
  assert.ok(Math.abs(pigSpeed(4, 1, 50) - 1.2) < 1e-9);
  assert.equal(pigSpeed(4, 500, 50), 6);
  assert.equal(pigSpeed(4, undefined, 50), 4);

  const { stream } = week();
  const pig = stream.pigs.find((p) => p.tag === "PIG-LGS-014");
  for (const frame of stream.frames.filter((f) => f.t > pig.launch && f.t < pig.launch + 20 * HOUR)) {
    const place = App.routes.pigPlace(pig, frame.t + 60);
    if (!place) continue;
    const want = pigSpeed(pig.speed, frame.flows[place.pid], stream.typical[place.pid]);
    assert.ok(Math.abs(place.speed - want) < 1e-9, `at ${frame.t}: ${place.speed} m/s, the flow says ${want}`);
  }
});

test("pigs: a run is a pure function of the data, so replay and seek agree", () => {
  const { App, stream } = week();
  const pig = stream.pigs.find((p) => p.tag === "PIG-LGS-014");
  const t = pig.launch + 17.3 * HOUR;
  App.seek(0);
  const r = App.pigs.pigRun(pig, 0);
  const before = { place: App.routes.pigPlace(pig, t), eta: App.pigs.pigEta(pig, r, t), log: App.pigs.pigStatus(pig, r, t).log };
  App.seek(stream.times.length - 1); // throws the worked-out runs away
  const again = App.pigs.pigRun(pig, 0);
  assert.notEqual(again, r, "worked out afresh");
  assert.deepEqual(JSON.stringify(App.routes.pigPlace(pig, t)), JSON.stringify(before.place));
  assert.equal(App.pigs.pigEta(pig, again, t), before.eta);
  assert.equal(JSON.stringify(App.pigs.pigStatus(pig, again, t).log), JSON.stringify(before.log));
  // A receiver set in stream.toml ends the run there.
  assert.equal(again.receiver, "easington");
  assert.equal(again.arrives, again.knots[again.knots.length - 1].t);
});

test("pig panel: tag, kind, pipeline, receiver, ETA and what the receiving station was told", () => {
  const { App, document, stream } = week();
  const pig = stream.pigs.find((p) => p.tag === "PIG-LGS-014");
  App.go({ screen: "unit", unit: "all" });
  App.seek((pig.launch + 13.5 * HOUR - stream.times[0]) / stream.step);
  const marker = App.markers().find((m) => m.kind === "pig" && m.ref === pig);
  assert.ok(marker, "the pig is under way");
  App.selectMarker(marker.key);
  const text = panel(document);
  for (const field of ["PIG-LGS-014", "Cleaning pig", "Pipeline", "Receiver", "Easington", "Messages to Easington (synthetic", "Launch notice", "Last ETA update", "ETA now", "Next update", "Arrival confirmation", "pending"]) {
    assert.ok(text.includes(field), `${field} is in the panel`);
  }
  assert.match(text, /Launch noticesent \d\d:\d\d/, "launch notice sent HH:MM");
  assert.match(text, /Last ETA updatesent \d\d:\d\d \(ETA \d\d:\d\d\)/, "last ETA update sent HH:MM (ETA hh:mm)");
  assert.match(text, /in \d+(\.\d)? h/, "the ETA as a clock and in hours");
  assert.ok(!text.includes("Estimate from the pig's speed"), "no closing note under the panel");
  // The log: launch notice and the 6-hourly updates so far, newest first.
  const log = find(document.getElementById("side-body"), (el) => /pig-log/.test(el.className || "") && el.tagName === "TABLE");
  assert.ok(log, "a message log");
  const rows = find(log, (el) => el.tagName === "TBODY").children;
  assert.equal(rows.length, 3, "launch notice, 6 h and 12 h updates");
  assert.match(rows[rows.length - 1].textContent, /Launch notice/);
  // The pipeline and the receiver are links that open them.
  const receiver = find(document.getElementById("side-body"), (el) => el.attributes && el.getAttribute && el.getAttribute("data-key") === "pig-link:easington");
  assert.ok(receiver, "the receiver is a link");
  receiver._listeners.click[0]();
  assert.equal(document.getElementById("side-title").textContent, "Easington", "it opens the receiver");
});

test("pig panel: the arrival confirmation once the pig is in", () => {
  const { App, stream } = week();
  const pig = stream.pigs.find((p) => p.tag === "PIG-LGS-014");
  const r = App.pigs.pigRun(pig, 0), st = App.pigs.pigStatus(pig, r, r.arrives + 60);
  assert.ok(st.arrival && st.arrival.t === r.arrives, "sent at the arrival");
  assert.equal(st.log[0].kind, "launch");
  assert.equal(st.log[0].t, r.start - 2 * HOUR, "the launch notice two hours before");
  assert.ok(st.log.filter((m) => m.reason === "scheduled").every((m) => (m.t - r.start) % (6 * HOUR) === 0), "updates every 6 hours");
});

test("pig alarms: an ETA that drifts from the last update is in the alarm list", () => {
  const { App, stream } = week();
  // Find a moment in the week with a pig's ETA more than 30 min from the last one sent.
  let hit = null;
  for (let t = stream.times[0]; t < stream.times[stream.times.length - 1] && !hit; t += 900) {
    const c = App.pigs.pigConditions(t);
    if (c.length) hit = { t, c: c[0] };
  }
  assert.ok(hit, "the synthetic week has an ETA drift");
  assert.match(hit.c.text, /^Pig PIG-[A-Z0-9]+-\d{3}: ETA moved [\d.]+ (min|h) (later|earlier) since the last update to /);
  assert.ok([1, 3].includes(hit.c.level), "a warning, or an alarm past 2 hours");
  App.seek((hit.t - stream.times[0]) / stream.step);
  const listed = App.live.conditions.find((c) => c.kind === "pig" && c.text === hit.c.text);
  assert.ok(listed, "evaluate() puts it in the alarm list");
  assert.equal(listed.id, hit.c.id, "on the pig's pipeline");
  assert.ok(App.levelOf(listed.id) >= listed.level, "and in the counts");
  // Within the next half hour the dispatcher sends the update and the alarm clears.
  App.seek((hit.t + 1800 - stream.times[0]) / stream.step);
  assert.ok(!App.live.conditions.find((c) => c.kind === "pig" && c.id === hit.c.id && c.text === hit.c.text), "cleared by the update");
});

test("overview: the pigs under way, each with its ETA and what its receiver was last told", () => {
  const { App, document, stream } = week();
  const pig = stream.pigs.find((p) => p.tag === "PIG-LGS-014");
  App.seek((pig.launch + 13.5 * HOUR - stream.times[0]) / stream.step);
  App.go({ screen: "overview" });
  const box = find(document.getElementById("screen-overview"), (el) => el.tagName === "TABLE" && /\bpigs\b/.test(el.className || ""));
  assert.ok(box, "a Pigs under way table");
  const rows = find(box, (el) => el.tagName === "TBODY").children;
  const mine = rows.find((r) => r.textContent.includes("PIG-LGS-014"));
  assert.ok(mine, "the Langeled pig is listed");
  assert.match(mine.textContent, /Langeled \(south\)Easington \d\d:\d\dETA sent \d\d:\d\d/);
  assert.equal(rows.length, App.markers().filter((m) => m.kind === "pig").length, "one row per pig on the lines");
  mine._listeners.click[0]();
  assert.equal(App.sidebar.marker(), `pig:${pig.label}|${pig.launch}`, "a row opens the pig");
});
