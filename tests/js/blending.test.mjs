/* The blending stations' picture (Ray, 27 Oct: "when clicking sleipner or draupner we
   need an image showing how the main pipelines go for the gas at those two blending
   stations, from left to right"). The lines come from the payload (blending.py); the
   page places them by the current flow, and every line opens its own page. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

const TITLE = "How gas runs through the Sleipner and Draupner blending stations";
const CAPTION = "Gas enters on the left, is blended at the stations, and leaves on the right.";

// Gas into Sleipner (80), on to Draupner S (40 of it, with 40 from Kårstø) and over the
// bridge to Draupner E (60, with 0 from Kollsnes); the exports take the rest.
const FLOWS = {
  gudrun_sleipner: 10, langeled_north: 30, zeepipe_2a: 40, statpipe_dry: 40, statpipe_heimdal: 0, zeepipe_2b: 0,
  sleipner_draupner: 40, draupner_bridge: 60,
  langeled_south: 30, zeepipe_1: 10, statpipe_ekofisk: 20, europipe_1: 30, franpipe: 30,
};

function withFrame(flows = FLOWS, metrics = {}) {
  const loaded = loadApp();
  const { App } = loaded;
  App.live.frames = [{ t: 1_790_000_000, flows, metrics, plan: null }];
  App.live.index = 0;
  App.live.values = flows;
  App.live.maxAbs = 100;
  return loaded;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
function findSvg(root) {
  let hit = null;
  walk(root, (n) => { if (!hit && /^svg$/i.test(n.tagName || "") && /blending/.test(n.getAttribute ? n.getAttribute("class") || "" : "")) hit = n; });
  return hit;
}

test("the payload names the stations and their lines; the page does not recompute them", () => {
  const { NORA } = loadApp();
  assert.deepEqual(NORA.blending.stations, ["sleipner", "draupner_s", "draupner_e"]);
  assert.deepEqual(NORA.blending.internal, ["draupner_bridge", "sleipner_draupner"]);
  assert.ok(NORA.blending.incoming.includes("zeepipe_2b") && NORA.blending.incoming.includes("statpipe_dry"));
  assert.equal(NORA.blending.outgoing.length, 5);
});

test("stations run left to right in the order the gas flows now, not the CSV's from and to", () => {
  let { App } = withFrame();
  assert.deepEqual([...App.blending.layout().order], ["sleipner", "draupner_s", "draupner_e"]);
  // The gas runs back: Draupner E to S to Sleipner (both links against their CSV direction).
  ({ App } = withFrame({ ...FLOWS, sleipner_draupner: -10, draupner_bridge: -5 }));
  assert.deepEqual([...App.blending.layout().order], ["draupner_e", "draupner_s", "sleipner"]);
  // Draupner S feeds both: it comes first, the other two keep nora.toml's order.
  ({ App } = withFrame({ ...FLOWS, sleipner_draupner: -10, draupner_bridge: 5 }));
  assert.deepEqual([...App.blending.layout().order], ["draupner_s", "sleipner", "draupner_e"]);
});

test("each line sits on the side its current flow says", () => {
  let { App } = withFrame();
  let L = App.blending.layout();
  const ids = (list) => Array.from(list, (l) => l.pid).sort(); // into this realm (the app runs in a vm)
  // (a line without a reading, Gina Krog here, sits where pipelines.csv points it)
  assert.deepEqual(ids(L.left.get("sleipner")), ["gina_krog_sleipner", "gudrun_sleipner", "langeled_north", "zeepipe_2a"]);
  assert.deepEqual(ids(L.right.get("sleipner")), ["langeled_south", "zeepipe_1"]);
  assert.deepEqual(ids(L.right.get("draupner_e")), ["europipe_1", "franpipe"]);
  // Zeepipe I running back into Sleipner: gas in, on the left.
  ({ App } = withFrame({ ...FLOWS, zeepipe_1: -4 }));
  L = App.blending.layout();
  assert.ok(ids(L.left.get("sleipner")).includes("zeepipe_1"));
  assert.equal(L.left.get("sleipner").find((l) => l.pid === "zeepipe_1").v, 4, "its flow as a positive number");
});

test("each station's share to each export follows the gas through the stations after it", () => {
  const { App } = withFrame();
  const shares = (s) => Object.fromEntries(App.blending.layout().shares.get(s));
  assert.deepEqual(shares("draupner_e"), { europipe_1: 0.5, franpipe: 0.5 });
  assert.deepEqual(shares("draupner_s"), { statpipe_ekofisk: 0.25, europipe_1: 0.375, franpipe: 0.375 });
  const s = shares("sleipner");
  assert.equal(s.langeled_south, 0.375);
  assert.equal(s.zeepipe_1, 0.125);
  assert.equal(s.statpipe_ekofisk, 0.125);
  assert.equal(s.europipe_1, 0.1875);
  assert.ok(Math.abs(Object.values(s).reduce((a, b) => a + b, 0) - 1) < 1e-12, "all of its gas goes somewhere");
});

test("the blended H₂S shows only with readings behind it, and says it is an estimate", () => {
  let { App } = withFrame();
  let markup = App.blending.picture("sleipner").innerHTML;
  assert.ok(!markup.includes("estimate"), "no quality data: no blend");
  // Gudrun 10 at 1.0 ppm, Nyhamna 30 at 2.0, Kollsnes 40 at 0.5: (10 + 60 + 20) / 80.
  ({ App } = withFrame(FLOWS, { h2s_ppm: { gudrun: 1.0, nyhamna: 2.0, kollsnes: 0.5 } }));
  const q = App.blending.layout().quality.get("sleipner");
  assert.equal(q.length, 1);
  assert.equal(q[0].name, "h2s_ppm");
  assert.ok(Math.abs(q[0].value - 90 / 80) < 1e-12);
  markup = App.blending.picture("sleipner").innerHTML;
  assert.ok(markup.includes("Blend, estimate"));
  assert.ok(markup.includes("H₂S 1.1 ppm"));
});

test("the picture: straight lines, names escaped, the station highlighted, colour only for an alarm", () => {
  const { App, NORA } = withFrame();
  NORA.assets.zeepipe_1.name = "Zeepipe <img src=x onerror=alert(1)>";
  const node = App.blending.picture("draupner_s");
  const markup = node.innerHTML;
  for (const pid of [...NORA.blending.incoming, ...NORA.blending.internal, ...NORA.blending.outgoing]) {
    assert.ok(markup.includes(`data-asset="${pid}"`), `${pid} is drawn and clickable`);
  }
  for (const s of NORA.blending.stations) assert.ok(markup.includes(`data-asset="${s}"`));
  assert.ok(!markup.includes("<img"), "a crowd-edited name never reaches the SVG as markup");
  assert.ok(markup.includes("&#60;img"));
  assert.ok(!/<path d="M[^"]*[CQAS]/.test(markup) && !markup.includes("<polyline"), "straight lines only");
  assert.ok(markup.includes("paint-order:stroke"), "labels on lines keep a halo");
  assert.ok(markup.includes('font-weight:700">Draupner S'), "the open station in bold");
  const colours = [App.colors.warning, App.colors.medium, App.colors.critical];
  assert.ok(!colours.some((c) => markup.includes(c)), "calm: no alarm colour while nothing is in alarm");
  App.live.levelOf.franpipe = 3;
  const alarmed = App.blending.picture("draupner_s").innerHTML;
  assert.ok(alarmed.includes(App.colors.critical) && alarmed.includes(">Critical<") && alarmed.includes(">1</text>"),
    "an alarm brings its colour, shape, number and word");
  // Every line opens its own page.
  node._listeners.click[0]({ target: { closest: () => ({ getAttribute: () => "zeepipe_1" }) } });
  assert.equal(App.route.screen, "asset");
  assert.equal(App.route.asset, "zeepipe_1");
});

test("the box sits on the stations' pages and their sidebar, and nowhere else", () => {
  const { App, document } = withFrame();
  const screen = document.getElementById("screen-asset");
  for (const id of ["sleipner", "draupner_s", "draupner_e"]) {
    App.go({ screen: "asset", asset: id });
    assert.ok(screen.textContent.includes(TITLE), `${id}: the picture's title`);
    assert.ok(screen.textContent.includes(CAPTION));
    assert.ok(screen.textContent.indexOf(TITLE) < screen.textContent.indexOf("In context"), "above In context");
    assert.ok(findSvg(screen), "with its picture");
  }
  App.go({ screen: "asset", asset: "kollsnes" });
  assert.ok(!screen.textContent.includes(TITLE), "a gas plant has no blending picture");
  App.go({ screen: "unit", unit: "all" });
  App.sidebar.open("draupner_e");
  const side = document.getElementById("side-body");
  assert.ok(side.textContent.includes(TITLE), "the sidebar shows it too");
  assert.ok(findSvg(side));
});
