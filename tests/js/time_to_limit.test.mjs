/* Hub 3604 (Ray, 27 Oct: "less absolute numbers, more visual ways of showing how values
   are heading towards what limit"). Beside the rate, a value that is heading for one of
   its limits says how soon it gets there, at the rate of the last hours, when that is
   within the plan's look-ahead. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const T0 = 1_800_000_000;
function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
// A terminal's pressure, one reading an hour.
function terminal(pressures) {
  const loaded = loadApp();
  const { App, NORA, document } = loaded;
  const id = Object.keys(NORA.assets).find((k) => NORA.assets[k].type === "terminal" && NORA.config.pressure_limits?.terminal);
  pressures.forEach((p, k) => App.feed.frame({ t: T0 + k * 3600, values: {}, metrics: { pressure_bar: { [id]: p } } }));
  App.go({ screen: "asset", asset: id });
  const texts = [];
  walk(document.getElementById("screen-asset"), (n) => { if (n.className === "to-limit") texts.push(n.textContent); });
  return { App, id, limits: NORA.config.pressure_limits.terminal, texts };
}

test("time to limit: a pressure rising toward its high limit says how soon", () => {
  const [, , high] = [57, 60, 76, 80, 85];
  const { limits, texts } = terminal([70, 71, 72]);
  assert.equal(limits[2], high, "the terminal's high limit in nora.toml");
  assert.ok(texts.includes("high limit in ~4.0 h"), `1 bar/h from 72 to 76 bar: ${texts}`);
});

test("time to limit: under an hour it counts minutes; falling it names the low limit", () => {
  assert.ok(terminal([74, 74.5, 75.5]).texts.includes("high limit in ~40 min"), "0.75 bar/h, 0.5 bar to go");
  assert.ok(terminal([66, 64, 62]).texts.includes("low limit in ~1.0 h"), "−2 bar/h from 62 to 60 bar");
});

test("time to limit: steady, or a limit further than the look-ahead, says nothing", () => {
  assert.deepEqual(terminal([68, 68, 68]).texts.length, 0);
  assert.deepEqual(terminal([66, 66.1, 66.2]).texts.length, 0, "0.1 bar/h: the high limit is 98 h away");
});
