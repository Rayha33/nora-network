import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../src/nora/templates/app.css", import.meta.url), "utf8");

test("map zoom controls are compact in both renderers", () => {
  assert.match(css, /\.maplibregl-ctrl-group button\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/s);
  assert.match(css, /\.map2d-zoom button\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px/s);
});

test("bottom player is shorter and visually simpler", () => {
  assert.match(css, /--player-h:\s*56px/);
  assert.match(css, /\.now \.player-label, \.speed \.player-label\s*\{\s*display:\s*none/);
  assert.doesNotMatch(css, /\.inventory \.player-label\s*\{\s*display:\s*none/, "Inventory keeps its label");
  assert.match(css, /\.now\s*\{\s*display:\s*flex/);
  assert.match(css, /\.play\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/s);
  assert.match(css, /\.track\s*\{[^}]*height:\s*22px/s);
});
