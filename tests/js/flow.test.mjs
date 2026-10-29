/* flow.js under the DOM-less harness: the view contract it registers with App,
   and that its methods are safe to call before the view is mounted. */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const { App } = await loadApp({ scripts: ["app.js", "flow.js"] });

test("flow.js registers a view implementing the view contract", () => {
  const view = App.views.flow;
  assert.ok(view, "flow.js registers with App.register");
  for (const method of ["mount", "restyle", "draw", "focus", "highlight", "setUnit", "fit", "resize"]) {
    assert.equal(typeof view[method], "function", `flow view implements ${method}()`);
  }
  assert.equal(view.ready, false);
});

test("flow.js methods are guarded before the view is mounted", () => {
  assert.doesNotThrow(() => {
    App.views.flow.restyle();
    App.views.flow.setUnit("all");
    App.views.flow.highlight(null);
    App.views.flow.draw();
  });
});