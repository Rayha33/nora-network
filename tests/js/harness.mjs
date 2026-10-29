/* DOM-less test harness for the template scripts (app.js, map.js, flow.js).

   Node evaluates the same files the page gets, in a `vm` context with just
   enough browser to exist: a `location`, a `localStorage`, a `document` of
   stub elements, `matchMedia`, and the `NORA` payload the real page would be
   given (tests/test_js.py writes it from render.nora_payload, so the scripts
   under test see exactly what production provides). No jsdom, no network:
   anything the scripts do with the DOM is observable on the stubs.

   Set NORA_PAYLOAD=<path to nora.json> (pytest does this), then run the
   template scripts in order and inspect what they left behind. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { argv, env } from "node:process";

const TEMPLATES = resolve(import.meta.dirname, "../../src/nora/templates");

/** A stub DOM element: records what the app does to it, never renders. */
export function stubElement(tag = "div") {
  const element = {
    tagName: tag.toUpperCase(),
    children: [],
    style: { setProperty() {} },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    attributes: {},
    listeners: {},
    hidden: true,
    value: "",
    textContent: "",
    innerHTML: "",
    clientWidth: 800,
    clientHeight: 600,
    append(...kids) { element.children.push(...kids.flat(Infinity)); },
    appendChild(kid) { element.children.push(kid); return kid; },
    addEventListener(type, fn) { (element.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatch(type, event = {}) {
      for (const fn of element.listeners[type] || []) fn({ currentTarget: element, target: element, ...event });
    },
    setAttribute(key, value) { element.attributes[key] = value; },
    getAttribute(key) { return element.attributes[key] ?? null; },
    replaceChildren(...kids) { element.children = kids.flat(Infinity); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    getContext() { return null; },
  };
  return element;
}

function stubDocument() {
  const byId = new Map();
  const document = {
    documentElement: stubElement("html"),
    body: stubElement("body"),
    createElement: (tag) => stubElement(tag),
    createElementNS: (_ns, tag) => stubElement(tag),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, stubElement("div"));
      return byId.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  return document;
}

/** The page globals the scripts expect, as inert stubs. */
export function browserContext(nora) {
  const storage = new Map();
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    atob: (s) => Buffer.from(s, "base64").toString("utf8"),
    btoa: (s) => Buffer.from(s, "utf8").toString("base64"),
    setTimeout,
    clearTimeout,
    NORA: nora,
    location: { search: "", hash: "", pathname: "/", href: "http://nora.test/network.html" },
    history: { pushState() {}, replaceState() {} },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame() {},
    navigator: {},
    EventSource: class {},
    Image: class {},
    Node: class {},
    document: stubDocument(),
  };
  sandbox.window = sandbox;
  // The page defines these for flow.js (pyvis writes them into network.html).
  class DataSet {
    constructor(items = []) { this.rows = new Map(items.map((r) => [r.id ?? r, r])); }
    add(rows) { for (const r of [].concat(rows)) this.rows.set(r.id ?? r, r); }
    update(rows) { this.add(rows); }
    get(id) { return this.rows.get(id); }
    getData() { return [...this.rows.values()]; }
  }
  sandbox.vis = { DataSet, Network: class {} };
  sandbox.nodes = new DataSet();
  sandbox.edges = new DataSet();
  sandbox.flowOptions = {};
  // map.js falls back to a notice when MapLibre is absent (the offline path).
  vm.createContext(sandbox);
  return sandbox;
}

/** Read the NORA payload the way the page would: from tests/test_js.py. */
export function noraFixture(path = env.NORA_PAYLOAD || argv.find((a) => a.endsWith(".json"))) {
  if (!path) throw new Error("set NORA_PAYLOAD to a nora.json payload (tests/test_js.py writes one)");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Evaluate template scripts in one fresh browser context; returns its App. */
export function loadApp({ scripts = ["app.js"], nora = noraFixture() } = {}) {
  const sandbox = browserContext(nora);
  for (const name of scripts) {
    vm.runInContext(readFileSync(resolve(TEMPLATES, name), "utf8"), sandbox, { filename: name });
  }
  const App = vm.runInContext("App", sandbox);
  if (!App) throw new Error(`app.js did not expose App (loaded: ${scripts.join(", ")})`);
  return { App, sandbox, document: sandbox.document };
}

export { TEMPLATES };