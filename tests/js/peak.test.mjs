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
