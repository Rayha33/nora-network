/* Ray, 30 Oct: "nodes are covering other nodes, we cant have that". In the Flow view no
   square sits on another, nor on a tie-in's dot. The layout file keeps them apart; a node
   an edit in this browser put on another (moved or added, and replayed over a newer
   layout) gives way to the nearest clear place, and the nodes as laid out stay put. */
import test from "node:test";
import assert from "node:assert/strict";

import { loadApp } from "./harness.mjs";

function load() {
  const set = () => ({ update() {}, get: () => null, getIds: () => [] });
  const loaded = loadApp({ globals: { vis: { Network: class {} }, nodes: set(), edges: set(), flowOptions: {} } });
  const { App, NORA } = loaded;
  // As the Flow view draws them: not the Map-only nodes (nora.toml [flow] hide, or map detail with a map_min_zoom).
  const shown = Object.keys(NORA.grid).filter((id) => !NORA.config.flow.hide.includes(id) && !(NORA.assets[id].min_zoom > 0) && !App.nodeStyle(id).hidden);
  const tee = (id) => NORA.assets[id].type === "tee";
  // Squares closer than 0.95 of a step both across and down touch; a dot needs 0.6.
  const clashes = (grid) => {
    const out = [];
    for (const [i, a] of shown.entries()) for (const b of shown.slice(i + 1)) {
      if (tee(a) && tee(b)) continue;
      const room = tee(a) || tee(b) ? 0.6 : 0.95;
      if (Math.abs(grid[a][0] - grid[b][0]) < room && Math.abs(grid[a][1] - grid[b][1]) < room) out.push(`${a}/${b}`);
    }
    return out;
  };
  return { App, NORA, shown, tee, clashes, clear: App.views.flow.clearPlaces };
}

test("flow clear: the layout file keeps every square apart, and nothing in it moves", () => {
  const { NORA, shown, clashes, clear } = load();
  assert.deepEqual(clashes(NORA.grid), [], "no square on another in data/flow_layout.toml");
  const out = clear(NORA.grid);
  for (const id of shown) assert.deepEqual(out[id], NORA.grid[id], `${id} stays where it is laid out`);
});

test("flow clear: a node an edit put on another gives way to the nearest clear place", () => {
  const { NORA, shown, tee, clashes, clear } = load();
  const [a, b] = shown.filter((id) => !tee(id)).slice(0, 2);
  const dropped = [...NORA.grid[b]];
  const out = clear({ ...NORA.grid, [a]: dropped }, [a]);
  assert.deepEqual(out[b], NORA.grid[b], "the node as laid out stays put");
  assert.notDeepEqual(out[a], dropped, "the moved one does not sit on it");
  assert.deepEqual(clashes(out), [], "and lands clear of every other node");
  const away = Math.hypot(out[a][0] - dropped[0], out[a][1] - dropped[1]);
  assert.ok(away <= 1.5, `close to where it was put (${away.toFixed(2)} steps)`);
});

test("flow clear: of two edits on one place, the later gives way", () => {
  const { NORA, shown, tee, clear } = load();
  const [a, b, c] = shown.filter((id) => !tee(id)).slice(0, 3);
  const spot = [...NORA.grid[c]].map((v) => v + 20); // an empty place far below the drawing
  const out = clear({ ...NORA.grid, [a]: spot, [b]: spot }, [a, b]);
  assert.deepEqual(out[a], spot, "the earlier edit keeps its place");
  assert.notDeepEqual(out[b], spot, "the later one moves");
});
