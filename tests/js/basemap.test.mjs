/* The basemap in English and in the theme (review, 29 Oct). OpenFreeMap's positron
   style writes place names in Latin and local script, so the map read "Baltic Sea
   Балтийское море", "Belarus Беларусь", "Kyiv Київ" in an English-only interface; and
   in the dark theme the zoom buttons and the attribution stayed white. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadApp, TEMPLATES } from "./harness.mjs";

const BASEMAP_LAYERS = [
  { id: "background", type: "background" },
  { id: "water", type: "fill" },
  { id: "place_country_major", type: "symbol" },
  { id: "place_city", type: "symbol" },
  { id: "water_name_point_label", type: "symbol" },
  { id: "highway_name_other", type: "symbol" },
];

function mountMap() {
  const layout = [];
  class FakeMap {
    constructor() { this.handlers = {}; this.touchZoomRotate = { disableRotation() {} }; maplibregl.last = this; }
    getCanvas() { return { addEventListener() {}, style: {} }; }
    getContainer() { return { clientWidth: 800, clientHeight: 600 }; }
    getStyle() { return { layers: BASEMAP_LAYERS }; }
    once() {}
    on(type, a, b) { (this.handlers[type] ??= []).push(b || a); }
    fire(type, event) { for (const fn of this.handlers[type] || []) fn(event); }
    setLayoutProperty(id, key, value) { layout.push({ id, key, value }); }
    setPaintProperty() {}
    addControl() {} hasImage() { return true; } addImage() {} addSource() {} addLayer() {} getLayer() { return null; }
    getSource() { return { setData() {} }; } setFeatureState() {} fitBounds() {} cameraForBounds() { return null; } setMinZoom() {}
  }
  const maplibregl = {
    Map: FakeMap, ScaleControl: class {}, NavigationControl: class {},
    Popup: class { setLngLat() { return this; } setText() { return this; } addTo() { return this; } remove() {} },
  };
  const { App, document } = loadApp({ globals: { maplibregl } });
  const make = document.createElement;
  document.createElement = (tag) => { const node = make(tag); if (tag === "canvas") node.getContext = (kind) => (kind.startsWith("webgl") ? { getExtension: () => null } : null); return node; };
  App.state.view = "map";
  App.go({ screen: "unit", unit: "all" });
  maplibregl.last.fire("style.load");
  return layout;
}

test("place, country and sea names on the basemap are in English", () => {
  const layout = mountMap();
  for (const id of ["place_country_major", "place_city", "water_name_point_label"]) {
    const set = layout.find((p) => p.id === id && p.key === "text-field");
    assert.ok(set, `${id} keeps the style's bilingual label`);
    const expression = JSON.stringify(set.value);
    assert.match(expression, /"name:en"/, `${id} prefers the English name`);
    assert.doesNotMatch(expression, /nonlatin/, `${id} adds no second script`);
  }
});

test("the map's zoom buttons and attribution follow the theme", () => {
  const css = readFileSync(`${TEMPLATES}/app.css`, "utf8");
  for (const selector of [".maplibregl-ctrl-group", ".maplibregl-ctrl-attrib"]) {
    const rules = [...css.matchAll(new RegExp(`${selector.replace(".", "\\.")}[^{,]*\\{([^}]*)\\}`, "g"))].map((m) => m[1]).join(";");
    assert.match(rules, /background(-color)?:\s*var\(--/, `${selector} takes its background from the theme`);
  }
});
