/* Ray, 29 Oct: "remember that pressure number inside rectangles should change color when
   meeting a limit, high = yellow, high high = red, integrity = dark red". The limits are
   nora.toml [pressure_limits]; a tag at one fills with its colour, its number in the ink
   that reads on it, and zoomed in says which limit (H, HH, INT). */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function play() {
  const loaded = loadApp();
  const { document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  const week = NORA.streams.find((s) => s.synthetic);
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: week.name } });
  return loaded;
}
function toHour(document, hour) {
  const scrub = document.getElementById("scrub");
  scrub.value = String(hour * 3600);
  scrub._listeners.input[0]({ target: { value: scrub.value } });
}
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("pressure limits: high is yellow, high-high red, integrity dark red, each readable", () => {
  const { App, NORA } = loadApp();
  const [high, highHigh, integrity] = NORA.config.pressure_limits.hub;
  assert.equal(App.pressureMark("draupner_e", high - 0.1), null, "below high: a plain tag");
  const marks = [high, highHigh, integrity].map((p) => App.pressureMark("draupner_e", p));
  assert.deepEqual(marks.map((m) => m.code), ["H", "HH", "INT"]);
  assert.deepEqual(marks.map((m) => m.fill), [App.colors.warning, App.colors.critical, App.colors.integrity]);
  assert.equal(App.colors.warning, NORA.config.colors.warning, "yellow (amber) at high");
  assert.notEqual(App.colors.integrity, App.colors.critical, "integrity is its own, darker red");
  assert.ok(luminance(App.colors.integrity) < luminance(App.colors.critical), "darker than the high-high red");
  for (const m of marks) assert.ok(contrast(m.fill, m.ink) >= 3.5, `${m.code}: its number reads on the fill (${contrast(m.fill, m.ink).toFixed(1)}:1)`);
  assert.equal(App.pressureMark("draupner_e", integrity + 20).code, "INT", "above integrity it stays at integrity");
});

test("pressure limits: the tags fill with the colour, and zoomed in say which limit", () => {
  const { App, NORA, document } = play();
  const week = NORA.streams.find((s) => s.synthetic), block = week.metrics.pressure_bar;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const seen = new Set();
  for (let hour = 0; hour < week.times.length; hour++) {
    toHour(document, hour);
    for (const id of block.assets) {
      const mark = App.pressureMark(id);
      if (!mark || !pos[id]) continue;
      seen.add(mark.code);
      const zoomedIn = App.views.flow.pressureTags(id, pos, 1.1, 64), zoomedOut = App.views.flow.pressureTags(id, pos, 0.6, 64);
      assert.ok(zoomedIn.length && zoomedIn.every((t) => t.mark && t.mark.code === mark.code && t.text.startsWith(`${mark.code} `)), `${id} hour ${hour}: "${mark.code}" on every tag`);
      assert.ok(zoomedOut.every((t) => t.mark === mark || t.mark.code === mark.code), `${id}: zoomed out the tags fill too`);
      assert.ok(zoomedOut.every((t) => !/[A-Z]/.test(t.text)), "zoomed out, the number alone");
      const alarm = App.live.conditions.find((c) => c.kind === "pressure" && c.id === id);
      assert.ok(alarm && alarm.text.includes(`${mark.name} limit`), `${id} hour ${hour}: the alarm list says the ${mark.name} limit`);
      assert.equal(alarm.level, mark.level === 1 ? 1 : 3, "high a warning; high-high and integrity critical");
    }
  }
  assert.deepEqual([...seen].sort(), ["H", "HH", "INT"], "the synthetic week shows all three");
});

test("pressure limits: a tag at a limit is drawn on its colour, its number in that ink", () => {
  const { App } = loadApp();
  const fills = [], texts = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "fill") return () => fills.push(target.fillStyle);
      if (key === "fillText") return (text) => texts.push({ text, color: target.fillStyle });
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const look = { fill: "#f1f2f3", edge: "#50575d", ink: "#22272b" }, mark = App.pressureMark("draupner_e", 200);
  App.views.flow.drawPressureTags(ctx, [
    { box: [0, 0, 60, 16], text: "150 bar", small: false, mark: null },
    { box: [0, 20, 60, 36], text: "INT 200 bar", small: false, mark },
  ], look);
  assert.deepEqual(fills, [look.fill, App.colors.integrity], "a plain tag on the card, the other on dark red");
  assert.deepEqual(texts.map((t) => t.color), [look.ink, mark.ink]);
});

test("pressure limits: a node's alarm badge takes a corner no tag covers", () => {
  const { App } = loadApp();
  const corner = App.views.flow.badgeCorner;
  assert.deepEqual(Array.from(corner(0, 0, 50, [])), [48, -48], "top right by default");
  assert.deepEqual(Array.from(corner(0, 0, 50, [[40, -60, 100, -40]])), [-48, -48], "a tag there: top left");
});
