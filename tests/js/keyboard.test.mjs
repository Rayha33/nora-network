/* The screens from the keyboard (review, 29 Oct). Alarm rows, indicator names and gas
   quality rows took clicks but not focus, and the overview is rebuilt a few times a
   second while the data plays, so focus on any of its controls was lost within 600 ms. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";
import { StubNode } from "./stub.mjs";

const NATIVE = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"]);

function play() {
  const loaded = loadApp();
  const { document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  return loaded;
}
function step(document) { // one hour on, through the player: every screen is rebuilt
  const scrub = document.getElementById("scrub");
  scrub.value = "3600";
  scrub._listeners.input[0]({ target: { value: scrub.value } });
}
function all(node, out = []) {
  if (node && typeof node === "object") {
    out.push(node);
    for (const child of node.children || []) all(child, out);
  }
  return out;
}
const clickable = (root) => all(root).filter((n) => n._listeners && n._listeners.click && n._listeners.click.length);

test("everything clickable on the overview is reachable and works from the keyboard", () => {
  const { App, document } = play();
  App.go({ screen: "overview" });
  const items = clickable(document.getElementById("screen-overview"));
  assert.ok(items.length > 10, "the overview has alarm rows, names and units to open");
  const unreachable = items.filter((n) => !NATIVE.has(n.tagName) && !(n.getAttribute("tabindex") === "0" && (n._listeners.keydown || []).length));
  assert.deepEqual([...new Set(unreachable.map((n) => n.tagName))], [], `${unreachable.length} clickable elements the keyboard cannot reach`);
  // Enter on an alarm row opens its asset, as a click does.
  const row = items.find((n) => n.tagName === "LI");
  assert.ok(row, "an alarm row");
  row._listeners.keydown[0]({ key: "Enter", preventDefault() {} });
  assert.equal(App.route.screen, "asset");
});

test("keyboard focus stays on the same control when the data steps and the screen is rebuilt", () => {
  const { App, document } = play();
  const saved = { focus: StubNode.prototype.focus, contains: StubNode.prototype.contains, qsa: StubNode.prototype.querySelectorAll };
  StubNode.prototype.focus = function () { document.activeElement = this; };
  StubNode.prototype.contains = function (node) { return all(this).includes(node); };
  StubNode.prototype.querySelectorAll = function (selector) {
    assert.equal(selector, "[data-key]");
    return all(this).filter((n) => n !== this && n.getAttribute && n.getAttribute("data-key") != null);
  };
  try {
    App.go({ screen: "overview" });
    const overview = document.getElementById("screen-overview");
    const unit = clickable(overview).find((n) => n.tagName === "BUTTON" && n.textContent.includes(App.units[Object.keys(App.units)[0]].name));
    assert.ok(unit, "a unit button");
    unit.focus();
    step(document);
    assert.notEqual(document.activeElement, unit, "the overview was rebuilt: the old button is gone");
    assert.ok(all(overview).includes(document.activeElement), "focus is on a control in the new overview");
    assert.equal(document.activeElement.textContent, unit.textContent, "the same unit's button");
  } finally {
    Object.assign(StubNode.prototype, { focus: saved.focus, contains: saved.contains, querySelectorAll: saved.qsa });
  }
});

test("the alarm counts and the plan chip are live regions: unchanged, they are left alone", () => {
  const { App, document } = play();
  App.go({ screen: "overview" });
  const counts = document.getElementById("alarm-counts"), chip = document.getElementById("plan-chip");
  const before = [counts._replaced, chip._replaced];
  App.go({ screen: "overview" }); // the same hour again: nothing to announce
  App.go({ screen: "overview" });
  assert.deepEqual([counts._replaced, chip._replaced], before, "a screen reader would read them out again");
});
