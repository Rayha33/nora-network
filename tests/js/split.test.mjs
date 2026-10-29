/* Issue #59: on a wide or ultra-wide screen (2.2 times wider than tall, or more) the
   Map and the Flow show side by side; on an ordinary screen one of them, as before. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function unitAt(width, height, search = "") {
  const loaded = loadApp({ search });
  Object.assign(loaded.window, { innerWidth: width, innerHeight: height });
  try { loaded.App.go({ screen: "unit", unit: "all" }); } catch { /* mounting needs more of MapLibre and vis than the stub has */ }
  const shown = ["view-map", "view-flow"].filter((id) => !loaded.document.getElementById(id).hidden);
  return { ...loaded, shown };
}

test("side by side: a 32:9 screen shows the Map and the Flow together", () => {
  assert.deepEqual(unitAt(3840, 1080).shown, ["view-map", "view-flow"]);
});

test("side by side: a 16:9 screen shows one view, as before", () => {
  assert.equal(unitAt(1920, 1080).shown.length, 1);
});

test("side by side: ?split=1 forces it, ?split=0 and the home page's frame never", () => {
  assert.equal(unitAt(1920, 1080, "?split=1").shown.length, 2);
  assert.equal(unitAt(3840, 1080, "?split=0").shown.length, 1);
  assert.equal(unitAt(3840, 1080, "?embed=1").shown.length, 1);
});

test("side by side: other screens hide both views", () => {
  const { App, document } = unitAt(3840, 1080);
  App.go({ screen: "overview" });
  assert.equal(document.getElementById("view-map").hidden, true);
  assert.equal(document.getElementById("view-flow").hidden, true);
});
