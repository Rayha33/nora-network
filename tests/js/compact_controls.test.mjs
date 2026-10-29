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

test("a nominations row fits a third-width desk card, its rate never cut off", () => {
  // The rate ("▲4.2/h at 12:00") was clipped at 1440 px: fixed minimums summed past the card.
  const columns = css.match(/\.nom-row\s*\{[^}]*grid-template-columns:\s*([^;]+);/s)[1];
  // the least each column takes: a minmax's minimum, or a bare width
  const minimums = [...columns.matchAll(/minmax\((\d+)px/g)].map((m) => Number(m[1]));
  const bare = [...columns.replace(/minmax\([^)]*\)/g, "").matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
  const fixed = [...minimums, ...bare].reduce((sum, n) => sum + n, 0);
  assert.ok(fixed <= 140, `fixed column minimums ${fixed}px leave the values and the rate their own width`);
  assert.match(columns, /auto minmax\(\d+px, 108px\) auto/, "values and rate size to their content; the steps shrink first");
  assert.match(css, /\.nom-row svg\.steps\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*108px/s);
});
