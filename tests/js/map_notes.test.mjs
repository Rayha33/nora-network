/* Ray, 29 Oct: "on the map i should be able to add a note to that spesific location on
   the pipeline with arrow pointing to it and then write inside a minimalsistic note
   window". Right-click a line, "Add a note here": a window beside that point of the
   laid route, a hairline arrow to it; kept in this browser. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function storage(initial = {}) {
  const kept = new Map(Object.entries(initial));
  return { getItem: (k) => (kept.has(k) ? kept.get(k) : null), setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k), kept };
}
// A canvas context that records the strokes and fills.
function recorder() {
  const calls = [];
  return { calls, ctx: new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; return true; } }) };
}
const find = (node, test) => (test(node) ? node : (node.children || []).map((c) => (c && typeof c === "object" ? find(c, test) : null)).find(Boolean) || null);

test("map notes: a pipeline's menu offers a note; the point snaps onto the laid route", () => {
  const { App } = loadApp();
  const pid = App.pipeIds[0], items = App.menu.for(pid, { note: () => {} });
  assert.ok(items.some((it) => it.label === "Add a note here"), "Add a note here, on a line");
  assert.ok(!App.menu.for(pid, {}).some((it) => it.label === "Add a note here"), "only where the view can place one");
  // A route from 0°E to 10°E along 60°N, drawn 10 px per degree: a click 3 px off it lands on it.
  const at = App.notes.snap([[0, 60], [10, 60]], ([lon, lat]) => ({ x: lon * 10, y: (60 - lat) * 10 }), 52, 3);
  assert.deepEqual(Array.from(at), [5.2, 60]);
});

test("map notes: a new note opens a window to type in, with an arrow to its point", () => {
  const local = storage();
  const { App, document } = loadApp({ globals: { localStorage: local } });
  const pid = App.pipeIds.find((id) => !App.pipeStyle(id).hidden);
  const container = document.createElement("div");
  container.clientWidth = 800;
  container.clientHeight = 600;
  const layer = App.notes.layer(container), note = App.notes.add(pid, 3, 58);
  const { ctx, calls } = recorder();
  const toScreen = ([lon, lat]) => ({ x: 300 + (lon - 3) * 50, y: 300 - (lat - 58) * 50 });
  const [placed] = layer.draw(ctx, toScreen);
  const card = find(container, (el) => String(el.className || "").includes("map-note-card")), text = find(card, (el) => el.tagName === "TEXTAREA");
  assert.ok(card && text, "a window with a text box");
  assert.deepEqual({ ...placed }, { id: note.id, x: 328, y: 236, hidden: false }, "beside the point, up and to the right");
  assert.ok(calls.some(([op, x, y]) => op === "moveTo" && x === 300 && y === 300), "the arrow's head is on the point");
  text.value = "Valve maintenance at KP 112";
  text._listeners.input[0]();
  assert.equal(JSON.parse(local.kept.get("nora-map-notes"))[0].text, "Valve maintenance at KP 112", "kept in this browser as you type");
  assert.equal(App.notes.list()[0].id, note.id);
});

test("map notes: an empty note or × removes it; a hidden line hides its note", () => {
  const { App, document } = loadApp({ globals: { localStorage: storage() } });
  const pid = App.pipeIds.find((id) => !App.pipeStyle(id).hidden);
  const container = document.createElement("div");
  container.clientWidth = 800;
  container.clientHeight = 600;
  const layer = App.notes.layer(container), toScreen = () => ({ x: 400, y: 300 }), { ctx } = recorder();
  App.notes.add(pid, 3, 58);
  layer.draw(ctx, toScreen);
  let card = find(container, (el) => String(el.className || "").includes("map-note-card"));
  find(card, (el) => el.tagName === "TEXTAREA")._listeners.blur[0]();
  assert.equal(App.notes.list().length, 0, "left empty, it goes");
  const kept = App.notes.add(pid, 3, 58);
  kept.text = "Pig receiver";
  assert.deepEqual(Array.from(layer.draw(ctx, toScreen, () => false), (p) => ({ ...p })), [{ id: kept.id, hidden: true }], "its line hidden or not at this zoom: the window hides too");
  card = container.children[0].children.at(-1); // the newest window
  find(card, (el) => el.tagName === "BUTTON")._listeners.click[0]();
  assert.equal(App.notes.list().length, 0, "× removes it");
  assert.equal(layer.draw(ctx, toScreen).length, 0, "and its window");
});

test("map notes: kept notes come back; ones on lines that no longer exist do not", () => {
  const local = storage({ "nora-map-notes": JSON.stringify([
    { id: "a", pid: "norpipe", lon: 5, lat: 55.5, text: "Kept", dx: 20, dy: -40 },
    { id: "b", pid: "gone_line", lon: 5, lat: 55.5, text: "Lost" },
    { id: "c", pid: "norpipe", lon: "x", lat: 55.5, text: "Bad" },
  ]) });
  const { App } = loadApp({ globals: { localStorage: local } });
  assert.deepEqual(App.notes.list().map((n) => n.text), ["Kept"]);
});
