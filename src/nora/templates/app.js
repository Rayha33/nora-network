/* NORA operations view: the shell both network views share.

   Screens follow the control-room hierarchy:
     1 Overview      is the plan holding, which values drift, active alarms
     2 Unit control  one operating unit on the Map (map.js) or the Flow view (flow.js)
     3 Asset detail  one asset as a small schematic, its values with context
     4 Diagnostics   the readings behind the values, and where they come from

   Colour is reserved for abnormal conditions and alarms (nora.toml [colors]): amber
   warning, orange medium, red critical, always with a shape, a number and text. Normal
   is grey: dark grey closed or inactive, light grey normal, lightest grey active.

   A view registers with App.register(name, view) and implements mount(el), restyle(),
   draw(), focus(id, animate), highlight(id), setUnit(id), fit() and resize().
   In the browser console, App.views.map.map and App.views.flow.network are the live
   objects. URL: #/overview, #/unit/<id>, #/asset/<id>, #/diag/<id>; ?view=map|flow,
   ?mode=live|load|risk|plain, ?stream=<name>, ?autoplay=1, ?live=<event-stream url>. */
const App = (() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const embed = params.get("embed") === "1";
  const C = NORA.config;
  const T = C.thresholds;
  // Two palettes with the same roles (nora.toml [colors] and [colors_dark]). COLORS is
  // updated in place when the theme switches, so everything reading it follows.
  const PALETTES = { light: C.colors, dark: C.colors_dark };
  const COLORS = { ...C.colors };
  function storedTheme() {
    try { return localStorage.getItem("nora-theme"); } catch (error) { return null; }
  }
  let theme = params.get("theme") || storedTheme()
    || (C.screen.theme === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : C.screen.theme);
  if (!PALETTES[theme]) theme = "light";

  // ------------------------------------------------------------------ helpers
  /* Number formats are cached: toLocaleString with options builds a new Intl.NumberFormat
     on every call, and the views format thousands of numbers a frame (the Flow view ran
     at 3 fps on that alone). */
  const NUMBER_FORMATS = {};
  function fmt(value, digits = 0) {
    if (value == null || Number.isNaN(value)) return "–";
    const format = NUMBER_FORMATS[digits]
      || (NUMBER_FORMATS[digits] = new Intl.NumberFormat("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits }));
    return format.format(Number(value));
  }
  function signed(value, digits = 1) {
    if (value == null || Number.isNaN(value)) return "–";
    return `${value > 0 ? "+" : value < 0 ? "−" : "±"}${fmt(Math.abs(value), digits)}`;
  }
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }
  function svg(viewBox, markup, cls) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", viewBox);
    node.setAttribute("aria-hidden", "true");
    if (cls) node.setAttribute("class", cls);
    node.innerHTML = markup; // built from numbers, palette colours and esc()'d names only
    return node;
  }
  // ------------------------------------------------------------------ network edits
  /* Ray, 29 Oct: "there should be a editing version of the flow map where i can add
     nodes, remove nodes, connect edges and remove edges"; "i should be able to right
     click to remove a node, i should also be able to add a new node and attach it where
     i want". Each edit is one step in a list kept in this browser. The page applies the
     list to NORA, and to the Flow view's vis data, before anything reads them, so every
     view, the what-if and the search agree. Undo drops the last step; Save writes the
     result to data/ (see saveEdits). */
  const EDITS_KEY = "nora-edits";
  function storedEdits() {
    try {
      const list = JSON.parse(localStorage.getItem(EDITS_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (error) { return []; }
  }
  function storeEdits(list) {
    try {
      if (list.length) localStorage.setItem(EDITS_KEY, JSON.stringify(list));
      else localStorage.removeItem(EDITS_KEY);
      return true;
    } catch (error) { return false; }
  }
  const visData = () => (typeof nodes !== "undefined" && typeof edges !== "undefined" ? { nodes, edges } : null);
  const kmBetween = (a, b) => { // great circle, as graph.great_circle_km
    const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return Math.round(2 * 6371 * Math.asin(Math.sqrt(s)) * 10) / 10;
  };
  function dropLine(pid) {
    delete NORA.assets[pid];
    NORA.geo.pipes.features = NORA.geo.pipes.features.filter((f) => f.properties.asset !== pid);
    for (const unit of NORA.units) unit.pipelines = (unit.pipelines || []).filter((p) => p !== pid);
    const vis = visData(); if (vis && vis.edges.get(pid)) vis.edges.remove(pid);
  }
  function dropNode(id) {
    for (const [pid, p] of Object.entries(NORA.assets)) if (p.kind === "pipeline" && (p.from === id || p.to === id)) dropLine(pid);
    delete NORA.assets[id];
    delete NORA.grid[id];
    NORA.geo.nodes.features = NORA.geo.nodes.features.filter((f) => f.properties.asset !== id);
    for (const unit of NORA.units) unit.nodes = unit.nodes.filter((n) => n !== id);
    const vis = visData(); if (vis && vis.nodes.get(id)) vis.nodes.remove(id);
  }
  const nextFeatureId = (collection) => Math.max(-1, ...collection.features.map((f) => f.id)) + 1;
  function putNode(n) {
    NORA.assets[n.id] = {
      kind: "node", name: n.name, type: n.type, country: n.country, lat: n.lat, lon: n.lon,
      operator: "", capacity: n.capacity ?? null, status: "operating", startup: null, shutdown: null,
      source: "", notes: "Added in the editor", line: 0, lost: 0, share: 0, modelFlow: null,
      supply: NORA.supplyTypes.includes(n.type), exit: n.type === "terminal" || n.type === "market", edited: true,
    };
    NORA.grid[n.id] = n.grid;
    const unit = NORA.units.find((u) => u.id === n.unit) || NORA.units[0];
    unit.nodes.push(n.id);
    NORA.geo.nodes.features.push({ type: "Feature", id: nextFeatureId(NORA.geo.nodes), properties: { asset: n.id, name: n.name, type: n.type }, geometry: { type: "Point", coordinates: [n.lon, n.lat] } });
    // pyvis's default shape needs an icon image; the Flow view draws every node as its square anyway
    const vis = visData(); if (vis) vis.nodes.add({ id: n.id, label: "", shape: "dot" });
  }
  function putLine(l) {
    const a = NORA.assets[l.from], b = NORA.assets[l.to];
    NORA.assets[l.id] = {
      kind: "pipeline", name: l.name, type: l.type, from: l.from, to: l.to, capacity: l.capacity ?? null,
      length: null, diameter: null, commissioned: null, bidirectional: Boolean(l.bidirectional), status: "operating",
      operator: "", source: "", notes: "Added in the editor", line: 0, lost: 0, share: 0, modelFlow: null,
      utilization: null, km: kmBetween(a, b), edited: true,
    };
    const unit = NORA.units.find((u) => u.nodes.includes(l.from));
    if (unit) (unit.pipelines = unit.pipelines || []).push(l.id);
    NORA.geo.pipes.features.push({ type: "Feature", id: nextFeatureId(NORA.geo.pipes), properties: { asset: l.id, onshore: l.type === "onshore" }, geometry: { type: "LineString", coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } });
    const vis = visData(); if (vis) vis.edges.add({ id: l.id, from: l.from, to: l.to, arrows: l.bidirectional ? "to, from" : "to" });
  }
  // One step onto NORA; false when it no longer applies (the data changed under it).
  function applyEdit(step) {
    const A = NORA.assets, has = (id, kind) => A[id] && A[id].kind === kind;
    if (step.op === "removeNode" && has(step.id, "node")) { dropNode(step.id); return true; }
    if (step.op === "removeLine" && has(step.id, "pipeline")) { dropLine(step.id); return true; }
    if (step.op === "addNode" && step.node && !A[step.node.id]) { putNode(step.node); return true; }
    if (step.op === "addLine" && step.line && !A[step.line.id] && has(step.line.from, "node") && has(step.line.to, "node")) { putLine(step.line); return true; }
    if (step.op === "moveNode" && has(step.id, "node") && Array.isArray(step.grid)) { NORA.grid[step.id] = step.grid; return true; }
    return false;
  }
  const edits = storedEdits().filter(applyEdit);
  const assets = NORA.assets;
  const nameOf = (id) => (assets[id] || {}).name || id;

  /* Water depth under the map (NORA.depth: EMODnet's seabed model, built by
     scripts/build_bathymetry.py): a zlib-packed grid of whole metres, inflated once in
     the background. depthAt(lon, lat) blends the sea points around a position; it is
     null on land, outside the grid, or before the grid is ready. */
  const depthGrid = { values: null, ready: Promise.resolve() };
  if (NORA.depth && typeof DecompressionStream !== "undefined") {
    const packed = Uint8Array.from(atob(NORA.depth.data), (c) => c.charCodeAt(0));
    depthGrid.ready = new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate")))
      .arrayBuffer()
      .then((buffer) => {
        // each row is stored as differences from the point to its west: add them up
        const steps = new Int16Array(buffer), values = new Uint16Array(steps.length), width = NORA.depth.width;
        for (let i = 0; i < steps.length; i++) values[i] = (i % width ? values[i - 1] : 0) + steps[i];
        depthGrid.values = values;
      })
      .catch(() => { /* no depth: the readout shows the position only */ });
  }
  function depthAt(lon, lat) {
    const g = NORA.depth, v = depthGrid.values;
    if (!g || !v) return null;
    const x = (lon - g.west) / g.step - 0.5, y = (g.north - lat) / g.step - 0.5; // grid points sit at cell centres
    const i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i >= g.width - 1 || j >= g.height - 1) return null;
    if (!v[Math.round(y) * g.width + Math.round(x)]) return null; // the nearest point is land
    let sum = 0, weight = 0;
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const d = v[(j + dj) * g.width + i + di];
      if (!d) continue;
      const w = (di ? x - i : 1 - (x - i)) * (dj ? y - j : 1 - (y - j));
      sum += d * w;
      weight += w;
    }
    return weight ? Math.round(sum / weight) : null;
  }
  /* A position as the control room writes it: always °N and °E (west is a negative
     east), then the water depth there: "61.90055°N  4.25673°E  ·  WD 58 m". */
  function positionText(lon, lat, digits = 5) {
    const depth = depthAt(lon, lat);
    return `${lat.toFixed(digits)}°N  ${lon.toFixed(digits)}°E${depth != null ? `  ·  WD ${fmt(depth)} m` : ""}`;
  }
  // Dates likewise: one cached Intl.DateTimeFormat per set of options.
  const DATE_FORMATS = new Map();
  const timeFormat = (epoch, opts) => {
    const key = JSON.stringify(opts || {});
    if (!DATE_FORMATS.has(key)) DATE_FORMATS.set(key, new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }));
    return DATE_FORMATS.get(key).format(new Date(epoch * 1000));
  };
  /* One frame's cache. While a view draws a frame the state cannot change, yet the Flow
     view asks for the same line style ~1,900 times a frame and the same node readings
     several times each. Between App.frame.begin() and end() (the views wrap each draw),
     styles and readings are computed once per asset; outside a frame nothing is cached,
     so anything that changes state and then reads it straight away sees the new state. */
  const frameCache = { on: false, maps: {} };
  const frameApi = {
    begin() { frameCache.on = true; frameCache.maps = {}; },
    end() { frameCache.on = false; frameCache.maps = {}; },
    run(draw) { if (frameCache.on) return draw(); frameApi.begin(); try { return draw(); } finally { frameApi.end(); } },
  };
  function cached(kind, key, compute) {
    if (!frameCache.on) return compute();
    const map = frameCache.maps[kind] || (frameCache.maps[kind] = new Map());
    if (!map.has(key)) map.set(key, compute());
    return map.get(key);
  }
  const formatTime = (t) => timeFormat(t, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";
  const shortTime = (t) => timeFormat(t, { weekday: "short", hour: "2-digit", minute: "2-digit" });

  /* The label beside a moving marker: its value, then the ETA in a dimmer tone, in
     small regular type with a paper halo (no box, so nothing covers the map). `detail`
     follows the zoom: 0 labels only gas quality and alarms, 1 every marker, 2 adds the
     next stop. `taken` holds the screen boxes already used (node circles and names,
     labels already placed): the label goes in the first corner beside the dot that is
     clear of them, so it never lands on other text (Ray: no text over text). With no
     clear corner it is left out; hovering the marker still shows it. */
  function labelSpot(x, y, d, w, h, taken) {
    const spots = [[x + d, y - d], [x + d, y + d], [x - d - w, y - d], [x - d - w, y + d]];
    for (const [lx, ly] of taken ? spots : spots.slice(0, 1)) {
      const box = [lx - 2, ly - h / 2, lx + w + 2, ly + h / 2];
      if (taken && taken.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) continue;
      if (taken) taken.push(box);
      return [lx, ly];
    }
    return null;
  }
  /* A gas-quality peak reads as three short lines (Ray, 29 Oct): the gas in its own
     calm colour, the concentration with its unit, and when it reaches the next stop:
       H2S
       3.6 ppm
       ETA 14:42
     Other markers keep one line. No alarm tag beside a moving label (Ray: "remove the
     red tag label"): the alarm shows on the asset it reaches. */
  function markerRows(marker, detail) {
    if (marker.kind === "quality") {
      const gas = QUALITY[marker.gas];
      return [[gas.name, COLORS[gas.color]], [`${marker.amount} ${gas.unit}`, COLORS.text], marker.eta ? [`ETA ${marker.eta}`, COLORS.text_dim] : null].filter(Boolean);
    }
    const parts = [marker.value, marker.eta, detail >= 2 ? marker.to : ""].filter(Boolean);
    return [[parts.join("  "), COLORS.text]];
  }
  function markerLabel(ctx, marker, x, y, size, detail, taken) {
    if (!marker.value || (!detail && !marker.level && marker.kind !== "quality")) return;
    const k = display.scale; // labels never under 11 px, larger on a wall
    const font = 11 * k, line = font + 3 * k, rows = markerRows(marker, detail);
    ctx.save();
    ctx.font = `${font}px Archivo, sans-serif`;
    const w = Math.max(...rows.map(([text]) => ctx.measureText(text).width));
    const spot = labelSpot(x, y, size * 0.9, w, line * rows.length, taken);
    if (!spot) { ctx.restore(); return; }
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3 * k;
    ctx.strokeStyle = COLORS.paper;
    rows.forEach(([text, color], i) => {
      const ly = spot[1] + (i - (rows.length - 1) / 2) * line;
      ctx.strokeText(text, spot[0], ly);
      ctx.fillStyle = color;
      ctx.fillText(text, spot[0], ly);
    });
    ctx.restore();
  }
  // A gas quality parcel: a calm-coloured dot; the strongest parcel of a slug is labelled.
  function drawParcel(ctx, marker, x, y, size, detail, taken) {
    if (marker.noDot) return; // the band shows this stretch; the dot is on the strongest part
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size * (marker.lead ? 0.45 : 0.3), 0, Math.PI * 2);
    ctx.fillStyle = COLORS[QUALITY[marker.gas].color];
    ctx.fill();
    ctx.lineWidth = 0.8 * display.scale;
    ctx.strokeStyle = COLORS.casing;
    ctx.stroke();
    ctx.restore();
    if (marker.lead) markerLabel(ctx, marker, x, y, size, detail, taken);
  }

  /* The stretch of gas a peak covers, from tail (a) to head (b), in screen pixels: an
     opaque band in the peak's calm colour over the line, with a dark casing so it
     stands off the paper in both themes, and a crisp edge at the head so the direction
     of travel reads at a glance. The dot and its label are drawn on top of it. */
  function drawBand(ctx, marker, a, b, width = 3.2, path = null) {
    const color = marker.kind === "quality" ? COLORS[QUALITY[marker.gas].color] : COLORS.peak;
    const points = path && path.length > 1 ? path : [a, b];
    const head = points[points.length - 1], before = points[points.length - 2];
    const dx = head.x - before.x, dy = head.y - before.y, len = Math.hypot(dx, dy);
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    // Follow the registered pipeline polyline exactly. Quadratic smoothing used the
    // bends as control handles and pulled the moving band off the physical route.
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    if (len < 1) ctx.lineTo(a.x + 0.5, a.y);
    ctx.strokeStyle = COLORS.casing;
    ctx.lineWidth = width + 1.2;
    ctx.stroke();
    ctx.strokeStyle = color;
    if (marker.kind === "peak" && len >= 1) {
      // Strong head and tail, quieter middle: the moving dot stays distinct.
      const gradient = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      gradient.addColorStop(0, `${color}ff`);
      gradient.addColorStop(0.5, `${color}59`);
      gradient.addColorStop(1, `${color}ff`);
      ctx.strokeStyle = gradient;
    }
    ctx.lineWidth = width;
    ctx.stroke();
    if (len >= 1) { // the head: a short dark bar across the band
      const nx = -dy / len, ny = dx / len, h = width / 2 + 1;
      ctx.beginPath();
      ctx.moveTo(head.x + nx * h, head.y + ny * h);
      ctx.lineTo(head.x - nx * h, head.y - ny * h);
      ctx.strokeStyle = COLORS.casing;
      ctx.lineWidth = 1;
      ctx.lineCap = "butt";
      ctx.stroke();
    }
    ctx.restore();
  }

  /* What a marker is, for a mouse-over: the value and when it reaches its next stop. */
  function markerTip(m) {
    const when = m.eta && m.to ? `: reaches ${m.to} at ${m.eta}` : m.to ? ` at ${m.to}` : "";
    const more = " · click for details";
    if (m.kind === "pig") return `${m.title || "Pig"}${when}${more}`;
    if (m.kind === "peak") return `Flow change ${m.value} MSm³/d on ${nameOf(m.id)}${when}${more}`;
    if (m.noDot) return `${QUALITY[m.gas].name} slug on ${nameOf(m.id)}${more}`;
    return `${m.value} ${QUALITY[m.gas].unit} on ${nameOf(m.id)}${when}${more}`;
  }

  // ------------------------------------------------------------------ alarm levels
  // 0 normal, 1 warning (amber, priority 3), 2 medium (orange, 2), 3 critical (red, 1).
  const LEVEL = ["Normal", "Warning", "Medium", "Critical"];
  const LEVEL_COLOR = [null, null, null, null];
  function mix(a, b, t) {
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [x, y] = [rgb(a), rgb(b)];
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
  }
  /* Surfaces for panels, controls and cards. In light mode the state greys are the
     surfaces. In dark mode they would glare, so surfaces stay dark and the state shows
     as a lighter tint and edge: lighter still means open and active. */
  function applyPalette() {
    Object.assign(COLORS, PALETTES[theme]);
    const c = COLORS;
    const card = (fill, ink, dim, edge) => ({ fill, ink, dim, edge });
    Object.assign(COLORS, theme === "dark" ? {
      surface: c.panel, raised: mix(c.panel, c.active, 0.14), band: mix(c.panel, c.active, 0.22),
      casing: mix(c.paper, "#000000", 0.55),
      rule: "rgba(225, 228, 230, 0.14)",
      card: {
        active: card(mix(c.panel, c.active, 0.2), c.text, c.text_dim, c.active),
        normal: card(c.panel, c.text, c.text_dim, c.normal),
        inactive: card(mix(c.paper, "#000000", 0.3), c.text, c.text, c.inactive),
      },
    } : {
      surface: c.normal, raised: c.active, band: c.active, rule: "rgba(34, 39, 43, 0.16)", casing: c.text,
      card: {
        active: card(c.active, c.text, c.text_dim, c.text_dim),
        normal: card(c.normal, c.text, c.text_dim, c.text_dim),
        inactive: card(c.inactive, c.active, c.normal, c.text),
      },
    });
    LEVEL_COLOR[1] = COLORS.warning;
    LEVEL_COLOR[2] = COLORS.medium;
    LEVEL_COLOR[3] = COLORS.critical;
    for (const [key, value] of Object.entries(COLORS)) {
      if (typeof value === "string") document.documentElement.style.setProperty(`--${key.replace("_", "-")}`, value);
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    NORA.icons = NORA.iconSets[theme];
  }
  applyPalette();
  function level(value, thresholds, rising = true) {
    if (value == null || Number.isNaN(value)) return 0;
    return rising ? thresholds.filter((t) => value >= t).length : thresholds.filter((t) => value <= t).length;
  }
  // Each priority has its own shape and number as well as its colour.
  function shapeMarkup(lvl, x = 8, y = 8, s = 7) {
    const fill = LEVEL_COLOR[lvl], ink = COLORS.text;
    const outline = `fill="${fill}" stroke="${ink}" stroke-width="1.3" stroke-linejoin="round"`;
    const shape = lvl === 3 ? `<rect x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}" rx="1" ${outline}/>`
      : lvl === 2 ? `<path d="M${x} ${y - s - 1}L${x + s + 1} ${y}L${x} ${y + s + 1}L${x - s - 1} ${y}Z" ${outline}/>`
      : `<path d="M${x} ${y - s}L${x + s} ${y + s - 1}L${x - s} ${y + s - 1}Z" ${outline}/>`;
    const number = `<text x="${x}" y="${y + (lvl === 1 ? 4.2 : 3.6)}" text-anchor="middle" font-size="${s * 1.35}" font-weight="600" font-family="Archivo, sans-serif" fill="${ink}">${4 - lvl}</text>`;
    return shape + number;
  }
  function badge(lvl, text) {
    if (!lvl) return h("span", { class: "badge text-only dim" }, text ?? LEVEL[0]);
    return h("span", { class: "badge", title: LEVEL[lvl] }, svg("0 0 16 16", shapeMarkup(lvl)), text ?? LEVEL[lvl]);
  }
  // The same badge on a canvas (the views): shape, colour, dark outline and number.
  function drawBadge(ctx, lvl, x, y, size = 8) {
    if (!lvl) return;
    ctx.save();
    ctx.beginPath();
    if (lvl === 3) ctx.rect(x - size, y - size, 2 * size, 2 * size);
    else if (lvl === 2) { ctx.moveTo(x, y - size - 1); ctx.lineTo(x + size + 1, y); ctx.lineTo(x, y + size + 1); ctx.lineTo(x - size - 1, y); ctx.closePath(); }
    else { ctx.moveTo(x, y - size); ctx.lineTo(x + size, y + size - 1); ctx.lineTo(x - size, y + size - 1); ctx.closePath(); }
    ctx.fillStyle = LEVEL_COLOR[lvl];
    ctx.fill();
    ctx.lineWidth = Math.max(1, size / 6);
    ctx.strokeStyle = COLORS.text;
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 ${size * 1.3}px Archivo, sans-serif`; // nothing heavier than semibold
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(4 - lvl), x, y + (lvl === 1 ? size * 0.28 : size * 0.08));
    ctx.restore();
  }
  /* A pig (a dot-sized solid triangle pointing downstream) or a peak (a calm circle)
     at x, y, turned along the line by `angle`. Each kind has its own shape AND its
     own calm colour, so nothing reads as an alarm badge (triangle/diamond/square in
     amber/orange/red). */
  function markerSize(kind) {
    return kind === "pig" ? 16 : 6.5; // pigs must remain visible in a dense operating view
  }
  function drawMarker(ctx, marker, x, y, angle, size = 7, detail = 1, taken = null) {
    size *= display.scale; // markers are drawn in screen pixels in every view
    if (marker.kind === "quality") { drawParcel(ctx, marker, x, y, size, detail, taken); return; }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    if (marker.kind === "pig") {
      const s = Math.max(2.5, size * 0.5);
      ctx.moveTo(s, 0); ctx.lineTo(-s * 0.8, -s * 0.7); ctx.lineTo(-s * 0.8, s * 0.7); ctx.closePath();
    } else {
      ctx.arc(0, 0, Math.max(2, size * 0.4), 0, Math.PI * 2);
    }
    ctx.fillStyle = marker.kind === "pig" ? COLORS.pig : COLORS.peak;
    ctx.fill();
    ctx.lineWidth = 0.8 * display.scale;
    ctx.strokeStyle = COLORS.casing;
    ctx.stroke();
    ctx.restore();
    if (marker.kind !== "pig") markerLabel(ctx, marker, x, y, size, detail, taken);
  }

  // ------------------------------------------------------------------ settings
  const DEFAULT_SETTINGS = {
    names: C.labels.names,
    lineValues: C.labels.line_values,
    hide: C.assets.hide,
    gridEntries: C.assets.grid_entries,
    direction: C.flow.direction,
    density: C.flow.density,
    animation: C.flow.animation,
    speed: C.screen.speed || 60,  // default playback: data seconds per real second
    display: C.screen.display || "auto", // auto, desk, wall or compact
    scale: "auto", // UI size: auto or a factor such as 1.25
  };
  function readSettings() {
    let saved = {}, shared = {};
    try { saved = JSON.parse(localStorage.getItem("nora-settings") || "{}"); } catch (error) { saved = {}; }
    try { if (params.get("s")) shared = JSON.parse(atob(params.get("s"))); } catch (error) { shared = {}; }
    const merged = { ...DEFAULT_SETTINGS, ...saved, ...shared };
    if (!Array.isArray(merged.hide)) merged.hide = [];
    return merged;
  }
  let settings = readSettings();
  function saveSettings() {
    try { localStorage.setItem("nora-settings", JSON.stringify(settings)); } catch (error) { /* private mode */ }
  }

  // ------------------------------------------------------------------ display
  /* Control-room display profiles (issue #59). The same page runs on a video wall read
     from metres away, at an operator desk and on a tablet. One UI scale drives the
     chrome (CSS zoom on the bars, player, sidebar, sheets and screens), and the views
     read App.uiScale() for whatever they draw in screen pixels. Auto picks the profile
     and the scale from the window; ?display= and ?scale=, or Settings, override them. */
  const PROFILES = ["desk", "wall", "compact"];
  const autoProfile = (width) => (width < 900 ? "compact" : width >= 3000 ? "wall" : "desk");
  // 1 up to 1920 px wide, rising to 1.5 at 3840 and 2.2 at 7680 (a 4×2 wall of 1080p cubes).
  function autoScale(width) {
    if (width <= 1920) return 1;
    if (width <= 3840) return 1 + (0.5 * (width - 1920)) / 1920;
    return Math.min(2.2, 1.5 + (0.7 * (width - 3840)) / 3840);
  }
  const display = { profile: null, scale: 1 };
  function chosenProfileFor(asked) { return PROFILES.includes(asked) ? asked : autoProfile(window.innerWidth); }
  const chosenProfile = () => chosenProfileFor(params.get("display") || settings.display);
  function chosenScale(profile) {
    let asked = Number(params.get("scale") || (settings.scale === "auto" ? NaN : settings.scale));
    if (asked > 4) asked /= 100; // ?scale=150 means 150 %
    return asked >= 0.75 && asked <= 3 ? asked : autoScaleFor(profile);
  }
  // A wall is read from 5-10 m: body text at least about 20 px (13 px × 1.5).
  const autoScaleFor = (profile) => (profile === "wall" ? Math.max(1.5, autoScale(window.innerWidth)) : autoScale(window.innerWidth));
  // Returns true when the profile or scale changed, so the views can re-fit.
  /* The bar is one row while it fits (Ray, 29 Oct: "everything here should be on one
     line"). The UI scale zooms it, so a 1440 px wall screen at 1.5 has 960 px of room:
     the fit is judged on that, which a media query cannot see. */
  function barLayout(scale) {
    const room = window.innerWidth / scale;
    document.documentElement.dataset.bar = room < 1060 ? "two" : room < 1240 ? "tight" : "one";
  }
  function applyDisplay() {
    const profile = chosenProfile(), scale = Math.round(chosenScale(profile) * 100) / 100;
    barLayout(scale);
    if (profile === display.profile && scale === display.scale) return false;
    display.profile = profile;
    display.scale = scale;
    document.documentElement.dataset.display = profile;
    document.documentElement.style.setProperty("--ui-scale", String(scale));
    return true;
  }
  applyDisplay();
  // Control rooms are dim: a wall starts dark unless the link or the operator chose.
  if (display.profile === "wall" && !params.get("theme") && !storedTheme() && theme !== "dark") {
    theme = "dark";
    applyPalette();
  }
  // ------------------------------------------------------------------ indexes
  const nodeIds = Object.keys(assets).filter((id) => assets[id].kind === "node").sort();
  const pipeIds = Object.keys(assets).filter((id) => assets[id].kind === "pipeline").sort();
  const markets = new Set(nodeIds.filter((id) => assets[id].type === "market"));
  const exitPoints = nodeIds.filter((id) => assets[id].type === "terminal");
  const maxCapacity = Math.max(1, ...pipeIds.map((id) => assets[id].capacity || 0));
  const worst = NORA.worstOutage || 1;
  const unitOf = {};
  for (const unit of NORA.units) {
    for (const id of unit.nodes) unitOf[id] = unit.id;
    for (const id of unit.pipelines) unitOf[id] = unit.id;
  }
  const unitById = Object.fromEntries(NORA.units.map((u) => [u.id, u]));
  function visible(id) {
    const d = assets[id];
    if (!yearActive(id)) return false;
    if (d.kind === "node") return !settings.hide.includes(d.type);
    if (d.type === "onshore" && !settings.gridEntries) return false;
    return !settings.hide.includes(assets[d.from].type) && !settings.hide.includes(assets[d.to].type);
  }

  // ------------------------------------------------------------------ state
  const route = { screen: "overview", unit: "all", asset: null, focus: null };
  const state = { view: C.screen.network_view, mode: C.screen.network_mode, year: null };

  // ---------------------------------------------------------------- the year shown
  /* The network as it stands this year: planned assets appear from their startup year,
     decommissioned ones are gone from their shutdown year (a blank year: always there).
     Ray removed the year slider (29 Oct), so this is today's year, in the browser. */
  function yearActive(id) {
    const d = assets[id], year = state.year;
    if (year == null) return true;
    if (d.kind === "pipeline") return yearActive(d.from) && yearActive(d.to);
    return !(d.startup && year < d.startup) && !(d.shutdown && year >= d.shutdown);
  }
  const live = {
    stream: null, // recorded stream being replayed
    feed: null, // EventSource when connected to a live feed
    frames: [], // [{t, flows, metrics, plan}], recorded or received from the feed
    playhead: 0,
    index: -1,
    playing: false,
    speed: 3600,
    clock: 0,
    time: null,
    values: {}, // flows at the playhead, interpolated between frames
    maxAbs: 1,
    typical: {},
    down: {}, // pipelines whose flow has collapsed
    peaks: [], // flow changes travelling down pipelines
    quality: [], // parcels of H₂S or CO₂-rich gas travelling with the flow
    slugs: new Map(), // slug -> {origin, metric, first, last, volume, max}: what each slug is
    conditions: [], // active abnormal conditions, worst first
    levelOf: {}, // asset -> worst active level
  };
  const frame = () => live.frames[Math.max(0, live.index)] || { flows: {}, metrics: {}, plan: null };
  const metric = (name, id, f = frame()) => ((f.metrics || {})[name] || {})[id];

  /* Gas through a node (or the node's own reading), from a frame's flows: what arrives,
     or for fields and storage what they send out (storage may also take gas in). */
  function throughput(id, flows) {
    if (flows[id] !== undefined) return Math.abs(flows[id]);
    let into = 0, out = 0, seen = false;
    for (const pid of pipeIds) {
      const v = flows[pid];
      if (v === undefined) continue;
      const p = assets[pid];
      if (p.type === "onshore" && !markets.has(id)) continue;
      if (p.to === id) { seen = true; if (v > 0) into += v; else out -= v; }
      else if (p.from === id) { seen = true; if (v > 0) out += v; else into -= v; }
    }
    if (!seen) return null;
    return assets[id] && assets[id].supply ? Math.max(out, into) : into;
  }
  function series(fn, n = 12) {
    const out = [];
    for (let i = Math.max(0, live.index - n + 1); i <= live.index; i++) out.push(live.frames[i] ? fn(live.frames[i]) : null);
    return out;
  }
  function stepHours() {
    if (live.stream) return live.stream.step / 3600;
    const n = live.frames.length;
    return n > 1 ? (live.frames[n - 1].t - live.frames[n - 2].t) / 3600 || 1 : 1;
  }
  // Change per hour over the last three readings.
  function rate(values) {
    const known = values.filter((v) => v != null);
    if (known.length < 2) return null;
    const recent = known.slice(-3);
    return (recent[recent.length - 1] - recent[0]) / ((recent.length - 1) * stepHours());
  }

  /* Within-day delivery at an exit point: the gas delivered so far this gas day against
     what was nominated for the same hours, as a share (0 = on plan, -0.05 = 5 % short).
     The gas day starts at thresholds.gas_day_start_utc. */
  const dayDelivery = (id) => cached("day", id, () => dayDeliveryNow(id));
  function dayDeliveryNow(id) {
    const start = T.gas_day_start_utc == null ? 5 : T.gas_day_start_utc, now = frame();
    if (now.t == null || metric("nomination_msm3d", id, now) == null) return null;
    const dayStart = Math.floor((now.t - start * 3600) / 86400) * 86400 + start * 3600;
    let actual = 0, nominated = 0;
    for (let i = live.index; i >= 0 && live.frames[i] && live.frames[i].t >= dayStart; i--) {
      const f = live.frames[i], nom = metric("nomination_msm3d", id, f), got = throughput(id, f.flows);
      if (nom == null || got == null) continue;
      actual += got;
      nominated += nom;
    }
    if (nominated <= 0) return null;
    const share = (actual - nominated) / nominated;
    return { share, level: level(Math.abs(share), T.nomination) };
  }
  // How fast gas through a node is changing, MSm³/d per hour, over the last 2 hours.
  const flowRate = (id) => rate(window4h(id).past);
  /* The 4-hour window shown in each flow-view card: the last 2 hours of actual flow,
     and the next 2 hours of what shippers have nominated (from the recorded data, or
     the `ahead` block of a live-feed frame). */
  function window4h(id) { return cached("w4h", id, () => window4hNow(id)); }
  function window4hNow(id) {
    const n = Math.max(1, Math.round(2 / stepHours()));
    const past = [];
    for (let i = live.index - n; i <= live.index; i++) past.push(live.frames[i] ? throughput(id, live.frames[i].flows) : null);
    let future = null;
    const nomNow = metric("nomination_msm3d", id);
    if (nomNow != null) {
      future = [nomNow];
      for (let k = 1; k <= n; k++) {
        const ahead = live.feed ? (((frame().ahead || {}).nomination_msm3d || {})[id] || [])[k - 1] : metric("nomination_msm3d", id, live.frames[live.index + k] || {});
        future.push(ahead ?? null);
      }
    }
    return { past, future, tol: T.nomination[0] };
  }

  // Six hourly nominations beginning at the displayed hour. Live frames carry their
  // forecast in `ahead`; recorded streams use their following hourly frames.
  function nominationWindow(id) {
    return cached("nom6", id, () => {
      const current = frame(), out = [];
      for (let k = 0; k < 6; k++) {
        const future = live.frames[live.index + k];
        const value = k === 0 ? metric("nomination_msm3d", id, current)
          : live.feed ? (((current.ahead || {}).nomination_msm3d || {})[id] || [])[k - 1]
          : metric("nomination_msm3d", id, future || {});
        out.push({ t: future && future.t != null ? future.t : current.t + k * 3600, value: value ?? null });
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ conditions
  /* Everything abnormal right now, as {level, id, kind, text}. The views, the alarm
     counts, the overview and the asset screens all read this one list. */
  function evaluate() {
    const f = frame(), out = [];
    const add = (lvl, id, kind, text) => { if (lvl > 0) out.push({ level: lvl, id, kind, text }); };
    for (const id of pipeIds) {
      const v = f.flows[id], d = assets[id];
      if (v === undefined) continue;
      if (d.capacity) add(level(Math.abs(v) / d.capacity, T.load), id, "load", `${nameOf(id)} at ${fmt((Math.abs(v) / d.capacity) * 100)}% of capacity`);
      if (live.down[id]) add(2, id, "trip", `${nameOf(id)}: flow collapsed to ${fmt(Math.abs(v), 1)} MSm³/d`);
    }
    for (const id of exitPoints) {
      const nom = metric("nomination_msm3d", id, f), booked = metric("booked_msm3d", id, f);
      const actual = throughput(id, f.flows);
      if (nom > 1 && actual != null) {
        const dev = (actual - nom) / nom;
        add(level(Math.abs(dev), T.nomination), id, "nomination", `${nameOf(id)} ${signed(dev * 100, 0)}% against nomination`);
      }
      if (nom > 0 && booked > 0) add(level(nom / booked, T.booking), id, "booking", `${nameOf(id)} nominated ${fmt((nom / booked) * 100)}% of booked capacity`);
    }
    for (const id of nodeIds) {
      const p = metric("pressure_bar", id, f), window = C.pressure[assets[id].type];
      if (p == null || !window) continue;
      const [low, high] = window, span = high - low;
      const margin = Math.min(p - low, high - p) / span;
      add(level(margin, T.pressure_margin, false), id, "pressure",
        `${nameOf(id)} ${fmt(p, 1)} bar, near the ${p - low < high - p ? "minimum" : "maximum"} (${fmt(low)}–${fmt(high)} bar)`);
    }
    for (const peak of live.peaks) {
      add(peak.level, peak.id, "peak", `${nameOf(peak.id)}: flow ${peak.delta > 0 ? "rose" : "fell"} ${fmt(Math.abs(peak.delta), 1)} MSm³/d in one step`);
    }
    for (const s of slugs()) {
      if (s.exit && s.exitLevel) {
        add(s.exitLevel, s.exit.node, "quality", `${qualityText(s.q.metric, s.exit.conc)} expected at ${nameOf(s.exit.node)} ${etaText(s.exit.t)}; limit ${C.quality[s.q.metric][2]} ${QUALITY[s.q.metric].unit}`);
      } else if (s.level) {
        add(1, s.q.origin, "quality", `${qualityText(s.q.metric, s.q.conc)} from ${nameOf(s.q.origin)}${s.exit ? `, diluted to ${fmt(s.exit.conc, QUALITY[s.q.metric].digits)} by ${nameOf(s.exit.node)}` : ""}`);
      }
    }
    const events = (live.stream && live.stream.events) || live.feedEvents || [];
    for (const event of events) {
      if (live.time >= event.start && live.time < event.end && !event.planned) add(2, event.asset, "event", event.label);
    }
    if (f.plan && f.plan.now[0]) add(f.plan.now[0], f.plan.now[2] || "plan", "plan", `Plan: ${f.plan.now[1]}`);
    if (live.stale) add(2, "feed", "feed", `Live feed stale, values from ${live.time ? formatTime(live.time) : "before"}: ${live.stale.text}`);
    out.sort((a, b) => b.level - a.level || a.text.localeCompare(b.text));
    live.conditions = out;
    live.levelOf = {};
    for (const c of out) live.levelOf[c.id] = Math.max(live.levelOf[c.id] || 0, c.level);
  }
  const levelOf = (id) => live.levelOf[id] || 0;
  const levelFor = (id, kinds) => Math.max(0, ...live.conditions.filter((c) => c.id === id && kinds.includes(c.kind)).map((c) => c.level));

  // A pipeline's flow collapsing to a tenth of its usual level is a trip.
  function trackTrips(f) {
    const floor = Math.max(1, 0.05 * live.maxAbs);
    for (const [id, raw] of Object.entries(f.flows)) {
      // Trips are a transport matter: trunks, export lines and interconnectors. A field
      // feeder going quiet (curtailment, shut-in) and balancing links swinging are not.
      if (!assets[id] || !["trunk", "export", "interconnector"].includes(assets[id].type)) continue;
      const v = Math.abs(raw), typical = live.typical[id] || 0;
      if (typical > floor && v < 0.1 * typical) live.down[id] = true;
      else if (live.down[id] && v > 0.3 * typical) delete live.down[id];
    }
  }
  // A large change in flow travels down the pipeline with the gas: a "peak".
  function spawnPeaks(previous, current) {
    if (!previous) return;
    for (const id of pipeIds) {
      const a = previous.flows[id], b = current.flows[id], d = assets[id];
      if (a === undefined || b === undefined || !d.capacity) continue;
      const share = Math.abs(b - a) / d.capacity;
      if (share >= C.pipelines.step_min) {
        live.peaks.push({ id, t0: current.t, delta: b - a, level: level(share, T.step), forward: b >= 0 });
      }
    }
  }
  function prunePeaks() {
    const places = new Map();
    live.peaks = live.peaks.filter((p) => {
      const place = live.time >= p.t0 ? peakPlace(p) : null;
      if (place) places.set(p, place);
      return place;
    });
    // Keep the play calm: at most `peak_max` peaks on screen at once. When a big
    // event changes many lines in the same hour, only the strongest changes travel.
    const max = C.pipelines.peak_max || live.peaks.length;
    if (live.peaks.length > max) {
      const strength = new Map(live.peaks.map((p) => {
        const place = places.get(p);
        return [p, Math.abs(place.delta) / (assets[place.pid].capacity || 1)];
      }));
      live.peaks.sort((a, b) => strength.get(b) - strength.get(a));
      live.peaks.length = max;
    }
  }
  // A small deterministic PRNG from a string seed: same seed, same route, always.
  function seeded(seed) {
    let h = 2166136261;
    for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return () => {
      h = (h + 0x6D2B79F5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* The frame in force at data time `t`: the last one at or before it (the first one
     before the data starts). Routes are chosen with the flows of the moment a marker
     reaches each node, never the flows on screen, so a choice made in the past stays
     made: no marker re-routes or jumps when the hour changes or the user seeks. */
  function frameAt(t) {
    const frames = live.frames;
    if (!frames.length) return frame();
    let lo = 0, hi = frames.length - 1;
    if (t < frames[0].t) return frames[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return frames[lo];
  }
  // The lines carrying gas away from `node`, each with the flow it carries.
  function linesOut(node, flows) {
    const out = [];
    for (const pid of pipeIds) {
      const v = flows[pid], p = assets[pid];
      if (v === undefined || p.type === "onshore") continue;
      const o = p.from === node ? v : p.to === node ? -v : 0;
      if (o > 0.05) out.push({ pid, forward: p.from === node, w: o });
    }
    return out;
  }
  // Pick the next line out of a node: random, weighted by the flow it carries, and
  // deterministic for the same seed - so a pig or a peak always takes the same way.
  function nextOut(node, flows, seed) {
    const out = linesOut(node, flows);
    if (!out.length) return null;
    if (out.length === 1) return out[0];
    const rand = seeded(seed);
    let pick = rand() * out.reduce((s, o) => s + o.w, 0);
    for (const o of out) { pick -= o.w; if (pick <= 0) return o; }
    return out[out.length - 1];
  }
  const lineMetres = (pid) => Math.max(1, assets[pid].km || 1) * 1000;
  /* A pig's route for one run (a relaunch is a new run): it starts down its line the
     way the gas flows at launch, and each further hop is chosen with the flows of the
     moment it reaches that node. Hops are added as the pig gets there, then kept. */
  const pigRoutes = new Map();
  function pigRoute(pig, run, distance) {
    const key = `${pig.label}|${pig.launch}|${run}`, start = pig.launch + run * (pig.every || 0);
    let route = pigRoutes.get(key);
    if (!route) {
      const v = frameAt(start).flows[pig.pipeline];
      pigRoutes.set(key, route = [{ pid: pig.pipeline, forward: !(v < 0), m: 0 }]);
    }
    let last = route[route.length - 1];
    while (last.m + lineMetres(last.pid) <= distance && route.length < 40) {
      const node = last.forward ? assets[last.pid].to : assets[last.pid].from;
      const at = start + (last.m + lineMetres(last.pid)) / pig.speed;
      const hop = isExit(node) ? null : nextOut(node, frameAt(at).flows, `${key}|${route.length}`);
      if (!hop) break;  // arrived at its receiver (or the network edge): off screen
      route.push(last = { pid: hop.pid, forward: hop.forward, m: last.m + lineMetres(last.pid) });
    }
    return route;
  }
  // Where a pig is now: on one line at a time, handing over at the nodes, never jumping.
  function pigPlace(pig, time) {
    if (time == null || time < pig.launch) return null;
    const since = time - pig.launch, every = pig.every > 0 ? pig.every : 0;
    const run = every ? Math.floor(since / every) : 0, distance = (since - run * every) * pig.speed;
    const route = pigRoute(pig, run, distance);
    const last = route[route.length - 1];
    if (distance >= last.m + lineMetres(last.pid)) return null;  // at the receiver, waiting for relaunch
    const seg = route.find((s) => distance < s.m + lineMetres(s.pid)) || last;
    const along = (distance - seg.m) / lineMetres(seg.pid);
    const runStart = pig.launch + run * every, next = seg.forward ? assets[seg.pid].to : assets[seg.pid].from;
    return { pid: seg.pid, along: seg.forward ? along : 1 - along, exitAt: runStart + (seg.m + lineMetres(seg.pid)) / pig.speed, next };
  }
  /* Where a peak is now: it keeps travelling downstream, attenuated by its share of
     the gas at each node, and disappears at an exit or when it fades below step_min.
     Each hop is worked out once, with the flows when the peak reaches that node, and
     kept on the peak, so the place costs a few steps per frame. */
  function peakPlace(peak, time = live.time) {
    const v = C.pipelines.gas_velocity_mps;
    if (!peak.hops) peak.hops = [{ pid: peak.id, forward: peak.forward, delta: peak.delta, t: peak.t0 }];
    for (let k = 0; time >= peak.hops[k].t; k++) {
      const hop = peak.hops[k], exitAt = hop.t + lineMetres(hop.pid) / v;
      if (time < exitAt) {
        const along = ((time - hop.t) * v) / lineMetres(hop.pid);
        return { pid: hop.pid, forward: hop.forward, delta: hop.delta, along: hop.forward ? along : 1 - along, exitAt };
      }
      if (k + 1 < peak.hops.length) continue;
      if (hop.end || k >= 40) return null;
      const node = hop.forward ? assets[hop.pid].to : assets[hop.pid].from, f = frameAt(exitAt);
      let delta = hop.delta;
      const inflow = throughput(node, f.flows), mine = Math.abs(f.flows[hop.pid] || 0);
      if (inflow > 0 && mine < inflow) delta *= mine / inflow;  // diluted where gas joins
      const next = isExit(node) || Math.abs(delta) < C.pipelines.step_min * (assets[hop.pid].capacity || 1)
        ? null : nextOut(node, f.flows, `${peak.id}|${peak.t0}|${k}`);
      if (!next) { hop.end = true; return null; }  // left the network, or faded out
      peak.hops.push({ pid: next.pid, forward: next.forward, delta, t: exitAt });
    }
    return null;
  }
  /* Markers moving along the lines, with their position (0..1 from the pipeline's
     `from` end): pigs at their own speed, peaks with the gas. Both follow ROUTES:
     chains of pipelines in the downstream direction (the way the gas flows, top to
     bottom in the Flow view), chosen at random weighted by the flow each line carries,
     from a seed, so replay and seek give the same route. Pigs hand over line to line
     at the nodes; peaks continue attenuated by their share of the gas at each node
     and die when that share or the exit ends them. */
  function markers() {
    const out = [];
    if (live.time == null) return out;
    const pigs = (live.stream && live.stream.pigs) || live.feedPigs || [];
    for (const pig of pigs) {
      const place = pigPlace(pig, live.time);
      if (place) out.push({ kind: "pig", id: place.pid, along: place.along, label: "", level: 0, title: pig.label,
        eta: clock(place.exitAt), to: nameOf(place.next), key: `pig:${pig.label}|${pig.launch}`, ref: pig });
    }
    /* Head and tail: a peak is a stretch of gas, not a point. A change in flow spreads
       over the gas that passed in one data step (velocity × step); the band is centred
       on the dot. `extent` is [tail, head] in the line's 0..1, clipped to the line. */
    const v = C.pipelines.gas_velocity_mps, stepSeconds = (live.stream && live.stream.step) || 3600;
    const clip01 = (x) => Math.max(0, Math.min(1, x));
    const extentOf = (pid, lo, hi, forward) => {
      const pad = (v * stepSeconds) / 2 / lineMetres(pid);
      const a = clip01(lo - pad), b = clip01(hi + pad);
      return forward ? [a, b] : [b, a];
    };
    const peakExtentOf = (pid, at, forward) => {
      const pad = (v * stepSeconds) / 2 / lineMetres(pid);
      const half = Math.min(pad, at, 1 - at); // clip both sides equally around the dot
      return forward ? [at - half, at + half] : [at + half, at - half];
    };
    for (const peak of live.peaks) {
      const place = peakPlace(peak);
      if (!place) continue;
      const d = assets[place.pid];
      out.push({ kind: "peak", id: place.pid, along: place.along, level: peak.level, rising: place.delta > 0,
        value: `${place.delta > 0 ? "+" : "−"}${fmt(Math.abs(place.delta), 1)}`, eta: clock(place.exitAt),
        to: nameOf(place.forward ? d.to : d.from), extent: peakExtentOf(place.pid, place.along, place.forward),
        key: `peak:${peak.id}|${peak.t0}`, ref: peak });
    }
    /* A slug of H₂S or CO₂ is drawn as one band per line it covers, from its rear parcel
       to its front parcel; the dot (and the label) sits on its strongest parcel. */
    const leads = new Map(slugs().map((s) => [s.q, s])), spans = new Map();
    for (const q of live.quality) {
      const t = q.arrived ? 1 : Math.min(1, (live.time - q.t0) / travelSeconds(q.pid)), at = q.forward ? t : 1 - t;
      const key = `${q.slug}|${q.pid}`, span = spans.get(key) || { q, lo: at, hi: at, lead: null };
      span.lo = Math.min(span.lo, at); span.hi = Math.max(span.hi, at);
      if (leads.has(q)) span.lead = { q, at, s: leads.get(q) };
      spans.set(key, span);
    }
    for (const { q, lo, hi, lead } of spans.values()) {
      const base = { kind: "quality", gas: q.metric, id: q.pid, extent: extentOf(q.pid, lo, hi, q.forward), key: `quality:${q.slug}`, ref: q.slug };
      if (!lead) { out.push({ ...base, along: (lo + hi) / 2, lead: false, noDot: true, level: 0, value: "" }); continue; }
      const { s } = lead;
      out.push({ ...base, along: lead.at, lead: true, level: Math.max(s.level, s.exitLevel),
        value: `${QUALITY[q.metric].name} ${fmt(lead.q.conc, QUALITY[q.metric].digits)}`, amount: fmt(lead.q.conc, QUALITY[q.metric].digits),
        eta: lead.q.arrived ? "" : clock(s.next.t), to: nameOf(lead.q.arrived ? lead.q.arrived.node : s.next.node) });
    }
    return out.sort((a, b) => Number(Boolean(a.lead)) - Number(Boolean(b.lead)));
  }

  // ------------------------------------------------------------------ gas quality
  /* H₂S and CO₂ peaks travel with the gas. Each hour a field's reading is at or above
     `follow_from` of its warning level, a parcel of that gas is followed: down the line
     taking most of the gas out of each node, diluted where other gas joins it. The
     parcels from one excursion form a slug; its strongest parcel carries the label. */
  const QUALITY = {
    h2s_ppm: { name: "H₂S", unit: "ppm", digits: 1, color: "h2s" },
    co2_molpct: { name: "CO₂", unit: "mol %", digits: 2, color: "co2" },
  };
  const isExit = (id) => ["terminal", "lng", "market"].includes(assets[id].type);
  const travelSeconds = (pid) => (Math.max(1, assets[pid].km || 1) * 1000) / C.pipelines.gas_velocity_mps;
  // The line taking most gas out of a node, in the direction it flows.
  function onward(node, flows) {
    let best = null, most = 0.05;
    for (const pid of pipeIds) {
      const v = flows[pid], p = assets[pid];
      if (v === undefined || p.type === "onshore") continue;
      const out = p.from === node ? v : p.to === node ? -v : 0;
      if (out > most) { most = out; best = { pid, forward: p.from === node }; }
    }
    return best;
  }
  // Concentration after mixing at a node: the other gas is assumed to carry the median
  // field reading. An estimate, and labelled as one.
  function mixAt(node, pid, conc, name, f) {
    const inflow = throughput(node, f.flows), mine = Math.abs(f.flows[pid] || 0);
    if (!inflow || mine >= inflow) return conc;
    const readings = Object.values((f.metrics || {})[name] || {}).filter((v) => v != null).sort((a, b) => a - b);
    const other = readings.length ? readings[Math.floor(readings.length / 2)] : 0;
    return other + (conc - other) * (mine / inflow);
  }
  function spawnQuality(previous, current) {
    if (!current) return;
    for (const name of Object.keys(QUALITY)) {
      const readings = (current.metrics || {})[name];
      if (!readings) continue;
      const follow = C.quality[name][0] * C.quality.follow_from;
      for (const [node, value] of Object.entries(readings)) {
        if (value == null || value < follow || !assets[node]) continue;
        const route = onward(node, current.flows);
        if (!route) continue;
        const was = previous ? ((previous.metrics || {})[name] || {})[node] : null;
        let slug = `${name}:${node}:${current.t}`;
        if (was != null && was >= follow) {
          for (let k = live.quality.length - 1; k >= 0; k--) {
            if (live.quality[k].origin === node && live.quality[k].metric === name) { slug = live.quality[k].slug; break; }
          }
        }
        live.quality.push({ metric: name, origin: node, slug, conc: value, pid: route.pid, forward: route.forward, t0: current.t, born: current.t, arrived: null });
        /* Each parcel is one data step of the field's gas: the slug's volume adds them
           up as they leave the field, so it stays whole after its head has left. */
        const step = previous ? current.t - previous.t : (live.stream && live.stream.step) || 3600;
        const info = live.slugs.get(slug) || { slug, metric: name, origin: node, first: current.t, last: current.t, volume: 0, max: 0 };
        info.last = current.t;
        info.max = Math.max(info.max, value);
        info.volume += ((throughput(node, current.flows) || 0) * step) / 86400; // MSm³/d over the step, in MSm³
        live.slugs.set(slug, info);
      }
    }
  }
  // Move parcels on to the time shown; at each node they mix and take the next line.
  function advanceQuality(time = live.time, f = frame()) {
    if (time == null) return;
    live.quality = live.quality.filter((q) => {
      for (let hops = 0; !q.arrived && hops < 20 && time >= q.t0 + travelSeconds(q.pid); hops++) {
        const p = assets[q.pid], node = q.forward ? p.to : p.from, at = q.t0 + travelSeconds(q.pid);
        q.conc = mixAt(node, q.pid, q.conc, q.metric, f);
        const next = isExit(node) ? null : onward(node, f.flows);
        if (!next || next.pid === q.pid) q.arrived = { node, t: at };
        else Object.assign(q, { pid: next.pid, forward: next.forward, t0: at });
      }
      return !q.arrived || time - q.arrived.t < 3600; // shown for an hour at the exit
    });
  }
  function replayQuality(index) {
    live.quality = [];
    live.slugs = new Map();
    for (let i = Math.max(0, index - 36); i <= index && live.frames[i]; i++) {
      spawnQuality(live.frames[i - 1], live.frames[i]);
      advanceQuality(live.frames[i].t, live.frames[i]);
    }
  }
  // Where a parcel goes next and where it leaves the network, with times and the
  // concentration expected there, following today's flows.
  function project(q, f = frame()) {
    if (q.arrived) { const at = { node: q.arrived.node, t: q.arrived.t, conc: q.conc }; return { next: at, exit: at }; }
    let pid = q.pid, node = q.forward ? assets[pid].to : assets[pid].from;
    let t = q.t0 + travelSeconds(pid), conc = mixAt(node, pid, q.conc, q.metric, f);
    const next = { node, t, conc };
    for (let hops = 0; hops < 20 && !isExit(node); hops++) {
      const r = onward(node, f.flows);
      if (!r || r.pid === pid) break;
      pid = r.pid;
      node = r.forward ? assets[pid].to : assets[pid].from;
      t += travelSeconds(pid);
      conc = mixAt(node, pid, conc, q.metric, f);
    }
    return { next, exit: isExit(node) ? { node, t, conc } : null };
  }
  // One entry per slug: its strongest parcel, where it heads, and how it compares with
  // the limits now and at the exit.
  function slugs() {
    const lead = new Map();
    for (const q of live.quality) if (!lead.has(q.slug) || q.conc > lead.get(q.slug).conc) lead.set(q.slug, q);
    return [...lead.values()].map((q) => {
      const ahead = project(q), limits = C.quality[q.metric];
      return { q, ...ahead, level: level(q.conc, limits), exitLevel: ahead.exit ? level(ahead.exit.conc, limits) : 0 };
    });
  }
  // An arrival time: the clock time, with the day when it is more than 20 hours away.
  const clock = (t) => (t - live.time > 20 * 3600 ? shortTime(t) : timeFormat(t, { hour: "2-digit", minute: "2-digit" }));
  const qualityText = (name, value) => `${QUALITY[name].name} ${fmt(value, QUALITY[name].digits)} ${QUALITY[name].unit}`;
  function etaText(t) {
    const hours = (t - live.time) / 3600;
    if (hours <= 0) return "now";
    return `${hours > 12 ? shortTime(t) : timeFormat(t, { hour: "2-digit", minute: "2-digit" })} (in ${fmt(hours, 1)} h)`;
  }

  // ------------------------------------------------------------------ what-if
  /* What the network can still deliver with some assets offline: the same max
     flow the Python analysis runs (analysis.py, `offline=`), recomputed here
     from the payload because the published site has no server to ask. The
     network is small, so Edmonds-Karp over arcs added in sorted id order is
     fast and always gives the same answer. */
  const WHATIF_SOURCE = "__supply__", WHATIF_SINK = "__markets__", EPS = 1e-9;
  const whatif = { offline: new Set(), cache: null };
  function whatifFlow() {
    const arcs = [], adj = {}, sinkArc = {};
    const add = (u, v, cap, pipeline = null, sign = 0) => {
      const i = arcs.length;
      arcs.push({ u, v, cap, f: 0, pipeline, sign, rev: i + 1 });
      arcs.push({ u: v, v: u, cap: 0, f: 0, pipeline: null, sign: 0, rev: i });
      (adj[u] = adj[u] || []).push(i);
      (adj[v] = adj[v] || []).push(i + 1);
      return i;
    };
    for (const id of nodeIds) {
      // offline nodes, and nodes not built (or shut down) in the year shown: no capacity
      if (whatif.offline.has(id) || !yearActive(id)) continue;
      const d = assets[id];
      adj[id] = adj[id] || [];
      if (d.supply && d.capacity) add(WHATIF_SOURCE, id, d.capacity);
      if (d.exit) sinkArc[id] = add(id, WHATIF_SINK, Infinity); // as analysis.flow_graph
    }
    /* A processing plant with a capacity is a bottleneck (the Python side splits
       it the same way, see analysis.flow_graph): incoming arcs land on an entry
       twin, one capacity arc joins the twin to the plant, outgoing arcs leave
       the plant itself. */
    const plantEntry = {};
    for (const id of nodeIds) {
      const d = assets[id];
      if (!whatif.offline.has(id) && d.type === "processing" && d.capacity)
        plantEntry[id] = add(`${id}__in`, id, d.capacity);
    }
    for (const id of pipeIds) {
      const p = assets[id];
      if (!adj[p.from] || !adj[p.to]) continue; // touches an offline asset
      const cap = p.capacity == null ? Infinity : p.capacity;
      const to = plantEntry[p.to] !== undefined ? `${p.to}__in` : p.to;
      add(p.from, to, cap, id, 1);
      if (p.bidirectional) add(to, p.from, cap, id, -1);
    }
    let value = 0;
    for (;;) { // shortest augmenting paths, in sorted order, so the split is stable
      const prev = { [WHATIF_SOURCE]: WHATIF_SOURCE }, prevArc = {}, queue = [WHATIF_SOURCE];
      while (queue.length && !prev[WHATIF_SINK]) {
        const u = queue.shift();
        for (const i of adj[u]) {
          const a = arcs[i];
          if (!prev[a.v] && a.cap - a.f > EPS) { prev[a.v] = u; prevArc[a.v] = i; queue.push(a.v); }
          if (prev[WHATIF_SINK]) break;
        }
      }
      if (!prev[WHATIF_SINK]) break;
      let push = Infinity;
      for (let v = WHATIF_SINK; v !== WHATIF_SOURCE; v = prev[v]) push = Math.min(push, arcs[prevArc[v]].cap - arcs[prevArc[v]].f);
      for (let v = WHATIF_SINK; v !== WHATIF_SOURCE; v = prev[v]) { arcs[prevArc[v]].f += push; arcs[arcs[prevArc[v]].rev].f -= push; }
      value += push;
    }
    const pipelines = {};
    for (const a of arcs) if (a.pipeline && Math.abs(a.f) > EPS) pipelines[a.pipeline] = (pipelines[a.pipeline] || 0) + a.f * a.sign;
    const delivered = {};
    for (const [id, i] of Object.entries(sinkArc)) delivered[id] = arcs[i].f;
    return { value, delivered, pipelines, max: Math.max(1, ...Object.values(pipelines).map(Math.abs)) };
  }
  function whatifResult() {
    if (!whatif.cache) whatif.cache = whatifFlow();
    return whatif.cache;
  }
  function toggleOffline(id) {
    if (whatif.offline.has(id)) whatif.offline.delete(id);
    else whatif.offline.add(id);
    whatif.cache = null;
    restyle();
    renderWhatif();
  }
  /* The header chip while the What-if mode is on: what the network can still
     deliver, which the user clears when done. Says so plainly when that is
     nothing, rather than showing an empty number. */
  /* The what-if status lives in the SAME chip as the plan status (one constant
     top bar: no element appears or disappears when the mode changes). */
  function renderWhatif() {
    if (state.mode !== "whatif") { renderTop(); return; }
    const chip = $("plan-chip");
    chip.hidden = false; // the chip is always there; only its words change
    const base = NORA.deliverable || 0, n = whatif.offline.size;
    if (!n) {
      chip.replaceChildren(h("span", { class: "dim" }, "What-if: click assets to take them offline"));
      chip.title = "Click assets to take them offline; the flows and the deliverable gas update";
      return;
    }
    const value = whatifResult().value;
    chip.replaceChildren(
      h("span", null, value < 0.05 ? "What-if: no gas can be delivered"
        : `What-if: ${fmt(value)} of ${fmt(base)} MSm³/d`),
      h("span", { class: "dim" }, ` · ${n} offline · Restore all`));
    chip.title = "Restore every asset: the what-if becomes the intact network again";
  }

  // ------------------------------------------------------------------ styling rules (both views)
  // The visible portion of a pipeline between its two node circles. A marker reaching
  // 0 or 1 stops at the circle edge; the next pipeline resumes beyond the other side.
  function visibleRange(length, gapA, gapB = gapA) {
    if (!(length > 0)) return [0, 1];
    return [Math.min(0.45, gapA / length), Math.max(0.55, 1 - gapB / length)];
  }
  /* Samples for a moving band, in tail-to-head order. Uniform samples keep short
     segments fluid; the route's own vertices are mandatory so no bend is skipped. */
  function bandStops(extent, vertices = [], visible = null) {
    const [a, b] = extent, lo = Math.min(a, b), hi = Math.max(a, b);
    const steps = Math.max(4, Math.ceil(Math.abs(b - a) * 32));
    const stops = Array.from({ length: steps + 1 }, (_, i) => a + ((b - a) * i) / steps);
    // Route distances run over the whole line; markers run over its visible part between
    // the node circles. Convert vertices into that same public 0..1 coordinate system.
    const positions = visible
      ? vertices.map((value) => (value - visible[0]) / (visible[1] - visible[0]))
      : vertices;
    for (const value of positions) if (Number.isFinite(value) && value > lo && value < hi) stops.push(value);
    stops.sort((x, y) => (a <= b ? x - y : y - x));
    return stops.filter((value, i) => i === 0 || Math.abs(value - stops[i - 1]) > 1e-9);
  }
  // Major named routes on the Map only. Split physical pipelines share one short name;
  // feeders, short links and notional grid entries stay quiet.
  function pipeMapName(id) {
    const d = assets[id];
    if (!d || (!["trunk", "export", "interconnector"].includes(d.type) && id !== "ogt")) return "";
    if (id.startsWith("europipe_2")) return "Europipe II";
    if (id.startsWith("langeled_")) return "Langeled";
    return d.name;
  }
  /* A pipeline always stays in the state grey palette. Alarms use a badge, shape and
     value beside the line; colouring the whole route would overwhelm the control room. */
  function pipeStyle(id) { return cached("pipe", id, () => pipeStyleNow(id)); }
  function pipeStyleNow(id) {
    const d = assets[id], mode = state.mode, onshore = d.type === "onshore";
    const out = {
      color: COLORS.normal, width: d.capacity ? 0.6 + 0.9 * Math.sqrt(d.capacity / maxCapacity) : 0.6,
      dashed: onshore || d.status !== "operating", label: "", level: 0,
      forward: true, backward: Boolean(d.bidirectional),
      hidden: !visible(id), dim: false, // every unit is always on (Ray, 29 Oct)
    };
    if (d.status !== "operating") out.color = COLORS.inactive;
    if (mode === "live") {
      const v = live.values[id];
      if (v === undefined) Object.assign(out, { color: COLORS.inactive, width: 1, dashed: true });
      else {
        const m = Math.abs(v);
        out.width = 1 + 4 * Math.sqrt(m / live.maxAbs);
        out.color = m < 0.05 ? COLORS.inactive : COLORS.active;
        out.label = m < 0.05 ? "" : fmt(m, 1); // the dark grey line already says "no flow"
        out.level = levelOf(id);
        if (d.bidirectional) Object.assign(out, { forward: v >= 0, backward: v < 0 });
      }
    } else if (mode === "load") {
      out.color = d.utilization == null ? COLORS.inactive : COLORS.active;
      // How full, at a glance: a hairline when empty, thick when running full.
      // Overload gets a badge; the route itself stays grey.
      if (d.utilization != null) out.width = 0.6 + 2.6 * Math.min(1, d.utilization);
      out.level = level(d.utilization, T.load);
      out.label = d.utilization == null ? "" : `${fmt(d.utilization * 100)}%`;
    } else if (mode === "risk") {
      out.level = onshore ? 0 : level(d.share, T.risk);
      out.label = d.lost ? `−${fmt(d.lost)}` : "";
    } else if (mode === "whatif") {
      if (whatif.offline.has(d.from) || whatif.offline.has(d.to)) {
        Object.assign(out, { color: COLORS.inactive, dashed: true, label: "" });
      } else {
        const m = Math.abs(whatifResult().pipelines[id] || 0);
        out.color = m < 0.05 ? COLORS.inactive : COLORS.active;
        if (m >= 0.05) out.width = 0.6 + 0.9 * Math.sqrt(m / whatifResult().max);  // same scale as live
        out.label = m < 0.05 ? "" : fmt(m, 1);
      }
    }
    if (settings.lineValues === "off" || (settings.lineValues === "auto" && mode === "plain")) out.label = "";
    if (settings.lineValues === "on" && !out.label && d.capacity) out.label = fmt(d.capacity);
    return out;
  }
  /* A node: a circle in its state grey, dark grey when inactive, an alarm badge when abnormal. */
  function nodeStyle(id) { return cached("node", id, () => nodeStyleNow(id)); }
  function nodeStyleNow(id) {
    const d = assets[id], mode = state.mode;
    const out = { level: 0, inactive: d.status !== "operating", sub: NORA.short[d.type], scale: 1,
      hidden: !visible(id), dim: false };
    if (mode === "live") {
      const f = frame(), through = throughput(id, f.flows), p = metric("pressure_bar", id, f);
      const nom = metric("nomination_msm3d", id, f);
      out.level = levelOf(id);
      if (through != null && through < 0.05) out.inactive = true;
      out.flow = nom > 0 ? `${fmt(through, 1)} / ${fmt(nom, 1)}` : through != null ? fmt(through, 1) : "";
      out.pressure = p != null ? `${fmt(p)} bar` : "";
      out.sub = "";
    } else if (mode === "load" && d.modelFlow != null) {
      out.sub = `${fmt(d.modelFlow)} MSm³/d`;
    } else if (mode === "risk" && d.type !== "market") {
      out.level = level(d.share, T.risk);
      out.scale = 0.75 + 0.9 * Math.sqrt(d.lost / worst);
      out.sub = d.lost ? `−${fmt(d.lost)} if it trips` : "No loss if it trips";
    } else if (mode === "whatif") {
      if (whatif.offline.has(id)) { out.inactive = true; out.sub = "offline"; }
      else if (d.exit) out.sub = `${fmt(whatifResult().delivered[id] || 0, 1)} MSm³/d`;
    }
    if (!settings.names) out.sub = "";
    return out;
  }

  // ------------------------------------------------------------------ indicators
  /* A range bar: the normal band, alarm-limit ticks, an optional target, and a moving
     pointer. All grey until the value is abnormal; then the pointer takes the alarm
     colour, with its dark outline. */
  function rangeBar({ min, max, value, band, ticks = [], target, lvl = 0 }) {
    const W = 200, x = (v) => Math.max(0, Math.min(W, ((v - min) / (max - min || 1)) * W));
    let m = `<rect x="0" y="11" width="${W}" height="7" rx="1" fill="${COLORS.dots}"/>`;
    if (band) m += `<rect x="${x(band[0])}" y="11" width="${Math.max(1, x(band[1]) - x(band[0]))}" height="7" fill="${COLORS.band}"/>`;
    for (const tick of ticks) {
      const tx = x(tick.at), tall = 3 + 2 * tick.level;
      m += `<line x1="${tx}" x2="${tx}" y1="${14.5 - tall}" y2="${14.5 + tall}" stroke="${COLORS.text}" stroke-width="${tick.level === 3 ? 1.6 : 1}"/>`;
    }
    if (target != null) {
      const tx = x(target);
      m += `<path d="M${tx} 9.5l3.5 5-3.5 5-3.5-5z" fill="none" stroke="${COLORS.text}" stroke-width="1.2"/>`;
    }
    if (value != null) {
      const px = x(value), fill = lvl ? LEVEL_COLOR[lvl] : COLORS.text;
      m += `<path d="M${px} 10l-4.5-7h9z" fill="${fill}" stroke="${COLORS.text}" stroke-width="1"/>`;
      m += `<line x1="${px}" x2="${px}" y1="10" y2="19" stroke="${COLORS.text}" stroke-width="1.4"/>`;
    }
    const node = svg(`0 0 ${W} 26`, m, "range");
    node.setAttribute("preserveAspectRatio", "none");
    return node;
  }
  /* A small trend: where the value has been, where it is heading (dashed), and the
     normal band behind it. */
  function trend(values, { band, lvl = 0 } = {}) {
    const W = 92, H = 26, known = values.filter((v) => v != null);
    if (known.length < 2) return svg(`0 0 ${W} ${H}`, "", "trend");
    const r = rate(values) || 0, ahead = Math.min(4, values.length);
    const lastValue = known[known.length - 1], projected = lastValue + r * stepHours() * ahead;
    const lo = Math.min(...known, projected, ...(band || [])), hi = Math.max(...known, projected, ...(band || []));
    const y = (v) => H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 6);
    const n = values.length + ahead - 1, x = (i) => (i / n) * W;
    let m = band ? `<rect x="0" y="${y(band[1])}" width="${W}" height="${Math.max(1, y(band[0]) - y(band[1]))}" fill="${COLORS.band}"/>` : "";
    const pts = values.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(" ");
    m += `<polyline points="${pts}" fill="none" stroke="${COLORS.text}" stroke-width="1.4"/>`;
    const last = values.length - 1;
    m += `<line x1="${x(last)}" y1="${y(lastValue)}" x2="${x(last + ahead)}" y2="${y(projected)}" stroke="${COLORS.text}" stroke-width="1.2" stroke-dasharray="2 2"/>`;
    m += `<circle cx="${x(last)}" cy="${y(lastValue)}" r="2.6" fill="${lvl ? LEVEL_COLOR[lvl] : COLORS.text}" stroke="${COLORS.text}"/>`;
    return svg(`0 0 ${W} ${H}`, m, "trend");
  }
  function rateText(r, unit) {
    if (r == null) return h("span", { class: "dim" }, "–");
    if (Math.abs(r) < 0.05) return h("span", { class: "dim" }, "◆ steady");
    return h("span", null, `${r > 0 ? "▲" : "▼"} ${signed(r, 1)} ${unit}/h`);
  }

  // What each kind of value's bar, band and ticks mean.
  function exitIndicator(id) {
    const nom = metric("nomination_msm3d", id), booked = metric("booked_msm3d", id);
    const actual = throughput(id, frame().flows), tol = T.nomination;
    const top = Math.max(nom || 0, booked || 0, actual || 0, 1) * 1.15;
    const band = nom ? [nom * (1 - tol[0]), nom * (1 + tol[0])] : null;
    const lvl = levelFor(id, ["nomination", "booking"]);
    return {
      id, measure: "Delivery", unit: "MSm³/d", lvl, band,
      bar: rangeBar({ min: 0, max: top, value: actual, target: nom, lvl, band,
        ticks: [...(nom ? [nom * (1 - tol[2]), nom * (1 + tol[2])].map((at) => ({ at, level: 3 })) : []), ...(booked ? [{ at: booked, level: 2 }] : [])] }),
      series: series((f) => throughput(id, f.flows)),
      value: nom ? `${fmt(actual, 1)} of ${fmt(nom, 1)} nominated${booked ? `, ${fmt(booked)} booked` : ""}` : `${fmt(actual, 1)} MSm³/d`,
    };
  }
  function pressureIndicator(id) {
    const p = metric("pressure_bar", id), [low, high] = C.pressure[assets[id].type], span = high - low;
    const pm = T.pressure_margin, band = [low + pm[0] * span, high - pm[0] * span];
    const lvl = levelFor(id, ["pressure"]);
    return {
      id, measure: "Pressure", unit: "bar", lvl, band,
      bar: rangeBar({ min: low - 0.1 * span, max: high + 0.1 * span, value: p, lvl, band,
        ticks: [{ at: low, level: 3 }, { at: high, level: 3 }, { at: low + pm[1] * span, level: 2 }, { at: high - pm[1] * span, level: 2 }] }),
      series: series((f) => metric("pressure_bar", id, f)),
      value: `${fmt(p, 1)} bar, window ${fmt(low)}–${fmt(high)}`,
    };
  }
  function qualityIndicator(id, name) {
    const v = metric(name, id), limits = C.quality[name], lvl = level(v, limits);
    return {
      id, measure: QUALITY[name].name, unit: QUALITY[name].unit, lvl, band: [0, limits[0]],
      bar: rangeBar({ min: 0, max: limits[2] * 1.5, value: v, lvl, band: [0, limits[0]],
        ticks: limits.map((at, i) => ({ at, level: i + 1 })) }),
      series: series((f) => metric(name, id, f)),
      value: `${qualityText(name, v)}, limit ${limits[2]}`,
    };
  }
  function loadIndicator(id) {
    const d = assets[id], v = Math.abs(frame().flows[id] || 0), u = v / d.capacity;
    return {
      id, measure: "Load", unit: "pts", lvl: level(u, T.load), band: [0, T.load[0] * 100],
      bar: rangeBar({ min: 0, max: 1.1, value: u, lvl: level(u, T.load), band: [0, T.load[0]], ticks: T.load.map((at, i) => ({ at, level: i + 1 })) }),
      series: series((f) => (f.flows[id] == null ? null : (Math.abs(f.flows[id]) / d.capacity) * 100)),
      value: `${fmt(u * 100)}%: ${fmt(v, 1)} of ${fmt(d.capacity)} MSm³/d`,
    };
  }
  /* A bank of indicators. Across assets (the overview) each row is named after its
     asset; for one asset (its page or sidebar) after what it measures, so the rows
     read "Delivery", "Pressure" instead of the asset's name twice. */
  function bank(indicators, empty, { byMeasure = false } = {}) {
    if (!indicators.length) return h("p", { class: "empty" }, empty);
    return h("div", { class: `bank${byMeasure ? " by-measure" : ""}` },
      h("div", { class: "head" }, byMeasure ? "" : "Asset"), h("div", { class: "head" }, "Value in its range"),
      h("div", { class: "head" }, "Last 2 h"), h("div", { class: "head optional" }, "Change"), h("div", { class: "head optional" }, "State"),
      ...indicators.flatMap((ind) => [
        byMeasure ? h("div", { class: "name measure" }, ind.measure || nameOf(ind.id))
          : h("div", { class: "name", onclick: () => go({ screen: "asset", asset: ind.id }), title: "Open the asset" }, nameOf(ind.id)),
        h("div", null, ind.bar, h("div", { class: "value" }, ind.value, h("span", { class: "rate-inline" }, rateText(rate(ind.series), ind.unit)))),
        trend(ind.series, { band: ind.band, lvl: ind.lvl }),
        h("div", { class: "rate" }, rateText(rate(ind.series), ind.unit)),
        h("div", { class: "state optional" }, badge(ind.lvl)),
      ]));
  }
  function alarmList(conditions) {
    if (!conditions.length) return h("p", { class: "empty" }, "No active alarms. Everything is in its normal range.");
    return h("ul", { class: "alarm-list" }, conditions.map((c) =>
      h("li", { onclick: () => (assets[c.id] ? go({ screen: "asset", asset: c.id }) : null) },
        badge(c.level, ""), h("span", null, c.text), h("time", null, live.time ? shortTime(live.time) : ""))));
  }

  // ------------------------------------------------------------------ decision support
  /* Analysis and suggestions from the model, never presented as instructions: each
     shows what it is based on and how uncertain it is. */
  function decisionBox(advice) {
    return h("div", { class: "box wide decision" },
      h("h2", null, "Decision support"),
      h("p", { class: "situation" }, advice.situation || ""),
      h("p", null, h("strong", null, "Likely cause: "), advice.cause),
      advice.suggestions.length
        ? h("ol", { class: "suggestions" }, advice.suggestions.map((t) => h("li", null, t)))
        : h("p", { class: "dim" }, "No rerouting found within today's bookings."),
      h("dl", { class: "facts provenance" },
        h("dt", null, "Based on"), h("dd", null, advice.basis),
        h("dt", null, "Confidence"), h("dd", null, `${advice.confidence}: ${advice.uncertainty.join(" ")}`)),
      h("p", { class: "dim", style: "margin:6px 0 0" }, "A suggestion to support your decision, not an instruction. Check it against the live system."));
  }
  // Why might this asset be abnormal? Look upstream for an active event or a trip.
  function upstreamCause(id) {
    const events = ((live.stream && live.stream.events) || live.feedEvents || []).filter((e) => live.time >= e.start && live.time < e.end);
    const seen = new Set([id]), queue = [[id, 0]];
    while (queue.length) {
      const [node, depth] = queue.shift();
      for (const event of events) if (event.asset === node && node !== id) return { text: `${event.label}, ${depth} step${depth === 1 ? "" : "s"} upstream`, confidence: event.planned ? "high (planned work)" : "medium" };
      for (const pid of pipeIds) {
        const p = assets[pid];
        const into = p.to === node ? p.from : p.bidirectional && p.from === node ? p.to : null;
        if (!into) continue;
        if (live.down[pid] || events.some((e) => e.asset === pid)) return { text: `${nameOf(pid)} has lost its flow, ${depth + 1} step${depth ? "s" : ""} upstream`, confidence: "medium" };
        if (!seen.has(into) && depth < 6) { seen.add(into); queue.push([into, depth + 1]); }
      }
    }
    return { text: "No active event or trip found upstream; check the readings (level 4).", confidence: "low" };
  }

  // ------------------------------------------------------------------ screens
  const screens = { overview: $("screen-overview"), asset: $("screen-asset"), diag: $("screen-diag") };
  const containers = { map: $("view-map"), flow: $("view-flow") };
  const views = {};
  function register(name, view) { views[name] = view; }
  const current = () => views[state.view];
  function restyle() {
    const view = current();
    if (route.screen === "unit" && view && view.ready) view.restyle();
  }

  // Level 1: plan, exit points, alarms, pressures, busiest lines, units.
  /* Where each H₂S or CO₂ peak is, where it goes next, and what is expected when it
     leaves the network: an estimate, with its basis shown. */
  function qualityBox() {
    if (!live.frames.some((f) => Object.keys(QUALITY).some((name) => (f.metrics || {})[name]))) return null;
    const rows = slugs().sort((a, b) => Math.max(b.level, b.exitLevel) - Math.max(a.level, a.exitLevel));
    const swatch = (name) => svg("0 0 14 14", `<circle cx="7" cy="7" r="5" fill="${COLORS[QUALITY[name].color]}" stroke="${COLORS.casing}"/>`);
    const limits = Object.keys(QUALITY).map((name) => `${QUALITY[name].name} ${C.quality[name][2]} ${QUALITY[name].unit}`).join(", ");
    return h("div", { class: "box" }, h("h2", null, "Gas quality on its way"),
      rows.length ? h("table", { class: "data quality" },
        h("thead", null, h("tr", null, ["Peak", "Now", "Next stop", "Leaves the network", ""].map((t) => h("th", null, t)))),
        h("tbody", null, rows.map((s) => h("tr", { onclick: () => go({ screen: "asset", asset: s.q.arrived ? s.q.arrived.node : s.q.pid }) },
          h("td", null, swatch(s.q.metric), ` ${QUALITY[s.q.metric].name} from ${nameOf(s.q.origin)}`),
          h("td", null, fmt(s.q.conc, QUALITY[s.q.metric].digits), ` ${QUALITY[s.q.metric].unit}`),
          h("td", null, s.q.arrived ? `Arrived at ${nameOf(s.q.arrived.node)}` : `${nameOf(s.next.node)}, ${etaText(s.next.t)}`),
          h("td", null, s.exit ? `${nameOf(s.exit.node)}, ${fmt(s.exit.conc, QUALITY[s.q.metric].digits)} ${QUALITY[s.q.metric].unit}, ${etaText(s.exit.t)}` : "No exit on today's flows"),
          h("td", null, badge(s.exitLevel || Math.min(1, s.level), ""))))))
        : h("p", { class: "empty" }, `No H₂S or CO₂ peaks in the network. Limits: ${limits}.`),
      h("p", { class: "dim small" }, `Estimate. Gas travels at ${fmt(C.pipelines.gas_velocity_mps)} m/s along the line taking most of the flow; where gas joins, it is assumed to carry the median field reading. Limits from nora.toml.`));
  }
  function renderOverview() {
    const f = frame(), plan = f.plan;
    const exits = exitPoints.filter((id) => metric("nomination_msm3d", id) != null || throughput(id, f.flows) > 0.05);
    const pressures = nodeIds.filter((id) => metric("pressure_bar", id) != null && ["terminal", "processing", "hub"].includes(assets[id].type))
      .sort((a, b) => levelOf(b) - levelOf(a) || nameOf(a).localeCompare(nameOf(b)));
    const loaded = pipeIds.filter((id) => f.flows[id] != null && assets[id].capacity && assets[id].type !== "onshore")
      .sort((a, b) => Math.abs(f.flows[b]) / assets[b].capacity - Math.abs(f.flows[a]) / assets[a].capacity).slice(0, 8);
    const nowLevel = plan ? plan.now[0] : 0, aheadLevel = plan ? Math.min(plan.ahead[0], 2) : 0;
    const bannerLevel = nowLevel || aheadLevel;
    const headline = !plan ? "No nominations in this dataset, so there is no plan to check"
      : !plan.nominated ? "No nominations at this hour, so there is no plan to check"
      : nowLevel ? `${plan.now[1]} now`
      : plan.ahead[0] ? `In ${fmt(plan.ahead[3])} h: ${plan.ahead[1]}`
      : "Plan holds at every exit point";
    const ts = timeState(), ahead = ts && ts.model ? `Model, ${spanText(ts.ahead)} ahead of now. ` : "";
    const context = ahead + (plan && plan.nominated ? `Nominated ${fmt(plan.nominated)} MSm³/d, deliverable ${fmt(plan.deliverable)} MSm³/d.`
      + (plan.bottleneck ? ` Busiest line: ${nameOf(plan.bottleneck)} at ${fmt(plan.maxLoad * 100)}%.` : "") : "");
    const units = NORA.units.map((u) => {
      const conds = live.conditions.filter((c) => unitOf[c.id] === u.id);
      return h("button", { type: "button", onclick: () => go({ screen: "unit", unit: u.id }) },
        h("span", null, u.name), badge(Math.max(0, ...conds.map((c) => c.level)), conds.length ? `${conds.length} active` : "Normal"));
    });
    screens.overview.replaceChildren(h("div", { class: "screen-body" },
      h("div", { class: `box banner${bannerLevel ? " alarm" : ""}`, style: bannerLevel ? `border-color:${LEVEL_COLOR[bannerLevel]}` : null },
        bannerLevel ? badge(bannerLevel, "") : null,
        h("div", null, h("div", { class: `big${plan ? "" : " dim"}` }, headline), h("div", { class: "context" }, context))),
      plan && plan.advice ? decisionBox(plan.advice) : null,
      h("div", { class: "cols" },
        h("div", { class: "box" }, h("h2", null, "Exit points: actual flow against the hourly nomination"),
          bank(exits.map(exitIndicator), "No exit-point readings in this dataset.")),
        h("div", { class: "box" }, h("h2", null, "Active alarms"), alarmList(live.conditions.slice(0, 12))),
        qualityBox(),
        h("div", { class: "box" }, h("h2", null, "Pressures at plants, hubs and terminals"),
          bank(pressures.slice(0, 10).map(pressureIndicator), "No pressure readings in this dataset.")),
        h("div", { class: "box" }, h("h2", null, "Busiest pipelines"), bank(loaded.map(loadIndicator), "No flow readings yet.")),
        h("div", { class: "box" }, h("h2", null, "Units"), h("div", { class: "units" }, units)))));
  }

  function nominationHistogram(id) {
    const readings = nominationWindow(id);
    if (!readings.some((reading) => reading.value != null)) return null;
    const W = 360, H = 116, baseline = 88, slot = W / 6;
    const peak = Math.max(1, ...readings.map((reading) => reading.value || 0));
    const text = "stroke:none;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif";
    let body = `<line x1="0" y1="${baseline}" x2="${W}" y2="${baseline}" stroke="${COLORS.border}" stroke-width="1"/>`;
    readings.forEach((reading, index) => {
      const center = slot * (index + 0.5), hour = String(new Date(reading.t * 1000).getUTCHours()).padStart(2, "0");
      if (reading.value != null) {
        const height = Math.max(1, (reading.value / peak) * 56), y = baseline - height;
        body += `<rect class="nomination-bar" x="${center - 15}" y="${y}" width="30" height="${height}" rx="2" fill="${COLORS.active}" opacity="${index === 0 ? 1 : 0.72}"/>`;
        body += `<text x="${center}" y="${Math.max(11, y - 4)}" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(reading.value, reading.value < 10 ? 1 : 0))}</text>`;
      }
      body += `<text x="${center}" y="106" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">${hour}</text>`;
    });
    return svg(`0 0 ${W} ${H}`, body, "nomination-histogram");
  }

  // Level 3: what flows in (top), the asset, what flows out (bottom), and its values.
  function assetDetail(id, inSidebar = false) {
    const d = assets[id];
    if (!d) return null;
    const f = frame(), indicators = [];
    if (d.kind === "node") {
      if (exitPoints.includes(id) && (metric("nomination_msm3d", id) != null || throughput(id, f.flows) != null)) indicators.push(exitIndicator(id));
      if (metric("pressure_bar", id) != null && C.pressure[d.type]) indicators.push(pressureIndicator(id));
      for (const name of Object.keys(QUALITY)) if (metric(name, id) != null) indicators.push(qualityIndicator(id, name));
    } else if (d.capacity && f.flows[id] != null) indicators.push(loadIndicator(id));
    const conds = live.conditions.filter((c) => c.id === id);
    // In the sidebar the name is already the panel header: no repeated h1.
    return h("div", { class: inSidebar ? "side-detail" : "screen-body" },
      inSidebar ? null : h("h1", null, d.name),
      inSidebar ? null : h("p", { class: "sub" }, d.kind === "node"
        ? `${NORA.nodeTypes[d.type]}, ${d.country}. Unit: ${(unitById[unitOf[id]] || {}).name || "none"}.`
        : `${NORA.pipelineTypes[d.type]}, ${nameOf(d.from)} to ${nameOf(d.to)}.`),
      h("div", { class: "cols" },
        h("div", { class: "box" }, h("h2", { title: "Flowing in above the asset, out below it" }, "In context"), schematic(id)),
        h("div", { class: "box" }, h("h2", { title: "Live readings in their ranges, from the data being played" }, "Values"), bank(indicators, "No live readings for this asset in the dataset.", { byMeasure: true }),
          exitPoints.includes(id) ? h("div", { class: "nomination-outlook" }, h("h2", { style: "margin-top:14px" }, "Next 6 hours · MSm³/d"), nominationHistogram(id)) : null,
          inSidebar ? null : h("h2", { style: "margin-top:14px" }, "State"),
          conds.length ? alarmList(conds)
            : h("p", { class: "state-quiet" }, "Normal · no alarms right now"),
          conds.length ? (() => { const cause = upstreamCause(id); return h("p", { class: "cause" }, h("strong", null, "Likely cause: "), cause.text, h("span", { class: "dim" }, ` (confidence ${cause.confidence}; traced through the network model)`)); })() : null),
        h("div", { class: "box" }, h("h2", null, "Facts"), facts(id))),
      h("div", { class: "actions" },
        d.kind === "node" ? h("button", { type: "button", class: "text", onclick: () => {
          state.mode = "whatif";
          markTabs();
          toggleOffline(id);
          if (side.id === id) renderSidebar(); else renderAsset();
        } }, `${whatif.offline.has(id) ? "Restore" : "Take offline"} in the what-if`) : null,
        inSidebar ? h("button", { type: "button", class: "text", onclick: () => go({ screen: "asset", asset: id }) }, "Open the full page") : null,
        !inSidebar ? h("button", { type: "button", class: "text", onclick: () => go({ screen: "unit", unit: unitOf[id] || "all", focus: id }) }, "Show in its unit") : null,
        h("button", { type: "button", class: "text", onclick: () => go({ screen: "diag", asset: id }) }, "Diagnostics")));
  }
  function renderAsset() {
    const detail = assetDetail(route.asset);
    if (detail) screens.asset.replaceChildren(detail);
  }

  /* The asset sidebar: a calm column that slides in from the right when a field,
     plant or line is clicked on the unit screen, and follows the data as it plays. */
  const side = { id: null, marker: null, form: false }; // form: a new node or line (the editor)
  function openSidebar(id) {
    if (!assets[id]) return;
    side.id = id;
    side.marker = null;
    renderSidebar();
    $("asset-side").classList.add("open");
    $("asset-side").setAttribute("aria-hidden", "false");
  }
  // A pig or a peak: the sidebar follows it as the data plays (`key` from markers()).
  function openMarker(key) {
    if (!key) return;
    side.id = null;
    side.marker = key;
    renderSidebar();
    $("asset-side").classList.add("open");
    $("asset-side").setAttribute("aria-hidden", "false");
  }
  function closeSidebar() {
    side.id = null;
    side.marker = null;
    side.form = false;
    $("asset-side").classList.remove("open");
    $("asset-side").setAttribute("aria-hidden", "true");
  }
  // A primary press anywhere outside dismisses the panel. Listening on pointerdown
  // means selecting another background asset closes the old panel before the new one
  // opens; interaction inside the panel itself never bubbles into a dismissal.
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (!side.id && !side.marker)) return;
    if (event.target.closest("#asset-side")) return;
    closeSidebar();
  });
  function renderSidebar() {
    if (side.marker) {
      const body = $("side-body"), top = body.scrollTop, detail = markerDetail(side.marker);
      $("side-title").textContent = detail.title;
      $("side-sub").textContent = detail.sub;
      body.replaceChildren(detail.body);
      body.scrollTop = top;
      return;
    }
    if (!side.id || !assets[side.id]) return;
    const d = assets[side.id], body = $("side-body"), top = body.scrollTop;
    $("side-title").textContent = d.name;
    $("side-sub").textContent = d.kind === "node"
      ? `${NORA.nodeTypes[d.type]} · ${d.operator || d.country}`
      : `${NORA.pipelineTypes[d.type]} · ${nameOf(d.from)} to ${nameOf(d.to)}`;
    body.replaceChildren(assetDetail(side.id, true));
    body.scrollTop = top;
  }
  /* A pig or a peak in the sidebar (Ray, 28 Oct: "head ETA and tail ETA as well as
     total volume of the peak as the origin of the peak (where was it first
     generated)"). Every time is an estimate from the model's gas speed and the flows
     of the data, and says so. */
  function markerDetail(key) {
    const m = markers().find((k) => k.key === key && !k.noDot) || markers().find((k) => k.key === key);
    const row = (label, ...value) => [h("dt", null, label), h("dd", null, ...value)];
    const box = (title, ...rows) => h("div", { class: "box" }, h("h2", null, title), h("dl", { class: "facts" }, ...rows.flat()));
    const note = (text) => h("p", { class: "dim small" }, text);
    const at = (node, t) => (t == null ? nameOf(node) : `${nameOf(node)}, ${etaText(t)}`);
    const v = C.pipelines.gas_velocity_mps, step = (live.stream && live.stream.step) || 3600;
    const volume = (msm3) => `${fmt(msm3, msm3 < 1 ? 2 : 1)} MSm³`;
    if (!m) return { title: "Left the network", sub: "", body: h("div", { class: "side-detail" }, h("p", { class: "empty" }, "This pig or peak has left the network, or the data moved past it. Click another on the map or in the Flow.")) };
    if (m.kind === "pig") {
      const pig = m.ref, trip = pigTrip(pig, live.time);
      return { title: pig.label, sub: `Pig on ${nameOf(m.id)}`, body: h("div", { class: "side-detail" },
        box("Where it is going",
          row("Now on", nameOf(m.id)),
          row("Next stop", at(trip.next, trip.nextAt)),
          row("Receiver", at(trip.receiver, trip.arrives))),
        box("Run",
          row("Launched", formatTime(trip.start)),
          row("Speed", `${fmt(pig.speed, 1)} m/s`),
          pig.every ? row("Relaunched", `every ${fmt(pig.every / 3600)} h`) : []),
        note("Estimate from the pig's speed and the route the gas takes through each node.")) };
    }
    if (m.kind === "peak") {
      const peak = m.ref, place = peakPlace(peak), pad = step / 2, d = assets[place.pid];
      const next = place.forward ? d.to : d.from, end = peakEnd(peak);
      const rose = place.delta > 0;
      return { title: `Flow ${rose ? "increase" : "drop"} of ${fmt(Math.abs(place.delta), 1)} MSm³/d`, sub: `Peak on ${nameOf(place.pid)}`,
        body: h("div", { class: "side-detail" },
          box("Head and tail",
            row("Head reaches", at(next, place.exitAt - pad)),
            row("Tail reaches", at(next, place.exitAt + pad)),
            end ? row(end.leaves ? "Leaves the network" : "Fades out", `${at(end.node, end.t)}, head to tail ${fmt(step / 3600, step % 3600 ? 1 : 0)} h`) : []),
          box("Volume and origin",
            row("Total volume", `${volume((Math.abs(place.delta) * step) / 86400)} ${rose ? "more" : "less"} gas`),
            row("Origin", `${nameOf(peak.id)}, first seen ${formatTime(peak.t0)}`),
            row("At the origin", `${signed(peak.delta, 1)} MSm³/d in one data step`)),
          note(`Estimate: a change in flow travels with the gas at ${fmt(v)} m/s, spread over the gas of one data step, and fades where other gas joins it.`)) };
    }
    // An H₂S or CO₂ slug: its head is the parcel that left the field first, its tail the last.
    const slug = live.slugs.get(m.ref), parcels = live.quality.filter((q) => q.slug === m.ref), q0 = QUALITY[m.gas];
    const head = parcels.reduce((a, b) => (a && a.born <= b.born ? a : b), null), tail = parcels.reduce((a, b) => (a && a.born >= b.born ? a : b), null);
    const ahead = (q) => (q ? project(q) : null), headGo = ahead(head), tailGo = ahead(tail);
    const conc = (value) => `${fmt(value, q0.digits)} ${q0.unit}`;
    return { title: `${q0.name} peak`, sub: `${m.value ? `${m.value} ${q0.unit} ` : ""}on ${nameOf(m.id)}${slug ? ` · from ${nameOf(slug.origin)}` : ""}`,
      body: h("div", { class: "side-detail" },
        box("Head and tail",
          headGo ? row("Head reaches", head.arrived ? `${nameOf(head.arrived.node)}: arrived` : at(headGo.next.node, headGo.next.t)) : [],
          tailGo ? row("Tail reaches", tail.arrived ? `${nameOf(tail.arrived.node)}: arrived` : at(tailGo.next.node, tailGo.next.t)) : [],
          headGo && headGo.exit ? row("Head leaves at", `${at(headGo.exit.node, headGo.exit.t)}, ${conc(headGo.exit.conc)}`) : [],
          tailGo && tailGo.exit ? row("Tail leaves at", `${at(tailGo.exit.node, tailGo.exit.t)}, ${conc(tailGo.exit.conc)}`) : []),
        slug ? box("Volume and origin",
          row("Total volume", `${volume(slug.volume)} of gas over ${conc(C.quality[m.gas][0] * C.quality.follow_from)}`),
          row("Origin", `${nameOf(slug.origin)}, first seen ${formatTime(slug.first)}`),
          row("Strongest at the origin", `${conc(slug.max)}; limit ${conc(C.quality[m.gas][2])}`)) : [],
        note(`Estimate: gas travels at ${fmt(v)} m/s along the line taking most of the flow; where gas joins, it is assumed to carry the median field reading. The volume is the field's gas while its reading stayed over the follow level.`)) };
  }
  // Where a peak's route ends: its last line, from the flows the data will have then.
  function peakEnd(peak) {
    peakPlace(peak, Infinity); // works out the rest of its hops, kept on the peak
    const last = peak.hops[peak.hops.length - 1];
    if (!last) return null;
    const node = last.forward ? assets[last.pid].to : assets[last.pid].from;
    return { node, t: last.t + lineMetres(last.pid) / C.pipelines.gas_velocity_mps, leaves: isExit(node) };
  }
  // A pig's run: the next node, the receiver at the end of its route, and when.
  function pigTrip(pig, time) {
    const since = time - pig.launch, every = pig.every > 0 ? pig.every : 0;
    const run = every ? Math.floor(since / every) : 0, start = pig.launch + run * every;
    const place = pigPlace(pig, time), route = pigRoute(pig, run, Infinity), last = route[route.length - 1];
    return {
      start, next: place.next, nextAt: place.exitAt,
      receiver: last.forward ? assets[last.pid].to : assets[last.pid].from,
      arrives: start + (last.m + lineMetres(last.pid)) / pig.speed,
    };
  }
  function facts(id) {
    const d = assets[id];
    const lost = d.lost ? `${fmt(d.lost)} MSm³/d (${fmt(d.share * 100, 1)}%)` : "Nothing lost";
    const position = d.lat != null ? `${d.lat.toFixed(4)}°N, ${d.lon.toFixed(4)}°E` : null; // always N and E (Ray)
    const depth = d.lat != null ? depthAt(d.lon, d.lat) : null;
    const rows = d.kind === "node"
      ? [["Operator", d.operator], ["Capacity", d.capacity == null ? null : `${fmt(d.capacity)} MSm³/d`], ["If it trips", lost],
        ["Pressure window", C.pressure[d.type] ? `${C.pressure[d.type][0]}–${C.pressure[d.type][1]} bar` : null], ["Status", d.status],
        ["Position", h("a", { href: `https://www.google.com/maps?q=${d.lat},${d.lon}`, target: "_blank", rel: "noopener", title: "Open this exact location in Google Maps" }, position)],
        ["Water depth", depth != null ? `${fmt(depth)} m (EMODnet seabed model)` : null]]
      : [["Capacity", d.capacity == null ? "Not modelled" : `${fmt(d.capacity)} MSm³/d`], ["Length", `${fmt(d.km)} km`],
        ["Diameter", d.diameter == null ? null : `${fmt(d.diameter)} in`], ["In service since", d.commissioned], ["If it trips", lost], ["Status", d.status]];
    return h("dl", { class: "facts" }, rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  }
  /* Labels in the asset picture: regular weight and never outlined. Set inline, so no
     stylesheet rule (the global `svg` one strokes shapes) can smudge them into bold. */
  const TEXT = "stroke:none;font-weight:400;paint-order:normal";
  function schematic(id) {
    const d = assets[id], f = frame();
    const inbound = [], outbound = [];
    if (d.kind === "node") {
      for (const pid of pipeIds) {
        const p = assets[pid];
        if (p.to !== id && p.from !== id) continue;
        const v = f.flows[pid];
        const toward = v === undefined || Math.abs(v) < 0.05 ? p.to === id : (p.to === id) === (v > 0);
        (toward ? inbound : outbound).push(pid);
      }
    }
    if (d.kind === "pipeline") {
      /* A pipeline: its two ends, the flow beside the line with an arrowhead for its
         direction, and the pigs and peaks in it now, each at its place with its value
         and ETA: what is in this line, at a glance. */
      const W = 420, H = 230, s = pipeStyle(id), x = W / 2, top = 52, bottom = H - 34;
      const v = f.flows[id], dir = v < 0 ? -1 : 1;
      let m = `<text x="${x}" y="40" text-anchor="middle" style="${TEXT}">${esc(nameOf(d.from))}</text><text x="${x}" y="${H - 14}" text-anchor="middle" style="${TEXT}">${esc(nameOf(d.to))}</text>`;
      m += `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${s.level ? COLORS.casing : "none"}" stroke-width="${s.width + 2.4}"/><line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${s.level ? LEVEL_COLOR[s.level] : s.color}" stroke-width="${Math.max(1.2, s.width)}"/>`;
      if (v != null && Math.abs(v) >= 0.05) {
        const tip = dir > 0 ? bottom : top;
        m += `<path d="M${x - 5} ${tip - dir * 9}L${x} ${tip}L${x + 5} ${tip - dir * 9}" fill="none" stroke="${COLORS.text}" stroke-width="1.4" stroke-linejoin="round"/>`;
        m += `<text x="${x - 14}" y="${(top + bottom) / 2 + 4}" text-anchor="end" class="dimtext" style="${TEXT}">${esc(fmt(Math.abs(v), 1))} MSm³/d</text>`;
      }
      const lvl = levelOf(id);
      if (lvl) m += `<g transform="translate(${x - 30} ${(top + bottom) / 2 + 10})">${shapeMarkup(lvl)}</g>`;
      let below = -Infinity; // labels on the right, one row each
      for (const k of markers().filter((k) => k.id === id && !k.noDot).sort((a, b) => a.along - b.along)) {
        const y = top + Math.max(0, Math.min(1, k.along)) * (bottom - top);
        if (k.kind === "pig") m += `<path d="M${x - 4.5} ${y - dir * 4}L${x + 4.5} ${y - dir * 4}L${x} ${y + dir * 5}Z" fill="${COLORS.pig}" stroke="${COLORS.casing}" stroke-width="0.8"/>`;
        else m += `<circle cx="${x}" cy="${y}" r="4" fill="${k.kind === "quality" ? COLORS[QUALITY[k.gas].color] : COLORS.peak}" stroke="${COLORS.casing}" stroke-width="0.8"/>`;
        const what = k.kind === "pig" ? k.title || "Pig" : k.value;
        const ly = Math.max(y + 4, below + 15);
        below = ly;
        m += `<text x="${x + 14}" y="${ly}" style="${TEXT}">${esc(what.length > 30 ? `${what.slice(0, 29)}…` : what)}${k.eta ? `<tspan class="dimtext" dx="6">${esc(k.eta)}</tspan>` : ""}</text>`;
      }
      return svg(`0 0 ${W} ${H}`, m, "schematic");
    }
    /* A node: one row per line, gas in above the circle and gas out below it, so labels
       never meet however many lines there are. Names sit in a column on the left with
       the flow (MSm³/d) right-aligned beside them; each line fans from its row into the
       circle, and the node's name sits to the right of the circle, where no line runs. */
    const W = 420, ROW = 19, R = 22, CX = 300, END = 236, START = 246;
    const rows = [];
    let y = 4, m = "";
    const group = (list, title) => {
      if (!list.length) return;
      y += 14;
      m += `<text x="18" y="${y}" class="dimtext" style="${TEXT};font-size:10.5px">${title}</text>`;
      for (const pid of list) { y += ROW; rows.push({ pid, y }); }
    };
    group(inbound, "Gas in");
    const mid = y + R + 14;
    y = mid + R;
    group(outbound, "Gas out");
    const H = Math.max(mid + R, y) + 10;
    for (const { pid, y: ry } of rows) {
      const s = pipeStyle(pid), v = f.flows[pid];
      const color = s.level ? LEVEL_COLOR[s.level] : v == null || Math.abs(v) < 0.05 ? COLORS.inactive : COLORS.active;
      const ly = ry - 4; // the middle of the row's text
      if (s.level) m += `<line x1="${START}" y1="${ly}" x2="${CX}" y2="${mid}" stroke="${COLORS.casing}" stroke-width="${s.width + 2.4}"/>`;
      m += `<line x1="${START}" y1="${ly}" x2="${CX}" y2="${mid}" stroke="${color}" stroke-width="${Math.max(1.2, s.width)}"/>`;
      if (s.level) m += `<g transform="translate(${START - 10} ${ry - 12}) scale(0.9)">${shapeMarkup(s.level)}</g>`;
      const name = nameOf(pid);
      m += `<text x="18" y="${ry}" style="${TEXT}">${esc(name.length > 28 ? `${name.slice(0, 27)}…` : name)}</text>`;
      if (v != null) m += `<text x="${END}" y="${ry}" text-anchor="end" class="dimtext" style="${TEXT}">${esc(fmt(Math.abs(v), 1))}</text>`;
    }
    // The node as a circle holding its flow, its pressure beside it (the Flow view draws squares).
    const st = nodeStyle(id), look = COLORS.card[st.inactive ? "inactive" : state.mode === "live" ? "active" : "normal"];
    const flow = throughput(id, f.flows), bar = metric("pressure_bar", id);
    m += `<circle cx="${CX}" cy="${mid}" r="${R}" fill="${look.fill}" stroke="${st.level ? LEVEL_COLOR[st.level] : look.edge}" stroke-width="${st.level ? 2.5 : 1}"/>`;
    if (flow != null) m += `<text x="${CX}" y="${mid + 4}" text-anchor="middle" fill="${look.ink}" style="${TEXT};font-weight:500">${esc(fmt(flow, flow < 10 ? 1 : 0))}</text>`;
    if (bar != null) m += `<text x="${CX + R + 8}" y="${mid + 20}" class="dimtext" style="${TEXT};font-size:11px">${esc(fmt(bar))} bar</text>`;
    const lvl = levelOf(id);
    if (lvl) m += `<g transform="translate(${CX + 12} ${mid - R - 10})">${shapeMarkup(lvl)}</g>`;
    m += `<text x="${CX + R + 8}" y="${mid + 4}" style="${TEXT};font-weight:500">${esc(d.name.length > 13 ? `${d.name.slice(0, 12)}…` : d.name)}</text>`;
    if (!rows.length) m += `<text x="${CX}" y="${mid + R + 18}" text-anchor="middle" class="dimtext" style="${TEXT}">No connected pipelines</text>`;
    return svg(`0 0 ${W} ${rows.length ? H : mid + R + 26}`, m, "schematic");
  }

  // Level 4: the readings behind the values, newest first, and where they come from.
  function renderDiag() {
    const id = route.asset, d = assets[id];
    if (!d) return;
    const read = (f) => (d.kind === "pipeline" ? f.flows[id] : throughput(id, f.flows));
    const names = { pressure_bar: "Pressure (bar)", nomination_msm3d: "Nomination", booked_msm3d: "Booked" };
    const here = Object.keys(names).filter((m) => live.frames.some((f) => metric(m, id, f) != null));
    const rows = [];
    for (let i = live.index; i >= Math.max(0, live.index - 23); i--) {
      const f = live.frames[i];
      if (f) rows.push(h("tr", null, h("td", null, formatTime(f.t)), h("td", null, fmt(read(f), 2)), ...here.map((m) => h("td", null, fmt(metric(m, id, f), 2)))));
    }
    const upto = live.frames.slice(0, live.index + 1);
    const gaps = upto.filter((f) => read(f) == null).length;
    const lastSeen = [...upto].reverse().find((f) => read(f) != null);
    const stream = live.stream || {}, links = NORA.links || {};
    const file = `${d.kind === "node" ? "nodes" : "pipelines"}.csv`;
    screens.diag.replaceChildren(h("div", { class: "screen-body" },
      h("h1", null, `${d.name}: diagnostics`),
      h("p", { class: "sub" }, `Dataset: ${stream.title || "live feed"}${stream.synthetic ? " (synthetic)" : ""}.`),
      h("div", { class: "cols" },
        h("div", { class: "box" }, h("h2", null, "Data quality and sources"), h("dl", { class: "facts" },
          h("dt", null, "Last reading"), h("dd", null, lastSeen ? formatTime(lastSeen.t) : "None"),
          h("dt", null, "Readings missing"), h("dd", null, `${gaps} of ${upto.length}`),
          h("dt", null, "Model flow"), h("dd", null, d.modelFlow == null ? "–" : `${fmt(Math.abs(d.modelFlow), 1)} MSm³/d (max-flow model)`),
          h("dt", null, "Source of the asset"), h("dd", null, d.source && /^https?:\/\//.test(d.source) ? h("a", { href: d.source, target: "_blank", rel: "noopener" }, new URL(d.source).hostname) : d.source || "None recorded"),
          h("dt", null, "Data row"), h("dd", null, links.blob ? h("a", { href: `${links.blob}/data/${file}#L${d.line}`, target: "_blank", rel: "noopener" }, `${file} line ${d.line}`) : `${file} line ${d.line}`),
          h("dt", null, "Dataset source"), h("dd", null, stream.source || "–"))),
        h("div", { class: "box wide" }, h("h2", null, "Readings, newest first (MSm³/d unless noted)"),
          h("table", { class: "data" },
            h("thead", null, h("tr", null, h("th", null, "Time"), h("th", null, d.kind === "pipeline" ? "Flow" : "Throughput"), ...here.map((m) => h("th", null, names[m])))),
            h("tbody", null, rows))))));
  }

  // ------------------------------------------------------------------ navigation
  function hashFor(r) {
    return r.screen === "overview" ? "#/overview" : r.screen === "unit" ? `#/unit/${r.unit}` : `#/${r.screen}/${r.asset}`;
  }
  function go(next, push = true) {
    Object.assign(route, { focus: null }, next);
    if (route.screen === "unit" && !unitById[route.unit]) route.unit = "all";
    if (route.screen !== "unit") closeSidebar();
    const hash = hashFor(route);
    if (push && location.hash !== hash) history.pushState(null, "", `${location.pathname}${location.search}${hash}`);
    render();
  }
  function fromHash() {
    const [, screen, arg] = (location.hash || "").split("/");
    if (screen === "unit") return { screen: "unit", unit: unitById[arg] ? arg : "all" };
    if ((screen === "asset" || screen === "diag") && assets[arg]) return { screen, asset: arg };
    if (screen === "overview") return { screen: "overview" };
    return null;
  }
  addEventListener("popstate", () => go(fromHash() || { screen: "overview" }, false));

  function render() {
    const s = route.screen;
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== s;
    for (const [key, el] of Object.entries(containers)) el.hidden = !(s === "unit" && key === state.view);
    // The Map/Flow and mode tabs stay in the bar on every screen: one constant top bar.
    $("crumb-overview").setAttribute("aria-current", s === "overview" ? "page" : "false");
    const deep = s === "asset" || s === "diag";
    $("sep-asset").hidden = $("crumb-asset").hidden = !deep;
    $("sep-diag").hidden = $("crumb-diag").hidden = s !== "diag";
    if (deep) $("crumb-asset").replaceChildren(h("span", { class: "level" }, "3"), nameOf(route.asset));
    $("crumb-asset").setAttribute("aria-current", s === "asset" ? "page" : "false");
    $("crumb-diag").setAttribute("aria-current", s === "diag" ? "page" : "false");
    if (s === "unit") {
      const view = views[state.view];
      if (!view.mounted) { view.mounted = true; view.mount(containers[state.view]); }
      else view.resize();
      if (view.ready) {
        view.setUnit(route.unit);
        view.restyle();
        if (route.focus) { view.highlight(route.focus); view.focus(route.focus, true); }
      }
    }
    refreshScreens();
  }
  function refreshScreens() {
    if (route.screen === "overview") renderOverview();
    else if (route.screen === "asset") renderAsset();
    else if (route.screen === "diag") renderDiag();
    renderTop();
  }
  function renderTop() {
    if (state.mode === "whatif") { renderWhatif(); return; } // one chip, no layout change
    const counts = [3, 2, 1].map((l) => [l, live.conditions.filter((c) => c.level === l).length]).filter(([, n]) => n);
    $("alarm-counts").replaceChildren(...counts.map(([l, n]) => h("span", { title: `${n} ${LEVEL[l].toLowerCase()}` }, badge(l, String(n)))));
    const plan = frame().plan, chip = $("plan-chip");
    chip.hidden = false; // always there: the top bar never changes between modes or datasets
    if (!plan || !plan.nominated) {
      chip.replaceChildren(h("span", { class: "dim" }, "No plan to check"));
      chip.title = plan ? "No nominations at this hour. Opens the overview" : "This dataset has no exit-point nominations, so there is no plan to check. Opens the overview";
      return;
    }
    const [lvl, text] = plan.now, [aheadLvl, aheadText, , hours] = plan.ahead;
    chip.replaceChildren(...(lvl ? [badge(lvl, ""), h("span", null, text)]
      : aheadLvl ? [badge(Math.min(aheadLvl, 2), ""), h("span", null, `In ${fmt(hours)} h: ${aheadText}`)]
      : [h("span", { class: "dim" }, "✓ Plan holds")]));
    chip.title = "Open the overview";
  }

  // ------------------------------------------------------------------ key and settings
  function buildKey() {
    const sample = (color, w, dash = "") => svg("0 0 26 14", `<line x1="1" y1="7" x2="25" y2="7" stroke="${COLORS.text}" stroke-width="${w + 2}"${dash}/><line x1="1" y1="7" x2="25" y2="7" stroke="${color}" stroke-width="${w}"${dash}/>`);
    const item = (icon, text) => h("li", null, icon, h("span", null, text));
    const section = (title, wide, ...children) => h("section", { class: `key-section${wide ? " key-wide" : ""}` }, h("h3", null, title), ...children);
    const timeline = svg("0 0 280 58", `<path d="M9 9l7 5-7 5z" fill="${COLORS.text}"/><line x1="28" y1="28" x2="268" y2="28" stroke="${COLORS.text_dim}"/><line x1="148" y1="17" x2="148" y2="39" stroke="${COLORS.text}" stroke-width="2"/><circle cx="148" cy="28" r="4" fill="${COLORS.text}"/><g fill="${COLORS.text_dim}" font-size="11" font-family="Archivo, sans-serif"><text x="28" y="49">← History</text><text x="148" y="49" text-anchor="middle" fill="${COLORS.text}">Now</text><text x="268" y="49" text-anchor="end">Model →</text></g>`);
    const tag = (x, y) => `<rect x="${x}" y="${y}" width="40" height="15" rx="2" fill="${COLORS.card.active.fill}" stroke="${COLORS.card.active.edge}"/><text x="${x + 20}" y="${y + 11}" text-anchor="middle" fill="${COLORS.card.active.ink}" font-size="9.5" font-family="Archivo, sans-serif">82 bar</text>`;
    const flow = svg("0 0 280 96", `<line x1="6" y1="34" x2="54" y2="34" stroke="${COLORS.text_dim}"/><path d="M45 30l9 4-9 4z" fill="${COLORS.text_dim}"/>${tag(54, 27)}<rect x="94" y="0" width="72" height="72" rx="4" fill="${COLORS.card.active.fill}" stroke="${COLORS.card.active.edge}"/>${tag(166, 27)}<line x1="206" y1="34" x2="274" y2="34" stroke="${COLORS.text_dim}"/><path d="M265 30l9 4-9 4z" fill="${COLORS.text_dim}"/><polyline points="102,62 112,58 122,60 130,54 138,56" fill="none" stroke="${COLORS.card.active.ink}" stroke-width="1.2"/><polyline points="138,56 148,55 158,55" fill="none" stroke="${COLORS.card.active.ink}" stroke-width="1.2" stroke-dasharray="3 2"/><g font-size="10" font-family="Archivo, sans-serif"><text x="160" y="14" text-anchor="end" fill="${COLORS.card.active.dim}">▼ 0.4/h</text></g><g font-size="11" font-family="Archivo, sans-serif" text-anchor="middle"><text x="113" y="38" fill="${COLORS.card.active.dim}">34M</text><text x="147" y="38" fill="${COLORS.card.active.ink}">34M</text><text x="130" y="88" fill="${COLORS.text}">Asset</text></g>`);
    const exit = svg("0 0 280 30", `<line x1="65" y1="14" x2="215" y2="14" stroke="${COLORS.text_dim}"/><line x1="105" y1="7" x2="105" y2="21" stroke="${COLORS.text_dim}"/><line x1="175" y1="7" x2="175" y2="21" stroke="${COLORS.text_dim}"/><line x1="145" y1="4" x2="145" y2="24" stroke="${COLORS.text}" stroke-width="3"/><g fill="${COLORS.text_dim}" font-size="11" font-family="Archivo, sans-serif"><text x="65" y="28">min</text><text x="140" y="28" fill="${COLORS.text}">now</text><text x="202" y="28">max</text></g>`);
    $("key").replaceChildren(
      h("button", { type: "button", class: "text close", onclick: closeGuide }, "Close"),
      h("div", { class: "key-grid" },
        section("Controls", true, timeline,
          h("ul", { class: "key-notes" },
            item(h("span", null, "▶"), "Play / scrub"),
            item(h("span", null, "↗"), "Click for details"),
            item(h("span", null, "⌁"), "What-if: click offline"),
            item(h("span", null, "⋯"), "Right-click: add, connect or remove"))),
        section("Moving", false, h("ul", null,
          item(svg("0 0 26 14", `<path d="M17 7l-8-4.5v9z" fill="${COLORS.pig}" stroke="${COLORS.casing}"/>`), "Pig"),
          item(svg("0 0 26 14", `<line x1="3" y1="7" x2="23" y2="7" stroke="${COLORS.peak}" stroke-width="4"/><circle cx="13" cy="7" r="5" fill="${COLORS.peak}" stroke="${COLORS.casing}"/>`), "Peak"),
          item(svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.h2s}" stroke="${COLORS.casing}"/>`), "H₂S · ppm"),
          item(svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.co2}" stroke="${COLORS.casing}"/>`), "CO₂ · mol %"))),
        section("Status", false, h("ul", null,
          ...[3, 2, 1].map((l) => item(badge(l), ["", "Watch", "Medium", "Act now"][l])),
          item(sample(COLORS.active, 3), "Active"),
          item(sample(COLORS.normal, 3), "Normal"),
          item(sample(COLORS.inactive, 3), "Inactive"),
          item(sample(COLORS.inactive, 1.5, ' stroke-dasharray="3 3"'), "No data"))),
        section("Flow", true, flow, h("p", { class: "key-caption" }, "Flow in MSm³/d: incoming faint, outgoing full · line ends: pressure"), exit, h("p", { class: "key-caption" }, "Exit delivery")),
        section("Indicators", true, rangeBar({ min: 0, max: 10, value: 6, band: [3, 7], ticks: [{ at: 1.5, level: 3 }, { at: 8.5, level: 3 }], target: 5 }),
          h("p", { class: "key-caption" }, "Band: normal · ◇ target · pointer: now"),
          h("p", { class: "key-caption" }, "Solid: history · dashed: model"))));
  }
  function storedFlag(key) { try { return localStorage.getItem(key); } catch (error) { return "1"; } }
  function openGuide() {
    $("key").hidden = false;
    $("key-toggle").setAttribute("aria-expanded", "true");
    try { localStorage.setItem("nora-guide-seen", "1"); } catch (error) { /* private window */ }
  }
  function closeGuide() {
    $("key").hidden = true;
    $("key-toggle").setAttribute("aria-expanded", "false");
  }
  function buildSettings() {
    const check = (label, key) => h("label", null, h("input", { type: "checkbox", checked: settings[key] ? "" : null, onchange: (e) => update({ [key]: e.target.checked }) }), label);
    const choose = (label, key, options) => h("div", { class: "row" }, h("span", null, label),
      h("select", { onchange: (e) => update({ [key]: e.target.value }) }, options.map(([v, t]) => h("option", { value: v, selected: settings[key] === v ? "" : null }, t))));
    $("settings").replaceChildren(
      h("h3", null, "Labels"),
      check("Asset names and values", "names"),
      choose("Values on lines", "lineValues", [["auto", "Auto"], ["on", "Always"], ["off", "Never"]]),
      h("h3", null, "Show"),
      ...Object.keys(NORA.nodeTypes).map((type) => h("label", null,
        h("input", { type: "checkbox", checked: settings.hide.includes(type) ? null : "",
          onchange: (e) => update({ hide: e.target.checked ? settings.hide.filter((t) => t !== type) : [...settings.hide, type] }) }),
        NORA.nodeTypes[type])),
      check("Notional grid entries", "gridEntries"),
      h("h3", null, "Flow view"),
      choose("Direction", "direction", [["vertical", "Top to bottom"], ["horizontal", "Left to right"], ["auto", "Follow the screen"]]),
      choose("Spacing", "density", [["compact", "Compact"], ["comfortable", "Comfortable"], ["spacious", "Spacious"]]),
      check("Flow bands in and out of the nodes", "animation"),
      h("h3", null, "Display"),
      choose("Screen", "display", [["auto", `Auto (${autoProfile(window.innerWidth)})`], ["desk", "Operator desk"], ["wall", "Video wall"], ["compact", "Tablet or phone"]]),
      choose("Size", "scale", [["auto", `Auto (${Math.round(autoScaleFor(chosenProfile()) * 100)} %)`],
        ...["1", "1.25", "1.5", "1.75", "2"].map((v) => [v, `${Number(v) * 100} %`])]),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "text", onclick: copyLink }, "Copy link"),
        h("button", { type: "button", class: "text", title: "Open this screen in its own window, for another monitor", onclick: () => window.open(location.href, "_blank", "noopener") }, "New window"),
        h("button", { type: "button", class: "text", onclick: () => update({ ...DEFAULT_SETTINGS }) }, "Reset")),
      h("p", { class: "dim", style: "margin:8px 0 0" }, "Defaults come from nora.toml in the repository."));
  }
  function update(changes) {
    settings = { ...settings, ...changes };
    saveSettings();
    const resized = applyDisplay();
    buildSettings();
    for (const view of Object.values(views)) if (view.ready && view.applySettings) view.applySettings();
    if (resized) displayChanged();
    restyle();
  }
  // After the profile or scale changed: the stage has a new size, so re-fit and redraw.
  function displayChanged() {
    const view = current();
    if (view && view.mounted) view.resize();
    drawSpark();
  }
  function copyLink() {
    const url = new URL(location.href);
    url.searchParams.set("s", btoa(JSON.stringify(settings)));
    if (navigator.clipboard) navigator.clipboard.writeText(url.toString());
  }
  for (const [button, panel] of [["key-toggle", "key"], ["settings-toggle", "settings"]]) {
    $(button).addEventListener("click", (event) => {
      const open = $(panel).hidden;
      $("key").hidden = $("settings").hidden = true;
      $("key-toggle").setAttribute("aria-expanded", "false");
      $("settings-toggle").setAttribute("aria-expanded", "false");
      $(panel).hidden = !open;
      event.currentTarget.setAttribute("aria-expanded", String(open));
    });
  }

  // ------------------------------------------------------------------ player
  function prepare(stream) {
    const columns = stream.assets.map(() => []);
    let maxAbs = 0;
    const metricNames = Object.keys(stream.metrics || {});
    stream.frames = stream.times.map((t, i) => {
      const flows = {};
      stream.assets.forEach((id, j) => {
        const v = stream.values[i][j];
        if (v == null) return;
        flows[id] = v;
        columns[j].push(Math.abs(v));
        maxAbs = Math.max(maxAbs, Math.abs(v));
      });
      const metrics = {};
      for (const name of metricNames) {
        const block = stream.metrics[name], values = {};
        block.assets.forEach((id, j) => { const v = block.values[i][j]; if (v != null) values[id] = v; });
        metrics[name] = values;
      }
      return { t, flows, metrics, plan: stream.plan ? stream.plan[i] : null };
    });
    stream.typical = {};
    stream.assets.forEach((id, j) => {
      const sorted = columns[j].sort((a, b) => a - b);
      stream.typical[id] = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    });
    stream.maxAbs = maxAbs || 1;
    stream.step = stream.times.length > 1 ? stream.times[1] - stream.times[0] : 3600;
    return stream;
  }
  const scrub = $("scrub"), spark = $("spark");
  /* "Now" in the middle of the timeline (Ray: "the middle of the timeline bar should be
     real time, while dragging to the right means looking into the future and modelled
     pressures and flows"). A synthetic stream is re-timed once when it loads, by whole
     days so its hours of the day and gas days stay true, to put the wall-clock now as
     near its middle as whole days allow. Left of now is history, right of it the model
     looking ahead, and the player says which. Recorded real data keeps its own dates:
     all of it is history. The built page holds no wall-clock time; this runs in the
     browser. [screen] now_in_middle = false plays synthetic data at its own dates. */
  const DAY = 86400, NOW_SLACK = 300; // within 5 minutes of the wall clock reads as now
  const wallClock = () => Date.now() / 1000;
  function retime(stream) {
    if (stream.offset != null || !stream.synthetic || C.screen.now_in_middle === false || stream.times.length < 2) return;
    const middle = (stream.times[0] + stream.times[stream.times.length - 1]) / 2;
    const offset = Math.round((wallClock() - middle) / DAY) * DAY;
    stream.offset = offset;
    stream.times = stream.times.map((t) => t + offset);
    for (const event of stream.events || []) { event.start += offset; event.end += offset; }
    for (const pig of stream.pigs || []) pig.launch += offset;
  }
  // Where the wall clock falls in a re-timed stream, as a playhead position; else null.
  function nowPosition(s = live.stream) {
    if (!s || live.feed || s.offset == null) return null;
    return (wallClock() - s.times[0]) / s.step;
  }
  /* The playhead against the wall clock: seconds ahead of now, and whether what is
     shown is the model's. Null for recorded data and live feeds. */
  function timeState() {
    if (nowPosition() == null || live.time == null) return null;
    const ahead = live.time - wallClock();
    return { ahead, model: ahead > NOW_SLACK };
  }
  const spanText = (seconds) => {
    const s = Math.abs(seconds);
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.round(s / 3600)} h`;
  };
  function timeText(ts) {
    if (!ts) return "";
    if (Math.abs(ts.ahead) <= NOW_SLACK) return "Now";
    return ts.model ? `Model · in ${spanText(ts.ahead)}` : `${spanText(ts.ahead)} ago`;
  }
  // The chip beside the clock, and a page-wide class so model numbers read as such.
  function showTime() {
    const ts = timeState(), when = $("when");
    if (live.feed) {
      when.hidden = !live.stale;
      when.textContent = live.stale ? "Stale" : "";
      when.title = live.stale ? live.stale.text : "";
      when.classList.toggle("model", Boolean(live.stale));
      return;
    }
    when.hidden = !ts;
    when.textContent = timeText(ts);
    when.classList.toggle("model", Boolean(ts && ts.model));
    document.body.classList.toggle("model-time", Boolean(ts && ts.model));
  }
  function setStream(stream) {
    retime(stream);
    live.stream = prepare(stream);
    live.frames = stream.frames;
    live.typical = stream.typical;
    live.maxAbs = stream.maxAbs;
    const speeds = [...$("speed").options].map((o) => Number(o.value));
    live.speed = speeds.includes(Number(settings.speed))
      ? Number(settings.speed)
      : speeds.includes(C.screen.speed) ? C.screen.speed : speeds[0];
    $("speed").value = String(live.speed);
    scrub.min = String(-4 * 3600);
    scrub.max = String(4 * 3600);
    scrub.step = "3600";
    scrub.value = "0";
    const retimed = stream.offset != null;
    $("tl-past").textContent = "−4 h";
    $("tl-now").textContent = "Real time · UTC";
    $("tl-future").textContent = "+4 h";
    seek(retimed ? nowPosition() : 0); // synthetic data opens at now; recordings keep their start
  }
  function seek(position) {
    const s = live.stream;
    live.playhead = Math.max(0, Math.min(s.times.length - 1, position));
    live.index = Math.floor(live.playhead);
    live.down = {};
    live.peaks = [];
    pigRoutes.clear();
    replayQuality(live.index);
    trackTrips(frame());
    step();
  }
  function valuesAt(position) {
    const s = live.stream, i = Math.floor(position), f = position - i;
    const a = s.frames[i].flows, b = s.frames[Math.min(i + 1, s.frames.length - 1)].flows;
    if (!f) return a;
    const out = {};
    for (const [id, v] of Object.entries(a)) out[id] = b[id] === undefined ? v : v + (b[id] - v) * f;
    return out;
  }
  // Whenever the playhead moves: values, conditions, then every screen.
  function step() {
    if (live.stream && !live.feed) {
      live.values = valuesAt(live.playhead);
      live.time = live.stream.times[live.index] + (live.playhead - live.index) * live.stream.step;
      scrub.value = "0"; // the selected real time remains at the centre of the window
    }
    prunePeaks();
    advanceQuality();
    evaluate();
    if (live.time != null) $("clock").textContent = formatTime(live.time);
    showTime();
    restyle();
    refreshScreens();
    if ((side.id || side.marker) && route.screen === "unit") renderSidebar();
    drawSpark();
  }
  // The selected time is the real-time centre of an eight-hour window: four hours of
  // history on the left and four hours ahead on the right.
  function timelineWindow() {
    const now = live.time == null ? 0 : live.time;
    return { start: now - 4 * 3600, now, end: now + 4 * 3600 };
  }
  // The track shows plan status and events within that moving eight-hour window.
  function drawSpark() {
    if ($("player").hidden) return;
    // The player is zoomed by the UI scale: draw at that resolution, or the track blurs.
    const ratio = (window.devicePixelRatio || 1) * display.scale, width = spark.clientWidth, height = spark.clientHeight;
    if (!width) return;
    spark.width = width * ratio;
    spark.height = height * ratio;
    const ctx = spark.getContext("2d");
    ctx.scale(ratio, ratio);
    const frames = live.frames, n = frames.length;
    if (n < 2) return;
    const window8h = timelineWindow(), x = (t) => ((t - window8h.start) / (8 * 3600)) * width, mid = height / 2;
    ctx.fillStyle = COLORS.dots;
    ctx.fillRect(0, mid - 3, width / 2, 6);
    ctx.globalAlpha = 0.45;
    ctx.fillRect(width / 2, mid - 3, width / 2, 6);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = COLORS.text_dim;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(width / 2, mid - 3.5); ctx.lineTo(width, mid - 3.5);
    ctx.moveTo(width / 2, mid + 3.5); ctx.lineTo(width, mid + 3.5);
    ctx.stroke();
    ctx.setLineDash([]);
    frames.forEach((f) => {
      const lvl = f.plan ? f.plan.now[0] : 0;
      if (!lvl || f.t < window8h.start || f.t > window8h.end) return;
      ctx.fillStyle = LEVEL_COLOR[lvl];
      ctx.fillRect(x(f.t), mid - 6, Math.max(1.5, ((live.stream ? live.stream.step : 3600) / (8 * 3600)) * width), 12);
    });
    for (const event of (live.stream && live.stream.events) || []) {
      if (event.end < window8h.start || event.start > window8h.end) continue;
      const left = Math.max(0, x(event.start)), right = Math.min(width, x(event.end));
      ctx.strokeStyle = COLORS.text;
      ctx.setLineDash(event.planned ? [3, 2] : []);
      ctx.strokeRect(left, mid - 8, Math.max(2, right - left), 16);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(width / 2 - 1, 0, 2, height);
  }
  function play() {
    if (!live.stream && !live.feed) return;
    live.playing = true;
    document.body.classList.add("playing");
    $("play").setAttribute("aria-label", "Pause");
  }
  function pause() {
    live.playing = false;
    document.body.classList.remove("playing");
    $("play").setAttribute("aria-label", "Play");
  }
  $("play").addEventListener("click", () => (live.playing ? pause() : play()));
  scrub.addEventListener("input", () => {
    if (!live.stream || live.feed) return;
    const offset = Number(scrub.value); // seconds left/right of the real-time centre
    scrub.value = "0";
    if (offset) seek(live.playhead + offset / live.stream.step);
  });
  $("speed").addEventListener("change", (e) => {
    live.speed = Number(e.target.value);
    settings.speed = live.speed;  // remembered with the other settings, and in ?s= links
    saveSettings();
  });
  $("stream-select").addEventListener("change", (e) => setStream(NORA.streams.find((s) => s.name === e.target.value)));

  let lastTick = 0, lastStep = 0;
  function tick(now) {
    frameApi.end(); // a draw that threw must not leave the cache on
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;
    if (live.playing) {
      live.clock += dt;
      if (live.stream && !live.feed) {
        const s = live.stream;
        live.playhead += (dt * live.speed) / s.step;
        if (live.playhead >= s.times.length - 1) seek(0);
        const i = Math.floor(live.playhead);
        if (i !== live.index) {
          const previous = live.frames[live.index];
          for (let k = live.index + 1; k <= i; k++) spawnQuality(live.frames[k - 1], live.frames[k]);
          live.index = i;
          trackTrips(frame());
          spawnPeaks(previous, frame());
        }
        live.time = s.times[live.index] + (live.playhead - live.index) * s.step;
        if (now - lastStep > 250) { lastStep = now; step(); }
      }
    } else if (now - lastStep > 30000) {
      // Paused, the wall clock still moves: keep "Now" / "3 h ago" and the now tick true.
      lastStep = now;
      showTime();
      drawSpark();
    }
    // A feed that goes quiet without an error is stale too: three missed frames, at least a minute.
    if (live.feed && !live.stale && live.frameGap && Date.now() - live.lastFrameWall > Math.max(60000, 3 * live.frameGap)) {
      feedTrouble(`No new data for ${spanText((Date.now() - live.lastFrameWall) / 1000)}`);
    }
    const view = current();
    if (route.screen === "unit" && view && view.ready) view.draw();
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ live feed
  function connectFeed(url) {
    live.feed = new EventSource(url);
    live.stream = null;
    document.body.classList.add("feed-mode");
    const select = $("stream-select");
    select.replaceChildren(h("option", null, "Connecting to the live feed"));
    select.disabled = true;
    $("speed").parentElement.hidden = true;
    $("tl-past").textContent = "Live feed";
    $("tl-future").textContent = "UTC";
    live.feed.addEventListener("meta", (message) => {
      const meta = JSON.parse(message.data);
      live.feedEvents = meta.events || [];
      live.feedPigs = meta.pigs || [];
      select.replaceChildren(h("option", null, `${meta.title || "Live feed"} (live)`));
    });
    live.feed.addEventListener("frame", (message) => receiveFrame(JSON.parse(message.data)));
    /* `error` is both the server's own event (it could not read its source: the data
       says why) and the browser's (the connection dropped; it reconnects by itself). */
    live.feed.addEventListener("error", (event) => {
      let text = "Connection to the live feed lost; reconnecting";
      if (event && typeof event.data === "string") {
        try { const d = JSON.parse(event.data); text = `${d.source || "Live source"}: ${d.error || "no data"}`; } catch (error) { /* keep the general text */ }
      }
      feedTrouble(text);
    });
  }
  /* One frame from the live feed. Frames must rise in time: routes, the gas day's
     delivery and peaks all assume it. A frame older than the last one means the feed
     started over (a replay looped, or the server restarted and the browser
     reconnected), so a new timeline begins; one with the same time replaces it. */
  function receiveFrame(f) {
    const last = live.frames[live.frames.length - 1], entry = { t: f.t, flows: f.values, metrics: f.metrics || {}, plan: f.plan || null };
    if (last && f.t < last.t) {
      live.frames = []; live.peaks = []; live.quality = []; live.slugs = new Map(); live.down = {};
      pigRoutes.clear();
    }
    for (const [id, v] of Object.entries(f.values)) {
      live.typical[id] = Math.max((live.typical[id] || 0) * 0.995, Math.abs(v));
      live.maxAbs = Math.max(live.maxAbs, Math.abs(v));
    }
    const wall = Date.now();
    if (live.lastFrameWall) live.frameGap = wall - live.lastFrameWall;
    live.lastFrameWall = wall;
    live.stale = null; // fresh data
    const same = last && live.frames.length && f.t === last.t;
    const previous = same ? null : live.frames[live.frames.length - 1];
    if (same) live.frames[live.frames.length - 1] = entry;
    else live.frames.push(entry);
    if (live.frames.length > 240) live.frames.shift();
    live.index = live.frames.length - 1;
    live.values = f.values;
    live.time = f.t;
    trackTrips(frame());
    if (previous) { spawnPeaks(previous, frame()); spawnQuality(previous, frame()); }
    if (!live.playing) play();
    step();
  }
  /* The feed is in trouble: the last frame stays on screen, marked stale and raised
     as an alarm, never passed off as live data. */
  function feedTrouble(text) {
    if (live.stale && live.stale.text === text) return;
    live.stale = { text, since: live.lastFrameWall || Date.now() };
    step();
  }

  // ------------------------------------------------------------------ start
  const byName = {};
  for (const id of [...nodeIds, ...pipeIds]) byName[nameOf(id).toLowerCase()] = id;
  $("asset-names").replaceChildren(...Object.keys(byName).sort().map((n) => h("option", { value: nameOf(byName[n]) })));
  $("search").addEventListener("change", (e) => {
    const id = byName[e.target.value.trim().toLowerCase()];
    if (id) { e.target.value = ""; go({ screen: "asset", asset: id }); }
  });
  function setTheme(next) {
    theme = next;
    try { localStorage.setItem("nora-theme", theme); } catch (error) { /* private mode */ }
    applyPalette();
    buildKey();
    buildSettings();
    for (const view of Object.values(views)) if (view.mounted && view.theme) view.theme(theme);
    refreshScreens();
    drawSpark();
  }
  /* Right-click menu: the same actions everywhere, on the Map and in the Flow.
     openMenu places it inside the viewport; any click, Esc or resize closes it. */
  const menu = { el: null };
  function closeMenu() { if (menu.el) { menu.el.remove(); menu.el = null; } }
  function openMenu(x, y, items) {
    closeMenu();
    if (!items.length) return;
    const el = h("div", { class: "ctx-menu", role: "menu" },
      ...items.map((it) => it === "-"
        ? h("div", { class: "rule" })
        : h("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); it.act(); } }, it.label)));
    // The menu is zoomed by the UI scale, so its position is in zoomed pixels.
    const k = display.scale;
    el.style.left = Math.max(8, Math.min(x, innerWidth - 240 * k)) / k + "px"; // min-width 220 + padding
    el.style.top = Math.max(8, Math.min(y, innerHeight - (10 + items.length * 32) * k)) / k + "px";
    document.body.append(el);
    menu.el = el;
  }
  /* One builder for the actions on an asset, so both views offer the same menu. */
  function menuFor(id, ctx = {}) {
    if (!id || !assets[id]) return [];
    const d = assets[id], items = [];
    items.push({ label: "Open details", act: () => { if (route.screen === "unit") openSidebar(id); else go({ screen: "asset", asset: id }); } });
    if (ctx.center) items.push({ label: "Centre here", act: ctx.center });
    if (ctx.coords) items.push({ label: `Copy position (${ctx.coords})`, act: () => { if (navigator.clipboard) navigator.clipboard.writeText(ctx.coords); } });
    items.push("-");
    if (d.kind === "node") items.push({
      label: whatif.offline.has(id) ? "Restore in the what-if" : "Take offline in the what-if",
      act: () => { if (state.mode !== "whatif") { state.mode = "whatif"; markTabs(); restyle(); } toggleOffline(id); renderSidebar(); renderWhatif(); },
    });
    items.push({ label: "Open the full page", act: () => go({ screen: "asset", asset: id }) });
    if (d.kind === "node") items.push({ label: "Diagnostics", act: () => go({ screen: "diag", asset: id }) });
    if (!embed) {
      items.push("-");
      if (d.kind === "node" && ctx.connect) items.push({ label: "Connect to another node…", act: ctx.connect });
      items.push(d.kind === "node"
        ? { label: "Remove from the network", act: () => commitEdit({ op: "removeNode", id }) }
        : { label: "Remove this line", act: () => commitEdit({ op: "removeLine", id }) });
    }
    return items;
  }

  // ------------------------------------------------------------------ editing the network
  /* The edits themselves are at the top (applyEdit): here are the right-click actions,
     the forms for a new node or line, and the bar that lists the changes with Undo,
     Save and Discard. An edit reloads the page with the view kept, so every index is
     rebuilt from the edited NORA. */
  const slug = (text) => text.toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
  function uniqueId(name) {
    const base = slug(name);
    let id = base;
    for (let n = 2; assets[id]; n++) id = `${base}_${n}`;
    return id;
  }
  function reloadKeepingView() {
    try {
      const flow = views.flow && views.flow.ready && views.flow.viewport ? views.flow.viewport() : null;
      sessionStorage.setItem("nora-restore", JSON.stringify({ view: state.view, mode: state.mode, flow }));
    } catch (error) { /* a plain reload then */ }
    if (location.reload) location.reload();
  }
  function takeRestore() {
    try {
      const restore = JSON.parse(sessionStorage.getItem("nora-restore") || "null");
      sessionStorage.removeItem("nora-restore");
      return restore;
    } catch (error) { return null; }
  }
  let restored = null; // read once at start; the Flow view takes its viewport
  function commitEdit(step) {
    edits.push(step);
    if (!storeEdits(edits)) { edits.pop(); editNote("This browser does not keep edits: its storage is blocked."); return; }
    reloadKeepingView();
  }
  /* A node dragged in the Flow view: its new place, kept like any edit but without a
     reload (only the drawing moves). Dragging the same node again updates that step. */
  function commitMove(id, grid) {
    const last = edits[edits.length - 1], step = { op: "moveNode", id, grid };
    if (last && last.op === "moveNode" && last.id === id) edits[edits.length - 1] = step;
    else edits.push(step);
    NORA.grid[id] = grid;
    storeEdits(edits);
    confirmDiscard = false;
    renderEditsBar();
  }
  function undoEdit() { edits.pop(); storeEdits(edits); reloadKeepingView(); }
  function discardEdits() { edits.length = 0; storeEdits(edits); reloadKeepingView(); }

  function openForm(title, sub, form) {
    side.id = null;
    side.marker = null;
    side.form = true;
    $("side-title").textContent = title;
    $("side-sub").textContent = sub;
    $("side-body").replaceChildren(form);
    $("asset-side").classList.add("open");
    $("asset-side").setAttribute("aria-hidden", "false");
    const first = form.querySelector && form.querySelector("input");
    if (first && first.focus) first.focus();
  }
  const field = (label, input, hint) => h("label", { class: "field" }, h("span", null, label), input, hint ? h("small", null, hint) : null);
  const formActions = (submit) => h("div", { class: "actions" },
    h("button", { type: "submit", class: "primary" }, submit),
    h("button", { type: "button", onclick: closeSidebar }, "Cancel"));
  /* A new node where the Flow view was right-clicked (`grid`: its stage and rank). The
     nearest node lends its unit, country and position as a start: the Map needs real
     coordinates, so they are asked for. */
  function openNodeForm({ grid, near }) {
    const anchor = near && assets[near];
    const name = h("input", { name: "name", autocomplete: "off", placeholder: "e.g. Snorre" });
    const type = h("select", { name: "type" }, ...Object.entries(NORA.nodeTypes).map(([key, label]) => h("option", { value: key }, label)));
    const unit = h("select", { name: "unit" }, ...NORA.units.map((u) => h("option", { value: u.id }, u.name)));
    if (anchor) unit.value = unitOf[near] || NORA.units[0].id;
    const lat = h("input", { name: "lat", type: "number", step: "0.001" });
    const lon = h("input", { name: "lon", type: "number", step: "0.001" });
    const country = h("input", { name: "country", maxlength: "2" });
    lat.value = anchor ? anchor.lat.toFixed(3) : "";
    lon.value = anchor ? anchor.lon.toFixed(3) : "";
    country.value = anchor ? anchor.country : "NO";
    const capacity = h("input", { name: "capacity", type: "number", step: "0.1", min: "0", placeholder: "MSm³/d" });
    const note = h("p", { class: "form-note", role: "alert" });
    const form = h("form", {
      class: "edit-form",
      onsubmit: (event) => {
        event.preventDefault();
        const node = {
          name: name.value.trim(), type: type.value, unit: unit.value, country: country.value.trim().toUpperCase(),
          lat: Number(lat.value), lon: Number(lon.value), capacity: capacity.value === "" ? null : Number(capacity.value), grid,
        };
        const problem = !node.name ? "Give the node a name."
          : lat.value === "" || !(node.lat >= -90 && node.lat <= 90) ? "Latitude is in °N, from -90 to 90."
          : lon.value === "" || !(node.lon >= -180 && node.lon <= 180) ? "Longitude is in °E (west is negative), from -180 to 180."
          : !/^[A-Z]{2}$/.test(node.country) ? "The country is two letters, such as NO or GB."
          : NORA.supplyTypes.includes(node.type) && !(node.capacity > 0) ? `${NORA.nodeTypes[node.type]}: give its capacity in MSm³/d.`
          : null;
        if (problem) { note.textContent = problem; return; }
        commitEdit({ op: "addNode", node: { id: uniqueId(node.name), ...node } });
      },
    },
    field("Name", name), field("Type", type), field("Unit", unit),
    h("div", { class: "field-pair" }, field("Latitude °N", lat), field("Longitude °E", lon, "West is negative")),
    h("div", { class: "field-pair" }, field("Country", country), field("Capacity MSm³/d", capacity, "Needed for fields")),
    note, formActions("Add node"));
    openForm("New node", anchor ? `Placed near ${anchor.name}; connect it with a right-click` : "Connect it with a right-click", form);
  }
  // A new line between two nodes (from the Flow view's "Connect to another node…").
  function openLineForm(from, to) {
    const name = h("input", { name: "name", autocomplete: "off" });
    name.value = `${nameOf(from)} – ${nameOf(to)}`;
    const type = h("select", { name: "type" }, ...Object.entries(NORA.pipelineTypes).map(([key, label]) => h("option", { value: key }, label)));
    type.value = "feeder";
    const capacity = h("input", { name: "capacity", type: "number", step: "0.1", min: "0", placeholder: "MSm³/d" });
    const twoWay = h("input", { name: "bidirectional", type: "checkbox" });
    const note = h("p", { class: "form-note", role: "alert" });
    const existing = pipeIds.find((pid) => [assets[pid].from, assets[pid].to].sort().join() === [from, to].sort().join());
    if (existing) note.textContent = `${nameOf(existing)} already joins these two.`;
    const form = h("form", {
      class: "edit-form",
      onsubmit: (event) => {
        event.preventDefault();
        const line = { name: name.value.trim(), from, to, type: type.value, capacity: capacity.value === "" ? null : Number(capacity.value), bidirectional: twoWay.checked };
        if (!line.name) { note.textContent = "Give the line a name."; return; }
        if (from === to) { note.textContent = "A line joins two different nodes."; return; }
        commitEdit({ op: "addLine", line: { id: uniqueId(line.name), ...line } });
      },
    },
    field("Name", name), field("Type", type), field("Capacity MSm³/d", capacity, "Leave empty if unknown"),
    h("label", { class: "field check" }, twoWay, h("span", null, "Gas can flow both ways")),
    note, formActions("Add line"));
    openForm("New line", `${nameOf(from)} to ${nameOf(to)}`, form);
  }

  /* The data files with the edits in: the rows nobody touched stay exactly as they are
     (NORA.sources is the files as built), removed rows go, new rows are appended. */
  const csvField = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  function editedCsv(name, kind, row) {
    const source = NORA.sources[name] || "";
    const lines = source.split(/\r?\n/), header = lines[0].split(",");
    const kept = lines.slice(1).filter((line) => line.trim() && assets[line.split(",")[0]] && assets[line.split(",")[0]].kind === kind);
    const added = Object.keys(assets).filter((id) => assets[id].kind === kind && assets[id].edited)
      .map((id) => header.map((column) => csvField(row(id)[column])).join(","));
    return [lines[0], ...kept, ...added].join("\n") + "\n";
  }
  const nodeRow = (id) => {
    const d = assets[id];
    return { id, name: d.name, type: d.type, country: d.country, lat: d.lat, lon: d.lon, operator: "", capacity_msm3d: d.capacity,
      status: "operating", startup: null, shutdown: null, source: "", notes: "Added in the NORA editor" };
  };
  const lineRow = (id) => {
    const d = assets[id];
    return { id, name: d.name, from: d.from, to: d.to, type: d.type, length_km: null, diameter_in: null, capacity_msm3d: d.capacity,
      bidirectional: d.bidirectional ? "true" : "false", commissioned: null, status: "operating", operator: "", source: "", notes: "Added in the NORA editor" };
  };
  function editedUnits() {
    const source = NORA.sources["units.toml"] || "", start = source.indexOf("[units.");
    const head = start >= 0 ? source.slice(0, start) : "";
    const list = (ids) => { // one line when it fits, else wrapped as the file is (edit.py)
      const items = ids.map((n) => JSON.stringify(n)), line = `nodes = [${items.join(", ")}]`;
      if (line.length <= 100) return line;
      const rows = [];
      let row = "   ";
      for (const item of items) {
        if (row.length + item.length + 2 > 92) { rows.push(row.trimEnd()); row = "   "; }
        row += ` ${item},`;
      }
      rows.push(row.trimEnd());
      return `nodes = [\n${rows.join("\n")}\n]`;
    };
    return head + NORA.units.map((u) => `[units.${u.id}]\nname = ${JSON.stringify(u.name)}\n${list(u.nodes)}\n`).join("\n");
  }
  /* flow_layout.toml: the lines of moved and added nodes rewritten (or added), those of
     removed nodes dropped, everything else as it was (edit.edit_layout does the same). */
  function editedLayout() {
    let text = NORA.sources["flow_layout.toml"] || "[positions]\n";
    const at = (id) => `${id} = [${NORA.grid[id][1]}, ${NORA.grid[id][0]}]`;
    const line = (id) => new RegExp(`^${id} = \\[[^\\]]*\\][^\\n]*\\n?`, "m");
    for (const step of edits) {
      const id = step.op === "moveNode" ? step.id : step.op === "addNode" ? step.node.id : null;
      if (step.op === "removeNode") text = text.replace(line(step.id), "");
      else if (id && assets[id]) text = line(id).test(text) ? text.replace(line(id), `${at(id)}\n`) : `${text.replace(/\n*$/, "\n")}${at(id)}\n`;
    }
    return text;
  }
  const editedFiles = () => ({
    "nodes.csv": editedCsv("nodes.csv", "node", nodeRow), "pipelines.csv": editedCsv("pipelines.csv", "pipeline", lineRow),
    "units.toml": editedUnits(), "flow_layout.toml": editedLayout(),
  });
  // The full network for `nora serve --edit` (POST api/save): its rows, with the edits.
  function editedNetwork(current) {
    let nodeRows = current.nodes.slice(), lineRows = current.pipelines.slice();
    const units = {};
    for (const step of edits) {
      if (step.op === "removeNode") {
        nodeRows = nodeRows.filter((n) => n.id !== step.id);
        lineRows = lineRows.filter((p) => p.from !== step.id && p.to !== step.id);
      } else if (step.op === "removeLine") lineRows = lineRows.filter((p) => p.id !== step.id);
      else if (step.op === "addNode" && assets[step.node.id]) { nodeRows.push(nodeRow(step.node.id)); units[step.node.id] = unitOf[step.node.id]; }
      else if (step.op === "addLine" && assets[step.line.id]) lineRows.push(lineRow(step.line.id));
    }
    for (const id of Object.keys(units)) if (!nodeRows.some((n) => n.id === id)) delete units[id];
    const layout = {}; // [across, down] of every node added or moved
    for (const step of edits) {
      const id = step.op === "moveNode" ? step.id : step.op === "addNode" ? step.node.id : null;
      if (id && NORA.grid[id] && nodeRows.some((n) => n.id === id)) layout[id] = [NORA.grid[id][1], NORA.grid[id][0]];
    }
    return { revision: current.revision, nodes: nodeRows, pipelines: lineRows, units, layout };
  }
  /* Save: served by `nora serve --edit` (make edit), the edits go straight into data/
     and the site rebuilds; anywhere else (a file, GitHub Pages) the three files download,
     ready to put in data/ and commit. */
  async function saveEdits() {
    editNote("Saving…");
    let current = null;
    try {
      const response = await fetch("api/network", { cache: "no-store" });
      if (response.ok) current = await response.json();
    } catch (error) { current = null; }
    if (!current) { downloadEdits(); return; }
    try {
      const response = await fetch("api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editedNetwork(current)) });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.saved) { edits.length = 0; storeEdits(edits); reloadKeepingView(); return; }
      editNote(`Not saved: ${(result.problems || [result.error || response.statusText]).join("; ")}`);
    } catch (error) { editNote(`Not saved: ${error.message}`); }
  }
  function downloadEdits() {
    for (const [name, text] of Object.entries(editedFiles())) {
      const link = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name });
      document.body.append(link);
      link.click();
      link.remove();
    }
    editNote("Downloaded nodes.csv, pipelines.csv, units.toml and flow_layout.toml for data/. `make edit` saves straight to data/ and also clears removed assets from the streams.");
  }
  let editsBar = null, editMessage = "", confirmDiscard = false;
  function editNote(text) { editMessage = text; renderEditsBar(); }
  function renderEditsBar() {
    if (!edits.length) { if (editsBar) { editsBar.remove(); editsBar = null; } return; }
    if (!editsBar) {
      editsBar = h("div", { class: "edits-bar", role: "status", "aria-live": "polite" });
      document.body.append(editsBar);
    }
    const button = (label, act, cls) => h("button", { type: "button", class: cls, onclick: act }, label);
    editsBar.replaceChildren(
      h("span", { class: "count" }, `${edits.length} ${edits.length === 1 ? "change" : "changes"} to the network`),
      h("span", { class: "dim" }, editMessage || "kept in this browser until saved"),
      button("Undo", undoEdit),
      button("Save", saveEdits, "primary"),
      confirmDiscard ? button("Discard all?", discardEdits, "danger") : button("Discard", () => { confirmDiscard = true; renderEditsBar(); }),
    );
  }

  function markTabs() {
    for (const tab of document.querySelectorAll("[data-view]")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    for (const tab of document.querySelectorAll("[data-mode]")) tab.setAttribute("aria-selected", String(tab.dataset.mode === state.mode));
  }

  function start() {
    $("crumb-overview").addEventListener("click", () => go({ screen: "overview" }));
    $("crumb-asset").addEventListener("click", () => go({ screen: "asset", asset: route.asset }));
    $("plan-chip").addEventListener("click", () => {
      // In What-if the chip is the restore-all control; otherwise it opens the overview.
      if (state.mode === "whatif" && whatif.offline.size) {
        whatif.offline.clear(); whatif.cache = null; restyle(); renderWhatif(); renderSidebar(); return;
      }
      go({ screen: "overview" });
    });
    $("theme-toggle").addEventListener("click", () => setTheme(theme === "light" ? "dark" : "light"));
    $("side-close").addEventListener("click", closeSidebar);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && (side.id || side.marker || side.form)) closeSidebar(); });
    addEventListener("click", closeMenu);
    addEventListener("resize", closeMenu);
    addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
    for (const tab of document.querySelectorAll("[data-view]")) {
      tab.addEventListener("click", () => {
        state.view = tab.dataset.view;
        markTabs();
        // The bar is identical on every page: a view tab from another screen opens it.
        if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
        else render();
      });
    }
    for (const tab of document.querySelectorAll("[data-mode]")) {
      tab.addEventListener("click", () => {
        state.mode = tab.dataset.mode;
        markTabs();
        restyle();
        renderWhatif();
        renderSidebar();
        if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
      });
    }
    addEventListener("resize", () => {
      if (applyDisplay()) { // a window dragged to another screen may change profile or scale
        buildSettings();
        for (const view of Object.values(views)) if (view.ready && view.applySettings) view.applySettings();
      }
      const view = current();
      if (view && view.mounted) view.resize();
      drawSpark();
    });
    if (embed) document.body.classList.add("embed");
    if (views[params.get("view")]) state.view = params.get("view");
    if (["live", "load", "risk", "whatif", "plain"].includes(params.get("mode"))) state.mode = params.get("mode");
    state.year = new Date().getFullYear();
    restored = takeRestore(); // after an edit: the same view and mode as before the reload
    if (restored) {
      if (views[restored.view]) state.view = restored.view;
      if (["live", "load", "risk", "whatif", "plain"].includes(restored.mode)) state.mode = restored.mode;
    }
    renderEditsBar();
    markTabs();
    renderWhatif();
    buildKey();
    buildSettings();
    if (!embed && !storedFlag("nora-guide-seen")) openGuide();
    if (NORA.streams.length || params.has("live")) {
      document.body.classList.add("has-player");
      $("player").hidden = false;
    }
    if (params.has("live")) connectFeed(params.get("live"));
    else if (NORA.streams.length) {
      const select = $("stream-select");
      select.replaceChildren(...NORA.streams.map((s) => h("option", { value: s.name }, `${s.title}${s.synthetic ? " (synthetic)" : ""}`)));
      select.disabled = NORA.streams.length < 2;
      const wanted = NORA.streams.find((s) => s.name === params.get("stream")) || NORA.streams[0];
      select.value = wanted.name;
      setStream(wanted);
    }
    go(fromHash() || (C.screen.start === "network" ? { screen: "unit", unit: "all" } : { screen: "overview" }), false);
    if (params.get("autoplay") === "1" || (C.screen.autoplay && params.get("autoplay") !== "0" && !params.has("live"))) play();
    kiosk();
    requestAnimationFrame(tick);
  }
  /* Wall behaviour: the pointer hides after a few idle seconds, and ?rotate=SECONDS
     (any profile) cycles Overview, Map and Flow for a screen nobody stands at. */
  function kiosk() {
    let idle = 0;
    const wake = () => {
      document.body.classList.remove("idle");
      clearTimeout(idle);
      if (display.profile === "wall") idle = setTimeout(() => document.body.classList.add("idle"), 4000);
    };
    for (const type of ["pointermove", "pointerdown", "keydown"]) addEventListener(type, wake);
    wake();
    const every = Number(params.get("rotate"));
    if (!(every >= 10)) return;
    const stops = [() => go({ screen: "overview" }), () => showView("map"), () => showView("flow")];
    let at = 0;
    setInterval(() => { at = (at + 1) % stops.length; stops[at](); }, every * 1000);
  }
  function showView(name) {
    state.view = name;
    markTabs();
    if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
    else render();
  }

  return {
    state, live, route, views, settings: () => settings, embed, reduceMotion, nodeIds, pipeIds,
    whatif: {
      result: whatifResult,
      toggle: toggleOffline,
      clear: () => { whatif.offline.clear(); whatif.cache = null; },
      offline: () => [...whatif.offline],
    },
    routes: { nextOut, pigPlace, peakPlace, seeded },
    colors: COLORS, levelColor: LEVEL_COLOR, shapeMarkup, drawBadge, drawMarker, drawBand, markerSize, markerTip, levelOf, fmt, esc, nameOf, unitOf, units: unitById,
    pipeStyle, pipeMapName, visibleRange, bandStops, nodeStyle, markers, window4h, nominationWindow, nominationHistogram, flowRate, thresholds: T,
    // Where the playhead stands against the wall clock ({ahead, model}), or null.
    timeState, timelineWindow,
    // The display profile (desk, wall or compact) and the one UI scale (1 = 100 %).
    display: () => display.profile,
    uiScale: () => display.scale,
    // Flow through a node now (MSm³/d) and its pressure (bar), for the views to show.
    reading: (id) => cached("reading", id, () => ({ flow: throughput(id, frame().flows), pressure: metric("pressure_bar", id) })),
    frame: frameApi, cached,
    dayDelivery, register, restyle, go, start, theme: () => theme,
    select: (id) => {
      if (!id || !assets[id]) { if (route.screen === "unit" && state.mode !== "whatif") closeSidebar(); return; }
      // In What-if mode a click takes a node offline or brings it back instead.
      if (state.mode === "whatif" && assets[id].kind === "node") { toggleOffline(id); renderSidebar(); return; }
      // On the unit screen the details slide in from the right instead of taking over the page.
      if (route.screen === "unit") { openSidebar(id); return; }
      go({ screen: "asset", asset: id });
    },
    sidebar: { open: (id) => openSidebar(id), close: closeSidebar, id: () => side.id, marker: () => side.marker },
    depth: { at: depthAt, ready: () => depthGrid.ready }, // water depth (m) under a position
    positionText,
    selectMarker: openMarker, // a click on a pig or a peak, from any view
    feed: { frame: receiveFrame, trouble: feedTrouble }, // the live feed's handlers, for tests
    menu: { open: openMenu, close: closeMenu, for: menuFor },
    // The editor: the Flow view's right-click on empty paper, its connect step, the
    // edited data files and network, and the viewport to restore after an edit.
    edit: {
      canvasMenu: (ctx) => (embed ? [] : [{ label: "Add a node here", act: () => openNodeForm(ctx) }]),
      lineForm: openLineForm,
      move: commitMove,
      list: () => edits.slice(),
      files: editedFiles,
      network: editedNetwork,
      viewport: () => (restored && restored.flow) || null,
    },
  };
})();
