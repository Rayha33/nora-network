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

/* Ray, 29 Oct: "volume (MSm3), Head KP, Tail KP, Sent (CET), ETA (CET), Duration,
   Max/Min value, Avg value, Notified (yes/no), Origo ref number (5 digits), also Network,
   Location and peakID as well description. make it look nice and easy to understand". */
test("peak panel: an H₂S or CO₂ peak has all Ray's fields, plainly", () => {
  const { App, NORA, document, slug } = playToASlug();
  App.selectMarker(slug.key);
  assert.equal(App.sidebar.marker(), slug.key, "the sidebar follows this peak");
  const text = panel(document);
  assert.match(text, /(H₂S|CO₂) peak/);
  for (const field of ["Volume", "Head", "Tail", "Sent", "ETA", "Duration", "Max", "Min", "Average", "Notified", "Origo ref", "Network", "Location", "Peak ID"]) {
    assert.ok(text.includes(field), `${field} is in the panel`);
  }
  assert.match(text, /KP \d[\d.,]* on /, "head and tail as a KP on their line");
  assert.match(text, /\d\d:\d\d (CET|CEST|GMT\+\d)/, "times in CET");
  assert.match(text, /(H2S|CO2)-[A-ZÆØÅ]{1,3}-\d{8}/, "a peak ID from the gas, the origin and when it was sent");
  const origin = App.live.slugs.get(slug.ref).origin;
  assert.ok(text.includes(`from ${NORA.assets[origin].name}, sent`), "a description in words");
  assert.ok(App.live.slugs.get(slug.ref).volume > 0, "the volume is the field's gas while it was over the follow level");
});

test("peak panel: Notified and the Origo reference are kept per peak", () => {
  const { App, document, slug } = playToASlug();
  App.selectMarker(slug.key);
  const find = (el, test) => (test(el) ? el : (el.children || []).map((c) => (c && typeof c === "object" ? find(c, test) : null)).find(Boolean) || null);
  const body = document.getElementById("side-body");
  find(body, (el) => el.attributes && /toggle/.test(el.className || ""))._listeners.click[0]();
  const origo = find(document.getElementById("side-body"), (el) => el.className === "origo");
  origo.value = "40217";
  origo._listeners.change[0]();
  App.selectMarker(slug.key);
  const again = panel(document);
  assert.match(again, /NotifiedYes/, "notified, after it was set");
  assert.equal(find(document.getElementById("side-body"), (el) => el.className === "origo").value, "40217", "the reference is kept");
});

/* Ray, 29 Oct: "a pig needs the same kind of setup for information as a peak on the
   screens ... Pig ID: 3420 / ETA: 23:21 / Speed: 5,3 m/s". */
test("pig panel: ID, ETA and speed first, then where it is and when", () => {
  const { App, document } = playToASlug();
  const pig = App.markers().find((m) => m.kind === "pig" && m.pigId != null);
  assert.ok(pig, "a pig with an ID is under way");
  App.selectMarker(pig.key);
  const text = panel(document);
  for (const field of ["Pig ID", "ETA", "Speed", "Launched", "Next stop", "KP", "Network", "Run"]) {
    assert.ok(text.includes(field), `${field} is in the panel`);
  }
  assert.ok(text.includes(String(pig.pigId)), "its ID");
  assert.match(text, /\d[\d.]* m\/s/, "its speed");
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

test("pigs: three lines on the drawing, like a gas peak", () => {
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
  App.drawMarker(ctx, { kind: "pig", pigId: 3420, arrives: 1793229660, speed: 5.3, level: 0 }, 100, 100, 0, 16, 1, []);
  const texts = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
  assert.equal(texts[0], "Pig 3420");
  assert.match(texts[1], /^ETA \d\d:\d\d$/);
  assert.equal(texts[2], "5.3 m/s");
});

/* Ray, 29 Oct: "the circle (center) of the peak H2S or CO2 should be at the point that
   is midway between the head and the tail of the peak". */
test("peak: the H₂S or CO₂ dot sits midway between the head and the tail", () => {
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "600" }];
  const week = NORA.streams.find((s) => s.synthetic);
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: week.name } });
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const scrub = document.getElementById("scrub"), v = NORA.config.pipelines.gas_velocity_mps;
  let checked = 0;
  for (let i = 0; i < week.times.length; i += 1) {
    scrub.value = String(i);
    scrub._listeners.input[0]();
    for (const dot of App.markers().filter((m) => m.kind === "quality" && m.lead)) {
      const parcels = App.live.quality.filter((q) => q.slug === dot.ref);
      if (parcels.length < 2 || parcels.some((q) => q.arrived || q.pid !== dot.id)) continue; // on one line
      const at = (q) => { const t = (App.live.time - q.t0) / ((NORA.assets[q.pid].km * 1000) / v); return q.forward ? t : 1 - t; };
      const head = parcels.reduce((a, b) => (a.born <= b.born ? a : b)), tail = parcels.reduce((a, b) => (a.born >= b.born ? a : b));
      assert.ok(Math.abs(dot.along - (at(head) + at(tail)) / 2) < 1e-9, `${dot.ref} at ${dot.along}, not midway`);
      const [a, b] = dot.extent;
      assert.ok(Math.abs(dot.along - (a + b) / 2) < 1e-9 || a <= 0 || b <= 0 || a >= 1 || b >= 1, "the middle of its band too");
      checked += 1;
    }
  }
  assert.ok(checked > 3, `checked ${checked} positions`);
});

/* Ray, 29 Oct, of a moving flow-change marker ("−50.7 16:31 Sleipner"): "what is this
   suppose to be? ... mainly stick to illustrating H2S, CO2 and pigs". A change in flow
   draws no marker; a large one is still an alarm. */
test("markers: H₂S, CO₂ and pigs only, no flow-change markers", () => {
  const { App } = playToASlug();
  const pid = App.pipeIds.find((id) => App.live.values[id] > 1);
  App.live.peaks.push({ id: pid, t0: App.live.time - 60, delta: 20, level: 2, forward: true });
  const kinds = new Set(App.markers().map((m) => m.kind));
  assert.ok(!kinds.has("peak"), "no flow-change marker");
  assert.ok([...kinds].every((k) => k === "quality" || k === "pig"), `only H₂S, CO₂ and pigs: ${[...kinds]}`);
});
