/* Map view (level 2): the network at its true coordinates on OpenFreeMap vector tiles,
   drawn with MapLibre GL. The basemap is recoloured to the paper greys so that colour on
   the map only ever means an alarm. Styling comes from App.pipeStyle / App.nodeStyle
   through feature state; this file only knows how to put things on a map. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  const C = App.colors;
  let map = null, canvas = null, ctx = null, highlighted = null, alarmKey = "";
  let drawnMarks = []; // where pigs, peaks and slugs were drawn this frame, for mouse-over
  const markAt = (x, y) => {
    let best = null, bestD = 9; // px
    for (const d of drawnMarks) { const dist = Math.hypot(d.x - x, d.y - y); if (dist < bestD) { best = d.m; bestD = dist; } }
    return best;
  };

  const featureOf = {}; // asset id -> { source, id }
  const ends = {}; // pipeline id -> [[lon, lat], [lon, lat]]
  for (const f of NORA.geo.nodes.features) featureOf[f.properties.asset] = { source: "nora-nodes", id: f.id };
  for (const f of NORA.geo.pipes.features) {
    featureOf[f.properties.asset] = { source: "nora-pipes", id: f.id };
    ends[f.properties.asset] = f.geometry.coordinates;
  }
  // Midpoints of pipelines, for alarm badges on lines.
  const mids = {
    type: "FeatureCollection",
    features: NORA.geo.pipes.features.map((f) => ({
      type: "Feature", id: f.id, properties: { asset: f.properties.asset, alarm: 0 },
      geometry: { type: "Point", coordinates: [(f.geometry.coordinates[0][0] + f.geometry.coordinates[1][0]) / 2, (f.geometry.coordinates[0][1] + f.geometry.coordinates[1][1]) / 2] },
    })),
  };
  // Badges have their own copy of the nodes, so updating them never re-places the names
  // (that made every label fade out and in).
  const badgeData = JSON.parse(JSON.stringify(NORA.geo.nodes));
  for (const f of badgeData.features) f.properties.alarm = 0;

  const padding = () => ({ top: 30, left: 30, right: 30, bottom: 30 });
  const duration = (ms) => (App.reduceMotion ? 0 : ms);

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
            map.setPaintProperty(id, "text-color", C.text_dim);
            map.setPaintProperty(id, "text-halo-color", C.paper);
            map.setPaintProperty(id, "icon-opacity", 0);
          } else map.setLayoutProperty(id, "visibility", "none");
        } else map.setLayoutProperty(id, "visibility", "none");
      } catch (error) { /* a layer without that property: leave it */ }
    }
  }

  function loadImage(name, uri, size) {
    return new Promise((resolve) => {
      if (map.hasImage(name)) return resolve();
      const image = new Image(size, size);
      image.onload = () => { map.addImage(name, image, { pixelRatio: 2 }); resolve(); };
      image.onerror = resolve;
      image.src = uri;
    });
  }
  function badgeUri(lvl) {
    const s = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 16 16">${App.shapeMarkup(lvl)}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`;
  }

  async function addLayers() {
    view.ready = false;
    calmBasemap();
    await Promise.all([1, 2, 3].map((l) => loadImage(`nora-alarm-${l}`, badgeUri(l), 32)));
    map.addSource("nora-pipes", { type: "geojson", data: NORA.geo.pipes });
    map.addSource("nora-nodes", { type: "geojson", data: NORA.geo.nodes });
    map.addSource("nora-node-badges", { type: "geojson", data: badgeData });
    map.addSource("nora-mids", { type: "geojson", data: mids });
    const state = (key, fallback) => ["coalesce", ["feature-state", key], fallback];
    // Hairlines at overview zoom, a little more weight only when zoomed in.
    const width = (k, extra = 0) => ["interpolate", ["linear"], ["zoom"],
      3, ["+", extra, ["*", 0.45 * k, state("width", 1)]],
      6, ["+", extra, ["*", 0.7 * k, state("width", 1)]],
      9, ["+", extra, ["*", 1.1 * k, state("width", 1)]]];
    const opacity = ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.3, 1];
    // A dark casing under any line in alarm, so colour never stands alone.
    map.addLayer({ id: "nora-casing", type: "line", source: "nora-pipes", layout: { "line-cap": "round" },
      paint: { "line-color": C.casing, "line-width": width(1, 1.6), "line-opacity": ["case", ["boolean", ["feature-state", "casing"], false], opacity, 0] } });
    map.addLayer({ id: "nora-pipes-onshore", type: "line", source: "nora-pipes", filter: ["==", ["get", "onshore"], true],
      paint: { "line-color": ["to-color", state("color", C.inactive)], "line-width": width(0.8), "line-dasharray": [2, 2], "line-opacity": opacity } });
    map.addLayer({ id: "nora-pipes", type: "line", source: "nora-pipes", filter: ["!=", ["get", "onshore"], true], layout: { "line-cap": "round" },
      paint: { "line-color": ["to-color", state("color", C.normal)], "line-width": width(1), "line-opacity": opacity } });
    map.addLayer({ id: "nora-pipes-hit", type: "line", source: "nora-pipes", paint: { "line-color": "#000", "line-opacity": 0, "line-width": 14 } });
    /* Nodes are plain circles in their state grey, as in the Flow view: no icons (Ray,
       28 Oct). An alarm colours only the outline, and the badge carries the shape and
       number. Names are a separate text layer that is never reloaded. */
    const radius = (extra = 0) => ["interpolate", ["linear"], ["zoom"], 3, 3.5 + extra, 6, 5.5 + extra, 9, 8 + extra];
    const nodeOpacity = ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.3, 1];
    map.addLayer({ id: "nora-selected", type: "circle", source: "nora-nodes",
      paint: { "circle-radius": radius(5), "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2, "circle-stroke-color": C.text,
        "circle-stroke-opacity": ["case", ["boolean", ["feature-state", "selected"], false], 1, 0] } });
    map.addLayer({ id: "nora-node-dots", type: "circle", source: "nora-nodes",
      paint: {
        "circle-radius": radius(), "circle-color": ["to-color", state("fill", C.normal)],
        "circle-stroke-color": ["to-color", state("edge", C.text_dim)], "circle-stroke-width": state("edgeWidth", 1),
        "circle-opacity": nodeOpacity, "circle-stroke-opacity": nodeOpacity,
      } });
    map.addLayer({ id: "nora-nodes", type: "symbol", source: "nora-nodes",
      layout: {
        "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11.5,
        "text-offset": [0, 0.8], "text-anchor": "top", "text-optional": true, "text-max-width": 9,
      },
      paint: {
        "text-opacity": nodeOpacity, "text-color": C.text, "text-halo-color": C.paper, "text-halo-width": 1.5,
      } });
    // Alarm badges: shape + number + colour, on nodes and at the middle of lines.
    for (const [id, source, offset] of [["nora-node-alarms", "nora-node-badges", [12, -12]], ["nora-pipe-alarms", "nora-mids", [0, 0]]]) {
      map.addLayer({ id, type: "symbol", source, filter: [">", ["get", "alarm"], 0],
        layout: { "icon-image": ["concat", "nora-alarm-", ["to-string", ["get", "alarm"]]], "icon-size": 0.85, "icon-offset": offset,
          "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-sort-key": ["-", 0, ["get", "alarm"]] } });
    }
    alarmKey = "";
    view.ready = true;
    view.applySettings();
    view.setUnit(App.route.unit);
    view.restyle();
    view.highlight(App.route.focus);
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
    el.replaceChildren();
    NoraCanvasMap(view);
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
    const [[w, s], [e, n]] = NORA.config.map.bounds, padLon = (e - w) * 0.6, padLat = (n - s) * 0.6;
    try {
      map = new maplibregl.Map({
        container: el, style: NORA.config.map.style, bounds: NORA.config.map.bounds,
        fitBoundsOptions: { padding: padding() }, attributionControl: { compact: true },
        cooperativeGestures: App.embed, dragRotate: false, pitchWithRotate: false, minZoom: 2, maxZoom: 12,
        maxBounds: [[w - padLon, s - padLat], [e + padLon, n + padLat]],
      });
    } catch { canvasFallback(el); return; } // MapLibre throws when it cannot get a WebGL context
    // WebGL lost and not back within 3 s (a GPU restart): carry on with the canvas map.
    let lostTimer = null;
    map.getCanvas().addEventListener("webglcontextlost", () => { lostTimer = setTimeout(() => canvasFallback(el), 3000); });
    map.getCanvas().addEventListener("webglcontextrestored", () => clearTimeout(lostTimer));
    map.once("load", limitZoom);
    view.map = map;
    map.touchZoomRotate.disableRotation();
    canvas = document.createElement("canvas");
    canvas.className = "dots-layer";
    el.append(canvas);
    ctx = canvas.getContext("2d");
    let styled = false;
    const failToFallback = (why) => {
      if (styled) return;
      styled = true;
      note.remove();
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
      readout.textContent = `${Math.abs(lngLat.lat).toFixed(5)}°${lngLat.lat >= 0 ? "N" : "S"}  ${Math.abs(lng).toFixed(5)}°${lng >= 0 ? "E" : "W"}  ·  zoom ${map.getZoom().toFixed(1)}`;
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
      const id = hit[0].properties.asset, d = NORA.assets[id];
      const items = App.menu.for(id, d.lat != null ? {
        center: () => map.easeTo({ center: [d.lon, d.lat], zoom: Math.max(map.getZoom(), 7), duration: App.reduceMotion ? 0 : 700 }),
        coords: `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`,
      } : {});
      App.menu.open(e.clientX, e.clientY, items);
    });
  };

  view.restyle = () => {
    if (!view.ready) return;
    const alarms = [];
    for (const id of App.pipeIds) {
      const s = App.pipeStyle(id);
      map.setFeatureState(featureOf[id], { color: s.color, width: s.width, casing: s.level > 0, dim: s.dim, hide: s.hidden });
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
      for (const f of badgeData.features) f.properties.alarm = lvl[f.properties.asset] || 0;
      for (const f of mids.features) f.properties.alarm = lvl[f.properties.asset] || 0;
      map.getSource("nora-node-badges").setData(badgeData);
      map.getSource("nora-mids").setData(mids);
    }
  };

  // Pigs and peaks (and, if switched on, faint flow dots) on a canvas over the map.
  view.draw = () => {
    if (!ctx) return;
    sizeCanvas();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (App.state.mode !== "live") return;
    const project = (id, along) => {
      const [a, b] = ends[id], pa = map.project(a), pb = map.project(b);
      return { x: pa.x + (pb.x - pa.x) * along, y: pa.y + (pb.y - pa.y) * along, angle: Math.atan2(pb.y - pa.y, pb.x - pa.x) };
    };
    if (App.settings().animation && App.live.playing && !App.reduceMotion) {
      /* Simulated flow at the nodes, not on the lines: short solid bands sliding
         INTO the icon where gas arrives and OUT of it where gas leaves, scaled by
         how much the line carries. The long lines stay still. */
      ctx.lineCap = "round";
      for (const nid of App.nodeIds) {
        const node = NORA.assets[nid];
        if (!node) continue;
        const pn = map.project([node.lon, node.lat]);
        if (pn.x < -40 || pn.y < -40 || pn.x > canvas.clientWidth + 40 || pn.y > canvas.clientHeight + 40) continue;
        for (const pid of App.pipeIds) {
          const v = App.live.values[pid], p = NORA.assets[pid];
          if (!v || Math.abs(v) < 0.05 || !p || (p.from !== nid && p.to !== nid)) continue;
          if (App.pipeStyle(pid).hidden) continue;
          const other = map.project(p.from === nid ? ends[pid][1] : ends[pid][0]);
          const dx = other.x - pn.x, dy = other.y - pn.y, len = Math.hypot(dx, dy);
          if (len < 8) continue;
          const ux = dx / len, uy = dy / len;
          // The stub shrinks with short lines (overview zoom): a hint, not a hair.
          const stub = Math.min(26, len * 0.4), band = Math.max(3, Math.min(8, stub * 0.5));
          // Gas moves toward this node when the flow sign points here.
          const inflow = (p.to === nid) === (v > 0);
          const share = Math.min(1, Math.abs(v) / (p.capacity || 30));
          ctx.strokeStyle = C.active;
          ctx.lineWidth = 1.6 + share * 2.2;
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
    // Peaks as bands from tail to head first, then every marker on top.
    const marks = App.markers().filter((m) => ends[m.id] && !App.pipeStyle(m.id).hidden);
    for (const m of marks) if (m.extent) App.drawBand(ctx, m, project(m.id, m.extent[0]), project(m.id, m.extent[1]));
    const zoom = map.getZoom(), detail = zoom >= 6.5 ? 2 : zoom >= 5 ? 1 : 0;
    drawnMarks = [];
    for (const m of marks) {
      const p = project(m.id, m.along);
      App.drawMarker(ctx, m, p.x, p.y, p.angle, 6.5, detail);
      if (!m.noDot) drawnMarks.push({ x: p.x, y: p.y, m });
    }
  };

  view.applySettings = () => {
    if (!view.ready) return;
    map.setLayoutProperty("nora-nodes", "text-field", App.settings().names ? ["get", "name"] : "");
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
      const [a, b] = ends[id];
      map.fitBounds([[Math.min(a[0], b[0]), Math.min(a[1], b[1])], [Math.max(a[0], b[0]), Math.max(a[1], b[1])]], { padding: 120, maxZoom: 7, duration: animate ? duration(600) : 0 });
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
  // A new palette: reload the style so the basemap, icons and badges are redrawn in it.
  view.theme = () => {
    if (!map) return;
    view.ready = false;
    alarmKey = "";
    map.setStyle(NORA.config.map.style, { diff: false });
  };

  App.register("map", view);
})();
