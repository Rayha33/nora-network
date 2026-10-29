/* Level 4 trends (hub 3614): the exact history behind an asset's values, with its
   limits, a crosshair, a window (2 h / 12 h / 24 h / All, or drag to zoom), a second
   asset to compare, and the window shown as a CSV. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
const all = (root, test) => { const hits = []; walk(root, (n) => { if (test(n)) hits.push(n); }); return hits; };
const find = (root, test) => all(root, test)[0] || null;

function diagnostics() {
  let csv = null;
  class Blob { constructor(parts) { this.text = parts.join(""); } }
  class FakeURL extends URL {
    static createObjectURL(blob) { csv = blob.text; return "blob:nora"; }
    static revokeObjectURL() {}
  }
  const loaded = loadApp({ globals: { Blob, URL: FakeURL } });
  const { App, document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  const scrub = document.getElementById("scrub");
  scrub.value = String(3 * 24 * 3600); // three days in: a long history behind the playhead
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  // An exit point: flow, pressure and its nomination
  const id = App.nodeIds.find((n) => App.live.frames.some((f) => f.metrics.pressure_bar?.[n] != null && f.metrics.nomination_msm3d?.[n] != null));
  App.go({ screen: "diag", asset: id });
  const screen = document.getElementById("screen-diag");
  const charts = () => all(screen, (n) => n.className === "diag-chart");
  const chart = (key) => charts().find((n) => n.getAttribute("data-series") === key);
  const markup = (key) => find(chart(key), (n) => n.tagName === "SVG" || n.tagName === "svg").innerHTML;
  const pointer = (key, type, share) => chart(key)._listeners[type][0]({ offsetX: share * 624, currentTarget: null }); // 720 px less the margins
  return { ...loaded, id, screen, charts, chart, markup, pointer, csv: () => csv };
}

test("diagnostics trends: a chart per reading, with the pressure limits drawn and labelled", () => {
  const { charts, markup } = diagnostics();
  const keys = charts().map((n) => n.getAttribute("data-series"));
  for (const key of ["flow", "pressure_bar", "nomination_msm3d"]) assert.ok(keys.includes(key), `a ${key} chart in ${keys}`);
  assert.match(markup("pressure_bar"), /class="measured"/);
  assert.match(markup("pressure_bar"), />(LL|L|H|HH) \d/, "the limits near the readings are labelled");
});

test("diagnostics trends: the window presets and a drag across a chart narrow what is shown", () => {
  const { App, screen, pointer, markup } = diagnostics();
  const window = () => {
    const [from, to] = [...markup("flow").matchAll(/>([A-Z][a-z]{2} \d\d:\d\d)</g)].map((m) => m[1]);
    return `${from}–${to}`;
  };
  const everything = window();
  find(screen, (n) => n.tagName === "BUTTON" && n.textContent === "2 h")._listeners.click[0]();
  const two = window();
  assert.notEqual(two, everything);
  find(screen, (n) => n.tagName === "BUTTON" && n.textContent === "All")._listeners.click[0]();
  assert.equal(window(), everything);
  pointer("flow", "pointerdown", 0.5);
  pointer("flow", "pointermove", 0.75);
  pointer("flow", "pointerup", 0.75);
  const zoomed = window();
  assert.notEqual(zoomed, everything, "dragged to the last quarter of the history");
  assert.ok(App.live.index > 0);
});

test("diagnostics trends: the crosshair gives the exact values at that hour", () => {
  const { App, id, screen, pointer } = diagnostics();
  assert.match(screen.textContent, /Point at a chart for the exact values/);
  pointer("pressure_bar", "pointermove", 1);
  const last = App.live.frames[App.live.index];
  const row = find(find(screen, (n) => n.className === "data diag-cursor"), (n) => n.tagName === "TBODY").children[0];
  const cells = row.children.map((c) => c.textContent);
  assert.match(cells[0], /UTC/);
  assert.ok(cells.includes(App.fmt(last.metrics.pressure_bar[id], 1)), `pressure ${last.metrics.pressure_bar[id]} in ${cells}`);
});

test("diagnostics trends: compare with another asset, and export the window as CSV", () => {
  const { App, id, screen, markup, csv } = diagnostics();
  const select = find(screen, (n) => n.tagName === "SELECT" && n.getAttribute("aria-label") === "Compare with");
  const other = App.nodeIds.find((n) => n !== id && App.live.frames.some((f) => f.metrics.pressure_bar?.[n] != null));
  select._listeners.change[0]({ target: { value: other } });
  assert.match(markup("pressure_bar"), /class="compare"/, "the second asset is drawn dashed");
  find(screen, (n) => n.tagName === "BUTTON" && n.textContent === "Export CSV")._listeners.click[0]();
  const lines = csv().trim().split("\n");
  assert.match(lines[0], /^time_utc,/);
  assert.ok(lines[0].includes(App.nameOf(other)), "the compared asset has its own columns");
  assert.equal(lines.length - 1, App.live.index + 1, "one row per hour up to the playhead");
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\.000Z,/);
});
