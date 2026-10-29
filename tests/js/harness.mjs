/* Shared harness for the JS tests: loads the three app templates into a vm context
   with the real payload fixture and the DOM stub, and returns the resulting App.

   The templates are plain browser scripts (IIFEs, no imports), so they are evaluated
   in order — app.js first, it defines App; then map.js and flow.js, which register
   their views with App.register and only touch MapLibre / vis-network inside
   mount(), which the tests never call. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

import { makeDom, makeSandbox } from "./stub.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATES = path.join(HERE, "..", "..", "src", "nora", "templates");

/* app.js is kept in parts (templates/app/, issue #50), joined in the order of
   templates/app/order.txt as render.py joins them: one script, one IIFE. */
export function appSource() {
  const dir = path.join(TEMPLATES, "app");
  const names = readFileSync(path.join(dir, "order.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return names.map((name) => readFileSync(path.join(dir, name), "utf8")).join("");
}
// A template's source by its name as the page uses it: "app.js" is the joined parts.
export const templateSource = (name) => (name === "app.js" ? appSource() : readFileSync(path.join(TEMPLATES, name), "utf8"));

export function loadPayload() {
  return JSON.parse(readFileSync(path.join(HERE, "fixtures", "payload.json"), "utf8"));
}

/* Evaluate the three templates in one context. `search` becomes location.search, so
   URL-driven behaviour (?embed=1, ?theme=…) can be exercised per test. `globals` adds
   browser objects the stub lacks (a fake maplibregl, Path2D) for the tests that mount
   a map view. */
export function loadApp({ search = "", globals = {} } = {}) {
  const nora = loadPayload();
  const document = makeDom();
  const sandbox = Object.assign(makeSandbox({ nora, document, search }), globals);
  const context = vm.createContext(sandbox, { name: "nora-dom" });
  const sources = {
    app: appSource(),
    map2d: readFileSync(path.join(TEMPLATES, "map2d.js"), "utf8"),
    map: readFileSync(path.join(TEMPLATES, "map.js"), "utf8"),
    flow: readFileSync(path.join(TEMPLATES, "flow.js"), "utf8"),
  };
  for (const [name, code] of Object.entries(sources)) {
    vm.runInContext(code, context, { filename: `${name}.js` });
  }
  // Top-level `const App` lives in the context's lexical scope, not on the global
  // object, so read it back out through the context rather than sandbox.App.
  const App = vm.runInContext("App", context);
  return { App, NORA: nora, document, nora, window: sandbox.window };
}

/* The smoke check every test file can lean on: the templates evaluate without
   touching the network or a real DOM, and both views registered. */
export function assertHealthy(t, { App, NORA }) {
  t.ok(App, "app.js defines App");
  t.ok(App.live, "App exports its live state");
  t.ok(App.register, "App.register exists");
  t.deepEqual(
    Object.keys(App.views).sort(),
    ["flow", "map"],
    "both views registered with App.register",
  );
  t.ok(Array.isArray(App.nodeIds) && App.nodeIds.length > 0, "App.nodeIds is a non-empty array");
  t.ok(Array.isArray(App.pipeIds) && App.pipeIds.length > 0, "App.pipeIds is a non-empty array");
  t.equal(App.nodeIds.length + App.pipeIds.length, Object.keys(NORA.assets).length,
    "nodeIds + pipeIds cover every asset in the payload");
}
