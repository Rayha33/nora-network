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

test("pressure limits: the number turns yellow, red, dark red, readable on its tag in both themes", () => {
  // Ray, 29 Oct: "only the number itself should turn yellow when we go above on pressure
  // not the whole square"; "we want to use strong colors sparingly".
  for (const theme of ["light", "dark"]) {
    const { App, NORA } = loadApp({ search: `?theme=${theme}` });
    const [lowLow, low, high, highHigh, integrity] = NORA.config.pressure_limits.hub;
    assert.equal(App.pressureMark("draupner_e", high - 0.1), null, "below high: a plain tag");
    assert.equal(App.pressureMark("draupner_e", low + 0.1), null, "above low: a plain tag");
    assert.deepEqual([low, lowLow].map((p) => App.pressureMark("draupner_e", p).code), ["L", "LL"], "low and low-low below");
    assert.equal(App.pressureMark("draupner_e", low).ink, App.pressureMark("draupner_e", high).ink, "L yellow like H");
    assert.equal(App.pressureMark("draupner_e", lowLow).ink, App.pressureMark("draupner_e", highHigh).ink, "LL red like HH");
    const marks = [high, highHigh, integrity].map((p) => App.pressureMark("draupner_e", p));
    assert.deepEqual(marks.map((m) => m.code), ["H", "HH", "INT"]);
    assert.ok(marks.every((m) => !("fill" in m)), "the tag itself is not coloured");
    assert.equal(new Set(marks.map((m) => m.ink)).size, 3, "three distinct colours");
    const tag = theme === "dark" ? NORA.config.colors_dark.paper : App.colors.card.active.fill;
    for (const m of marks) assert.ok(contrast(m.ink, tag) >= 3, `${theme} ${m.code}: ${contrast(m.ink, tag).toFixed(1)}:1 on its tag`);
    const hue = (hex) => { const [r, g] = [1, 3].map((i) => parseInt(hex.slice(i, i + 2), 16)); return r >= g; };
    assert.ok(marks.every((m) => hue(m.ink)), "yellow to red, warm hues");
    assert.ok(luminance(marks[2].ink) < luminance(marks[1].ink), "integrity darker than high-high");
    assert.equal(App.pressureMark("draupner_e", integrity + 20).code, "INT", "above integrity it stays at integrity");
  }
});

test("pressure limits: the tags fill with the colour, and zoomed in say which limit", () => {
  const { App, NORA, document } = play();
  const week = NORA.streams.find((s) => s.synthetic), block = week.metrics.pressure_bar;
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const seen = new Set();
  toHour(document, -400); // the scrub moves from the playhead: back to the first hour
  for (let hour = 0; hour < week.times.length; hour++, toHour(document, 1)) {
    for (const id of block.assets) {
      const mark = App.pressureMark(id);
      if (!mark || !pos[id] || NORA.config.flow.hide.includes(id)) continue; // not drawn in the Flow view
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
  for (const code of ["H", "HH", "L", "LL"]) assert.ok(seen.has(code), `the synthetic week passes ${code} now and then`);
});

test("pressure limits: a tag at a limit keeps its own fill; only its number is coloured", () => {
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
  assert.deepEqual(fills, [look.fill, look.fill], "both tags on the card's own fill");
  assert.deepEqual(texts.map((t) => t.color), [look.ink, mark.ink], "the number at the limit in its colour");
});

test("pressure limits: a node's alarm badge takes a corner no tag covers", () => {
  const { App } = loadApp();
  const corner = App.views.flow.badgeCorner;
  assert.deepEqual(Array.from(corner(0, 0, 50, [])), [48, -48], "top right by default");
  assert.deepEqual(Array.from(corner(0, 0, 50, [[40, -60, 100, -40]])), [-48, -48], "a tag there: top left");
});

/* A line's flow over its capacity: its number in the Flow view yellow over the load's
   warning level, red past the critical one (Ray, 29 Oct: "random pressure and flow limits
   breached ... a few of them turning red"). */
test("flow limits: a line's number turns yellow over capacity, red past the critical level", () => {
  const { App, NORA } = loadApp();
  const pid = App.pipeIds.find((id) => NORA.assets[id].capacity > 10), cap = NORA.assets[pid].capacity, T = NORA.config.thresholds.load;
  assert.equal(App.flowMark(pid, cap * 0.9), null, "under capacity: plain");
  assert.equal(App.flowMark(pid, -cap * (T[0] + 0.01)).ink, App.pressureMark("draupner_e", NORA.config.pressure_limits.hub[2]).ink, "over: yellow, either direction");
  assert.equal(App.flowMark(pid, cap * (T[2] + 0.01)).ink, App.pressureMark("draupner_e", NORA.config.pressure_limits.hub[3]).ink, "past critical: red");
});
