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
