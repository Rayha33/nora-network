/* The steady-state What-if (Ray, 29 Oct): "users change production deliveries and pipeline
   packing to see how the network balance and pipeline flows change. it then uses
   pipeline-specific regression formulas and correction factor to estimate pressures and
   the flow of gas stored in each pipeline"; "when clicking on a node i should be able to
   add my own flow and pressure values that are temporary"; "how the whole overview will
   look based on nominations for the next gas day". */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function play() {
  const loaded = loadApp();
  const { document, NORA, App } = loaded;
  document.getElementById("speed").options = [{ value: "60" }];
  const week = NORA.streams.find((s) => s.synthetic);
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: week.name } });
  const scrub = document.getElementById("scrub");
  scrub.value = String(-400 * 3600); // the first hour, then a day in
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  scrub.value = String(30 * 3600);
  scrub._listeners.input[0]({ target: { value: scrub.value } });
  App.state.mode = "whatif";
  return loaded;
}
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test("what-if: with nothing changed, every flow and pressure is today's", () => {
  const { App, NORA } = play();
  const w = App.whatif.state(), f = App.live.frames[App.live.index];
  for (const pid of App.pipeIds) {
    const today = f.flows[pid];
    if (today === undefined || NORA.assets[pid].status !== "operating") continue;
    assert.ok(near(w.frame.flows[pid], today, 1e-6), `${pid}: ${w.frame.flows[pid]} vs today's ${today}`);
  }
  for (const [id, p] of Object.entries(f.metrics.pressure_bar)) {
    if (w.pressure[id] == null) continue;
    assert.ok(near(w.pressure[id], p, 1e-3), `${id}: ${w.pressure[id]} vs today's ${p}`);
  }
});

test("what-if: more production at a field reaches the exits; packing comes off the delivery", () => {
  const { App, NORA } = play();
  const before = App.whatif.state().balance;
  App.whatif.set("supply", "troll", App.whatif.state().supply.troll + 10);
  const more = App.whatif.state().balance;
  assert.ok(near(more.produced, before.produced + 10, 1e-6) && near(more.delivered, before.delivered + 10, 1e-6), "10 more in, 10 more out");
  const line = App.pipeIds.find((pid) => NORA.assets[pid].from === "troll" || NORA.assets[pid].to === "troll");
  App.whatif.set("pack", line, 5);
  const w = App.whatif.state();
  assert.ok(near(w.lines[line].into - w.lines[line].out, 5), "the line takes in 5 more than it delivers");
  assert.ok(near(w.balance.packed, 5) && near(w.balance.delivered, more.delivered - 5, 1e-6), "the balance: 5 packed, 5 less out");
  assert.equal(App.pipeStyle(line).pack, "pack +5.0", "the line says it packs");
  App.whatif.reset();
  assert.ok(near(App.whatif.state().balance.delivered, before.delivered, 1e-6), "Reset clears your values");
});

test("what-if: a pressure you set holds, and the nodes upstream move with it", () => {
  const { App } = play();
  const w0 = App.whatif.state(), id = "kollsnes", p0 = w0.pressure[id];
  App.whatif.set("pressure", id, p0 + 8);
  const w = App.whatif.state();
  assert.ok(near(w.pressure[id], p0 + 8, 1e-6), "yours holds");
  assert.ok(w.pressure.troll > w0.pressure.troll + 1, `Troll, upstream, rises with it: ${w0.pressure.troll} -> ${w.pressure.troll}`);
  assert.equal(App.reading(id).pressure, w.pressure[id], "the views draw the what-if's pressure");
});

test("what-if: a field offline sends nothing; the next gas day's nominations drive the exits", () => {
  const { App, NORA } = play();
  App.whatif.toggle("troll");
  assert.equal(App.whatif.state().supply.troll, 0, "an offline field produces nothing");
  App.whatif.reset();
  App.whatif.scenario("next");
  const w = App.whatif.state();
  for (const id of Object.keys(w.delivered)) {
    if (w.nominations[id] != null) assert.ok(near(w.delivered[id], w.nominations[id], 1e-6), `${id} takes the next gas day's nomination`);
  }
  const today = App.whatif.scenario("now") && App.whatif.state().balance;
  App.whatif.scenario("next");
  assert.ok(near(w.balance.produced - today.produced, w.balance.delivered - today.delivered, 1e-6), "the fields make what more the exits take");
  App.whatif.set("offtake", "dornum", (w.nominations.dornum || 0) + 6);
  assert.ok(near(App.whatif.state().balance.produced, w.balance.produced + 6, 1e-6), "6 more out at Dornum: 6 more made upstream");
  assert.ok(NORA.pipeModels.norpipe && NORA.pipeModels.norpipe.a > 0, "the pipeline models reach the page");
});

test("what-if: a click opens the asset's card; its inputs are your values", () => {
  const { App, document } = play();
  App.go({ screen: "unit", unit: "all" });
  App.select("troll");
  const body = document.getElementById("side-body");
  const find = (el, test) => (test(el) ? el : (el.children || []).map((c) => (c && typeof c === "object" ? find(c, test) : null)).find(Boolean) || null);
  const production = find(body, (el) => el.attributes && el.attributes.get && el.attributes.get("data-key") === "whatif:supply:troll");
  assert.ok(production, "a production input for a field");
  const made = App.whatif.state().supply.troll;
  production.value = String(made - 20);
  production._listeners.change[0]();
  assert.ok(near(App.whatif.state().supply.troll, made - 20), "typed in, taken");
  assert.match(body.textContent, /What-if/);
});

test("what-if: with nothing changed, in and out balance over every exit, markets too", () => {
  const { App } = play();
  const b = App.whatif.state().balance;
  assert.ok(Math.abs(b.produced - b.packed - b.delivered) < 0.5, `in ${b.produced}, out ${b.delivered}: Poland and Tjeldbergodden are exits too`);
});

test("what-if: a line's pack now and then on the same pressures; a tie-in's from the model", () => {
  const { App } = play();
  const w = App.whatif.state();
  assert.ok(w.pressureNow.ekofisk_tee > 0, "the Ekofisk tie-in has a model pressure now");
  assert.ok(Math.abs(w.pack.norpipe.then - w.pack.norpipe.now) < 1e-6, "nothing changed: the same line pack");
  assert.ok(Math.abs(w.balance.offNominations) < 1, "on nominations, over the exits that have one");
});
