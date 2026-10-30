/* Ray, 30 Oct: "if the packing is very high in one pipeline it should get some attention
   by adding color". A line packing at nora.toml's pack_high (20 %) of its capacity a day
   or more reads "pack +N high" in the warning's amber; below that, as before. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

test("line pack: packing hard reads high, in amber; ordinary packing does not", () => {
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "600" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  App.state.mode = "live";
  const share = NORA.config.thresholds.pack_high;
  assert.equal(share, 0.2);
  let high = null, calm = null;
  for (let k = 2; k < App.live.stream.times.length && !(high && calm); k++) {
    App.seek(k);
    for (const pid of App.pipeIds) {
      const rate = App.packRate(pid), cap = NORA.assets[pid].capacity;
      if (rate == null || !cap) continue;
      if (!high && rate >= share * cap) high = { k, pid, s: App.frame.run(() => App.pipeStyle(pid)) };
      if (!calm && rate >= 0.5 && rate < 0.5 * share * cap) calm = { k, pid, s: App.frame.run(() => App.pipeStyle(pid)) };
    }
  }
  assert.ok(high, "the synthetic week has a line packing hard");
  assert.match(high.s.pack, /^pack \+[\d.]+ high$/, `${high.pid}: ${high.s.pack}`);
  assert.equal(high.s.packHigh, true);
  assert.ok(calm, "and lines packing gently");
  assert.match(calm.s.pack, /^pack \+[\d.]+$/, `${calm.pid}: ${calm.s.pack}`);
  assert.equal(calm.s.packHigh, false);
});
