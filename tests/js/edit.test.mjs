/* The network editor (Ray, 29 Oct): "there should be a editing version of the flow map
   where i can add nodes, remove nodes, connect edges and remove edges"; "i should be
   able to right click to remove a node, i should also be able to add a new node and
   attach it where i want". Edits are steps kept in the browser and applied to NORA
   when the page loads; Save turns them into the data files. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";
import { STEPS, editedApp, storage } from "./edits.mjs";

test("edits: applied before anything reads the network", () => {
  const { App, NORA } = editedApp();
  assert.ok(!App.nodeIds.includes("gudrun"), "the removed node is gone");
  assert.ok(!App.pipeIds.includes("gudrun_sleipner"), "and its lines with it");
  assert.ok(!App.pipeIds.includes("ogt"), "a removed line is gone");
  assert.ok(App.nodeIds.includes("kveikje") && App.pipeIds.includes("kveikje_statfjord"), "the new node and its line are in");
  assert.deepEqual(Array.from(NORA.grid.kveikje), [1, 2.5], "placed where the Flow view was clicked");
  assert.ok(NORA.units.find((u) => u.id === "northern_north_sea").nodes.includes("kveikje"), "in the unit chosen for it");
  assert.ok(!NORA.units.some((u) => u.nodes.includes("gudrun")), "the removed node left its unit");
  assert.ok(NORA.geo.nodes.features.some((f) => f.properties.asset === "kveikje"), "the Map has it");
  assert.ok(!NORA.geo.pipes.features.some((f) => f.properties.asset === "ogt"), "and not the removed line");
  assert.equal(NORA.assets.kveikje.supply, true, "a field supplies the network (the what-if counts it)");
  assert.deepEqual(Array.from(NORA.grid.sleipner), [3, 5.25], "a dragged node keeps its place");
  assert.equal(NORA.assets.statfjord.name, "Statfjord A", "a node renamed in its form");
  assert.ok(NORA.units.find((u) => u.id === "hubs").nodes.includes("statfjord") && !NORA.units.find((u) => u.id === "northern_north_sea").nodes.includes("statfjord"), "and moved to its new unit");
  assert.ok(NORA.units.find((u) => u.id === "hubs").pipelines.includes("statpipe_rich"), "with the lines it sends gas into");
  assert.equal(NORA.geo.nodes.features.find((f) => f.properties.asset === "statfjord").properties.name, "Statfjord A", "the Map has the new name");
  assert.equal(NORA.assets.europipe_1.bidirectional, true, "a line changed in its form");
  assert.equal(NORA.assets.europipe_1.km, 661, "its markers move by the new length");
  assert.equal(App.edit.list().length, 7, "a step that no longer applies is dropped");
});

test("edits: right-click offers remove, connect and add", () => {
  const { App, NORA } = loadApp();
  App.state.mode = "edit";
  const node = App.menu.for("sleipner", { connect: () => {} }).map((item) => item.label);
  assert.ok(node.includes("Connect to another node…") && node.includes("Remove from the network"));
  assert.ok(!App.menu.for("sleipner").map((item) => item.label).includes("Connect to another node…"), "connect only where it can be done (the Flow view)");
  const pid = App.pipeIds[0];
  assert.ok(App.menu.for(pid).map((item) => item.label).includes("Remove this line"));
  assert.deepEqual(Array.from(App.edit.canvasMenu({ grid: [2, 3], near: "sleipner" }), (item) => item.label), ["Add a node here"]);
  assert.ok(NORA.sources["nodes.csv"].startsWith("id,name,type"), "the page carries the files to edit");
});

test("edits: removing a node from its menu keeps the step in the browser", () => {
  const { App, localStorage } = editedApp([]);
  App.state.mode = "edit";
  App.menu.for("heimdal").find((item) => item.label === "Remove from the network").act();
  assert.deepEqual(JSON.parse(localStorage.store.get("nora-edits")), [{ op: "removeNode", id: "heimdal" }]);
});

test("edits: the new-node form checks its fields, then adds the node", () => {
  const { App, document, localStorage } = editedApp([]);
  App.state.mode = "edit";
  App.edit.canvasMenu({ grid: [3, 4], near: "sleipner" })[0].act();
  const form = document.getElementById("side-body").children[0];
  const inputs = {};
  const walk = (el) => { if (el && el.attributes && el.attributes.get("name")) inputs[el.attributes.get("name")] = el; (el.children || []).forEach(walk); };
  walk(form);
  const submit = () => form._listeners.submit[0]({ preventDefault() {} });
  const saved = () => JSON.parse(localStorage.store.get("nora-edits") || "[]");
  inputs.name.value = "";
  submit();
  assert.equal(saved().length, 0, "no name: nothing added");
  inputs.name.value = "Snøhvit Test";
  inputs.type.value = "field";
  inputs.capacity.value = "";
  submit();
  assert.equal(saved().length, 0, "a field without its capacity: nothing added");
  inputs.capacity.value = "12";
  submit();
  const [step] = saved();
  assert.equal(step.op, "addNode");
  assert.equal(step.node.id, "snohvit_test", "an id from the name");
  assert.deepEqual(step.node.grid, [3, 4]);
  assert.equal(step.node.lat, Number(App.views.flow && inputs.lat.value), "the nearest node's position as a start");
  assert.equal(step.node.unit, "hubs", "and its unit");
});

test("edits: the files to save keep every untouched row exactly", () => {
  const { App, NORA } = editedApp();
  const files = App.edit.files();
  const rows = (text) => text.trim().split("\n");
  const nodes = rows(files["nodes.csv"]), source = rows(NORA.sources["nodes.csv"]);
  assert.equal(nodes[0], source[0], "the same header");
  assert.ok(!nodes.some((row) => row.startsWith("gudrun,")), "the removed row is gone");
  for (const row of source.slice(1)) if (!/^(gudrun|statfjord),/.test(row)) assert.ok(nodes.includes(row), `${row.split(",")[0]} untouched`);
  // The node changed in its form: the new values, quoted where needed; its other fields as they were.
  const before = source.find((row) => row.startsWith("statfjord,")), after = nodes.find((row) => row.startsWith("statfjord,"));
  assert.ok(after.startsWith("statfjord,Statfjord A,field,NO,") && after.includes(',"Equinor, ""Statfjord""",9,'), after);
  assert.equal(after.split(",").slice(-5).join(","), before.split(",").slice(-5).join(","), "source, notes and the rest kept");
  const added = nodes.find((row) => row.startsWith("kveikje,"));
  assert.equal(added.split(",").length, source[0].split(",").length, "a full row");
  const lines = rows(files["pipelines.csv"]);
  assert.ok(!lines.some((row) => /^(ogt|gudrun_sleipner),/.test(row)) && lines.some((row) => row.startsWith("kveikje_statfjord,")));
  assert.match(files["units.toml"], /^# Units for level 2/, "the comments at the top stay");
  const layout = files["flow_layout.toml"];
  assert.match(layout, /^sleipner = \[5\.25, 3\]$/m, "the dragged node's new place, [across, down]");
  assert.match(layout, /^kveikje = \[2\.5, 1\]$/m, "the new node's place");
  assert.doesNotMatch(layout, /^gudrun =/m, "the removed node's line is gone");
  assert.match(layout, /^troll = /m, "the other lines stay");
  const section = files["units.toml"].split("[units.northern_north_sea]")[1].split("[units.")[0];
  assert.match(section, /"kveikje"/, "the new node in its unit");
  assert.doesNotMatch(files["units.toml"], /"gudrun"/);
  assert.ok(files["units.toml"].split("\n").every((line) => line.length <= 100), "long lists wrap, as in the file");
});

test("edits: the network for `nora serve --edit` has the same edits", () => {
  const { App } = editedApp();
  const current = {
    revision: "r",
    nodes: [{ id: "gudrun" }, { id: "statfjord", name: "Statfjord", source: "kept" }],
    pipelines: [{ id: "gudrun_sleipner", from: "gudrun", to: "sleipner" }, { id: "ogt", from: "oseberg", to: "heimdal" }, { id: "keep", from: "statfjord", to: "x" }],
  };
  const sent = App.edit.network(current);
  assert.deepEqual(sent.nodes.map((n) => n.id), ["statfjord", "kveikje"]);
  assert.deepEqual(sent.pipelines.map((p) => p.id), ["keep", "kveikje_statfjord"]);
  assert.deepEqual({ ...sent.units }, { kveikje: "northern_north_sea", statfjord: "hubs" }, "new nodes and moved ones in their units");
  const statfjord = sent.nodes.find((n) => n.id === "statfjord");
  assert.equal(statfjord.name, "Statfjord A", "a changed node's row has its new values");
  assert.equal(statfjord.source, "kept", "and keeps the fields the form does not show");
  assert.deepEqual(JSON.parse(JSON.stringify(sent.layout)), { kveikje: [2.5, 1] }, "places of added and moved nodes that are sent");
  assert.equal(sent.revision, "r", "the revision guards against a stale save");
});

test("edits: a new node and line reach the Flow view's vis data, drawable before the squares", () => {
  const set = (items) => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return { added: [], get: (id) => byId.get(id) || null, add(item) { this.added.push(item); byId.set(item.id, item); }, remove: (id) => byId.delete(id) };
  };
  const nodes = set([{ id: "gudrun" }, { id: "statfjord" }]), edges = set([{ id: "ogt" }, { id: "gudrun_sleipner" }]);
  const { localStorage } = editedApp([]);
  localStorage.setItem("nora-edits", JSON.stringify(STEPS));
  loadApp({ globals: { localStorage, nodes, edges } });
  assert.equal(nodes.get("gudrun"), null, "the removed node left the vis data");
  assert.equal(edges.get("ogt"), null);
  const snorre = nodes.added.find((n) => n.id === "kveikje");
  assert.ok(snorre && snorre.shape && snorre.shape !== "circularImage", "a shape that needs no icon (vis threw on pyvis's default)");
  assert.ok(edges.added.some((e) => e.id === "kveikje_statfjord" && e.from === "kveikje" && e.to === "statfjord"));
});

test("edits: dragging a node keeps its place without a reload; dragging again updates it", () => {
  const { App, NORA, localStorage } = editedApp([]);
  App.edit.move("troll", [0.5, 8]);
  App.edit.move("troll", [0.4, 8.2]);
  assert.deepEqual(JSON.parse(localStorage.store.get("nora-edits")), [{ op: "moveNode", id: "troll", grid: [0.4, 8.2] }]);
  assert.deepEqual(Array.from(NORA.grid.troll), [0.4, 8.2], "the drawing follows at once");
  App.edit.move("kollsnes", [2, 8.5]);
  assert.equal(App.edit.list().length, 2, "another node is its own step");
});

test("edits: a hosted server's Save asks for its edit key once, then keeps it", async () => {
  // Ray, 29 Oct: saving must not mean downloading files once NORA is hosted. The server
  // (NORA_EDIT_TOKEN) answers 401 without its key; the page asks, resends and keeps it.
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, auth: options.headers && options.headers.Authorization });
    if (url === "api/network") return { ok: true, status: 200, json: async () => ({ nodes: [], pipelines: [], revision: "r1" }) };
    const ok = options.headers.Authorization === "Bearer s3cret";
    return { ok, status: ok ? 200 : 401, json: async () => (ok ? { saved: true } : { error: "this server needs its edit key to save" }) };
  };
  const { App, window, localStorage } = (() => {
    const localStorage = storage([{ op: "removeLine", id: "ogt" }]);
    return { ...loadApp({ globals: { localStorage, fetch } }), localStorage };
  })();
  let asked = 0;
  window.prompt = () => { asked += 1; return "s3cret"; };
  await App.edit.save();
  assert.equal(asked, 1, "asked for the key once");
  assert.deepEqual(calls.map((c) => c.auth), [undefined, undefined, "Bearer s3cret"], "sent without, then with the key");
  assert.equal(localStorage.store.get("nora-edit-key"), "s3cret", "kept for the next save");
  assert.ok(!localStorage.store.has("nora-edits"), "saved: the edits are cleared");
  assert.equal(App.edit.list().length, 0);
});

/* Ray, 30 Oct: "i should not be prompted to dowload a file when i click save". On the
   hosted site no editing server answers, so Save keeps the edits in this browser and says
   so; nothing downloads unless Export files is pressed. */
test("edits: Save on the hosted site keeps the edits in this browser, with no download", async () => {
  const files = { Blob: class { constructor(parts) { this.parts = parts; } }, URL: { createObjectURL: () => "blob:x" } };
  const { App, document, localStorage } = editedApp([{ op: "removeLine", id: "ogt" }], files);
  App.setMode("edit");
  const downloads = () => { const out = []; const walk = (n) => { if (n && typeof n === "object") { if (n.tagName === "A" && n.getAttribute("download")) out.push(n); (n.children || []).forEach(walk); } }; walk(document.body); return out; };
  const clicked = [];
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => { const el = realCreate(tag); if (tag === "a") el.click = () => clicked.push(el.getAttribute("download")); return el; };
  await App.edit.save(); // fetch rejects: no editing server, as on factorlab.app
  assert.deepEqual(clicked, [], "no file downloads on Save");
  assert.equal(downloads().length, 0);
  assert.equal(App.edit.list().length, 1, "the edit is still there");
  assert.deepEqual(JSON.parse(localStorage.store.get("nora-edits")), [{ op: "removeLine", id: "ogt" }], "kept in this browser");
  const bar = document.body.children.find((c) => /(^| )edits-bar( |$)/.test(c.className || ""));
  assert.match(bar.textContent, /Saved in this browser: 1 change/);
  const exportButton = buttonsOf(bar).find((b) => b.textContent === "Export files");
  assert.ok(exportButton, "Export files is offered, for whoever wants the files");
  exportButton._listeners.click[0]();
  assert.ok(clicked.length > 0 && clicked.every((n) => ["nodes.csv", "pipelines.csv", "units.toml", "flow_layout.toml"].includes(n)), `only Export downloads them (${clicked})`);
});

/* Ray, 29 Oct, of the bar "13 changes to the network kept in this browser until saved":
   "what is the purpose of this? maybe remove it?". Changing the network is its own mode,
   Edit (his "editing version of the flow map"); outside it nothing can be dragged or
   removed by accident, and the bar does not show. */
test("edits: only in Edit: the menu items, the canvas menu and the bar", () => {
  const { App, document } = editedApp();
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const labels = (id) => App.menu.for(id, { connect: () => {} }).map((item) => item.label);
  assert.ok(!labels("sleipner").includes("Remove from the network"), "no remove outside Edit");
  assert.ok(!labels("sleipner").includes("Connect to another node…"));
  assert.equal(App.edit.canvasMenu({ grid: [2, 3] }).length, 0, "no add outside Edit");
  const bar = () => document.body.children.find((c) => /(^| )edits-bar( |$)/.test(c.className || ""));
  assert.equal(bar(), undefined, "no edits bar outside Edit, though edits are kept");
  assert.ok(App.edit.list().length > 0);
  App.setMode("edit"); // the Edit tab
  assert.ok(bar(), "in Edit the bar lists them");
  assert.ok(labels("sleipner").includes("Remove from the network"));
});

/* Ray, 30 Oct: "the editing page should be a fully fledged editing program where new
   nodes can be added or removed, named, etc". In Edit a click on a node or a line opens
   its form; what changed is one step; the files Save writes carry it. */
const inputsOf = (form) => {
  const inputs = {};
  const walk = (el) => { if (el && el.attributes && el.attributes.get("name")) inputs[el.attributes.get("name")] = el; (el.children || []).forEach(walk); };
  walk(form);
  return inputs;
};
const buttonsOf = (form) => {
  const out = [];
  const walk = (el) => { if (el && el.tagName === "BUTTON") out.push(el); (el.children || []).forEach(walk); };
  walk(form);
  return out;
};

test("editor: in Edit a click on a node opens its form; a rename is one step with only what changed", () => {
  const { App, document, localStorage } = editedApp([]);
  App.setMode("edit");
  App.select("troll");
  const form = document.getElementById("side-body").children[0];
  const inputs = inputsOf(form);
  assert.equal(inputs.name.value, "Troll", "the form holds the node as it is");
  assert.equal(inputs.unit.value, "northern_north_sea");
  inputs.name.value = "Troll A";
  inputs.status.value = "planned";
  form._listeners.submit[0]({ preventDefault() {} });
  assert.deepEqual(JSON.parse(localStorage.store.get("nora-edits")), [{ op: "editNode", id: "troll", changes: { name: "Troll A", status: "planned" } }]);
  assert.ok(buttonsOf(form).some((b) => b.textContent === "Remove node"), "and it can be removed from there");
});

test("editor: a line's form changes it, reverses it, and Save writes its row", () => {
  const steps = [{ op: "editLine", id: "zeepipe_2b", changes: { name: "Zeepipe 2B", capacity: 71, reverse: true } }];
  const { App, NORA } = editedApp(steps);
  const d = NORA.assets.zeepipe_2b;
  assert.equal(d.from, "draupner_e", "reversed: from Draupner E");
  assert.equal(d.to, "kollsnes");
  const row = App.edit.files()["pipelines.csv"].split("\n").find((line) => line.startsWith("zeepipe_2b,"));
  assert.ok(row.startsWith("zeepipe_2b,Zeepipe 2B,draupner_e,kollsnes,trunk,300,40,71,false,1997,operating,Gassco,"), row);
  const source = NORA.sources["pipelines.csv"].split("\n").find((line) => line.startsWith("zeepipe_2b,"));
  assert.equal(row.split(",").slice(12).join(","), source.split(",").slice(12).join(","), "the source and notes stay as they were");
});

test("editor: Undo and Redo, from the toolbar and the keys; Delete removes what the form shows", () => {
  const { App, document, localStorage, window } = editedApp([]);
  const saved = () => JSON.parse(localStorage.store.get("nora-edits") || "[]");
  App.setMode("edit");
  const bar = () => document.body.children.find((c) => /(^| )edits-bar( |$)/.test(c.className || ""));
  const labels = () => buttonsOf(bar()).filter((b) => b.className !== "palette-icon").map((b) => b.textContent);
  assert.ok(bar(), "the toolbar shows in Edit, with no changes yet");
  assert.deepEqual(labels(), ["Add node", "Connect", "Undo", "Redo", "Save"]);
  App.select("heimdal");
  const key = (e) => { for (const fn of window._listeners.keydown || []) fn({ preventDefault() {}, target: document.body, ...e }); };
  key({ key: "Delete" });
  assert.deepEqual(saved(), [{ op: "removeNode", id: "heimdal" }], "Delete removed the node in the form");
  key({ key: "z", metaKey: true });
  assert.deepEqual(saved(), [], "Cmd+Z undid it");
  key({ key: "z", ctrlKey: true, shiftKey: true });
  assert.deepEqual(saved(), [{ op: "removeNode", id: "heimdal" }], "Shift+Ctrl+Z redid it");
  key({ key: "Delete", target: { tagName: "INPUT" } });
  assert.equal(saved().length, 1, "keys typed in a field are left alone");
});


// Just enough of vis-network for the Flow view to mount (the icons work on its drawing).
function fakeVis() {
  const set = () => ({ update() {}, get: () => null, getIds: () => [] });
  class Network {
    constructor() { this.body = { nodes: {}, view: { scale: 0.3, translation: { x: 0, y: 0 } }, emitter: { emit() {} } }; }
    on() {} once() {} off() {} fit() {} setOptions() {} redraw() {} selectNodes() {} unselectAll() {}
    getScale() { return 0.3; } moveTo() {} getPositions() { return {}; } getViewPosition() { return { x: 0, y: 0 }; }
    DOMtoCanvas(p) { return p; } canvasToDOM(p) { return p; }
  }
  return { vis: { Network }, nodes: set(), edges: set(), flowOptions: {} };
}
/* Ray, 30 Oct: "the edit page is way to simple, we are missing features like click and drag
   of icons etc". The toolbar has an icon for each node type: drag one onto the Flow drawing
   for a new node of that type there, or click it and then the drawing. Connect makes a line
   with two clicks. */
test("editor: type icons drag onto the drawing, or click then place; the form has that type", () => {
  const { App, document } = editedApp([], fakeVis());
  App.state.view = "flow"; // the icons work on the Flow drawing
  App.setMode("edit");
  const bar = document.body.children.find((c) => /(^| )edits-bar( |$)/.test(c.className || ""));
  const icons = buttonsOf(bar).filter((b) => b.className === "palette-icon");
  assert.deepEqual(icons.map((b) => b.getAttribute("data-type")), ["field", "hub", "tee", "processing", "terminal", "storage", "lng", "market"]);
  assert.equal(icons[0].getAttribute("draggable"), "true");
  const sent = {};
  icons[3]._listeners.dragstart[0]({ dataTransfer: { setData: (k, v) => { sent[k] = v; }, set effectAllowed(v) { sent.effect = v; } } });
  assert.equal(sent["application/x-nora-node"], "processing", "dragging carries the type");
  assert.equal(sent.effect, "copy");
  // What the Flow view does on the drop (and on a click after an icon): a new node there, of that type.
  App.edit.addAt({ grid: [3, 4], near: "kollsnes", type: "processing" });
  const form = document.getElementById("side-body").children[0];
  const select = (() => { let hit = null; const walk = (n) => { if (!hit && n && n.tagName === "SELECT" && n.getAttribute("name") === "type") hit = n; (n && n.children || []).forEach(walk); }; walk(form); return hit; })();
  assert.ok(select, "the new node's form opens");
  assert.equal(select.value, "processing", "with the dragged type");
});

test("editor: Connect in the toolbar picks the first node, then the second makes the line form", () => {
  const { App, document } = editedApp([], fakeVis());
  App.state.view = "flow";
  App.setMode("edit");
  let picked = 0;
  App.views.flow.pickToConnect = () => { picked += 1; };
  const bar = document.body.children.find((c) => /(^| )edits-bar( |$)/.test(c.className || ""));
  buttonsOf(bar).find((b) => b.textContent === "Connect")._listeners.click[0]();
  assert.equal(picked, 1, "the Flow view waits for the first node");
  assert.match(bar.textContent, /Click the node the new line starts from/);
});
