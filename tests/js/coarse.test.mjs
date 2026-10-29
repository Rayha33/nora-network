/* Daily and monthly datasets in the player (29 Oct, found adding the IUK year). The
   timeline was four hours either side and the scrub moved an hour at a time, so a daily
   dataset (Energinet, IUK) or a monthly one (SODIR) could never leave its first day by
   scrubbing, and at the fastest speed (30 min/s) a day took 48 s to play. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadApp, TEMPLATES } from "./harness.mjs";

// The speeds the page really offers, read from its template.
const SPEEDS = [...readFileSync(`${TEMPLATES}/app.html.j2`, "utf8").matchAll(/<option value="(\d+)">/g)].map((m) => ({ value: m[1] }));

function open(name) {
  const loaded = loadApp();
  const { document, NORA } = loaded;
  document.getElementById("speed").options = SPEEDS;
  const stream = NORA.streams.find((s) => s.name === name);
  assert.ok(stream, `the fixture has the ${name} stream`);
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: name } });
  return loaded;
}
const text = (document, id) => document.getElementById(id).textContent;

test("a daily dataset scrubs a day at a time, four days either way", () => {
  const { App, document } = open("denmark-gas-energinet");
  const scrub = document.getElementById("scrub");
  assert.deepEqual([scrub.min, scrub.max, scrub.step], [String(-4 * 86400), String(4 * 86400), "86400"]);
  assert.deepEqual([text(document, "tl-past"), text(document, "tl-future")], ["−4 d", "+4 d"]);
  const start = App.live.index;
  scrub.value = "172800";
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  assert.equal(App.live.index, start + 2, "two days on");
  const window = App.timelineWindow();
  assert.equal(window.end - window.start, 8 * 86400, "the track shows the eight days around it");
});

test("a monthly dataset shows four months either way", () => {
  const { document } = open("sodir-field-production");
  assert.deepEqual([text(document, "tl-past"), text(document, "tl-future")], ["−4 mo", "+4 mo"]);
});

test("a recorded dataset is not labelled real time; the synthetic week still is", () => {
  assert.equal(text(open("denmark-gas-energinet").document, "tl-now"), "Selected time · UTC");
  const { document } = open("synthetic-week");
  assert.equal(text(document, "tl-now"), "Real time · UTC");
  assert.deepEqual([text(document, "tl-past"), text(document, "tl-future")], ["−4 h", "+4 h"], "hourly data keeps its four hours");
  assert.equal(document.getElementById("scrub").step, "3600");
});

test("a daily dataset plays a day in about a second", () => {
  const { App } = open("denmark-gas-energinet");
  assert.ok(86400 / App.live.speed <= 2, `a day takes ${86400 / App.live.speed} s to play`);
  assert.equal(open("synthetic-week").App.live.speed, 600, "hourly data keeps nora.toml's 10 min/s");
});

test("the scrub says how far it moves, for keyboard and screen reader users", () => {
  const { document } = open("denmark-gas-energinet");
  assert.equal(document.getElementById("scrub").getAttribute("aria-label"), "Move around the selected time: 4 d back or ahead");
});

test("the trend column says the span it draws: hours for hourly data, days for daily", () => {
  const head = (name) => {
    const { App, document } = open(name);
    App.go({ screen: "overview" });
    const heads = [];
    const walk = (n) => { if (n && typeof n === "object") { if (n.className === "head" && /^Last /.test(n.textContent)) heads.push(n.textContent); (n.children || []).forEach(walk); } };
    walk(document.getElementById("screen-overview"));
    return heads[0];
  };
  assert.equal(head("synthetic-week"), "Last 12 h", "twelve hourly readings back");
  assert.equal(head("denmark-gas-energinet"), "Last 12 d", "twelve gas days back");
});
