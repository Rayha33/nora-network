/* Ray, 30 Oct: "info, ETA and value glitches in and out as the peak or pig moves along the
   pipeline over time. fix this issue". A moving label keeps its corner while that stays
   clear, slides to the nearest clear spot (a second ring further out) before it gives up,
   and once left out comes back only after it has had room for 600 ms. Never text over
   text: with no clear spot at all it is still left out. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const { App } = loadApp();
const spot = (taken, memo, now = 0) => App.labelSpot(0, 0, 10, 40, 12, taken, memo, now);
const memo = () => ({ spot: null, shown: true, clearSince: null });

test("marker labels: a label keeps the corner it had while that stays clear", () => {
  const m = memo();
  assert.deepEqual(Array.from(spot([], m)), [10, -10], "first: up and to the right");
  m.spot = 1; // it had moved down-right earlier
  assert.deepEqual(Array.from(spot([], m)), [10, 10], "it stays there though up-right is clear again");
});

test("marker labels: blocked, a label slides to the nearest clear spot, further out if need be", () => {
  const m = memo();
  spot([], m);
  const near = [[-55, -17, 55, 17]]; // every corner next to the dot is taken
  const got = spot(near, m);
  assert.ok(got, "a spot in the outer ring");
  assert.deepEqual(Array.from(got), [25, -25], "the same corner, further out");
  assert.equal(spot([[-200, -200, 200, 200]], m), null, "no clear spot at all: left out, never on other text");
});

test("marker labels: once left out, a label comes back only after 600 ms of room", () => {
  const m = memo();
  assert.equal(spot([[-200, -200, 200, 200]], m, 1000), null);
  assert.equal(spot([], m, 1100), null, "room again, but only just");
  assert.equal(spot([], m, 1650), null, "550 ms: still waiting");
  assert.ok(spot([], m, 1701), "after 600 ms it is back");
  assert.equal(m.shown, true);
});

/* Seen on the live Flow, 30 Oct: a pig's three-line label (tag, ETA, speed) sat across its
   own pipeline, so "6.0 m/s" read as struck through. */
const crosses = ([lx, ly], h, angle, w = 40) => {
  const c = Math.cos(angle), s = Math.sin(angle);
  const sides = [[lx - 2, ly - h / 2], [lx + w + 2, ly - h / 2], [lx - 2, ly + h / 2], [lx + w + 2, ly + h / 2]]
    .map(([px, py]) => px * s - py * c);
  return Math.min(...sides) < 0 && Math.max(...sides) > 0;
};

test("marker labels: a tall label sits wholly beside its line, never across it", () => {
  for (const angle of [0, Math.PI, Math.PI / 4, -Math.PI / 4, Math.PI / 2, 2.6]) {
    const got = App.labelSpot(0, 0, 10, 40, 42, [], memo(), 0, angle);
    assert.ok(got, `a spot for a line at ${angle.toFixed(2)} rad`);
    assert.ok(!crosses(got, 42, angle), `clear of a line at ${angle.toFixed(2)} rad: ${Array.from(got)}`);
  }
});

test("marker labels: across its own line only when every other spot is taken", () => {
  const right = [[-200, -200, -1, 200]]; // all of the left side taken
  const got = App.labelSpot(0, 0, 10, 40, 42, right, memo(), 0, -Math.PI / 4);
  assert.ok(got, "it still shows on the right");
  assert.ok(!crosses(got, 42, -Math.PI / 4), "below the line that climbs to the upper right");
  const only = [[-200, -200, 200, -1], [-200, 0, -1, 200]]; // only the lower right is free
  assert.ok(App.labelSpot(0, 0, 10, 40, 42, only, memo(), 0, Math.PI / 4), "the lower right, though the line runs through it");
});
