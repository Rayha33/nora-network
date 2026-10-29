/* The line-pack model (Ray, 29 Oct): the pack rate "normally we want to stay close to
   0"; the rate of change of pressure "especially in and out of SLR, DRP S and DRP E";
   "a trend showing total inventory in the whole system ... minimalistic". */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

// Two frames an hour apart with the pressures given at each end of Franpipe.
function twoHours(App, NORA, before, after) {
  const pipe = NORA.assets.franpipe;
  const frame = (t, [a, b]) => ({ t, flows: { franpipe: 50 }, metrics: { pressure_bar: { [pipe.from]: a, [pipe.to]: b, sleipner: a } }, plan: null });
  App.live.stream = { step: 3600 };
  App.live.frames = [frame(0, before), frame(3600, after)];
  App.live.index = 1;
  App.live.values = { franpipe: 50 };
}

test("line pack: a pipeline's gas from its size and end pressures, in MSm³", () => {
  const { App, NORA } = loadApp();
  twoHours(App, NORA, [140, 70], [140, 70]);
  const pipe = NORA.assets.franpipe, lp = App.linepack("franpipe", App.live.frames[1]);
  const volume = (Math.PI / 4) * (pipe.diameter * 0.0254) ** 2 * pipe.length * 1000;
  assert.ok(lp > volume * 80 / 1e6 && lp < volume * 140 / 1e6, `${lp} MSm³ lies between the end pressures' packs`);
  assert.equal(App.packRate("franpipe"), 0, "steady pressures: no packing");
  assert.equal(App.pipeStyle("franpipe").pack, "", "and nothing extra on the line");
  assert.ok(App.inventory(App.live.frames[1]) >= lp, "the inventory sums every line it can");
});

test("line pack: packing shows on the line, with its sign, as a model estimate", () => {
  const { App, NORA } = loadApp();
  twoHours(App, NORA, [140, 70], [140.5, 70.5]); // half a bar up in an hour
  const rate = App.packRate("franpipe");
  assert.ok(rate > 0.5 && rate < 40, `${rate} MSm³/d: a few, not hundreds`);
  assert.match(App.pipeStyle("franpipe").pack, /^pack \+\d/, "under the line's flow");
  assert.ok(Math.abs(App.pressureRate("sleipner") - 0.5) < 1e-9, "0.5 bar/h at Sleipner");
});

test("pressure tags: the watched hubs always show their rate, zoomed out too", () => {
  const { App, NORA } = loadApp();
  assert.deepEqual(Array.from(NORA.config.flow.watch), ["sleipner", "draupner_s", "draupner_e"]);
  twoHours(App, NORA, [140, 70], [140.5, 70.5]);
  App.state.mode = "live";
  const pos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id, { x: rank * 258, y: stage * 204 }]));
  const near = App.views.flow.pressureTags("sleipner", pos, 1.1, 64);
  assert.ok(near.length && near.every((t) => /▲0\.5$/.test(t.text)), `zoomed in: ${near[0] && near[0].text}`);
  const far = App.views.flow.pressureTags("sleipner", pos, 0.6, 64);
  assert.match(far[0].text, /▲0\.5$/, "zoomed out, a watched hub keeps its rate");
});

test("inventory: a number and a hairline in the player", () => {
  const html = (url) => import("node:fs").then((fs) => fs.readFileSync(new URL(url, import.meta.url), "utf8"));
  return html("../../src/nora/templates/app.html.j2").then((text) => {
    assert.match(text, /id="inventory"[^>]*hidden/, "hidden until there is data");
    assert.match(text, /id="inventory-value"/);
    assert.match(text, /id="inventory-spark"/);
  });
});

test("settle-out pressure: on the line, the number alone, from its end pressures", () => {
  const { App, NORA } = loadApp();
  twoHours(App, NORA, [140, 70], [140, 70]);
  App.state.mode = "live";
  const sop = App.settleOut("franpipe");
  assert.ok(sop > 105 && sop < 115, `${sop} bar: the compressible mean of 140 and 70 bar, above the plain 105`);
  assert.equal(App.pipeStyle("franpipe").label, App.fmt(sop, 1), "Ray's old screen: sop on the lines, the number alone (29 Oct); flows are in the squares");
});
