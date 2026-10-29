/* Map view (level 2): the network at its true coordinates on OpenFreeMap vector tiles,
   drawn with MapLibre GL. The basemap is recoloured to the paper greys so that colour on
   the map only ever means an alarm. Styling comes from App.pipeStyle / App.nodeStyle
   through feature state; this file only knows how to put things on a map. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  const C = App.colors;
  let map = null, canvas = null, ctx = null, highlighted = null, alarmKey = "";
  let basemap = null; // the style in use: the online one, or FALLBACK_STYLE once that failed
  let drawnMarks = []; // where pigs, peaks and slugs were drawn this frame, for mouse-over
  let notes = null; // the notes' windows over the map (App.notes)
  const markAt = (x, y) => {
    let best = null, bestD = 9 * App.uiScale(); // px
    for (const d of drawnMarks) { const dist = Math.hypot(d.x - x, d.y - y); if (dist < bestD) { best = d.m; bestD = dist; } }
    return best;
  };
  /* Detailed fields (data/nodes.csv map_min_zoom) appear only when zoomed in, and so do
     the lines to them; everything else is always on the map. */
  const nodeAtZoom = (id) => map && map.getZoom() >= ((NORA.assets[id] && NORA.assets[id].min_zoom) || 0);
  const pipeAtZoom = (id) => {
    const d = NORA.assets[id];
    return d && nodeAtZoom(d.from) && nodeAtZoom(d.to);
  };

  const featureOf = {}; // asset id -> { source, id }
  const ends = {}; // pipeline id -> its laid route, [[lon, lat], ...] from its `from` node
  for (const f of NORA.geo.nodes.features) featureOf[f.properties.asset] = { source: "nora-nodes", id: f.id };
  for (const f of NORA.geo.pipes.features) {
    featureOf[f.properties.asset] = { source: "nora-pipes", id: f.id };
    ends[f.properties.asset] = f.geometry.coordinates;
  }
  // The lines at each node, once: the flow stubs look only at a node's own lines.
  const linesAt = {};
  for (const pid of App.pipeIds) {
    const p = NORA.assets[pid];
    for (const end of new Set([p.from, p.to])) (linesAt[end] = linesAt[end] || []).push(pid);
  }
  /* A point part-way along a pipeline's laid route (0..1 from its first point), in
     lon/lat, with the segment it falls on: lines follow their real route, not a chord. */
  const routeLengths = {};
  function alongRoute(id, t) {
    const pts = ends[id];
    if (!routeLengths[id]) {
      let total = 0;
      routeLengths[id] = [0];
      for (let i = 1; i < pts.length; i++) {
        const k = Math.cos((pts[i][1] * Math.PI) / 180);
        total += Math.hypot((pts[i][0] - pts[i - 1][0]) * k, pts[i][1] - pts[i - 1][1]);
        routeLengths[id].push(total);
      }
    }
    const cum = routeLengths[id], d = Math.max(0, Math.min(1, t)) * cum[cum.length - 1];
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const f = cum[i] > cum[i - 1] ? (d - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0;
    const a = pts[i - 1], b = pts[i];
    return { at: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], a, b };
  }
  // Midpoints of pipelines, for alarm badges on lines.
  const mids = {
    type: "FeatureCollection",
    features: NORA.geo.pipes.features.map((f) => ({
      type: "Feature", id: f.id, properties: { asset: f.properties.asset, alarm: 0 },
      geometry: { type: "Point", coordinates: alongRoute(f.properties.asset, 0.5).at },
    })),
  };

  const padding = () => ({ top: 30, left: 30, right: 30, bottom: 30 });
  const duration = (ms) => (App.reduceMotion ? 0 : ms);

  const ENGLISH_NAME = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];
  // Recolour the basemap to calm greys: land is paper, water a step darker, roads,
  // parks and points of interest hidden, place names in dim text.
  function calmBasemap() {
    for (const layer of map.getStyle().layers) {
      const id = layer.id;
      if (id.startsWith("nora-")) continue;
      try {
        if (layer.type === "background") map.setPaintProperty(id, "background-color", C.paper);
        else if (layer.type === "fill") {
          if (/water|ocean|sea/.test(id)) map.setPaintProperty(id, "fill-color", C.water);
          else map.setLayoutProperty(id, "visibility", "none");
        } else if (layer.type === "line") {
          if (/boundary|admin/.test(id)) { map.setPaintProperty(id, "line-color", C.text_dim); map.setPaintProperty(id, "line-opacity", 0.35); }
          else if (/water|river/.test(id)) map.setPaintProperty(id, "line-color", C.water);
          else map.setLayoutProperty(id, "visibility", "none");
        } else if (layer.type === "raster") { /* fallback basemap: keep as drawn */ }
        else if (layer.type === "symbol") {
          if (/place|country|state|city|town|water_name|marine|ocean|sea/.test(id)) {
            // English only, like the rest of the page: the style stacks the Latin name
            // over the local script ("Baltic Sea / Балтийское море").
            map.setLayoutProperty(id, "text-field", ENGLISH_NAME);
            map.setPaintProperty(id, "text-color", C.text_dim);
            map.setPaintProperty(id, "text-halo-color", C.paper);
            map.setPaintProperty(id, "icon-opacity", 0);
          } else map.setLayoutProperty(id, "visibility", "none");
        } else map.setLayoutProperty(id, "visibility", "none");
      } catch (error) { /* a layer without that property: leave it */ }
    }
  }


  async function addLayers() {
    view.ready = false;
    calmBasemap();
    const pipeGeo = {
      ...NORA.geo.pipes,
      features: NORA.geo.pipes.features.map((feature) => ({
        ...feature,
        properties: { ...feature.properties, map_name: App.pipeMapName(feature.properties.asset) },
      })),
    };
    map.addSource("nora-pipes", { type: "geojson", data: pipeGeo });
    map.addSource("nora-nodes", { type: "geojson", data: NORA.geo.nodes });
    map.addSource("nora-mids", { type: "geojson", data: mids });
    const state = (key, fallback) => ["coalesce", ["feature-state", key], fallback];
    const detailFilter = ["<=", ["coalesce", ["get", "minZoom"], 0], ["zoom"]]; // the same rule as nodeAtZoom
    // A tie-in is where lines meet: no dot or name of its own on the map.
    const nodeFilter = ["all", detailFilter, ["!=", ["get", "type"], "tee"]];
    // Hairlines at overview zoom, a little more weight only when zoomed in. Load and
    // Risk speak in line weight, so their lines keep it at every zoom (review #49802).
    const width = (k, extra = 0) => ["interpolate", ["linear"], ["zoom"],
      3, ["+", extra, ["*", k, atZoom(0.45), state("width", 1)]],
      6, ["+", extra, ["*", k, atZoom(0.7), state("width", 1)]],
      9, ["+", extra, ["*", 1.1 * k, state("width", 1)]]];
    const opacity = ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.3, 1];
    // A dark casing under any line in alarm, so colour never stands alone.
    map.addLayer({ id: "nora-casing", type: "line", source: "nora-pipes", filter: detailFilter, layout: { "line-cap": "round" },
      paint: { "line-color": C.casing, "line-width": width(1, 1.6), "line-opacity": ["case", ["boolean", ["feature-state", "casing"], false], opacity, 0] } });
    map.addLayer({ id: "nora-pipes-onshore", type: "line", source: "nora-pipes", filter: ["all", detailFilter, ["==", ["get", "onshore"], true]],
      paint: { "line-color": ["to-color", state("color", C.inactive)], "line-width": width(0.8), "line-dasharray": [2, 2], "line-opacity": opacity } });
    map.addLayer({ id: "nora-pipes", type: "line", source: "nora-pipes", filter: ["all", detailFilter, ["!=", ["get", "onshore"], true]], layout: { "line-cap": "round" },
      paint: { "line-color": ["to-color", state("color", C.normal)], "line-width": width(1), "line-opacity": opacity } });
    map.addLayer({ id: "nora-pipes-hit", type: "line", source: "nora-pipes", filter: detailFilter, paint: { "line-color": "#000", "line-opacity": 0, "line-width": 14 } });
    /* Nodes are plain circles in their state grey, as in the Flow view: no icons (Ray,
       28 Oct). An alarm colours only the outline, and the badge carries the shape and
       number. Names are a separate text layer that is never reloaded. */
    const radius = (extra = 0) => ["interpolate", ["linear"], ["zoom"], 3, 3.5 + extra, 6, 5.5 + extra, 9, 8 + extra];
    const nodeOpacity = ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.3, 1];
    map.addLayer({ id: "nora-selected", type: "circle", source: "nora-nodes", filter: nodeFilter,
      paint: { "circle-radius": radius(5), "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2, "circle-stroke-color": C.text,
        "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, 0] } });
    map.addLayer({ id: "nora-node-dots", type: "circle", source: "nora-nodes", filter: nodeFilter,
      paint: {
        "circle-radius": radius(), "circle-color": ["to-color", state("fill", C.normal)],
        "circle-stroke-color": ["to-color", state("edge", C.text_dim)], "circle-stroke-width": state("edgeWidth", 1),
        "circle-opacity": nodeOpacity, "circle-stroke-opacity": nodeOpacity,
      } });
    map.addLayer({ id: "nora-nodes", type: "symbol", source: "nora-nodes", filter: nodeFilter,
      layout: {
        "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11.5,
        "text-offset": [0, 0.8], "text-anchor": "top", "text-optional": true, "text-max-width": 9,
      },
      paint: {
        "text-opacity": nodeOpacity, "text-color": C.text, "text-halo-color": C.paper, "text-halo-width": 2, // no line shows through a name
      } });
    // No alarm badges on the map (Ray, 29 Oct: "remove all warning triangles from the map",
    // "but keep pig and peaks"): a node's ring says it, the alarm list says what.
    alarmKey = "";
    view.ready = true;
    view.applySettings();
    view.setUnit(App.route.unit);
    view.restyle();
    view.highlight(App.route.focus);
  }

  // A line's weight factor at a zoom stop: a model mode's line (Load, Risk) never thins.
  const atZoom = (factor) => ["case", ["boolean", ["feature-state", "model"], false], Math.max(1, factor), factor];

  /* Sizes in screen pixels follow the one UI scale (App.uiScale, issue #59): a video
     wall gets lines, circles, names and badges it can read from metres away. The
     layers are added at 100 %; scaleLayers() sets these whenever settings apply. */
  function scaleLayers() {
    const k = App.uiScale(), state = (key, fallback) => ["coalesce", ["feature-state", key], fallback];
    const width = (w, extra = 0) => ["interpolate", ["linear"], ["zoom"],
      3, ["+", extra * k, ["*", w * k, atZoom(0.45), state("width", 1)]],
      6, ["+", extra * k, ["*", w * k, atZoom(0.7), state("width", 1)]],
      9, ["+", extra * k, ["*", 1.1 * w * k, state("width", 1)]]];
    const radius = (extra = 0) => ["interpolate", ["linear"], ["zoom"], 3, (3.5 + extra) * k, 6, (5.5 + extra) * k, 9, (8 + extra) * k];
    const sizes = {
      "nora-casing": { paint: { "line-width": width(1, 1.6) } },
      "nora-pipes-onshore": { paint: { "line-width": width(0.8) } },
      "nora-pipes": { paint: { "line-width": width(1) } },
      "nora-pipes-hit": { paint: { "line-width": 14 * k } },
      "nora-selected": { paint: { "circle-radius": radius(5), "circle-stroke-width": 2 * k } },
      "nora-node-dots": { paint: { "circle-radius": radius(), "circle-stroke-width": ["*", k, state("edgeWidth", 1)] } },
      "nora-nodes": { layout: { "text-size": 11.5 * k }, paint: { "text-halo-width": 2 * k } },
    };
    for (const [id, { paint = {}, layout = {} }] of Object.entries(sizes)) {
      if (!map.getLayer(id)) continue;
      for (const [key, value] of Object.entries(paint)) map.setPaintProperty(id, key, value);
      for (const [key, value] of Object.entries(layout)) map.setLayoutProperty(id, key, value);
    }
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

  // A GIS-style raster fallback for when the vector basemap is unreachable
  // (blocked CDN, offline tiles): OpenStreetMap raster tiles still place every
  // asset precisely, and NORA's own layers draw on top either way.
  const FALLBACK_STYLE = {
    version: 8,
    glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
    sources: {
      osm: {
        type: "raster", tileSize: 256, maxzoom: 19,
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        attribution: "© OpenStreetMap contributors",
      },
    },
    layers: [{ id: "osm-raster", type: "raster", source: "osm" }],
  };

  // Can this browser draw with WebGL? The test context is released at once, since
  // browsers allow only a handful of live WebGL contexts per page.
  function hasWebGL() {
    try {
      const gl = document.createElement("canvas").getContext("webgl2") || document.createElement("canvas").getContext("webgl");
      if (!gl) return false;
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return true;
    } catch { return false; }
  }
  /* No WebGL (hardware acceleration off, an old or locked-down browser, the GPU
     restarting), no MapLibre (offline), or ?map=simple: draw the same map on a plain
     canvas instead (map2d.js), with the coastline shipped inside the page. */
  function canvasFallback(el) {
    if (map) { try { map.remove(); } catch { /* already gone */ } }
    map = null; canvas = null; ctx = null;
    NoraCanvasMap(view); // its mount clears the map's own elements and keeps the map card
    view.mount(el);
  }
  const wantSimple = new URLSearchParams(location.search).get("map") === "simple";
  // Keep the camera on the network: no zooming out far past the whole of it.
  function limitZoom() {
    if (!map || !map.getContainer().clientWidth) return;
    const fit = map.cameraForBounds(NORA.config.map.bounds, { padding: padding() });
    if (fit && Number.isFinite(fit.zoom)) map.setMinZoom(Math.max(2, fit.zoom - 0.3));
  }

  view.mount = (el) => {
    if (wantSimple || typeof maplibregl === "undefined" || !hasWebGL()) { canvasFallback(el); return; }
    /* Panning stays near the network. The limit is generous sideways: the network is
       tall and narrow, so fitting all of it in a wide window shows a lot of longitude,
       and a tight limit would make MapLibre zoom in and cut off the south instead.
       Zooming out is capped separately (limitZoom). */
    const [[w, s], [e, n]] = NORA.config.map.bounds, padLon = Math.max(40, (e - w) * 2), padLat = (n - s) * 0.5;
    try {
      /* fadeDuration 0: names appear and go at once instead of fading in over 300 ms.
         With a fade, MapLibre kept repainting the whole map while the data stepped
         (4 times a second): about 40 repaints a second instead of 4. */
      map = new maplibregl.Map({
        container: el, style: NORA.config.map.style, bounds: NORA.config.map.bounds,
        fitBoundsOptions: { padding: padding() }, attributionControl: { compact: true },
        cooperativeGestures: false, dragRotate: false, pitchWithRotate: false, minZoom: 2, maxZoom: 12,
        maxBounds: [[w - padLon, s - padLat], [e + padLon, Math.min(85, n + padLat)]], fadeDuration: 0,
      });
    } catch { canvasFallback(el); return; } // MapLibre throws when it cannot get a WebGL context
    // WebGL lost and not back within 3 s (a GPU restart): carry on with the canvas map.
    let lostTimer = null;
    map.getCanvas().addEventListener("webglcontextlost", () => { lostTimer = setTimeout(() => canvasFallback(el), 3000); });
    map.getCanvas().addEventListener("webglcontextrestored", () => clearTimeout(lostTimer));
    map.once("load", limitZoom);
    view.map = map;
    map.touchZoomRotate.disableRotation();
    App.onPinch(el, (factor, at) => map.zoomTo(map.getZoom() + Math.log2(factor), { around: map.unproject([at.x, at.y]), duration: 0 }));
    canvas = document.createElement("canvas");
    canvas.className = "dots-layer";
    el.append(canvas);
    ctx = canvas.getContext("2d");
    notes = App.notes.layer(el);
    let styled = false;
    const failToFallback = (why) => {
      if (styled) return;
      styled = true;
      note.remove();
      basemap = FALLBACK_STYLE;
      try { map.setStyle(FALLBACK_STYLE); } catch { /* already gone */ }
    };
    // If the online style never arrives (CDN blocked, DNS, captive portal), fall back.
    const note = Object.assign(document.createElement("div"), { className: "map-note", textContent: "Loading the map…" });
    el.append(note);
    const styleTimer = setTimeout(() => failToFallback("timeout"), 9000);
    map.on("style.load", () => { clearTimeout(styleTimer); styled = true; note.remove(); addLayers(); });
    map.on("error", (e) => {
      if (styled) return; // a tile hiccup after a good load is not a failure
      const msg = String((e && e.error && e.error.message) || "");
      failToFallback(msg);
    });
    // GIS controls: scale bar, zoom buttons, and a live coordinate readout.
    try {
      map.addControl(new maplibregl.ScaleControl({ maxWidth: 120 }), "bottom-left");
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }), "bottom-right");
    } catch { /* a stripped MapLibre build without controls */ }
    const readout = Object.assign(document.createElement("div"), { className: "coord-readout", textContent: "" });
    el.append(readout);
    const showCoord = (lngLat) => {
      const lng = ((lngLat.lng + 180) % 360 + 360) % 360 - 180;
      readout.textContent = App.positionText(lng, lngLat.lat); // water depth instead of the zoom (Ray)
    };
    map.on("mousemove", (e) => showCoord(e.lngLat));
    map.on("move", () => showCoord(map.getCenter()));
    map.on("mouseout", () => { readout.textContent = ""; });
    map.on("resize", sizeCanvas);
    map.on("render", () => view.ready && view.draw());
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    // A pig, peak or slug under the pointer wins: its value and when it reaches the next stop.
    let overMark = false;
    map.on("mousemove", (e) => {
      const m = markAt(e.point.x, e.point.y);
      if (m) { popup.setLngLat(e.lngLat).setText(App.markerTip(m)).addTo(map); map.getCanvas().style.cursor = "help"; overMark = true; }
      else if (overMark) { popup.remove(); map.getCanvas().style.cursor = ""; overMark = false; }
    });
    for (const layer of ["nora-node-dots", "nora-nodes", "nora-pipes-hit"]) {
      map.on("mousemove", layer, (e) => {
        if (markAt(e.point.x, e.point.y)) return;
        map.getCanvas().style.cursor = "pointer";
        const id = e.features[0].properties.asset;
        popup.setLngLat(e.lngLat).setText(App.nameOf(id)).addTo(map);
      });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
    }
    map.on("click", (e) => {
      if (!view.ready) return;
      const mark = markAt(e.point.x, e.point.y); // a pig or a peak under the pointer wins
      if (mark) { App.selectMarker(mark.key); return; }
      const hit = map.queryRenderedFeatures(e.point, { layers: ["nora-node-dots", "nora-nodes", "nora-pipes-hit"] });
      if (hit.length) App.select(hit[0].properties.asset);
    });
    // Right-click a node or a pipeline: the same menu everywhere. A plain DOM
    // listener on the container: it fires for real right-clicks, whichever
    // canvas MapLibre puts on top, and we hit-test the point ourselves.
    el.addEventListener("contextmenu", (e) => {
      if (!view.ready) return;
      const rect = map.getCanvas().getBoundingClientRect();
      const hit = map.queryRenderedFeatures([e.clientX - rect.left, e.clientY - rect.top], { layers: ["nora-node-dots", "nora-nodes", "nora-pipes-hit"] });
      if (!hit.length) return;
      e.preventDefault();
      const id = hit[0].properties.asset, d = NORA.assets[id], at = [e.clientX - rect.left, e.clientY - rect.top];
      const items = App.menu.for(id, d.lat != null ? {
        center: () => map.easeTo({ center: [d.lon, d.lat], zoom: Math.max(map.getZoom(), 7), duration: App.reduceMotion ? 0 : 700 }),
        coords: `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`,
      } : ends[id] ? { note: () => App.notes.add(id, ...App.notes.snap(ends[id], (lonlat) => map.project(lonlat), ...at)) } : {});
      App.menu.open(e.clientX, e.clientY, items);
    });
  };

  view.restyle = () => {
    if (!view.ready) return;
    changed();
    const alarms = [];
    for (const id of App.pipeIds) {
      const s = App.pipeStyle(id);
      map.setFeatureState(featureOf[id], { color: s.color, width: s.width, casing: s.level > 0, dim: s.dim, hide: s.hidden, model: Boolean(s.model) });
      if (s.level && !s.hidden) alarms.push(`${id}:${s.level}`);
    }
    for (const id of App.nodeIds) {
      const s = App.nodeStyle(id);
      const look = C.card[s.inactive ? "inactive" : App.state.mode === "live" ? "active" : "normal"];
      map.setFeatureState(featureOf[id], {
        fill: look.fill, edge: s.level ? App.levelColor[s.level] : C.text_dim, edgeWidth: s.level ? 2.5 : 1,
        dim: s.dim, hide: s.hidden,
      });
      if (s.level && !s.hidden) alarms.push(`${id}:${s.level}`);
    }
    // Badges are layout, so they follow the data, not feature state: reload them only
    // when an alarm changes. Names are never reloaded, so they stay put.
    const key = alarms.join(",");
    if (key !== alarmKey) {
      alarmKey = key;
      const lvl = Object.fromEntries(alarms.map((a) => [a.split(":")[0], Number(a.split(":")[1])]));
      for (const f of mids.features) f.properties.alarm = lvl[f.properties.asset] || 0;
      map.getSource("nora-mids").setData(mids);
    }
  };

  /* Pigs and peaks (and, if switched on, faint flow dots) on a canvas over the map.
     App's frame loop asks for a draw every frame and so does every MapLibre repaint (a
     pan, a zoom, a restyle), so the layer always follows the map. It is drawn again
     only when what it shows can have changed: the camera, the canvas, the data or
     settings (restyle), the mode, or, while playing, the clock. That was ~100 draws a
     second while playing and 60 while paused with nothing moving. */
  let revision = 0, drawnKey = "", boxesKey = "", boxes = [];
  const changed = () => { revision++; };
  function sceneKey() {
    const c = map.getCenter(), el = map.getContainer();
    return [revision, App.notes.version(), App.state.mode, c.lng, c.lat, map.getZoom(), map.getBearing(), map.getPitch(),
      el.clientWidth, el.clientHeight, window.devicePixelRatio || 1].join("|");
  }
  view.draw = () => {
    if (!ctx || !map) return;
    const scene = sceneKey(), key = `${scene}|${App.live.playing ? App.live.clock : "paused"}`;
    if (key === drawnKey) return;
    App.frame.run(() => drawNow(scene));
    drawnKey = key;
  };
  function drawNow(scene) {
    sizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawnMarks = []; // nothing to hover over until markers are drawn again
    if (App.state.mode !== "live") { modelLabels(scene); drawNotes(); return; }
    const visibleRanges = {};
    const visibleAlong = (id, along) => {
      if (!visibleRanges[id]) {
        const points = ends[id].map((lonlat) => map.project(lonlat));
        const total = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0) || 1;
        const z = map.getZoom(), k = App.uiScale();
        const radius = (z <= 3 ? 3.5 : z <= 6 ? 3.5 + ((z - 3) / 3) * 2 : z <= 9 ? 5.5 + ((z - 6) / 3) * 2.5 : 8) * k;
        visibleRanges[id] = App.visibleRange(total, radius + 8 * k);
      }
      const [start, end] = visibleRanges[id];
      return start + (end - start) * Math.max(0, Math.min(1, along));
    };
    const project = (id, along) => {
      const r = alongRoute(id, visibleAlong(id, along)), p = map.project(r.at), pa = map.project(r.a), pb = map.project(r.b);
      return { x: p.x, y: p.y, angle: Math.atan2(pb.y - pa.y, pb.x - pa.x) };
    };
    const projectBand = (id, extent) => {
      // Include every laid-route vertex inside the band, not just uniform samples:
      // otherwise a moving head/tail visibly cuts across a bend between two samples.
      const cumulative = routeLengths[id], total = cumulative[cumulative.length - 1] || 1;
      const [start, end] = visibleRanges[id];
      const vertices = cumulative.map((distance) => distance / total);
      return App.bandStops(extent, vertices, [start, end]).map((along) => project(id, along));
    };
    if (App.settings().animation && App.live.playing && !App.reduceMotion) {
      /* Simulated flow at the nodes, not on the lines: short solid bands sliding
         INTO the icon where gas arrives and OUT of it where gas leaves, scaled by
         how much the line carries. The long lines stay still. */
      ctx.lineCap = "round";
      for (const nid of App.nodeIds) {
        const node = NORA.assets[nid];
        if (!node || !nodeAtZoom(nid) || node.type === "tee") continue;
        const pn = map.project([node.lon, node.lat]);
        if (pn.x < -40 || pn.y < -40 || pn.x > canvas.clientWidth + 40 || pn.y > canvas.clientHeight + 40) continue;
        const k = App.uiScale();
        for (const pid of linesAt[nid] || []) {
          const v = App.live.values[pid], p = NORA.assets[pid];
          if (!v || Math.abs(v) < 0.05 || !p || (p.from !== nid && p.to !== nid)) continue;
          if (App.pipeStyle(pid).hidden || !pipeAtZoom(pid)) continue;
          const line = ends[pid], other = map.project(p.from === nid ? line[1] : line[line.length - 2]);
          const dx = other.x - pn.x, dy = other.y - pn.y, len = Math.hypot(dx, dy);
          if (len < 8 * k) continue;
          const ux = dx / len, uy = dy / len;
          // The stub shrinks with short lines (overview zoom): a hint, not a hair.
          const stub = Math.min(26 * k, len * 0.4), band = Math.max(3 * k, Math.min(8 * k, stub * 0.5));
          // Gas moves toward this node when the flow sign points here.
          const inflow = (p.to === nid) === (v > 0);
          const share = Math.min(1, Math.abs(v) / (p.capacity || 30));
          ctx.strokeStyle = C.active;
          ctx.lineWidth = (1.6 + share * 2.2) * k;
          for (let k = 0; k < 2; k++) {
            const t = (App.live.clock * 0.45 + k / 2) % 1;
            const d = inflow ? (stub - band) * (1 - t) + band : (stub - band) * t + band;
            // Brighter as a band reaches the node, fading as one leaves it.
            ctx.globalAlpha = 0.25 + (inflow ? t : 1 - t) * 0.55;
            const cx = pn.x + ux * d, cy = pn.y + uy * d;
            ctx.beginPath();
            ctx.moveTo(cx - ux * band / 2, cy - uy * band / 2);
            ctx.lineTo(cx + ux * band / 2, cy + uy * band / 2);
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    }
    // Peaks as bands from tail to head, then every marker, then pipeline names on top.
    const marks = App.markers().filter((m) => ends[m.id] && !App.pipeStyle(m.id).hidden && pipeAtZoom(m.id));
    const zoom = map.getZoom(), detail = zoom >= 6.5 ? 2 : zoom >= 5 ? 1 : 0, u = App.uiScale();
    // The node boxes only move with the camera or a restyle: work them out once per scene.
    const reserve = marks.length || App.settings().names;
    if (reserve && boxesKey !== scene) { boxes = nodeBoxes(ctx); boxesKey = scene; }
    const taken = reserve ? boxes.slice() : []; // labels add their own boxes to `taken`
    const pipeLabels = [];
    if (App.settings().names) {
      ctx.save();
      ctx.font = `${11.5 * u}px Archivo, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const id of App.pipeIds) {
        const style = App.pipeStyle(id), text = App.pipeMapName(id);
        if (!text || style.hidden || style.dim || !pipeAtZoom(id)) continue;
        const point = project(id, 0.5), y = point.y - 9 * u;
        // zoomed in, its diameter and length on a second line above the name
        const sub = zoom >= App.detailZoom ? App.pipeDetail(id) : "";
        const w = Math.max(ctx.measureText(text).width, sub ? ctx.measureText(sub).width : 0) + 4 * u;
        const box = [point.x - w / 2, y - (sub ? 21 : 8) * u, point.x + w / 2, y + 8 * u];
        if (taken.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
        taken.push(box); // reserve now so marker labels avoid the name too
        pipeLabels.push({ text, sub, x: point.x, y });
      }
      ctx.restore();
    }
    for (const id of App.pipeIds) {
      if (NORA.assets[id].type === "interconnector" && !App.pipeStyle(id).hidden && pipeAtZoom(id)) App.drawFlowDirection(ctx, id, (t) => project(id, t), u, taken);
    }
    for (const m of marks) if (m.extent) App.drawBand(ctx, m, project(m.id, m.extent[0]), project(m.id, m.extent[1]), 3.2 * u, projectBand(m.id, m.extent));
    for (const m of marks) {
      const p = project(m.id, m.along);
      App.drawMarker(ctx, m, p.x, p.y, p.angle, App.markerSize(m.kind, (map.getZoom() - 6) / 4), detail, taken);
      if (!m.noDot) drawnMarks.push({ x: p.x, y: p.y, m });
    }
    // MapLibre's own label layer would be below this canvas. Paint names here instead,
    // last, so neither a moving band nor a peak marker can cross out a pipeline's name.
    ctx.save();
    ctx.font = `${11.5 * u}px Archivo, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const label of pipeLabels) {
      ctx.lineWidth = 4 * u; ctx.strokeStyle = C.paper; ctx.strokeText(label.text, label.x, label.y);
      ctx.fillStyle = C.text; ctx.fillText(label.text, label.x, label.y);
    }
    ctx.font = `${10.5 * u}px Archivo, system-ui, sans-serif`;
    for (const label of pipeLabels) {
      if (!label.sub) continue;
      ctx.lineWidth = 3.5 * u; ctx.strokeStyle = C.paper; ctx.strokeText(label.sub, label.x, label.y - 13 * u);
      ctx.fillStyle = C.text_dim; ctx.fillText(label.sub, label.x, label.y - 13 * u);
    }
    ctx.restore();
    drawNotes();
  }
  // Notes last: their windows and arrows sit over everything the layer draws.
  const drawNotes = () => notes && notes.draw(ctx, (lonlat) => map.project(lonlat), (pid) => !App.pipeStyle(pid).hidden && pipeAtZoom(pid));

  /* Screen boxes of the node dots and their names, where MapLibre puts them (under the
     dot, wrapped at 9 em), so the labels of pigs and peaks keep clear of them. */
  /* Load and Risk write each line's number (how full; what a trip costs) under its
     middle, in the italic the model's numbers use, where it clears the node names:
     at overview zoom the map had no numbers at all (review #49802). */
  function modelLabels(scene) {
    if (boxesKey !== scene) { boxes = nodeBoxes(ctx); boxesKey = scene; }
    const taken = boxes.slice(), u = App.uiScale();
    ctx.save();
    ctx.font = `italic ${11 * u}px Archivo, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    for (const id of App.pipeIds) {
      const s = App.pipeStyle(id);
      if (!s.model || !s.label || s.hidden || !ends[id] || !pipeAtZoom(id)) continue;
      const p = map.project(alongRoute(id, 0.5).at), y = p.y + 9 * u, w = ctx.measureText(s.label).width + 4 * u;
      const box = [p.x - w / 2, y - 7 * u, p.x + w / 2, y + 7 * u];
      if (taken.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      taken.push(box);
      ctx.lineWidth = 3.5 * u; ctx.strokeStyle = C.paper; ctx.strokeText(s.label, p.x, y);
      ctx.fillStyle = C.text; ctx.fillText(s.label, p.x, y);
    }
    ctx.restore();
  }

  function nodeBoxes(ctx) {
    const out = [], names = App.settings().names, w0 = map.getContainer().clientWidth, h0 = map.getContainer().clientHeight;
    const k = App.uiScale(), wrap = 104 * k; // the names grow with the one UI scale
    ctx.save();
    ctx.font = `${11.5 * k}px Archivo, system-ui, sans-serif`;
    for (const id of App.nodeIds) {
      const d = NORA.assets[id];
      if (App.nodeStyle(id).hidden || !nodeAtZoom(id) || d.type === "tee") continue;
      const p = map.project([d.lon, d.lat]);
      if (p.x < -150 || p.y < -60 || p.x > w0 + 150 || p.y > h0 + 60) continue;
      out.push([p.x - 6 * k, p.y - 6 * k, p.x + 6 * k, p.y + 6 * k]);
      if (!names) continue;
      const w = ctx.measureText(d.name).width, half = Math.min(w, wrap) / 2 + 2;
      out.push([p.x - half, p.y + 7 * k, p.x + half, p.y + 9 * k + Math.ceil(w / wrap) * 14 * k]);
    }
    ctx.restore();
    return out;
  }

  view.applySettings = () => {
    if (!view.ready) return;
    changed();
    map.setLayoutProperty("nora-nodes", "text-field", App.settings().names ? ["get", "name"] : "");
    scaleLayers();
  };

  let pendingFit = false;
  view.setUnit = (unit) => {
    if (!view.ready) return;
    // Hidden behind the other view (a theme switch reloads the style): fit when shown.
    if (!map.getContainer().clientWidth) { pendingFit = true; return; }
    pendingFit = false;
    const members = unit === "all" ? null : App.units[unit].nodes;
    const points = members ? members.map((id) => [NORA.assets[id].lon, NORA.assets[id].lat]) : null;
    if (!points || !points.length) { map.fitBounds(NORA.config.map.bounds, { padding: padding(), duration: duration(400) }); return; }
    const lons = points.map((p) => p[0]), lats = points.map((p) => p[1]);
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 70, maxZoom: 7.5, duration: duration(400) });
  };

  view.highlight = (id) => {
    if (!view.ready) return;
    if (highlighted && featureOf[highlighted] && featureOf[highlighted].source === "nora-nodes") map.setFeatureState(featureOf[highlighted], { selected: false });
    highlighted = id;
    if (id && featureOf[id] && featureOf[id].source === "nora-nodes") map.setFeatureState(featureOf[id], { selected: true });
  };

  view.focus = (id, animate) => {
    if (!view.ready) return;
    const d = NORA.assets[id];
    if (d.kind === "node") map.easeTo({ center: [d.lon, d.lat], zoom: Math.max(map.getZoom(), 6.5), duration: animate ? duration(600) : 0 });
    else {
      const line = ends[id], lons = line.map((p) => p[0]), lats = line.map((p) => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 120, maxZoom: 7, duration: animate ? duration(600) : 0 });
    }
  };
  view.fit = () => view.setUnit(App.route.unit);
  view.resize = () => {
    if (!map) return;
    map.resize();
    sizeCanvas();
    limitZoom();
    if (pendingFit) view.setUnit(App.route.unit);
  };
  /* A new palette: reload the style so the basemap, icons and badges are redrawn in
     it. The style in use, not the configured one: after a fall back to raster tiles,
     reloading the online style that failed would leave the map empty. */
  view.theme = () => {
    if (!map) return;
    view.ready = false;
    alarmKey = "";
    map.setStyle(basemap || NORA.config.map.style, { diff: false });
  };

  App.register("map", view);
})();
