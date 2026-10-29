/* The map's position readout gives the EMODnet depth there as ED, from the seabed model
   shipped in the page. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

// The browser's own inflate, which the page uses to unpack the depth grid.
const browser = { DecompressionStream, Blob, Response, atob };

test("water depth: real depths at known platforms, none on land", async () => {
  const { App, NORA } = loadApp({ globals: browser });
  assert.ok(NORA.depth, "the page carries the depth grid");
  await App.depth.ready();
  const at = (id) => App.depth.at(NORA.assets[id].lon, NORA.assets[id].lat);
  // Published water depths: Troll A 303 m, Sleipner 82 m, Ekofisk about 70-75 m,
  // Johan Sverdrup about 115 m, Aasta Hansteen about 1300 m.
  for (const [id, low, high] of [["troll", 250, 350], ["sleipner", 65, 100], ["ekofisk", 60, 90], ["johan_sverdrup", 95, 135], ["aasta_hansteen", 1100, 1500]]) {
    const depth = at(id);
    assert.ok(depth >= low && depth <= high, `${id}: ${depth} m, expected ${low}-${high} m`);
  }
  assert.equal(App.depth.at(10.75, 59.91), null, "Oslo is on land: no water depth");
  assert.equal(App.depth.at(-30, 60), null, "outside the grid: no water depth");
});

test("water depth: the readout says ED in metres instead of the zoom, in N and E", async () => {
  const { App, NORA } = loadApp({ globals: browser });
  await App.depth.ready();
  const troll = NORA.assets.troll;
  assert.match(App.positionText(troll.lon, troll.lat), /^60\.64600°N {2}3\.72600°E {2}· {2}ED \d+ m$/);
  assert.equal(App.positionText(-1.08, 53.96), "53.96000°N  -1.08000°E", "west is a negative east; on land (York) no depth");
  assert.doesNotMatch(App.positionText(troll.lon, troll.lat), /zoom/);
});
