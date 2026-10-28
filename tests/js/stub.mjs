/* A minimal DOM stub: just enough for src/nora/templates/{app,map,flow}.js to load
   and register their views under `node --test`, without a browser or jsdom.

   The templates are IIFEs that only touch the DOM through document/$() helpers and
   never need real layout, so every element is the same inert StubNode. Anything the
   app reads (classList, dataset, style, attributes) is stored on the node; anything
   it calls (addEventListener, replaceChildren, ...) is a no-op that records nothing.

   Usage:  import { makeDom, makeSandbox } from "./stub.mjs";  then pass the result to
   vm.createContext / vm.runInContext.

   Element ids come from the real page template, as in a browser: getElementById
   returns null for an id the page does not have, and for one whose element was
   removed because an element around it had its children replaced. A stub that made
   up any element on demand let a crash ship (the canvas map cleared the map card,
   then every navigation wrote to its missing labels). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "nora", "templates", "app.html.j2");
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/* Every id in the page, with the ids of the elements it sits inside. */
export function templateIds(html = readFileSync(TEMPLATE, "utf8")) {
  const stack = [], ancestors = new Map();
  for (const [, close, name, attrs, selfClose] of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g)) {
    const tag = name.toLowerCase();
    if (close) {
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (id) ancestors.set(id, stack.filter((e) => e.id).map((e) => e.id));
    if (!VOID.has(tag) && !selfClose) stack.push({ tag, id });
  }
  return ancestors;
}

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
    this._replaced = 0; // times its children were replaced: page elements inside it are gone
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
  replaceChildren(...nodes) { this.children = [...nodes.flat()]; this._replaced += 1; }
  remove() {}
  contains() { return false; }
  getBoundingClientRect() { return { x: 0, y: 0, width: this.width, height: this.height, top: 0, left: 0, right: this.width, bottom: this.height }; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() {}
  blur() {}
  click() {}
  // The app builds small SVG snippets from palette colours and esc()'d text only.
  set innerHTML(markup) { this._innerHTML = String(markup); this.children = []; this._replaced += 1; }
  get innerHTML() { return this._innerHTML ?? ""; }
  get textContent() { return this.children.map((c) => (c instanceof StubNode ? c.textContent : String(c))).join(""); }
  set textContent(text) { this.children = [String(text)]; this._innerHTML = ""; this._replaced += 1; }
  getContext() { return null; } // canvases stay blank: draw code is not under test
}

const media = (matches = false) => ({ matches, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });

export function makeDom() {
  const byId = new Map(), page = templateIds();
  const node = (tag) => new StubNode(tag);
  const document = {
    nodeType: 9,
    body: node("body"),
    documentElement: node("html"),
    getElementById(id) {
      if (!page.has(id)) return null; // not in the page
      if (page.get(id).some((outer) => document.getElementById(outer) === null || byId.get(outer)._replaced)) return null; // removed with what held it
      if (!byId.has(id)) byId.set(id, node("div"));
      return byId.get(id);
    },
    createElement: (tag) => node(tag),
    createElementNS: (ns, tag) => node(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    querySelector: () => null,
    querySelectorAll: () => [],
    _listeners: {},
    addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
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
