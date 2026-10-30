/* Full review, 30 Oct. A satellite's tie-back is not a line with no gas in it: its gas is in
   its host's figure, so the asset's "In context" says tie-back. On a video wall the Flow
   view's on-screen text (pressure tags, names, line values) grows with the UI scale, as the
   bar and the moving labels already did. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

test("review: a host's In context calls its satellite's line a tie-back, not 0.0", () => {
  const { App, NORA, document } = loadApp();
  document.getElementById("speed").options = [{ value: "600" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  assert.ok(NORA.assets.fram_troll && NORA.assets.fram.min_zoom > 0, "Fram is map detail, tied back to Troll");
  App.go({ screen: "asset", asset: "troll" });
  let markup = "";
  walk(document.getElementById("screen-asset"), (n) => { if (/Fram - Troll/.test(n._innerHTML || "")) markup = n._innerHTML; });
  assert.ok(markup, "the context picture lists Fram's line");
  const row = markup.slice(markup.indexOf("Fram - Troll"), markup.indexOf("Fram - Troll") + 300);
  assert.match(row, />tie-back</, "said as a tie-back");
  assert.doesNotMatch(row, />0\.0</, "not as a line carrying nothing");
});

test("review: on a wall the Flow view's pressure tags grow with the UI scale", () => {
  const desk = loadApp(), wall = loadApp({ search: "?scale=2" });
  assert.equal(wall.App.uiScale(), 2);
  const positions = { troll: { x: 0, y: 0 }, kollsnes: { x: 0, y: 400 } };
  const box = (loaded) => loaded.App.views.flow.pressureTags("troll", positions, 1, 64).find((t) => t.pid === "troll_kollsnes").box;
  const [a, b] = [box(desk), box(wall)];
  assert.ok(Math.abs((b[2] - b[0]) - 2 * (a[2] - a[0])) < 0.01, `twice as wide: ${a[2] - a[0]} -> ${b[2] - b[0]}`);
  assert.ok(Math.abs((b[3] - b[1]) - 2 * (a[3] - a[1])) < 0.01, "and twice as high");
});

test("review: a small zoomed-out square drops the M and the decimal before it cuts a number", () => {
  const { App } = loadApp();
  const drawn = [];
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (t) => ({ width: String(t).length * 7 });
      if (key === "fillText") return (t) => drawn.push(String(t));
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  const draw = (half) => { drawn.length = 0; App.views.flow.drawOverviewFlows(ctx, 0, 0, "gjoa", App.colors.card.active, { half, total: 4.04, day: null, scale: 0.5 }); return drawn.filter((t) => /\d/.test(t)); };
  // Half a side on screen: 30 px, 14 px, 11.5 px (the room is 1.8 times that; 7 px a character).
  assert.deepEqual(draw(60), ["4.0M"], "room for all of it");
  assert.deepEqual(draw(28), ["4.0"], "the M gives way first");
  assert.deepEqual(draw(23), ["4"], "then the decimal");
  assert.ok(!draw(60).concat(draw(28), draw(23)).some((t) => t.includes("…")), "never cut to 4…");
});
