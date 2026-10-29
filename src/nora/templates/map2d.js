/* The Map view without WebGL: the same map drawn on a plain 2D canvas. map.js switches
   to it when the browser has no WebGL (hardware acceleration off, a locked-down or old
   browser, the GPU process restarting), when WebGL is lost and does not come back, or
   when MapLibre cannot load (offline). The land is Natural Earth, shipped inside the page
   (NORA.land), so this map also works offline. It implements the same view contract and
   takes every colour, width and label from App.pipeStyle / App.nodeStyle / App.markers,
   like map.js: only the drawing differs. */
function NoraCanvasMap(view) {
  "use strict";
  const C = App.colors;
  let el = null, canvas = null, ctx = null, width = 0, height = 0, ratio = 1;
  let highlighted = null, pendingFit = false, land = null, animation = null, drawnMarks = [];
  const cam = { x: 0.5, y: 0.5, k: 512 }; // centre in Web Mercator units (0..1), pixels per unit
  const MIN_ZOOM = 2, MAX_ZOOM = 12;

  // Web Mercator on the unit square; zoom as MapLibre counts it (512 px world at zoom 0).
  const merc = (lon, lat) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  };
  const unmerc = (x, y) => [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
  const zoom = () => Math.log2(cam.k / 512);
  const toScreen = (lon, lat) => {
    const [x, y] = merc(lon, lat);
    return { x: (x - cam.x) * cam.k + width / 2, y: (y - cam.y) * cam.k + height / 2 };
  };
  const toMerc = (sx, sy) => [cam.x + (sx - width / 2) / cam.k, cam.y + (sy - height / 2) / cam.k];

  const nodes = NORA.geo.nodes.features.map((f) => ({ id: f.properties.asset, lonlat: f.geometry.coordinates }));
  const pipes = NORA.geo.pipes.features.map((f) => ({ id: f.properties.asset, line: f.geometry.coordinates, onshore: f.properties.onshore }));
  const pipeById = Object.fromEntries(pipes.map((p) => [p.id, p]));
  // Detailed fields (data/nodes.csv map_min_zoom) and their lines appear only when zoomed in.
  const nodeAtZoom = (id) => zoom() >= ((NORA.assets[id] && NORA.assets[id].min_zoom) || 0);
  const pipeAtZoom = (id) => {
    const d = NORA.assets[id];
    return d && nodeAtZoom(d.from) && nodeAtZoom(d.to);
  };

  // The land as one Path2D in Mercator units, built once and drawn under a transform.
  function landPath() {
    const path = new Path2D();
    for (const ring of (NORA.land && NORA.land.rings) || []) {
      ring.forEach(([lon, lat], i) => {
        const [x, y] = merc(lon, lat);
        if (i) path.lineTo(x, y); else path.moveTo(x, y);
      });
      path.closePath();
    }
    return path;
  }
  // A point `along` (0..1 from the line's first point) a pipeline, in screen pixels.
  function along(id, t) {
    const pts = pipeById[id].line.map(([lon, lat]) => toScreen(lon, lat));
    const lengths = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const total = lengths.reduce((a, b) => a + b, 0) || 1;
    const [start, end] = App.visibleRange(total, nodeRadius() + 8 * App.uiScale());
    let d = (start + (end - start) * Math.max(0, Math.min(1, t))) * total;
    for (let i = 0; i < lengths.length; i++) {
      if (d <= lengths[i] || i === lengths.length - 1) {
        const f = lengths[i] ? Math.min(1, d / lengths[i]) : 0, a = pts[i], b = pts[i + 1];
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, angle: Math.atan2(b.y - a.y, b.x - a.x) };
      }
      d -= lengths[i];
    }
    return { ...pts[0], angle: 0 };
  }
  function bandPath(id, extent) {
    const pts = pipeById[id].line.map(([lon, lat]) => toScreen(lon, lat));
    const lengths = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const total = lengths.reduce((a, b) => a + b, 0) || 1;
    const visible = App.visibleRange(total, nodeRadius() + 8 * App.uiScale());
    let distance = 0;
    const vertices = [0];
    for (const length of lengths) {
      distance += length;
      vertices.push(distance / total);
    }
    return App.bandStops(extent, vertices, visible).map((t) => along(id, t));
  }
  /* Line widths follow map.js: hairlines when zoomed out, a little more weight closer in.
     Every size in screen pixels follows the one UI scale (App.uiScale, issue #59). */
  // Thin at overview zoom; a model mode's line (Load, Risk) keeps its weight (review #49802).
  function lineWidth(w, model = false) {
    const z = zoom(), k = z <= 3 ? 0.45 : z <= 6 ? 0.45 + ((z - 3) / 3) * 0.25 : Math.min(1.1, 0.7 + ((z - 6) / 3) * 0.4);
    return Math.max(0.6, w * (model ? Math.max(1, k) : k)) * App.uiScale();
  }
  const nodeRadius = () => Math.max(3.5, Math.min(9, 2 + zoom() * 0.9)) * App.uiScale();

  function size() {
    ratio = window.devicePixelRatio || 1;
    width = el.clientWidth;
    height = el.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  function redraw() { App.frame.run(redrawNow); }
  function redrawNow() {
    if (!ctx || !width) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = C.water;
    ctx.fillRect(0, 0, width, height);
    // Land: paper, as on the WebGL map.
    ctx.setTransform(ratio * cam.k, 0, 0, ratio * cam.k, ratio * (width / 2 - cam.x * cam.k), ratio * (height / 2 - cam.y * cam.k));
    land = land || landPath();
    ctx.fillStyle = C.paper;
    ctx.fill(land);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const live = App.state.mode === "live", u = App.uiScale();
    // Pipelines: casing under any line in alarm, so colour never stands alone.
    ctx.lineCap = "round";
    for (const p of pipes) {
      const s = App.pipeStyle(p.id);
      if (s.hidden || !pipeAtZoom(p.id)) continue;
      const pts = p.line.map(([lon, lat]) => toScreen(lon, lat));
      const trace = () => { ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); };
      ctx.globalAlpha = s.dim ? 0.3 : 1;
      const w = lineWidth(s.width, s.model) * (p.onshore ? 0.8 : 1);
      if (s.level) { trace(); ctx.setLineDash([]); ctx.strokeStyle = C.casing; ctx.lineWidth = w + 1.6 * u; ctx.stroke(); }
      trace();
      ctx.setLineDash(p.onshore || s.dashed ? [2 * w + 1, 2 * w + 1] : []);
      ctx.strokeStyle = s.color;
      ctx.lineWidth = w;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    // Nodes: calm circles by state; names placed so no two overlap.
    const r = nodeRadius(), names = App.settings().names, boxes = [], dots = [];
    for (const n of nodes) {
      const s = App.nodeStyle(n.id);
      if (s.hidden || !nodeAtZoom(n.id)) continue;
      const q = toScreen(n.lonlat[0], n.lonlat[1]);
      if (q.x < -40 || q.y < -40 || q.x > width + 40 || q.y > height + 40) continue;
      const look = C.card[s.inactive ? "inactive" : live ? "active" : "normal"];
      ctx.globalAlpha = s.dim ? 0.3 : s.inactive ? 0.7 : 1;
      ctx.beginPath();
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fillStyle = look.fill;
      ctx.fill();
      ctx.lineWidth = (s.level ? 2.5 : 1) * u;
      ctx.strokeStyle = s.level ? App.levelColor[s.level] : C.text_dim;
      ctx.stroke();
      if (n.id === highlighted) {
        ctx.beginPath(); ctx.arc(q.x, q.y, r + 5 * u, 0, Math.PI * 2);
        ctx.lineWidth = 2 * u; ctx.strokeStyle = C.text; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      dots.push([q.x - r - u, q.y - r - u, q.x + r + u, q.y + r + u]);
      if (names && !s.dim) boxes.push({ id: n.id, x: q.x, y: q.y + r + 3 * u, level: s.level });
    }
    // Labels: alarms first, then the rest; a name that would cover another is skipped.
    ctx.font = `${11.5 * u}px Archivo, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    const placed = [];
    for (const b of boxes.sort((a, c) => c.level - a.level)) {
      const text = App.nameOf(b.id), w = ctx.measureText(text).width + 4 * u, box = [b.x - w / 2, b.y, b.x + w / 2, b.y + 13 * u];
      if (placed.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      placed.push(box);
      ctx.lineWidth = 4 * u; ctx.strokeStyle = C.paper; ctx.strokeText(text, b.x, b.y); // no line shows through a name
      ctx.fillStyle = C.text; ctx.fillText(text, b.x, b.y);
    }
    // Major pipeline names use the same collision map as node names. Reserve their boxes
    // now, but paint them after the moving bands so a peak never crosses out the text.
    const pipeLabels = [];
    if (names) {
      ctx.textBaseline = "middle";
      for (const p of pipes) {
        const s = App.pipeStyle(p.id), text = App.pipeMapName(p.id);
        if (!text || s.hidden || s.dim || !pipeAtZoom(p.id)) continue;
        const m = along(p.id, 0.5), y = m.y - 9 * u;
        const sub = zoom() >= App.detailZoom ? App.pipeDetail(p.id) : ""; // diameter and length, zoomed in
        const w = Math.max(ctx.measureText(text).width, sub ? ctx.measureText(sub).width : 0) + 4 * u;
        const box = [m.x - w / 2, y - (sub ? 21 : 8) * u, m.x + w / 2, y + 8 * u];
        if (placed.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
        placed.push(box);
        pipeLabels.push({ text, sub, x: m.x, y });
      }
      ctx.textBaseline = "top";
    }
    // Load and Risk: each line's number under its middle, clear of the names (as map.js).
    const modelLabels = [];
    ctx.font = `italic ${11 * u}px Archivo, system-ui, sans-serif`;
    for (const p of pipes) {
      const s = App.pipeStyle(p.id);
      if (!s.model || !s.label || s.hidden || !pipeAtZoom(p.id)) continue;
      const m = along(p.id, 0.5), y = m.y + 9 * u, w = ctx.measureText(s.label).width + 4 * u;
      const box = [m.x - w / 2, y - 7 * u, m.x + w / 2, y + 7 * u];
      if (placed.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      placed.push(box);
      modelLabels.push({ text: s.label, x: m.x, y });
    }
    ctx.font = `${11.5 * u}px Archivo, system-ui, sans-serif`;
    // No alarm badges on lines (Ray, 29 Oct: "remove the small red squares they serve no purpose").
    // Pigs, peaks and gas quality: bands, then markers, then pipeline names on top, so a
    // crossing peak can never erase a name.
    const z = zoom(), detail = z >= 6.5 ? 2 : z >= 5 ? 1 : 0, marks = live ? App.markers() : [];
    for (const m of marks) {
      if (m.extent && pipeById[m.id] && !App.pipeStyle(m.id).hidden && pipeAtZoom(m.id)) App.drawBand(ctx, m, along(m.id, m.extent[0]), along(m.id, m.extent[1]), 3.2 * u, bandPath(m.id, m.extent));
    }
    drawnMarks = [];
    const taken = [...placed, ...dots]; // marker labels keep clear of names and dots
    for (const id of live ? App.pipeIds : []) {
      if (NORA.assets[id].type === "interconnector" && pipeById[id] && !App.pipeStyle(id).hidden && pipeAtZoom(id)) App.drawFlowDirection(ctx, id, (t) => along(id, t), u, taken);
    }
    for (const m of marks) {
      if (!pipeById[m.id] || App.pipeStyle(m.id).hidden || !pipeAtZoom(m.id)) continue;
      const p = along(m.id, m.along);
      App.drawMarker(ctx, m, p.x, p.y, p.angle, App.markerSize(m.kind, (z - 6) / 4), detail, taken);
      if (!m.noDot) drawnMarks.push({ x: p.x, y: p.y, m });
    }
    ctx.textBaseline = "middle";
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
    ctx.font = `italic ${11 * u}px Archivo, system-ui, sans-serif`;
    for (const label of modelLabels) {
      ctx.lineWidth = 3.5 * u; ctx.strokeStyle = C.paper; ctx.strokeText(label.text, label.x, label.y);
      ctx.fillStyle = C.text; ctx.fillText(label.text, label.x, label.y);
    }
    ctx.font = `${11.5 * u}px Archivo, system-ui, sans-serif`;
    ctx.textBaseline = "top";
  }

  // ------------------------------------------------------------------ camera
  function fitBounds([[w, s], [e, n]], padding = 30, maxZoom = MAX_ZOOM) {
    const [x0, y1] = merc(w, s), [x1, y0] = merc(e, n);
    const k = Math.min((width - 2 * padding) / Math.max(1e-9, x1 - x0), (height - 2 * padding) / Math.max(1e-9, y1 - y0));
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, k: Math.max(512 * 2 ** MIN_ZOOM, Math.min(512 * 2 ** maxZoom, k)) };
  }
  function moveTo(target, animate) {
    if (animation) cancelAnimationFrame(animation);
    if (!animate || App.reduceMotion) { Object.assign(cam, target); redraw(); return; }
    const from = { ...cam }, start = performance.now(), ms = 450;
    const step = (now) => {
      const t = Math.min(1, (now - start) / ms), e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      cam.x = from.x + (target.x - from.x) * e;
      cam.y = from.y + (target.y - from.y) * e;
      cam.k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e);
      redraw();
      animation = t < 1 ? requestAnimationFrame(step) : null;
    };
    animation = requestAnimationFrame(step);
  }
  /* Keep the camera on the network: zooming out stops a little past the whole of it,
     and panning keeps the centre within the network's area plus a margin. */
  const minK = () => fitBounds(NORA.config.map.bounds).k * 0.75;
  function clampCam() {
    cam.k = Math.max(minK(), Math.min(512 * 2 ** MAX_ZOOM, cam.k));
    const [[w, s], [e, n]] = NORA.config.map.bounds, [x0, y1] = merc(w, s), [x1, y0] = merc(e, n);
    const mx = (x1 - x0) * 0.6, my = (y1 - y0) * 0.6;
    cam.x = Math.max(x0 - mx, Math.min(x1 + mx, cam.x));
    cam.y = Math.max(y0 - my, Math.min(y1 + my, cam.y));
  }
  function zoomAt(sx, sy, factor) {
    const k = Math.max(minK(), Math.min(512 * 2 ** MAX_ZOOM, cam.k * factor));
    if (k === cam.k) return; // at a zoom limit, do not recenter or slide the camera
    const [mx, my] = toMerc(sx, sy);
    cam.k = k;
    cam.x = mx - (sx - width / 2) / k;
    cam.y = my - (sy - height / 2) / k;
    clampCam();
    redraw();
  }

  // ------------------------------------------------------------------ hit testing
  function hit(sx, sy) {
    const r = nodeRadius() + 5 * App.uiScale();
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      if (App.nodeStyle(n.id).hidden || !nodeAtZoom(n.id)) continue;
      const q = toScreen(n.lonlat[0], n.lonlat[1]), d = Math.hypot(q.x - sx, q.y - sy);
      if (d <= r && d < bestD) { best = n.id; bestD = d; }
    }
    if (best) return best;
    for (const p of pipes) {
      if (App.pipeStyle(p.id).hidden || !pipeAtZoom(p.id)) continue;
      const pts = p.line.map(([lon, lat]) => toScreen(lon, lat));
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((sx - a.x) * dx + (sy - a.y) * dy) / len2));
        const d = Math.hypot(a.x + t * dx - sx, a.y + t * dy - sy);
        if (d <= 6 && d < bestD) { best = p.id; bestD = d; }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ view contract
  view.mount = (container) => {
    el = container;
    // Clear what a map drew here before, but keep the page's map card: the app writes
    // the unit and mode into it on every navigation (clearing it broke navigation).
    for (const child of [...el.children]) if (!child.classList.contains("map-context")) child.remove();
    canvas = document.createElement("canvas");
    canvas.className = "map2d";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Map of the network");
    el.append(canvas);
    ctx = canvas.getContext("2d");
    const note = Object.assign(document.createElement("div"), {
      className: "map-note quiet",
      textContent: "Simple map: this browser cannot draw the full map (no WebGL).",
      title: "Turn on hardware acceleration, or use an up-to-date browser, for the full map. Everything else works the same.",
    });
    const readout = Object.assign(document.createElement("div"), { className: "coord-readout", textContent: "" });
    const zoomButtons = document.createElement("div");
    zoomButtons.className = "map2d-zoom";
    for (const [label, factor] of [["+", 2], ["−", 0.5]]) {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: label, title: factor > 1 ? "Zoom in" : "Zoom out" });
      b.addEventListener("click", () => zoomAt(width / 2, height / 2, factor));
      zoomButtons.append(b);
    }
    el.append(note, readout, zoomButtons);
    size();

    // Pan with a drag, zoom with the wheel or a pinch, click to open, right-click for the menu.
    const pointers = new Map();
    let dragged = false, pinch = 0;
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      dragged = false;
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    canvas.addEventListener("pointermove", (e) => {
      const [lon, lat] = unmerc(...toMerc(e.offsetX, e.offsetY));
      readout.textContent = App.positionText(lon, lat); // water depth instead of the zoom (Ray)
      const previous = pointers.get(e.pointerId);
      if (!previous) {
        const mark = drawnMarks.find((d) => Math.hypot(d.x - e.offsetX, d.y - e.offsetY) < 9 * App.uiScale());
        if (mark) { canvas.style.cursor = "help"; canvas.title = App.markerTip(mark.m); return; }
        const id = hit(e.offsetX, e.offsetY);
        canvas.style.cursor = id ? "pointer" : "grab";
        canvas.title = id ? App.nameOf(id) : "";
        return;
      }
      if (pointers.size === 2) {
        pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch);
        pinch = d;
        dragged = true;
        return;
      }
      const dx = e.offsetX - previous.x, dy = e.offsetY - previous.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
      cam.x -= dx / cam.k;
      cam.y -= dy / cam.k;
      clampCam();
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      canvas.style.cursor = "grabbing";
      redraw();
    });
    const release = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; canvas.style.cursor = "grab"; };
    canvas.addEventListener("pointerup", (e) => {
      const wasDrag = dragged;
      release(e);
      if (wasDrag || e.button !== 0) return;
      const mark = drawnMarks.find((d) => Math.hypot(d.x - e.offsetX, d.y - e.offsetY) < 9 * App.uiScale());
      if (mark) App.selectMarker(mark.m.key); // a pig or a peak under the pointer wins
      else App.select(hit(e.offsetX, e.offsetY));
    });
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("pointerleave", () => { readout.textContent = ""; });
    canvas.addEventListener("wheel", (e) => {
      if (App.embed && !e.ctrlKey) return; // embedded: let the page scroll
      e.preventDefault();
      zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    canvas.addEventListener("dblclick", (e) => zoomAt(e.offsetX, e.offsetY, 2));
    canvas.addEventListener("contextmenu", (e) => {
      const id = hit(e.offsetX, e.offsetY);
      if (!id) return;
      e.preventDefault();
      const d = NORA.assets[id];
      App.menu.open(e.clientX, e.clientY, App.menu.for(id, d.lat != null ? {
        center: () => view.focus(id, true),
        coords: `${d.lat.toFixed(4)}, ${d.lon.toFixed(4)}`,
      } : {}));
    });
    view.ready = true;
    view.setUnit(App.route.unit);
    view.highlight(App.route.focus);
  };

  view.restyle = () => redraw();
  /* App's frame loop asks every frame. Only moving markers need that (live and playing);
     every other change (a restyle, the camera, settings, a resize) redraws on its own,
     so a paused map is not drawn 60 times a second. */
  view.draw = () => { if (App.state.mode === "live" && App.live.playing) redraw(); };
  view.applySettings = () => redraw();
  view.setUnit = (unit) => {
    if (!view.ready) return;
    if (!el.clientWidth) { pendingFit = true; return; }
    pendingFit = false;
    const members = unit === "all" ? null : App.units[unit].nodes;
    const points = members ? members.map((id) => [NORA.assets[id].lon, NORA.assets[id].lat]) : null;
    if (!points || !points.length) { moveTo(fitBounds(NORA.config.map.bounds), false); return; }
    const lons = points.map((p) => p[0]), lats = points.map((p) => p[1]);
    moveTo(fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], 70, 7.5), true);
  };
  view.highlight = (id) => { highlighted = id; redraw(); };
  view.focus = (id, animate) => {
    if (!view.ready) return;
    const d = NORA.assets[id];
    if (d.kind === "node") {
      const [x, y] = merc(d.lon, d.lat);
      moveTo({ x, y, k: Math.max(cam.k, 512 * 2 ** 6.5) }, animate);
    } else if (pipeById[id]) {
      const line = pipeById[id].line, lons = line.map((p) => p[0]), lats = line.map((p) => p[1]);
      moveTo(fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], 120, 7), animate);
    }
  };
  view.fit = () => view.setUnit(App.route.unit);
  view.resize = () => {
    if (!el) return;
    size();
    if (pendingFit) view.setUnit(App.route.unit);
    redraw();
  };
  view.theme = () => redraw(); // App.colors is updated in place
  view.map = null; // no MapLibre map behind this view
  view.canvasMap = true;
  view.zoomAt = zoomAt; // for tests: zoom-limit gestures must not move the camera
  view.camera = () => ({ ...cam });
  return view;
}
