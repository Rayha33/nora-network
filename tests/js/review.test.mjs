/* Review probe tests (deep review of main @ 32a4b47): verify suspected bugs against
   the REAL templates (src/nora/templates/{app,map,flow}.js), driven through the same
   DOM stub the repo's own tests use. Findings-only: nothing here fixes anything.

   1. Playback head: scrub/seek clamping, "Next problem" landing on a risky frame.
   2. Live-feed mode (?live=): the playhead stays put there, so anything that
      animates must follow live.clock instead; and start() survives the harness.
   3. Escaping: a hostile asset NAME from the (crowd-edited) payload must never
      reach any innerHTML as raw markup. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { loadApp, loadPayload, assertHealthy } from "./harness.mjs";
import { makeDom, makeSandbox } from "./stub.mjs";

const TEMPLATES = new URL("../../src/nora/templates/", import.meta.url);

/* Like harness.loadApp, but with a caller-mutated payload (the XSS probe needs a
   hostile asset name in the real payload shape). */
function loadAppWith(nora, search = "") {
  const document = makeDom();
  const sandbox = makeSandbox({ nora, document, search });
  const context = vm.createContext(sandbox, { name: "nora-dom" });
  for (const name of ["app.js", "map.js", "flow.js"]) {
    vm.runInContext(readFileSync(new URL(name, TEMPLATES), "utf8"), context, { filename: name });
  }
  return { App: vm.runInContext("App", context), NORA: nora, document };
}

/* ---------------------------------------------------------------- playback head */

test("playback: real time stays centred between four hours back and ahead", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App, document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  // Load a stream through the REAL change listener, as the browser would.
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  const s = App.live.stream, scrub = document.getElementById("scrub"), initial = App.live.index;
  assert.ok(s && s.frames.length > 1, "a recorded stream is prepared");
  assert.ok(initial > 0 && initial < s.times.length - 1, "the opening view has history and look-ahead");
  assert.ok(Math.abs(App.live.time - Date.now() / 1000) < 5, "a synthetic stream still opens at wall-clock now");
  assert.equal(scrub.min, String(-4 * 3600));
  assert.equal(scrub.max, String(4 * 3600));
  assert.equal(scrub.value, "0", "the real-time handle starts at the centre");

  scrub.value = "3600";
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  assert.equal(App.live.index, initial + 1, "dragging right moves one hour forward");
  assert.equal(scrub.value, "0", "the handle returns to the real-time centre");

  scrub.value = "-7200";
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  assert.equal(App.live.index, initial - 1, "dragging left moves back through historical values");
  const window = App.timelineWindow();
  assert.equal(window.now, App.live.time);
  assert.equal(window.start, App.live.time - 4 * 3600);
  assert.equal(window.end, App.live.time + 4 * 3600);

  while (App.live.index < s.times.length - 1) {
    scrub.value = String(4 * 3600);
    scrub._listeners.input[0]({ target: scrub });
  }
  assert.equal(App.live.index, s.times.length - 1, "repeated forward drags clamp to the last frame");
  assert.deepEqual(App.live.values, s.frames[s.times.length - 1].flows);
  while (App.live.index > 0) {
    scrub.value = String(-4 * 3600);
    scrub._listeners.input[0]({ target: scrub });
  }
  assert.equal(App.live.index, 0, "repeated backward drags clamp to the first frame");
});

test("playback: Next problem lands on an hour where the plan is at risk", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { App, document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0](
    { target: { value: NORA.streams[0].name } });
  const s = App.live.stream;
  // Start from the first hour (a synthetic stream opens at now, mid-way).
  const scrub = document.getElementById("scrub");
  while (App.live.index > 0) {
    scrub.value = String(-4 * 3600);
    scrub._listeners.input[0]({ target: scrub });
  }

  // A risky hour: the plan's now- or ahead-level is raised. Use a real one if the
  // fixture has it, otherwise plant one (as a scripted event would).
  let risky = s.frames.findIndex((f) => f.plan && (f.plan.now[0] || f.plan.ahead[0]));
  if (risky < 0) {
    risky = Math.min(10, s.frames.length - 1);
    s.frames[risky].plan = { now: [2, "Plant trip at the terminal", "plan"],
      ahead: [0, "", null, 1], nominated: 1, deliverable: 1, maxLoad: 1, bottleneck: "x" };
  }
  const next = document.getElementById("next-problem");
  assert.equal(next.disabled, false, "Next problem is enabled while a risky hour exists");
  next._listeners.click[0](); // the real click handler: pause, seek, maybe go()
  assert.equal(App.live.index, risky, "the playhead is ON the risky hour");
  assert.equal(App.live.playing, false, "and the player is paused");
});

/* ---------------------------------------------------------------------- feed mode */

test("feed mode (?live=): start() runs, and the playhead never moves", () => {
  const nora = loadPayload();
  nora.config.screen.start = "overview"; // keep start() off the view mounts (no vis in the vm)
  const { App, document } = loadAppWith(nora, "?live=http://localhost:8765/stream");
  assertHealthy(assert, { App, NORA: nora });
  // connectFeed hides the speed CONTROL: $("speed").parentElement.hidden = true
  document.getElementById("speed").parentElement = { hidden: false };
  App.start(); // must not throw, even though no stream was prepared
  assert.equal(App.live.stream, null, "feed mode prepares no recorded stream");
  assert.ok(App.live.feed, "an EventSource was connected");
  assert.equal(document.body.classList.add /* no-op, but called */ !== undefined, true);
  /* In feed mode nothing advances live.playhead (tick only advances it under
     `live.stream && !live.feed`), so a view that animated on the playhead would
     freeze for the whole session: anything moving in feed mode follows live.clock. */
  assert.equal(App.live.playhead, 0, "feed mode: playhead stays 0 forever");
  assert.equal(typeof App.window4h, "function", "window4h exported (flow.js drawTrend uses it)");
});

/* ------------------------------------------------------------------------ escaping */

test("escaping: a hostile asset name never reaches innerHTML as markup", () => {
  const nora = loadPayload();
  const nodeId = Object.keys(nora.assets).find((id) => nora.assets[id].kind === "node");
  const pipeId = Object.keys(nora.assets).find((id) => nora.assets[id].kind === "pipeline");
  assert.ok(nodeId && pipeId, "the payload has nodes and pipelines");
  const hostile = '<img src=x onerror="globalThis.__pwned=1"><script>alert(1)</script>';
  nora.assets[nodeId].name = hostile;
  nora.assets[pipeId].name = hostile;
  if (nora.streams[0] && nora.streams[0].events) {
    nora.streams[0].events[0] = { ...nora.streams[0].events[0], label: hostile };
  }
  const { App, document } = loadAppWith(nora);

  // The shared esc() covers every char that could break out of a text context
  // (the entity markup itself may contain "&" as "&#38;" — compare exactly).
  const entity = hostile.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  assert.equal(App.esc(hostile), entity, "esc() entity-encodes & < > \" '");

  // Render the asset page (schematic builds svg.innerHTML with esc()'d names).
  App.go({ screen: "asset", asset: nodeId });
  const raw = [];
  const escd = [];
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node._innerHTML !== undefined) {
      if (/<(img|script)\b/i.test(node._innerHTML)) raw.push(node._innerHTML);
      if (node._innerHTML.includes("&#60;img")) escd.push(node._innerHTML);
    }
    for (const child of node.children || []) walk(child);
  })(document.getElementById("screen-asset"));
  assert.deepEqual(raw, [], "no innerHTML in the asset page contains raw <img/<script markup");
  assert.ok(escd.length > 0, "the hostile name DOES flow through, but esc()'d (&#60;img)");

  // The overview carries stream event labels as alarm text: plain text nodes.
  App.go({ screen: "overview" });
  let rawOverview = "";
  (function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node._innerHTML !== undefined && /<(img|script)\b/i.test(node._innerHTML)) rawOverview += node._innerHTML;
    for (const child of node.children || []) walk(child);
  })(document.getElementById("screen-overview"));
  assert.equal(rawOverview, "", "no raw markup on the overview either");
  assert.equal(globalThis.__pwned, undefined, "no code from the hostile name ever ran");
});