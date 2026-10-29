/* Ray's type rules for everything drawn on a canvas: labels are never smaller than
   11 px, and nothing is heavier than semibold (600), not even the alarm numbers. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, assertHealthy } from "./harness.mjs";

// A 2D context that records the font of every piece of text drawn with it.
function recorder() {
  const texts = [];
  const ctx = new Proxy({ font: "10px sans-serif" }, {
    get(target, key) {
      if (key === "fillText" || key === "strokeText") return (text) => texts.push({ text: String(text), font: target.font });
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { ctx, texts };
}
const px = (font) => Number((font.match(/([\d.]+)px/) || [])[1]);
const weight = (font) => Number((font.match(/\b([1-9]00)\b/) || [, 400])[1]);

test("marker labels are at least 11 px and regular weight", () => {
  const loaded = loadApp();
  assertHealthy(assert, loaded);
  const { ctx, texts } = recorder();
  const peak = { kind: "peak", value: "+12M", eta: "14:20", to: "Kollsnes", level: 2, lead: true };
  loaded.App.drawMarker(ctx, peak, 100, 100, 0, 7, 2);
  const labels = texts.filter((t) => t.text.length > 1);
  assert.ok(labels.length >= 2, "the peak's value and ETA are labelled");
  for (const t of labels) {
    assert.ok(px(t.font) >= 11, `"${t.text}" is drawn at ${px(t.font)} px`);
    assert.ok(weight(t.font) <= 600, `"${t.text}" is drawn at weight ${weight(t.font)}`);
  }
});

test("pig markers use a larger shared size without enlarging peaks", () => {
  const { App } = loadApp();
  assert.ok(App.markerSize("pig") >= 12, "pig icons are clearly visible");
  assert.ok(App.markerSize("pig") < 16, "and a bit smaller than they were (Ray, 29 Oct)");
  assert.ok(App.markerSize("pig") > App.markerSize("peak"), "pigs are more prominent than peak dots");
  assert.equal(App.markerSize("peak"), 6.5, "peak markers keep their established size");
});

test("alarm badge numbers are never heavier than semibold", () => {
  const loaded = loadApp();
  const { ctx, texts } = recorder();
  for (const lvl of [1, 2, 3]) loaded.App.drawBadge(ctx, lvl, 20, 20, 8);
  // Ray, 29 Oct: "remove all warning triangles". A warning draws nothing on a view.
  assert.deepEqual(texts.map((t) => t.text), ["2", "1"], "medium and critical carry their number");
  assert.equal(loaded.App.shapeMarkup(1), "", "no warning triangle in panels either");
  for (const t of texts) assert.ok(weight(t.font) <= 600, `badge ${t.text}: weight ${weight(t.font)}`);
  for (const lvl of [1, 2, 3]) {
    assert.doesNotMatch(loaded.App.shapeMarkup(lvl), /font-weight="[7-9]00"/, `SVG badge ${4 - lvl}`);
  }
});
