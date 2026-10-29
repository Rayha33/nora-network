/* Control-room display profiles (issue #59): the profile and the one UI scale come
   from the window, unless ?display= / ?scale= (or Settings) say otherwise. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { TEMPLATES, loadPayload, assertHealthy } from "./harness.mjs";
import { makeDom, makeSandbox } from "./stub.mjs";

function load({ width = 1280, search = "", stored = {} } = {}) {
  const nora = loadPayload();
  const document = makeDom();
  const sandbox = makeSandbox({ nora, document, search });
  sandbox.window.innerWidth = width;
  for (const [key, value] of Object.entries(stored)) sandbox.window.localStorage.setItem(key, value);
  const context = vm.createContext(sandbox, { name: "nora-dom" });
  for (const name of ["app.js", "map2d.js", "map.js", "flow.js"]) {
    vm.runInContext(readFileSync(path.join(TEMPLATES, name), "utf8"), context, { filename: name });
  }
  const App = vm.runInContext("App", context);
  assertHealthy(assert, { App, NORA: nora });
  return { App, NORA: nora, document };
}

test("auto: the window picks the profile and the scale", () => {
  const cases = [
    [390, "compact", 1], [768, "compact", 1], [1366, "desk", 1], [1920, "desk", 1],
    // A wall's scale comes from nora.toml's reading distance (5 m) and picture width
    // (4 m): capitals of about 20 arcmin (review #49802: × 1.5 read to about 1.5 m).
    [2560, "desk", 1.17], [3840, "wall", 3.1], [7680, "wall", 4], [10000, "wall", 4],
  ];
  for (const [width, profile, scale] of cases) {
    const { App } = load({ width });
    assert.equal(App.display(), profile, `${width} px is a ${profile}`);
    assert.equal(App.uiScale(), scale, `${width} px: scale ${scale}`);
  }
});

test("a wall is large and dark unless the operator chose a theme", () => {
  const wall = load({ width: 1920, search: "?display=wall" });
  assert.equal(wall.App.display(), "wall");
  assert.ok(wall.App.uiScale() >= 1.5, "readable from metres away: at least 150 %");
  assert.equal(wall.document.documentElement.dataset.theme, "dark");
  assert.equal(wall.App.colors.card.inactive.ink, wall.App.colors.text, "dark-gray nodes use light primary text");
  assert.equal(wall.App.colors.card.inactive.dim, wall.App.colors.text, "secondary text inside dark-gray nodes is just as bright as primary text");
  const chosen = load({ width: 3840, stored: { "nora-theme": "light" } });
  assert.equal(chosen.App.display(), "wall");
  assert.equal(chosen.document.documentElement.dataset.theme, "light", "the operator's choice wins");
  const desk = load({ width: 1920 });
  assert.equal(desk.document.documentElement.dataset.theme, "light");
});

test("?scale= and Settings override the scale; nonsense falls back to auto", () => {
  assert.equal(load({ search: "?scale=150" }).App.uiScale(), 1.5, "per cent");
  assert.equal(load({ search: "?scale=1.25" }).App.uiScale(), 1.25, "a factor");
  assert.equal(load({ search: "?scale=banana" }).App.uiScale(), 1);
  assert.equal(load({ search: "?scale=40" }).App.uiScale(), 1, "below 75 % is refused");
  const saved = load({ stored: { "nora-settings": JSON.stringify({ scale: "1.75", display: "desk" }) }, width: 3840 });
  assert.equal(saved.App.display(), "desk", "Settings pick the profile");
  assert.equal(saved.App.uiScale(), 1.75, "and the size");
  assert.equal(load({ search: "?display=compact", width: 3840 }).App.display(), "compact");
});

test("exit nominations: six hourly bars with hour-only labels", () => {
  const { App, NORA } = load();
  const id = "dunkirk", stream = NORA.streams[0], block = stream.metrics.nomination_msm3d;
  const column = block.assets.indexOf(id);
  assert.ok(column >= 0, "the fixture has an exit nomination series");
  App.live.stream = stream;
  App.live.frames = stream.times.slice(0, 6).map((t, i) => ({ t, flows: {}, metrics: { nomination_msm3d: { [id]: block.values[i][column] } }, plan: null }));
  App.live.index = 0;
  App.live.time = stream.times[0];
  const series = App.nominationWindow(id);
  assert.equal(series.length, 6);
  for (let k = 1; k < series.length; k++) assert.equal(series[k].t - series[k - 1].t, 3600, "one bar per hour");
  const chart = App.nominationHistogram(id).innerHTML;
  assert.equal((chart.match(/class="nomination-bar"/g) || []).length, 6);
  for (const reading of series) {
    const hour = String(new Date(reading.t * 1000).getUTCHours()).padStart(2, "0");
    assert.ok(chart.includes(`>${hour}</text>`), `hour ${hour} is labelled`);
  }
  assert.ok(!chart.includes(":00"), "hour labels do not repeat minutes");
});

/* Ray, 29 Oct: "in this view we also need booking hourly level so see if the hourly
   nomination level is above or below. if its above it should have some color like
   yellow or red but not strong color"; "two bars next to eachother for each hour". */
test("the next 6 hours: booking and nomination side by side, over booking in a muted colour", () => {
  const { App } = load();
  const id = "dunkirk", t0 = 1_790_000_000, noms = [40, 41, 49.5, 52, 45, 40], booked = 49;
  App.live.frames = noms.map((n, i) => ({ t: t0 + i * 3600, flows: {}, metrics: { nomination_msm3d: { [id]: n }, booked_msm3d: { [id]: booked } }, plan: null }));
  App.live.index = 0;
  App.live.time = t0;
  const chart = App.nominationHistogram(id).innerHTML;
  assert.equal((chart.match(/class="booking-bar"/g) || []).length, 6, "a booking bar each hour");
  assert.equal((chart.match(/class="nomination-bar( over)?"/g) || []).length, 6, "a nomination bar each hour");
  assert.equal((chart.match(/class="nomination-bar over"/g) || []).length, 2, "the two hours over 49 booked");
  const fills = [...chart.matchAll(/class="nomination-bar over"[^>]*fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  assert.notEqual(fills[0], fills[1], "just over is yellow; 6 % over is red");
  for (const fill of fills) {
    assert.ok(![App.colors.warning, App.colors.critical].includes(fill), "muted, not the strong alarm colours");
  }
  assert.match(chart, />Booked</);
});

test("the scale reaches the page as --ui-scale and a data-display attribute", () => {
  const props = {};
  const nora = loadPayload();
  const document = makeDom();
  document.documentElement.style = { setProperty: (k, v) => { props[k] = v; } };
  const sandbox = makeSandbox({ nora, document, search: "?scale=2" });
  const context = vm.createContext(sandbox, { name: "nora-dom" });
  vm.runInContext(readFileSync(path.join(TEMPLATES, "app.js"), "utf8"), context, { filename: "app.js" });
  assert.equal(props["--ui-scale"], "2");
  assert.equal(document.documentElement.dataset.display, "desk");
});

/* Ray, 29 Oct: "everything here should be on one line". The bar keeps one row while it
   fits; the UI scale zooms it, so the room is judged at that scale. */
test("the bar is one row while it fits at its UI scale", () => {
  const bar = (options) => load(options).document.documentElement.dataset.bar;
  assert.equal(bar({ width: 1920 }), "one");
  assert.equal(bar({ width: 1366 }), "one", "a laptop desk keeps one row");
  assert.equal(bar({ width: 1200 }), "tight", "tighter: the wordmark goes, the mark stays");
  assert.equal(bar({ width: 1440, search: "?scale=150" }), "two", "960 px of room at 1.5: the switches wrap");
  assert.equal(bar({ width: 3840 }), "tight", "a 4K wall at 3.1: one row, without the wordmark");
});

/* Ray, 29 Oct: "hourly nominations from the shippers at each exitpoint ... in both
   absolute numbers but in a visual minimalistic way. what is important are rate of
   change at each exit point for the next 6 hours". */
test("nominations: the next 6 hours at an exit point, with its steepest hourly change", () => {
  const { App } = load({ width: 1440 });
  const values = [10, 10, 13, 13, 12, 12];
  App.live.stream = { step: 3600 };
  App.live.frames = values.map((v, k) => ({ t: 3600 * k, flows: {}, metrics: { nomination_msm3d: { emden: v } }, plan: null }));
  App.live.index = 0;
  const ramp = App.rampAhead("emden");
  assert.equal(ramp.now, 10);
  assert.equal(ramp.last, 12, "in six hours");
  assert.equal(ramp.steepest.change, 3, "the steepest hourly change");
  assert.equal(ramp.steepest.t, 7200, "and when it starts");
  assert.equal(ramp.level, 2, "30% of the nomination in an hour is a fast ramp (step thresholds)");
  App.live.frames = [10, 10.2, 10.1, 10, 10, 10].map((v, k) => ({ t: 3600 * k, flows: {}, metrics: { nomination_msm3d: { emden: v } }, plan: null }));
  assert.equal(App.rampAhead("emden").level, 0, "a small change is no alarm");
});

/* Ray, 29 Oct: "the end of day target to exit points changes over time and this need to
   be illustrated as well". The day bar keeps a faint trail of where the day stood at each
   earlier hour; the panel charts the gas day: nominated (dashed, to the end-of-day target)
   against delivered (solid, up to now). */
test("gas day: a trail of earlier hours on the bar, and the day's chart in the panel", () => {
  const { App } = load();
  const id = "dunkirk", day0 = 20_718 * 86_400 + 5 * 3600; // 05:00 UTC, a gas day's start
  const delivered = [40, 41, 39, 44, 45], nominated = [40, 40, 40, 40, 40];
  App.live.frames = delivered.map((d, i) => ({
    t: day0 + i * 3600, plan: null, flows: { franpipe: d }, metrics: { nomination_msm3d: { [id]: nominated[i] } },
  }));
  for (let k = 5; k < 30; k++) App.live.frames.push({ t: day0 + k * 3600, plan: null, flows: {}, metrics: { nomination_msm3d: { [id]: 42 } } });
  App.live.index = 4;
  App.live.time = day0 + 4 * 3600;
  const day = App.dayDelivery(id);
  assert.equal(day.trail.length, 4, "one mark for each earlier hour");
  assert.ok(Math.abs(day.share - (209 - 200) / 200) < 1e-9, "the day so far: 209 of 200");
  const chart = App.gasDayChart(id).innerHTML;
  assert.match(chart, /class="gasday-nominated"/);
  assert.match(chart, /class="gasday-delivered"/);
  const target = (5 * 40 + 19 * 42) / 24; // five hours at 40, the rest of the day at 42, in MSm³
  assert.ok(chart.includes(`Target ${App.fmt(target, 1)}`), "the end-of-day target, from the day's nominations");
  assert.match(chart, /now [\d.]+ of [\d.]+/);
});
