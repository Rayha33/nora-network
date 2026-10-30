/* Ray, 30 Oct: "i should be able to right click alamrs in the alarm list to get options";
   "if i click outside the alarm list view it should be minimized or go away", "or if i
   click on a field or exit point". */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, loadPayload } from "./harness.mjs";

const CAPACITY = Object.fromEntries(Object.entries(loadPayload().assets).map(([id, a]) => [id, a.capacity || 0]));
const find = (el, ok) => (el && ok(el) ? el : ((el && el.children) || []).map((c) => (typeof c === "object" ? find(c, ok) : null)).find(Boolean) || null);

// A line over its capacity: alarms in the list, and the list open.
function withList() {
  const loaded = loadApp({ globals: { innerWidth: 1400, innerHeight: 900 } }); // the menu keeps inside the window
  const { App, document } = loaded;
  const pid = App.pipeIds.find((id) => CAPACITY[id] > 10);
  [0.5, 0.5, 1.2, 1.2].forEach((share, k) => App.feed.frame({ t: 1_800_000_000 + k * 3600, values: { [pid]: share * CAPACITY[pid] }, metrics: {} }));
  const counts = document.getElementById("alarm-counts"), panel = document.getElementById("alarms");
  panel.hidden = true;
  counts._listeners.click[0]({ currentTarget: counts });
  assert.ok(!panel.hidden, "the list is open");
  return { ...loaded, pid, counts, panel };
}
const menuOf = (document) => find(document.body, (n) => n.className === "ctx-menu");
const labels = (menu) => menu.children.filter((n) => n.tagName === "BUTTON").map((n) => n.textContent);

test("alarm list: right-click an alarm for its options; Acknowledge acknowledges it", () => {
  const { App, document, panel, pid } = withList();
  const row = find(panel, (n) => n.tagName === "TR" && n._listeners && n._listeners.contextmenu);
  assert.ok(row, "an alarm row answers a right-click");
  let prevented = false;
  row._listeners.contextmenu[0]({ preventDefault: () => { prevented = true; }, clientX: 200, clientY: 200 });
  assert.ok(prevented, "the browser's own menu stays shut");
  const menu = menuOf(document);
  assert.ok(menu, "a menu opens");
  const items = labels(menu);
  for (const want of ["Acknowledge", "Shelve…", "Open details", "Open the full page"]) assert.ok(items.includes(want), `it offers ${want} (${items.join(", ")})`);
  assert.ok(items.some((t) => /^Copy [A-Z]+-/.test(t)), "and copying the alarm ID");
  const before = App.live.conditions.filter((c) => c.id === pid && !c.acked).length;
  find(menu, (n) => n.tagName === "BUTTON" && n.textContent === "Acknowledge")._listeners.click[0]();
  assert.equal(App.live.conditions.filter((c) => c.id === pid && !c.acked).length, before - 1, "one alarm acknowledged");
  assert.ok(!panel.hidden, "the list stays open");
});

test("alarm list: a click outside closes it, also on a field or exit point; inside keeps it", () => {
  const { document, panel, counts } = withList();
  const down = (target) => document._listeners.pointerdown.forEach((fn) => fn({ target }));
  down(find(panel, (n) => n.tagName === "TD"));
  assert.ok(!panel.hidden, "a click inside the list keeps it");
  down(counts);
  assert.ok(!panel.hidden, "its own button toggles it, not this");
  down(document.getElementById("flow")); // a field or exit point on the Flow or the Map
  assert.ok(panel.hidden, "a click outside closes it");
  assert.equal(counts.getAttribute("aria-expanded"), "false");
});
