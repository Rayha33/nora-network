/* Map view (level 2): the network at its true coordinates on OpenFreeMap vector tiles,
   drawn with MapLibre GL. The basemap is recoloured to the paper greys so that colour on
   the map only ever means an alarm. Styling comes from App.pipeStyle / App.nodeStyle
   through feature state; this file only knows how to put things on a map. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  const C = App.colors;
  let map = null, canvas = null, ctx = null, highlighted = null, alarmKey = "";

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
        } else if (layer.type === "symbol") {
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
    await Promise.all([
      ...Object.entries(NORA.icons).map(([kind, uri]) => loadImage(`nora-${kind}`, uri, 48)),
      ...[1, 2, 3].map((l) => loadImage(`nora-alarm-${l}`, badgeUri(l), 32)),
    ]);
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
    map.addLayer({ id: "nora-selected", type: "circle", source: "nora-nodes",
      paint: { "circle-radius": ["case", ["boolean", ["feature-state", "selected"], false], 17, 0], "circle-color": "rgba(0,0,0,0)", "circle-stroke-width": 2.5, "circle-stroke-color": C.text } });
    map.addLayer({ id: "nora-nodes", type: "symbol", source: "nora-nodes",
      layout: {
        "icon-image": ["concat", "nora-", ["get", "type"]], "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.55, 6, 0.8, 9, 1],
        "icon-allow-overlap": true, "icon-ignore-placement": true,
        "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11.5, "text-offset": [0, 1.3],
        "text-anchor": "top", "text-optional": true, "text-max-width": 9,
      },
      paint: {
        "icon-opacity": ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.3, ["boolean", ["feature-state", "inactive"], false], 0.55, 1],
        "text-opacity": ["case", ["boolean", ["feature-state", "hide"], false], 0, ["boolean", ["feature-state", "dim"], false], 0.3, 1],
        "text-color": C.text, "text-halo-color": C.paper, "text-halo-width": 1.5,
      } });
    // Alarm badges: shape + number + colour, on nodes and at the middle of lines.
    for (const [id, source, offset] of [["nora-node-alarms", "nora-node-badges", [22, -22]], ["nora-pipe-alarms", "nora-mids", [0, 0]]]) {
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

  view.mount = (el) => {
    if (typeof maplibregl === "undefined") {
      el.append(Object.assign(document.createElement("p"), { className: "notice", textContent: "The map needs an internet connection. The Flow view works offline." }));
      return;
    }
    map = new maplibregl.Map({
      container: el, style: NORA.config.map.style, bounds: NORA.config.map.bounds,
      fitBoundsOptions: { padding: padding() }, attributionControl: { compact: true },
      cooperativeGestures: App.embed, dragRotate: false, pitchWithRotate: false, minZoom: 2, maxZoom: 12,
    });
    view.map = map;
    map.touchZoomRotate.disableRotation();
    canvas = document.createElement("canvas");
    canvas.className = "dots-layer";
    el.append(canvas);
    ctx = canvas.getContext("2d");
    map.on("style.load", addLayers);
    map.on("resize", sizeCanvas);
    map.on("render", () => view.ready && view.draw());
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12 });
    for (const layer of ["nora-nodes", "nora-pipes-hit"]) {
      map.on("mousemove", layer, (e) => {
        map.getCanvas().style.cursor = "pointer";
        const id = e.features[0].properties.asset;
        popup.setLngLat(e.lngLat).setText(App.nameOf(id)).addTo(map);
      });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
    }
    map.on("click", (e) => {
      if (!view.ready) return;
      const hit = map.queryRenderedFeatures(e.point, { layers: ["nora-nodes", "nora-pipes-hit"] });
      if (hit.length) App.select(hit[0].properties.asset);
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
      map.setFeatureState(featureOf[id], { inactive: s.inactive, dim: s.dim, hide: s.hidden });
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
      ctx.fillStyle = C.active;
      for (const id of App.pipeIds) {
        const v = App.live.values[id];
        if (!v || Math.abs(v) < 0.05) continue;
        const shift = (App.live.clock * 0.08) % 1;
        for (let k = 0; k < 3; k++) {
          const along = (k / 3 + shift) % 1, p = project(id, v >= 0 ? along : 1 - along);
          ctx.globalAlpha = 0.6;
          ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
    for (const marker of App.markers()) {
      if (App.pipeStyle(marker.id).hidden) continue;
      const p = project(marker.id, marker.along);
      const zoom = map.getZoom();
      App.drawMarker(ctx, marker, p.x, p.y, p.angle, 6.5, zoom >= 6.5 ? 2 : zoom >= 5 ? 1 : 0);
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
