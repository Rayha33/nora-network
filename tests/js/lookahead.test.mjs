/* Ray, 29 Oct: "it should be easy to see if a nomination increase at an exit point in the
   future and we dont increase the input flow into that pipeline, we wont be able to reach
   the nomination level because the exit point pressure will be too low. seeing this into
   the future as a lookahead function should be ongoing calculations being done and shown /
   illustrated in a suble and minimalstic way". */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function week() {
  const loaded = loadApp();
  const { document, NORA } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams.find((s) => s.synthetic).name } });
  const scrub = document.getElementById("scrub"), move = (s) => { scrub.value = String(s); scrub._listeners.input[0]({ target: { value: scrub.value } }); };
  move(-400 * 3600);
  return { ...loaded, move };
}
const exitsOf = (NORA) => Object.keys(NORA.assets).filter((id) => NORA.assets[id].exit);

test("lookahead: with the input as now, a rising nomination draws the line pack down; under the low limit is short", () => {
  const { App, NORA, move } = week();
  let checked = 0, short = 0, hours = 0;
  for (let k = 0; k < NORA.streams.find((s) => s.synthetic).times.length; k++, move(3600)) {
    for (const id of exitsOf(NORA)) {
      const r = App.reachAhead(id);
      if (!r) continue;
      hours += 1;
      const [now, ...ahead] = r.hours;
      let previous = now.pressure;
      for (const hour of ahead) {
        if (hour.pressure == null) continue;
        assert.ok(hour.pressure <= previous + 1e-9, `${id}: the pack only drains while the input stays`);
        assert.equal(hour.short, hour.pressure < r.low);
        if (hour.value <= r.input) assert.ok(Math.abs(hour.pressure - previous) < 1e-9, "no more out than in: nothing drawn");
        previous = hour.pressure;
        checked += 1;
      }
      if (r.first) short += 1;
    }
  }
  assert.ok(checked > 500, `checked ${checked} hours ahead`);
  assert.ok(short > 0 && short < hours * 0.1, `${short} of ${hours} exit-hours short: now and then, never everywhere`);
});

test("lookahead: shown in place, the short hour's step in the warning colour and 'short HH:MM' in the list", () => {
  const { App, NORA, document, move } = week();
  let id = null;
  for (let k = 0; k < 168 && !id; k++, move(3600)) id = exitsOf(NORA).find((e) => App.reachAhead(e) && App.reachAhead(e).first) || null;
  assert.ok(id, "the synthetic week has an hour that would be short");
  App.go({ screen: "overview" });
  const text = document.getElementById("screen-overview").textContent;
  assert.match(text, new RegExp(`${NORA.assets[id].name}.*short \\d\\d:\\d\\d`), "the nominations list says when");
  // The Flow square's six steps: the short hours drawn again, in the warning colour.
  const strokes = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "stroke" ? () => strokes.push(t.strokeStyle) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  App.views.flow.drawNominationSteps(ctx, id, 0, 0, 120, 30, { ink: "#222222" });
  assert.ok(strokes.includes(App.limitInk(1)), "a step in the warning colour");
});
