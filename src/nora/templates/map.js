/* Map view: the network at its true coordinates on OpenFreeMap vector tiles, drawn with
   MapLibre GL. Colours and widths come from App.pipeStyle / App.nodeStyle and reach the
   map as feature state, so this file only knows how to put things on a map. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  let map = null, canvas = null, ctx = null, lastMode = null, highlighted = null;

  const featureOf = {}; // asset id -> { source, id } for feature state
  const ends = {}; // pipeline id -> [[lon, lat], [lon, lat]]
  const worst = NORA.worstOutage || 1;
  for (const f of NORA.geo.nodes.features) {
    featureOf[f.properties.asset] = { source: "nora-nodes", id: f.id };
    f.properties.risk = (NORA.assets[f.properties.asset].lost || 0) / worst;
  }
  for (const f of NORA.geo.pipes.features) {
    featureOf[f.properties.asset] = { source: "nora-pipes", id: f.id };
    ends[f.properties.asset] = f.geometry.coordinates;
  }

  const ICON_SIZE = ["interpolate", ["linear"], ["zoom"], 3, 0.6, 6, 0.85, 9, 1.05];
  const RISK_SIZE = ["interpolate", ["linear"], ["zoom"],
    3, ["+", 0.4, ["*", 0.8, ["sqrt", ["get", "risk"]]]],
    9, ["+", 0.7, ["*", 1.2, ["sqrt", ["get", "risk"]]]]];

  const padding = () => ({
    top: 60, left: 24, right: 24,
    bottom: document.body.classList.contains("has-player") ? 80 : 24,
  });
  const duration = (ms) => (App.reduceMotion ? 0 : ms);

  function loadIcon(kind, uri) {
    return new Promise((resolve) => {
      if (map.hasImage(`nora-${kind}`)) return resolve();
      const image = new Image(48, 48);
      image.onload = () => { map.addImage(`nora-${kind}`, image, { pixelRatio: 2 }); resolve(); };
      image.onerror = resolve;
      image.src = uri;
    });
  }

  async function addLayers() {
    view.ready = false;
    await Promise.all(Object.entries(NORA.icons).map(([kind, uri]) => loadIcon(kind, uri)));
    const t = App.palette();
    map.addSource("nora-pipes", { type: "geojson", data: NORA.geo.pipes });
    map.addSource("nora-nodes", { type: "geojson", data: NORA.geo.nodes });
    const color = ["to-color", ["coalesce", ["feature-state", "color"], t.pipe]];
    const width = (k) => ["interpolate", ["linear"], ["zoom"],
      3, ["*", 0.8 * k, ["coalesce", ["feature-state", "width"], 1]],
      8, ["*", 2.2 * k, ["coalesce", ["feature-state", "width"], 1]]];
    map.addLayer({
      id: "nora-pipes-onshore", type: "line", source: "nora-pipes",
      filter: ["==", ["get", "onshore"], true],
      paint: { "line-color": color, "line-width": width(0.8), "line-dasharray": [2, 2] },
    });
    map.addLayer({
      id: "nora-pipes", type: "line", source: "nora-pipes",
      filter: ["!=", ["get", "onshore"], true],
      layout: { "line-cap": "round" },
      paint: { "line-color": color, "line-width": width(1) },
    });
    map.addLayer({
      id: "nora-pipes-hit", type: "line", source: "nora-pipes",
      paint: { "line-color": "#000", "line-opacity": 0, "line-width": 14 },
    });
    map.addLayer({
      id: "nora-halo", type: "circle", source: "nora-nodes",
      paint: {
        "circle-radius": ["case",
          ["boolean", ["feature-state", "selected"], false], 17,
          ["boolean", ["feature-state", "alarm"], false], 16, 0],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-width": 2.5,
        "circle-stroke-color": ["case", ["boolean", ["feature-state", "alarm"], false], t.alarm, t.pipe],
      },
    });
    map.addLayer({
      id: "nora-nodes", type: "symbol", source: "nora-nodes",
      layout: {
        "icon-image": ["concat", "nora-", ["get", "type"]],
        "icon-size": ICON_SIZE,
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "text-field": ["get", "name"],
        "text-font": ["Noto Sans Regular"],
        "text-size": 11.5,
        "text-offset": [0, 1.3],
        "text-anchor": "top",
        "text-optional": true,
        "text-max-width": 9,
      },
      paint: { "text-color": t.ink, "text-halo-color": t.paper, "text-halo-width": 1.5 },
    });
    lastMode = null;
    view.ready = true;
    App.restyle();
    view.highlight(App.state.selected);
  }

  function sizeCanvas() {
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1, el = map.getContainer();
    const width = el.clientWidth, height = el.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  function clearDots() {
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  view.mount = (el) => {
    if (typeof maplibregl === "undefined") {
      el.append(Object.assign(document.createElement("p"), {
        className: "notice",
        textContent: "The map needs an internet connection. The Flow view works offline.",
      }));
      return;
    }
    map = new maplibregl.Map({
      container: el,
      style: NORA.mapStyles[App.theme()],
      bounds: NORA.bounds,
      fitBoundsOptions: { padding: padding() },
      attributionControl: { compact: true },
      cooperativeGestures: App.embed,
      dragRotate: false,
      pitchWithRotate: false,
      minZoom: 2,
      maxZoom: 12,
    });
    view.map = map;
    map.touchZoomRotate.disableRotation();
    canvas = document.createElement("canvas");
    canvas.className = "dots";
    el.append(canvas);
    ctx = canvas.getContext("2d");
    map.on("style.load", addLayers);
    map.on("resize", sizeCanvas);
    map.on("render", () => {
      if (!(App.state.mode === "live" && App.live.playing)) clearDots();
    });
    for (const layer of ["nora-nodes", "nora-pipes-hit"]) {
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
    map.on("click", (event) => {
      if (!view.ready) return;
      const hit = map.queryRenderedFeatures(event.point, { layers: ["nora-nodes", "nora-pipes-hit"] });
      App.select(hit.length ? hit[0].properties.asset : null);
    });
  };

  view.restyle = () => {
    for (const id of App.pipeIds) {
      const style = App.pipeStyle(id);
      map.setFeatureState(featureOf[id], { color: style.color, width: style.width });
    }
    for (const id of App.nodeIds) {
      map.setFeatureState(featureOf[id], { alarm: Boolean(App.nodeStyle(id).ring) });
    }
    if (App.state.mode !== lastMode) {
      lastMode = App.state.mode;
      map.setLayoutProperty("nora-nodes", "icon-size", lastMode === "risk" ? RISK_SIZE : ICON_SIZE);
      clearDots();
    }
  };

  view.draw = () => {
    sizeCanvas();
    clearDots();
    for (const id of App.pipeIds) {
      if (!App.live.values[id]) continue;
      const a = map.project(ends[id][0]), b = map.project(ends[id][1]);
      App.drawDots(ctx, id, [[a.x, a.y], [b.x, b.y]]);
    }
  };

  view.highlight = (id) => {
    if (highlighted && featureOf[highlighted].source === "nora-nodes") {
      map.setFeatureState(featureOf[highlighted], { selected: false });
    }
    highlighted = id;
    if (id && featureOf[id].source === "nora-nodes") map.setFeatureState(featureOf[id], { selected: true });
  };

  view.focus = (id, animate) => {
    const d = NORA.assets[id];
    if (d.kind === "node") {
      map.easeTo({ center: [d.lon, d.lat], zoom: Math.max(map.getZoom(), 6.5), duration: animate ? duration(600) : 0 });
    } else {
      const [a, b] = ends[id];
      const bounds = [[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]];
      map.fitBounds(bounds, { padding: 120, maxZoom: 7, duration: animate ? duration(600) : 0 });
    }
  };

  view.fit = () => map.fitBounds(NORA.bounds, { padding: padding(), duration: duration(500) });

  view.resize = () => {
    if (!map) return;
    map.resize();
    sizeCanvas();
  };

  view.theme = (name) => {
    if (!map) return;
    view.ready = false;
    map.setStyle(NORA.mapStyles[name], { diff: false });
  };

  App.register("map", view);
})();
