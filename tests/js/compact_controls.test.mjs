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
  assert.match(css, /\.player \.player-label\s*\{\s*display:\s*none/);
  assert.match(css, /\.now\s*\{\s*display:\s*flex/);
  assert.match(css, /\.play\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px/s);
  assert.match(css, /\.track\s*\{[^}]*height:\s*22px/s);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*--player-h:\s*88px/);
});
