/* Review #49802: the What-if max flow in the browser must build the same graph as
   analysis.flow_graph. It used every node whatever its status, split only processing
   plants, and knew nothing of booked exit capacity (Baltic Pipe to Poland). */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

test("what-if: booked exit capacity is served first, as in the Python routing", () => {
  const { App, NORA } = loadApp();
  assert.equal(NORA.assets.pl_vtp.booked, 22);
  const r = App.whatif.result();
  assert.equal(Math.round(r.delivered.pl_vtp), 22, "Baltic Pipe carries Poland's booking");
  assert.equal(Math.round(r.value), 445, "the total is still the maximum");
});

test("what-if: an asset that is not operating carries no gas, like an offline one", () => {
  const { App, NORA } = loadApp();
  App.whatif.toggle("troll");
  const offline = App.whatif.result().value;
  App.whatif.clear();
  NORA.assets.troll.status = "decommissioned";
  assert.equal(App.whatif.result().value, offline, "a decommissioned field supplies nothing");

  const intact = loadApp();
  const pipe = intact.App.pipeIds.find((id) => Math.abs(intact.App.whatif.result().pipelines[id] || 0) > 30);
  const before = intact.App.whatif.result();
  intact.App.whatif.clear();
  intact.NORA.assets[pipe].status = "planned";
  const after = intact.App.whatif.result();
  assert.equal(after.pipelines[pipe] || 0, 0, `${pipe}: a planned pipeline carries nothing`);
  assert.ok(after.value <= before.value);
});

test("what-if: any capacitated node between supply and exits is a bottleneck", () => {
  const { App, NORA } = loadApp();
  const hub = "draupner_s";
  assert.equal(NORA.assets[hub].type, "hub", "not a processing plant, not a supplier, not an exit");
  // gas leaving the hub: along a line drawn from it, or against one drawn into it
  const through = (r) => App.pipeIds.reduce((sum, id) => {
    const p = NORA.assets[id], f = r.pipelines[id] || 0;
    return sum + (p.from === hub ? Math.max(0, f) : p.to === hub ? Math.max(0, -f) : 0);
  }, 0);
  assert.ok(through(App.whatif.result()) > 10);
  NORA.assets[hub].capacity = 10;
  App.whatif.clear();
  assert.ok(through(App.whatif.result()) <= 10 + 1e-6, "no more than its capacity leaves the hub");
});
