/* The bar and the player on any screen (review, 29 Oct): on a 390 px phone the bar's
   three rows were squeezed into two rows' height, so the brand and the Overview crumb
   sat above the top of the screen and Plain was scrolled out of sight; and the player's
   "Real time · UTC" sat on top of "−4 h" at every size. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { loadPayload, TEMPLATES, templateSource } from "./harness.mjs";
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
  vm.runInContext(templateSource("app.js"), vm.createContext(sandbox), { filename: "app.js" });
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

test("the ruler draws its own days; its ends and state are said for screen readers", () => {
  const css = readFileSync(`${TEMPLATES}/app.css`, "utf8");
  const rule = css.match(/\.timeline-label\s*\{([^}]+)\}/);
  assert.ok(rule && /clip-path:\s*inset\(50%\)/.test(rule[1]) && /width:\s*1px/.test(rule[1]), "visually hidden, still read out");
  assert.match(css, /\.track input\s*\{[^}]*pointer-events:\s*none/s, "the pointer works on the ruler; the keys on the input");
});
