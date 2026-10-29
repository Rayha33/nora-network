/* map.js under the DOM-less harness: the view contract it registers with App,
   and the offline fallback when MapLibre cannot load. */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp, stubElement } from "./harness.mjs";

const { App } = await loadApp({ scripts: ["app.js", "map.js"] });

test("map.js registers a view implementing the view contract", () => {
  const view = App.views.map;
  assert.ok(view, "map.js registers with App.register");
  for (const method of ["mount", "restyle", "draw", "focus", "highlight", "setUnit", "fit", "resize"]) {
    assert.equal(typeof view[method], "function", `map view implements ${method}()`);
  }
  assert.equal(view.ready, false); // nothing mounts until the network view is shown
});

test("map.js falls back to a notice when MapLibre is unavailable", () => {
  const el = stubElement("div");
  App.views.map.mount(el);
  const notice = el.children.find((c) => c.className === "notice");
  assert.ok(notice, "appends the offline notice");
  assert.match(notice.textContent, /Flow view works offline/i);
});