/* Ray, 30 Oct: "look for improvements" / "fix all". Found walking every screen in WebKit:
   limit labels written over each other on the diagnostics charts, an alarm's word on a
   flow in the blending picture and its names cut short with room to spare, the asset
   page's buttons touching, and "A synthetic week (synthetic)". */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadApp } from "./harness.mjs";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
const all = (root, ok) => { const hits = []; walk(root, (n) => { if (ok(n)) hits.push(n); }); return hits; };
const textsOf = (markup) => [...markup.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"([^>]*)>([^<]*)<\/text>/g)]
  .map(([, x, y, attrs, words]) => ({ x: Number(x), y: Number(y), end: attrs.includes('text-anchor="end"'), words }));

test("diagnostics: close pressure limits (H 160, HH 168, INT 175) are labelled without one over another", () => {
  const { App, document, NORA } = loadApp();
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  const scrub = document.getElementById("scrub");
  scrub.value = String(5 * 24 * 3600);
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  App.go({ screen: "diag", asset: "gudrun" });
  const chart = all(document.getElementById("screen-diag"), (n) => n.className === "diag-chart").find((n) => n.getAttribute("data-series") === "pressure_bar");
  const svg = all(chart, (n) => /^svg$/i.test(n.tagName || ""))[0];
  const labels = textsOf(svg.innerHTML).filter((t) => /^(LL|L|H|HH|INT) \d/.test(t.words));
  assert.ok(labels.length >= 2, `limits labelled: ${labels.map((l) => l.words)}`);
  const box = (l) => [l.end ? l.x - l.words.length * 6.2 : l.x, l.y - 9, l.end ? l.x : l.x + l.words.length * 6.2, l.y + 2];
  for (const a of labels) for (const b of labels) {
    if (a === b) continue;
    const [p, q] = [box(a), box(b)];
    assert.ok(!(p[0] < q[2] && p[2] > q[0] && p[1] < q[3] && p[3] > q[1]), `"${a.words}" and "${b.words}" overlap`);
  }
});

test("blending picture: an alarm's word on the last station's line clears the flow beside it; names in full", () => {
  const flows = { gudrun_sleipner: 10, langeled_north: 30, zeepipe_2a: 40, statpipe_dry: 40, statpipe_heimdal: 0, zeepipe_2b: 0,
    sleipner_draupner: 40, draupner_bridge: 60, langeled_south: 30, zeepipe_1: 10, statpipe_ekofisk: 20, europipe_1: 30, franpipe: 55 };
  const { App, NORA } = loadApp();
  App.live.frames = [{ t: 1_790_000_000, flows, metrics: {}, plan: null }];
  App.live.index = 0;
  App.live.values = flows;
  App.live.maxAbs = 100;
  App.live.levelOf = { ...App.live.levelOf, franpipe: 1 }; // a warning on Franpipe, as seen live
  const markup = App.blending.picture("draupner_e").innerHTML, texts = textsOf(markup);
  const word = texts.find((t) => t.words === "Warning");
  assert.ok(word, "Franpipe carries its warning");
  const flow = texts.find((t) => t.words === "55.0");
  assert.ok(flow, "and its flow");
  assert.ok(word.x + "Warning".length * 6.2 < flow.x, `the word ends (${word.x + 43}) before the flow begins (${flow.x})`);
  for (const pid of ["statpipe_ekofisk", "statpipe_dry"]) assert.ok(markup.includes(`>${NORA.assets[pid].name}<`), `${NORA.assets[pid].name} in full`);
});

test("asset page: its buttons sit apart; a dataset is called synthetic once", () => {
  const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");
  assert.match(css, /#screen-asset \.actions \{[^}]*gap: 8px/, "a gap between the asset page's buttons");
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "600" }];
  App.start();
  const options = document.getElementById("stream-select").children.map((o) => o.textContent);
  for (const s of NORA.streams.filter((x) => x.synthetic)) {
    const label = options.find((o) => o.startsWith(s.title));
    assert.equal((label.match(/synthetic/gi) || []).length, 1, `"${label}" says synthetic once`);
  }
});

test("overview: a long name in a values table wraps, never cut short", () => {
  const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");
  const rule = css.match(/\.bank \.name \{([^}]*)\}/)[1];
  assert.doesNotMatch(rule, /ellipsis|nowrap/, `.bank .name {${rule}}`);
});
