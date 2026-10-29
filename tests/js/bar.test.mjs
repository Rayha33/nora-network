/* The bar and the player on any screen (review, 29 Oct): on a 390 px phone the bar's
   three rows were squeezed into two rows' height, so the brand and the Overview crumb
   sat above the top of the screen and Plain was scrolled out of sight; and the player's
   "Real time · UTC" sat on top of "−4 h" at every size. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { loadPayload, TEMPLATES } from "./harness.mjs";
import { makeDom, makeSandbox, StubNode } from "./stub.mjs";

/* app.js on a window `width` wide, whose bar lays its rows out `barHeight` tall. */
function loadAt(width, barHeight) {
  const document = makeDom(), props = {};
  const bar = new StubNode("header");
  bar.getBoundingClientRect = () => ({ top: 0, left: 0, width, height: barHeight, right: width, bottom: barHeight });
  document.querySelector = (selector) => (selector === ".bar" ? bar : null);
  document.documentElement.style = { setProperty: (k, v) => { props[k] = v; }, removeProperty: (k) => { delete props[k]; } };
  const sandbox = makeSandbox({ nora: loadPayload(), document });
  sandbox.window.innerWidth = width;
  sandbox.getComputedStyle = () => ({ getPropertyValue: (k) => (k === "--bar-h" ? "104px" : "") });
  vm.runInContext(readFileSync(`${TEMPLATES}/app.js`, "utf8"), vm.createContext(sandbox), { filename: "app.js" });
  return { props, root: document.documentElement };
}

test("on a phone the bar is as tall as its rows, so no control is cut off", () => {
  const { props, root } = loadAt(390, 140);
  assert.equal(root.dataset.bar, "two");
  assert.equal(props["--bar-h"], "156px", "the rows' 140 px plus 8 px above and below");
});

test("a bar whose rows fit keeps its own height", () => {
  assert.equal(loadAt(900, 76).props["--bar-h"], undefined, "two rows fit in 104 px");
  assert.equal(loadAt(1440, 60).props["--bar-h"], undefined, "one row: the stylesheet's height");
});

test("the player's 'now' label is centred over the track, not over '−4 h'", () => {
  const css = readFileSync(`${TEMPLATES}/app.css`, "utf8");
  const rule = css.match(/#tl-now\s*\{([^}]+)\}/);
  assert.ok(rule, "the label has a rule");
  // Absolutely placed and pulled back by half its width: it also needs to start at half the row.
  assert.match(rule[1], /position:\s*absolute/);
  assert.match(rule[1], /translateX\(-50%\)/);
  assert.match(rule[1], /left:\s*50%/, "without left: 50% it sits at the row's start");
});
