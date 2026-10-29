/* Ray, 28 Oct: "if i click on info on a peak and the sidepanel appear i should be able
   to see head ETA and tail ETA as well as total volume of the peak as the origin of the
   peak (where was it first generated)". A click on a pig or a peak opens it in the
   sidebar, which follows it as the data plays. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

// The synthetic week, played to the first hour with an H₂S or CO₂ slug under way.
function playToASlug() {
  const loaded = loadApp();
  const { App, NORA, document } = loaded;
  document.getElementById("speed").options = [{ value: "600" }];
  const week = NORA.streams.find((s) => s.synthetic);
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: week.name } });
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const scrub = document.getElementById("scrub");
  for (let i = 0; i < week.times.length; i += 2) {
    scrub.value = String(i);
    scrub._listeners.input[0]();
    const slug = App.markers().find((m) => m.kind === "quality" && m.lead);
    if (slug) return { ...loaded, slug };
  }
  throw new Error("no H₂S or CO₂ slug in the synthetic week");
}
const panel = (document) => `${document.getElementById("side-title").textContent} | ${document.getElementById("side-body").textContent}`;

test("peak panel: an H₂S or CO₂ peak shows head and tail ETAs, its volume and its origin", () => {
  const { App, NORA, document, slug } = playToASlug();
  App.selectMarker(slug.key);
  assert.equal(App.sidebar.marker(), slug.key, "the sidebar follows this peak");
  const text = panel(document);
  assert.match(text, /(H₂S|CO₂) peak/);
  assert.match(text, /Head reaches/);
  assert.match(text, /Tail reaches/);
  assert.match(text, /Total volume\d[\d.,]* MSm³ of gas/);
  const origin = App.live.slugs.get(slug.ref).origin;
  assert.match(text, new RegExp(`Origin${NORA.assets[origin].name}, first seen`), "where it was first generated, and when");
  assert.ok(App.live.slugs.get(slug.ref).volume > 0, "the volume is the field's gas while it was over the follow level");
});

test("peak panel: a change in flow shows head and tail ETAs, volume and origin", () => {
  const { App, NORA, document } = playToASlug();
  const pid = App.pipeIds.find((id) => NORA.assets[id].type === "trunk" && NORA.assets[id].capacity);
  App.live.peaks.push({ id: pid, t0: App.live.time - 60, delta: 6, level: 1, forward: true });
  const peak = App.markers().find((m) => m.kind === "peak");
  App.selectMarker(peak.key);
  const text = panel(document);
  assert.match(text, /Flow increase of 6\.0 MSm³\/d/);
  const head = text.match(/Head reaches[^,]+, (?:\w{3} )?(\d\d:\d\d)/), tail = text.match(/Tail reaches[^,]+, (?:\w{3} )?(\d\d:\d\d)/);
  assert.ok(head && tail && head[1] !== tail[1], "the head arrives before the tail");
  assert.match(text, /Total volume0\.25 MSm³ more gas/, "6 MSm³/d over a one-hour step");
  assert.match(text, new RegExp(`Origin${NORA.assets[pid].name}, first seen`));
});

test("pig panel: the next stop, the receiver and when it gets there", () => {
  const { App, document } = playToASlug();
  const pig = App.markers().find((m) => m.kind === "pig");
  assert.ok(pig, "a pig is under way");
  App.selectMarker(pig.key);
  const text = panel(document);
  assert.match(text, /Next stop/);
  assert.match(text, /Receiver/);
  assert.match(text, /Launched/);
  App.go({ screen: "overview" });
  assert.equal(App.sidebar.marker(), null, "leaving the unit screen closes it");
});

/* Ray, 29 Oct: "remove the red tag label, have it say like this format: H2S / 3,6 ppm /
   ETA 14:42. H2S should be yellow and CO2 red, but not strong colors." */
test("gas peaks: three lines, the gas in its calm colour, no alarm tag", () => {
  const { App } = loadApp();
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      return (...args) => calls.push({ op: key, args, fill: target.fillStyle });
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const marker = { kind: "quality", gas: "h2s_ppm", lead: true, level: 3, value: "H₂S 3.6", amount: "3.6", eta: "14:42", to: "Dornum" };
  App.drawMarker(ctx, marker, 100, 100, 0, 7, 2, []);
  const texts = calls.filter((c) => c.op === "fillText");
  assert.deepEqual(texts.map((c) => c.args[0]), ["H₂S", "3.6 ppm", "ETA 14:42"]);
  assert.equal(texts[0].fill, App.colors.h2s, "the gas name in the gas's colour");
  assert.ok(texts[1].args[2] > texts[0].args[2] && texts[2].args[2] > texts[1].args[2], "one under the other");
  const { colors } = App;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, g, b] = rgb(colors.h2s), [cr, cg, cb] = rgb(colors.co2);
  assert.ok(r > b && g > b, "H2S is a yellow"), assert.ok(cr > cg && cr > cb, "CO2 is a red");
  assert.notEqual(colors.co2, colors.critical, "not the alarm red");
  const badge = calls.filter((c) => c.op === "fillRect" || c.op === "lineTo").length;
  App.drawMarker(ctx, { ...marker, level: 0 }, 100, 100, 0, 7, 2, []);
  assert.equal(calls.filter((c) => c.op === "fillRect" || c.op === "lineTo").length, badge * 2, "an alarm level adds no tag");
});
