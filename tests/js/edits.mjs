/* Edits for the editor's tests (edit.test.mjs) and the Python cross-check
   (edited_files.mjs, tests/test_editor_files.py): a node and a line removed, a field
   added and connected, and a step that no longer applies. */

import { loadApp } from "./harness.mjs";

export const STEPS = [
  { op: "removeNode", id: "gudrun" },
  { op: "removeLine", id: "ogt" },
  { op: "addNode", node: { id: "snorre", name: "Snorre", type: "field", unit: "northern_north_sea", country: "NO", lat: 61.45, lon: 2.14, capacity: 4, grid: [1, 2.5] } },
  { op: "addLine", line: { id: "snorre_statfjord", name: "Snorre – Statfjord", from: "snorre", to: "statfjord", type: "feeder", capacity: 4, bidirectional: false } },
  { op: "moveNode", id: "sleipner", grid: [3, 5.25] }, // dragged in the Flow view
  { op: "editNode", id: "statfjord", changes: { name: "Statfjord A", unit: "hubs", capacity: 9, operator: "Equinor, \"Statfjord\"" } }, // the node form
  { op: "editLine", id: "europipe_1", changes: { name: "Europipe 1", length: 661, bidirectional: true } }, // the line form
  { op: "removeNode", id: "no_such_node" }, // the data changed under it: skipped
];

export function storage(steps) {
  const store = new Map([["nora-edits", JSON.stringify(steps)]]);
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    store,
  };
}

export function editedApp(steps = STEPS) {
  const localStorage = storage(steps);
  return { ...loadApp({ globals: { localStorage } }), localStorage };
}
