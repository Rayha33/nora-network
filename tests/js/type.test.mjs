/* Ray's type rules for everything drawn on a canvas: labels are never smaller than
   11 px, and nothing is heavier than semibold (600), not even the alarm numbers. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

/* Ray, 29 Oct: "the numbers are sometimes difficult to see". Incoming flows, the
   rate and the line values read at 4.5:1 or better on their card or paper, in both
   themes; the dark top bar's unselected switches too. */
test("numbers read at 4.5:1 or better on their card, in both themes", () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const theme of ["light", "dark"]) {
    const { App, NORA } = loadApp({ search: `?theme=${theme}` });
    for (const state of ["active", "normal"]) {
      const look = App.colors.card[state];
      assert.ok(contrast(look.soft, look.fill) >= 4.5, `${theme} ${state}: incoming flows ${contrast(look.soft, look.fill).toFixed(2)}:1`);
      assert.ok(contrast(look.ink, look.fill) >= 4.5, `${theme} ${state}: outgoing flows`);
    }
    const palette = theme === "dark" ? NORA.config.colors_dark : NORA.config.colors;
    assert.ok(contrast(palette.text, palette.paper) >= 4.5, `${theme}: line values on the paper`);
  }
  const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");
  assert.match(css, /:root\[data-theme="dark"\] \.seg button:not\(\[aria-selected="true"\]\) \{ color: var\(--text\); \}/);
});

test("a pig's label reads on the paper in both themes", () => {
  // Ray, 29 Oct: "here its difficult to read the actual text PIG, maybe change the color for pigs".
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const { NORA } = loadApp();
  for (const palette of [NORA.config.colors, NORA.config.colors_dark]) {
    assert.ok(contrast(palette.pig, palette.paper) >= 4.5, `pig ${palette.pig} on ${palette.paper}: ${contrast(palette.pig, palette.paper).toFixed(1)}:1`);
  }
});
