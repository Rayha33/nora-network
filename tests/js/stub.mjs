/* A minimal DOM stub: just enough for src/nora/templates/{app,map,flow}.js to load
   and register their views under `node --test`, without a browser or jsdom.

   The templates are IIFEs that only touch the DOM through document/$() helpers and
   never need real layout, so every element is the same inert StubNode. Anything the
   app reads (classList, dataset, style, attributes) is stored on the node; anything
   it calls (addEventListener, replaceChildren, ...) is a no-op that records nothing.

   Usage:  import { makeDom, makeSandbox } from "./stub.mjs";  then pass the result to
   vm.createContext / vm.runInContext.  */

export class StubNode {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.childNodes = this.children;
    // CSS custom properties (--paper, --text, …) are recorded, never applied.
    this.style = new Proxy(
      {
        setProperty() {}, removeProperty() {}, getPropertyValue() { return ""; },
      },
      { get: (target, key) => (key in target ? target[key] : ""), set: () => true },
    );
    this.dataset = {};
    this.hidden = false;
    this.value = "";
    this.disabled = false;
    this.checked = false;
    this.width = 300;
    this.height = 150;
    this.attributes = new Map();
    this.classList = {
      add: () => {},
      remove: () => {},
      toggle: () => false,
      contains: () => false,
    };
    this._listeners = {};
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }

  addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  append(...nodes) { this.children.push(...nodes.flat()); }
  appendChild(node) { this.children.push(node); return node; }
  removeChild(node) { this.children = this.children.filter((c) => c !== node); return node; }
  insertBefore(node) { this.children.unshift(node); return node; }
  replaceChildren(...nodes) { this.children = [...nodes.flat()]; }
  contains() { return false; }
  getBoundingClientRect() { return { x: 0, y: 0, width: this.width, height: this.height, top: 0, left: 0, right: this.width, bottom: this.height }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  click() {}
  // The app builds small SVG snippets from palette colours and esc()'d text only.
  set innerHTML(markup) { this._innerHTML = String(markup); this.children = []; }
  get innerHTML() { return this._innerHTML ?? ""; }
  get textContent() { return this.children.map((c) => (c instanceof StubNode ? c.textContent : String(c))).join(""); }
  set textContent(text) { this.children = [String(text)]; this._innerHTML = ""; }
  getContext() { return null; } // canvases stay blank: draw code is not under test
}

const media = (matches = false) => ({ matches, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

export function makeDom() {
  const byId = new Map();
  const node = (tag) => new StubNode(tag);
  const document = {
    nodeType: 9,
    body: node("body"),
    documentElement: node("html"),
    getElementById(id) { if (!byId.has(id)) byId.set(id, node("div")); return byId.get(id); },
    createElement: (tag) => node(tag),
    createElementNS: (ns, tag) => node(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
  };
  return document;
}

/* Everything the templates read from their host environment at load time, plus the
   timers and globals node:test provides, so vm contexts behave like a browser. */
export function makeSandbox({ nora, document = makeDom(), search = "" } = {}) {
  const listeners = {};
  const storage = new Map();
  const window = {
    document,
    location: { search, hash: "", href: "http://localhost/" },
    history: { replaceState() {}, pushState() {}, state: null },
    matchMedia: media,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
      clear: () => storage.clear(),
    },
    addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
  };
  window.self = window;
  window.top = window;
  window.parent = window;
  const sandbox = {
    NORA: nora,
    App: undefined, // set by evaluating app.js
    Node: StubNode,
    Image: class { set src(_) {} },
    document,
    window,
    URLSearchParams,
    URL,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Promise,
    RegExp,
    Error,
    isNaN,
    isFinite,
    parseInt,
    parseFloat,
    console,
    addEventListener: window.addEventListener,
    removeEventListener() {},
    requestAnimationFrame: window.requestAnimationFrame,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    setInterval: window.setInterval,
    clearInterval: window.clearInterval,
    matchMedia: media,
    history: window.history,
    location: window.location,
    localStorage: window.localStorage,
    EventSource: class { close() {} addEventListener() {} },
    fetch: () => Promise.reject(new Error("no network in tests")),
  };
  return sandbox;
}
