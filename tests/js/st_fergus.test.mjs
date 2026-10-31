/* Issue #38, Ray, 31 Oct: "try to make space for it top left if possible. find a solution
   that works related to geographical location partly as well". St Fergus is three plants
   and the grid entry: SEGAL (FLAGS), PX (FUKA and Vesterled) and SAGE in a column top left,
   the UK grid entry west of them, the one exit. The links inside the site carry no
   settle-out number: they have no length to settle along. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const PLANTS = ["st_fergus_segal", "st_fergus_px", "st_fergus_sage"];

test("St Fergus: three plants top left, in the order their lines come in, the grid entry west of them", () => {
  const { NORA } = loadApp();
  const [stage, rank] = [(id) => NORA.grid[id][0], (id) => NORA.grid[id][1]];
  for (const id of PLANTS) {
    assert.equal(NORA.assets[id].type, "processing", id);
    assert.ok(rank(id) < -1.5 && stage(id) < 3.5, `${id} top left: rank ${rank(id)}, stage ${stage(id)}`);
    assert.ok(rank("st_fergus") < rank(id), `the grid entry is west of ${id}`);
  }
  assert.ok(stage("st_fergus_segal") < stage("st_fergus_px") && stage("st_fergus_px") < stage("st_fergus_sage"), "SEGAL, PX, SAGE from the top");
  const lands = (pid) => NORA.assets[pid].to;
  assert.deepEqual(["flags", "fuka", "vesterled", "sage"].map(lands), ["st_fergus_segal", "st_fergus_px", "st_fergus_px", "st_fergus_sage"]);
});

test("St Fergus: one exit, as before; the site links carry no settle-out number", () => {
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "600" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams.find((s) => s.synthetic).name } });
  const terminals = App.nodeIds.filter((id) => NORA.assets[id].type === "terminal");
  assert.ok(terminals.includes("st_fergus") && !PLANTS.some((id) => terminals.includes(id)), "the plants are not exits");
  for (const pid of ["segal_nts", "px_nts", "sage_nts"]) assert.equal(App.pipeStyle(pid).label, "", `${pid}: no number`);
  assert.notEqual(App.pipeStyle("flags").label, "", "FLAGS keeps its settle-out pressure");
});
