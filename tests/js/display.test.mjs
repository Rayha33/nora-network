/* Control-room display profiles (issue #59): the profile and the one UI scale come
   from the window, unless ?display= / ?scale= (or Settings) say otherwise. */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { TEMPLATES, loadPayload, assertHealthy } from "./harness.mjs";
import { makeDom, makeSandbox } from "./stub.mjs";

function load({ width = 1280, search = "", stored = {} } = {}) {
  const nora = loadPayload();
  const document = makeDom();
  const sandbox = makeSandbox({ nora, document, search });
  sandbox.window.innerWidth = width;
  for (const [key, value] of Object.entries(stored)) sandbox.window.localStorage.setItem(key, value);
  const context = vm.createContext(sandbox, { name: "nora-dom" });
  for (const name of ["app.js", "map2d.js", "map.js", "flow.js"]) {
    vm.runInContext(readFileSync(path.join(TEMPLATES, name), "utf8"), context, { filename: name });
  }
  const App = vm.runInContext("App", context);
  assertHealthy(assert, { App, NORA: nora });
  return { App, document };
}

test("auto: the window picks the profile and the scale", () => {
  const cases = [
    [390, "compact", 1], [768, "compact", 1], [1366, "desk", 1], [1920, "desk", 1],
    [2560, "desk", 1.17], [3840, "wall", 1.5], [7680, "wall", 2.2], [10000, "wall", 2.2],
  ];
  for (const [width, profile, scale] of cases) {
    const { App } = load({ width });
    assert.equal(App.display(), profile, `${width} px is a ${profile}`);
    assert.equal(App.uiScale(), scale, `${width} px: scale ${scale}`);
  }
});

test("a wall is large and dark unless the operator chose a theme", () => {
  const wall = load({ width: 1920, search: "?display=wall" });
  assert.equal(wall.App.display(), "wall");
  assert.equal(wall.App.uiScale(), 1.5, "readable from metres away: at least 150 %");
  assert.equal(wall.document.documentElement.dataset.theme, "dark");
  assert.equal(wall.App.colors.card.inactive.ink, wall.App.colors.text, "dark-gray nodes use light primary text");
  assert.equal(wall.App.colors.card.inactive.dim, wall.App.colors.text_dim, "secondary text inside dark-gray nodes stays light too");
  const chosen = load({ width: 3840, stored: { "nora-theme": "light" } });
  assert.equal(chosen.App.display(), "wall");
  assert.equal(chosen.document.documentElement.dataset.theme, "light", "the operator's choice wins");
  const desk = load({ width: 1920 });
  assert.equal(desk.document.documentElement.dataset.theme, "light");
});

test("?scale= and Settings override the scale; nonsense falls back to auto", () => {
  assert.equal(load({ search: "?scale=150" }).App.uiScale(), 1.5, "per cent");
  assert.equal(load({ search: "?scale=1.25" }).App.uiScale(), 1.25, "a factor");
  assert.equal(load({ search: "?scale=banana" }).App.uiScale(), 1);
  assert.equal(load({ search: "?scale=40" }).App.uiScale(), 1, "below 75 % is refused");
  const saved = load({ stored: { "nora-settings": JSON.stringify({ scale: "1.75", display: "desk" }) }, width: 3840 });
  assert.equal(saved.App.display(), "desk", "Settings pick the profile");
  assert.equal(saved.App.uiScale(), 1.75, "and the size");
  assert.equal(load({ search: "?display=compact", width: 3840 }).App.display(), "compact");
});

test("the scale reaches the page as --ui-scale and a data-display attribute", () => {
  const props = {};
  const nora = loadPayload();
  const document = makeDom();
  document.documentElement.style = { setProperty: (k, v) => { props[k] = v; } };
  const sandbox = makeSandbox({ nora, document, search: "?scale=2" });
  const context = vm.createContext(sandbox, { name: "nora-dom" });
  vm.runInContext(readFileSync(path.join(TEMPLATES, "app.js"), "utf8"), context, { filename: "app.js" });
  assert.equal(props["--ui-scale"], "2");
  assert.equal(document.documentElement.dataset.display, "desk");
});
