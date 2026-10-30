/* Ray, 28 Oct: "the application is extremely slow". After the Flow view, the Map view
   was the heaviest screen: MapLibre repainted the whole map ~40 times a second while
   the data stepped 4 times a second (its 300 ms label fade kept it busy), and the layer
   of pigs and peaks over the map was drawn ~100 times a second while playing and 60
   while paused, with nothing moving. These tests drive map.js with a fake MapLibre and
   pin when the layer is drawn: when what it shows changes, at most once a frame. */

import test from "node:test";
import assert from "node:assert/strict";

import { loadApp, assertHealthy } from "./harness.mjs";

// A 2D context that draws nothing and counts the calls the tests look at.
function recordingContext(counts) {
  return new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "measureText") return (text) => ({ width: String(text).length * 6 });
      if (key === "createLinearGradient") return () => ({ addColorStop() {} });
      return () => { counts[key] = (counts[key] || 0) + 1; };
    },
    set(target, key, value) { target[key] = value; return true; },
  });
}

/* Canvases get a counting 2D context and, with `webgl`, a WebGL one (so map.js picks
   MapLibre); every new element can be removed, as the map's loading note is. */
function withCanvases(document, counts, webgl = true) {
  const create = document.createElement;
  document.createElement = (tag) => {
    const node = create(tag);
    node.remove = () => {};
    if (String(tag).toLowerCase() === "canvas") {
      node.getContext = (type) => (type === "2d" ? recordingContext(counts) : webgl ? { getExtension: () => null } : null);
    }
    return node;
  };
}

// Just enough MapLibre for map.js: a camera, events, and no-ops for everything else.
function fakeMapLibre() {
  class FakeMap {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.sources = {};
      this.center = { lng: 3, lat: 58 };
      this.zoom = 4.5;
      this.touchZoomRotate = { disableRotation() {} };
      FakeMap.last = this;
      return new Proxy(this, { get: (target, key) => (key in target ? target[key] : () => undefined) });
    }
    on(type, layerOrFn, fn) { if (!fn) (this.handlers[type] ??= []).push(layerOrFn); return this; }
    once() { return this; }
    fire(type, event = { point: { x: 0, y: 0 } }) { for (const fn of this.handlers[type] || []) fn(event); }
    addSource(id, spec) { this.sources[id] = spec; }
    getCanvas() { return this.options.container; }
    getContainer() { return this.options.container; }
    getCenter() { return this.center; }
    getZoom() { return this.zoom; }
    getBearing() { return 0; }
    getPitch() { return 0; }
    project([lon, lat]) { return { x: (lon - this.center.lng) * 120 + 500, y: (this.center.lat - lat) * 200 + 400 }; }
    hasImage() { return true; }
    getStyle() { return { layers: [] }; }
    getSource() { return { setData() {} }; }
    getLayer() { return true; }
    cameraForBounds() { return { zoom: 3 }; }
  }
  class Popup { setLngLat() { return this; } setText() { return this; } addTo() { return this; } remove() { return this; } }
  return { Map: FakeMap, Popup };
}

async function mountMap() {
  const maplibregl = fakeMapLibre();
  const loaded = loadApp({ globals: { maplibregl } });
  const { App, document, NORA } = loaded;
  const counts = {};
  withCanvases(document, counts);
  const el = document.getElementById("view-map");
  el.clientWidth = 1000;
  el.clientHeight = 700;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[1].name } });
  App.state.view = "map";
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const map = maplibregl.Map.last;
  map.fire("style.load");
  for (let i = 0; i < 5 && !App.views.map.ready; i++) await new Promise((resolve) => setImmediate(resolve));
  map.fire("sourcedata", { sourceId: "nora-pipes", isSourceLoaded: true }); // the lines are on the map
  map.fire("render"); // MapLibre draws its first frame: the layer draws only with a camera the map has drawn
  return { ...loaded, view: App.views.map, map, el, counts };
}

test("map: names appear at once, so MapLibre repaints only when something changes", async () => {
  const loaded = await mountMap();
  const { view, map } = loaded;
  assertHealthy(assert, loaded);
  assert.equal(view.canvasMap, undefined, "the MapLibre map, not the canvas fallback");
  assert.equal(view.ready, true, "the layers are added");
  assert.equal(map.options.fadeDuration, 0, "no 300 ms label fade that keeps the map repainting");
});

test("map: the layer over the map is drawn when what it shows changes, at most once a frame", async () => {
  const { App, view, map, el, counts } = await mountMap();
  App.live.playing = false;
  const drawn = (fn) => { const before = counts.clearRect || 0; fn(); return (counts.clearRect || 0) - before; }; // each draw clears the layer once
  view.draw(); // whatever the first frame shows

  assert.equal(drawn(() => { for (let i = 0; i < 5; i++) { view.draw(); map.fire("render"); } }), 0,
    "paused, with nothing changing: not drawn at all");

  map.center = { lng: 3.5, lat: 58 };
  assert.equal(drawn(() => { map.fire("render"); view.draw(); }), 1, "a pan: drawn once, from the map's repaint");
  map.zoom = 6;
  assert.equal(drawn(() => view.draw()), 0, "a zoom the map has not drawn yet: the layer waits for it (never off its lines)");
  assert.equal(drawn(() => { map.fire("render"); view.draw(); }), 1, "then drawn once, with the map's repaint");

  assert.equal(drawn(() => { view.restyle(); view.draw(); view.draw(); }), 1, "a restyle (new data, a filter): drawn once");
  assert.equal(drawn(() => { view.applySettings(); view.draw(); }), 1, "new settings: drawn once");
  App.state.mode = "load";
  assert.equal(drawn(() => { view.draw(); view.draw(); }), 1, "another mode: drawn once (the layer is cleared)");
  App.state.mode = "live";
  view.draw();
  el.clientWidth = 900;
  assert.equal(drawn(() => { view.draw(); view.draw(); }), 1, "a resized window: drawn once");

  App.live.playing = true;
  assert.equal(drawn(() => {
    for (let frame = 0; frame < 10; frame++) {
      App.live.clock += 1 / 60;
      view.draw();
      map.fire("render"); // the map repainting for a data step, camera unchanged
    }
  }), 3, "playing: about 20 a second (10 frames at 60 a second: every third), not again when the map repaints");

  App.live.playing = false;
  assert.equal(drawn(() => { view.draw(); view.draw(); }), 1, "pausing: drawn once more (the flow stubs stop)");
});

test("map: a draw that fails is tried again on the next frame", async () => {
  const { App, view, counts } = await mountMap();
  App.live.playing = false;
  view.draw();
  const markers = App.markers;
  view.restyle();
  App.markers = () => { throw new Error("draw failed"); };
  assert.throws(() => view.draw());
  App.markers = markers;
  const before = counts.clearRect;
  view.draw();
  assert.equal(counts.clearRect, before + 1, "the failed frame is not taken as drawn");
});

test("map without WebGL: a paused canvas map is not redrawn every frame", () => {
  const Path2D = class { moveTo() {} lineTo() {} closePath() {} };
  const loaded = loadApp({ globals: { Path2D } }); // no MapLibre: the canvas map
  const { App, document, NORA } = loaded;
  const counts = {};
  withCanvases(document, counts, false);
  const el = document.getElementById("view-map");
  el.clientWidth = 1000;
  el.clientHeight = 700;
  document.getElementById("speed").options = [{ value: "60" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  App.state.view = "map";
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const view = App.views.map;
  assert.equal(view.canvasMap, true);
  // A frame copies the still map (drawImage); repainting the still map fills the water (fillRect).
  const count = (fn) => {
    const frames = counts.drawImage || 0, repaints = counts.fillRect || 0;
    fn();
    return { frames: (counts.drawImage || 0) - frames, repaints: (counts.fillRect || 0) - repaints };
  };
  App.live.playing = false;
  assert.deepEqual(count(() => { for (let i = 0; i < 5; i++) view.draw(); }), { frames: 0, repaints: 0 }, "paused: the frame loop draws nothing");
  assert.deepEqual(count(() => view.restyle()), { frames: 1, repaints: 0 }, "a restyle that changes no line or node keeps the still map");
  assert.deepEqual(count(() => view.highlight(App.nodeIds[0])), { frames: 1, repaints: 1 }, "a new look repaints it");
  App.live.playing = true;
  /* Without WebGL the CPU paints every pixel: repainting water, land, lines and names
     60 times a second to move a few markers took 75 % of a core (Ray, 29 Oct: "make it
     run more smoothly"). Playing, a frame copies the still map and draws the markers,
     and only when one of them has moved. */
  assert.deepEqual(count(() => { for (let i = 0; i < 3; i++) view.draw(); }), { frames: 0, repaints: 0 }, "playing, nothing moved: nothing painted");
  const moving = count(() => { for (let i = 0; i < 3; i++) { App.live.time += 1800; App.live.clock += 0.05; view.draw(); } });
  assert.deepEqual(moving, { frames: 3, repaints: 0 }, "playing, the markers moved: each frame paints them over the still map");
  const fast = count(() => { for (let i = 0; i < 6; i++) { App.live.time += 1800; App.live.clock += 1 / 60; view.draw(); } });
  assert.deepEqual(fast, { frames: 2, repaints: 0 }, "at 60 frames a second, every third one: at most 20 a second");
});

/* Ray, 30 Oct: "peak lines are sometimes glitching and jumping outside pipelines". While
   the style reloads (a light/dark switch, or the fall back to raster tiles), the map has
   no lines: the layer of pigs and peaks is emptied, and drawn again only once the
   pipelines are back. And the lines are drawn exactly as laid (no simplification), as
   the peaks follow them. */
test("map: no pig or peak while the lines are off the map; the lines are not simplified", async () => {
  const { App, view, map, counts } = await mountMap();
  assert.equal(map.sources["nora-pipes"].tolerance, 0, "lines exactly as laid, at every zoom");
  App.live.playing = false;
  view.draw();
  const cleared = counts.clearRect || 0, drawn = () => (counts.clearRect || 0) - cleared;
  view.theme(); // a theme switch reloads the style
  assert.equal(drawn(), 1, "the layer is emptied at once, not left over a map with no lines");
  map.center = { lng: 3.2, lat: 58 };
  map.fire("render");
  view.draw();
  assert.equal(drawn(), 1, "and stays empty while the style loads");
  map.fire("style.load");
  for (let i = 0; i < 5 && !view.ready; i++) await new Promise((resolve) => setImmediate(resolve));
  const before = drawn();
  map.fire("render");
  assert.equal(drawn(), before, "the layers are added, their lines not loaded yet: still empty");
  map.fire("sourcedata", { sourceId: "nora-pipes", isSourceLoaded: true });
  map.fire("render");
  assert.ok(drawn() > before, "the lines are on the map: the pigs and peaks are drawn again");
});
