/* Ray, 29 Oct: "if i change from light to dark mode or vice versa the page should stay in
   the exact same location and not zoom out every time". Going back to a view, or a theme
   switch, keeps where it was; only another unit fits the view to that unit. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

test("camera: back to a view it is where you left it; another unit fits that unit", () => {
  const { App } = loadApp();
  const fits = [];
  for (const name of ["map", "flow"]) {
    Object.assign(App.views[name], {
      mounted: true, ready: true, resize() {}, restyle() {}, highlight() {}, focus() {}, theme() {},
      setUnit: (unit) => fits.push(`${name}:${unit}`),
    });
  }
  App.state.view = "flow";
  App.go({ screen: "unit", unit: "all" });
  assert.deepEqual(fits, ["flow:all"], "the first time, the view is fitted");
  App.go({ screen: "overview" });
  App.go({ screen: "unit", unit: "all" });
  assert.deepEqual(fits, ["flow:all"], "back from the overview: no new fit");
  const unit = Object.keys(App.units).find((u) => u !== "all");
  App.go({ screen: "unit", unit });
  assert.deepEqual(fits, ["flow:all", `flow:${unit}`], "another unit: fitted to it");
});
