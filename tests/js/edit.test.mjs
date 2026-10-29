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
  assert.ok(App.nodeIds.includes("snorre") && App.pipeIds.includes("snorre_statfjord"), "the new node and its line are in");
  assert.deepEqual(Array.from(NORA.grid.snorre), [1, 2.5], "placed where the Flow view was clicked");
  assert.ok(NORA.units.find((u) => u.id === "northern_north_sea").nodes.includes("snorre"), "in the unit chosen for it");
  assert.ok(!NORA.units.some((u) => u.nodes.includes("gudrun")), "the removed node left its unit");
  assert.ok(NORA.geo.nodes.features.some((f) => f.properties.asset === "snorre"), "the Map has it");
  assert.ok(!NORA.geo.pipes.features.some((f) => f.properties.asset === "ogt"), "and not the removed line");
  assert.equal(NORA.assets.snorre.supply, true, "a field supplies the network (the what-if counts it)");
  assert.deepEqual(Array.from(NORA.grid.sleipner), [3, 5.25], "a dragged node keeps its place");
  assert.equal(App.edit.list().length, 5, "a step that no longer applies is dropped");
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
  for (const row of source.slice(1)) if (!row.startsWith("gudrun,")) assert.ok(nodes.includes(row), `${row.split(",")[0]} untouched`);
  const added = nodes.find((row) => row.startsWith("snorre,"));
  assert.equal(added.split(",").length, source[0].split(",").length, "a full row");
  const lines = rows(files["pipelines.csv"]);
  assert.ok(!lines.some((row) => /^(ogt|gudrun_sleipner),/.test(row)) && lines.some((row) => row.startsWith("snorre_statfjord,")));
  assert.match(files["units.toml"], /^# Units for level 2/, "the comments at the top stay");
  const layout = files["flow_layout.toml"];
  assert.match(layout, /^sleipner = \[5\.25, 3\]$/m, "the dragged node's new place, [across, down]");
  assert.match(layout, /^snorre = \[2\.5, 1\]$/m, "the new node's place");
  assert.doesNotMatch(layout, /^gudrun =/m, "the removed node's line is gone");
  assert.match(layout, /^troll = /m, "the other lines stay");
  const section = files["units.toml"].split("[units.northern_north_sea]")[1].split("[units.")[0];
  assert.match(section, /"snorre"/, "the new node in its unit");
  assert.doesNotMatch(files["units.toml"], /"gudrun"/);
  assert.ok(files["units.toml"].split("\n").every((line) => line.length <= 100), "long lists wrap, as in the file");
});

test("edits: the network for `nora serve --edit` has the same edits", () => {
  const { App } = editedApp();
  const current = {
    revision: "r",
    nodes: [{ id: "gudrun" }, { id: "statfjord" }],
    pipelines: [{ id: "gudrun_sleipner", from: "gudrun", to: "sleipner" }, { id: "ogt", from: "oseberg", to: "heimdal" }, { id: "keep", from: "statfjord", to: "x" }],
  };
  const sent = App.edit.network(current);
  assert.deepEqual(sent.nodes.map((n) => n.id), ["statfjord", "snorre"]);
  assert.deepEqual(sent.pipelines.map((p) => p.id), ["keep", "snorre_statfjord"]);
  assert.deepEqual({ ...sent.units }, { snorre: "northern_north_sea" });
  assert.deepEqual(JSON.parse(JSON.stringify(sent.layout)), { snorre: [2.5, 1] }, "places of added and moved nodes that are sent");
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
  const snorre = nodes.added.find((n) => n.id === "snorre");
  assert.ok(snorre && snorre.shape && snorre.shape !== "circularImage", "a shape that needs no icon (vis threw on pyvis's default)");
  assert.ok(edges.added.some((e) => e.id === "snorre_statfjord" && e.from === "snorre" && e.to === "statfjord"));
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
