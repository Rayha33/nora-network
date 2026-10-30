/* Review, 30 Oct: a pipeline's own page showed its load and nothing else. Its Values now
   carry its line pack too: the gas it holds (the line-pack model's estimate, as on the Flow
   and in the inventory trend), its settle-out pressure and how fast it packs, said once in
   MSm³/d as on the Flow, and called an estimate. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

test("pipeline page: its line pack, settle-out pressure and packing, as an estimate", () => {
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams.find((s) => s.synthetic).name } });
  const scrub = document.getElementById("scrub");
  scrub.value = String(2 * 24 * 3600);
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  App.go({ screen: "asset", asset: "langeled_south" });
  const text = document.getElementById("screen-asset").textContent;
  const lp = App.linepack("langeled_south", App.live.frames[App.live.index]), sop = App.settleOut("langeled_south", App.live.frames[App.live.index]);
  assert.ok(lp > 0, "the model holds gas in the line");
  assert.match(text, /Line pack/, "a Line pack row");
  assert.ok(text.includes(`${App.fmt(lp, 1)} MSm³ at ${App.fmt(sop, 1)} bar settle-out`), "the gas it holds and its settle-out pressure");
  assert.match(text, /an estimate/, "said to be an estimate");
  assert.doesNotMatch(text, /MSm³\/h/, "its packing once, in MSm³/d, not again per hour");
  assert.match(text, /Load/, "with its load, as before");
});

test("pipeline page: a line without length or diameter has no line pack row", () => {
  const { App, NORA, document } = loadApp();
  const bare = App.pipeIds.find((pid) => !(NORA.assets[pid].length && NORA.assets[pid].diameter));
  if (!bare) return; // every line in the data has both
  App.go({ screen: "asset", asset: bare });
  assert.doesNotMatch(document.getElementById("screen-asset").textContent, /Line pack/);
});
