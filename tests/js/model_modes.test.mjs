/* Review #49802: Risk mode painted the N-1 model answer with the alarm palette and
   shapes (15+ red and orange badges while the top bar counted 4 alarms), and Load did
   the same for full lines. Alarms belong to Live; the model modes show their answer by
   line weight, node size and the number. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

for (const mode of ["risk", "load"]) {
  test(`${mode} mode: no alarm badge or level on any asset`, () => {
    const { App } = loadApp();
    App.state.mode = mode;
    for (const id of App.pipeIds) assert.equal(App.pipeStyle(id).level, 0, `${id} has no alarm level`);
    for (const id of App.nodeIds) assert.equal(App.nodeStyle(id).level, 0, `${id} has no alarm level`);
  });
}

test("risk mode: the line that loses most is drawn heaviest, and keeps its number", () => {
  const { App, NORA } = loadApp();
  App.state.mode = "risk";
  const pipes = App.pipeIds.filter((id) => NORA.assets[id].type !== "onshore" && NORA.assets[id].lost > 0);
  const byLoss = [...pipes].sort((a, b) => NORA.assets[b].lost - NORA.assets[a].lost);
  const [big, small] = [byLoss[0], byLoss[byLoss.length - 1]];
  assert.ok(NORA.assets[big].lost > NORA.assets[small].lost);
  assert.ok(App.pipeStyle(big).width > App.pipeStyle(small).width, "heavier line, bigger loss");
  assert.match(App.pipeStyle(big).label, /^−\d/);
  const node = App.nodeIds.filter((id) => NORA.assets[id].lost > 0).sort((a, b) => NORA.assets[b].lost - NORA.assets[a].lost)[0];
  assert.match(App.nodeStyle(node).sub, /if it trips/);
});
