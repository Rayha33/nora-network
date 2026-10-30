/* Ray, 30 Oct: "remove this menu from the map view page" (the dataset menu on the
   player). The player keeps play, the clock and the timeline; the dataset is chosen in
   Settings, under Data, and choosing one there still loads it. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadApp } from "./harness.mjs";

const page = readFileSync(new URL("../../src/nora/templates/app.html.j2", import.meta.url), "utf8");

test("dataset menu: not on the player, in Settings under Data", () => {
  const player = page.slice(page.indexOf('<div class="transport">'), page.indexOf('<div class="timeline">'));
  assert.ok(!player.includes("stream-select") && !player.includes(">Dataset<"), "the player has no dataset menu");
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "600" }];
  App.start();
  assert.ok(NORA.streams.length > 1, "the fixture has more than one dataset");
  const texts = [], walk = (n) => { if (n && typeof n === "object") { if (n.tagName === "H3" || n.tagName === "SPAN") texts.push(n.textContent); (n.children || []).forEach(walk); } };
  const has = (node, target) => node === target || (node.children || []).some((c) => has(c, target));
  const settings = document.getElementById("settings"), select = document.getElementById("stream-select");
  walk(settings);
  assert.ok(texts.includes("Data") && texts.includes("Dataset"), "a Data heading and a Dataset row");
  assert.ok(has(settings, select), "the menu sits in Settings");
  const other = NORA.streams.find((s) => s.name !== App.live.stream.name);
  select._listeners.change[0]({ target: { value: other.name } });
  assert.equal(App.live.stream.name, other.name, "choosing a dataset there loads it");
});
