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
   ?mode=live|load|risk|plain, ?stream=<name>, ?autoplay=1, ?live=<event-stream url on this site
   or this computer>. */
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
      else if (key.startsWith("on")) on(node, key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat(Infinity)) {
      if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }
  // A listener through a small table on the node, so an update in place (morph) can hand
  // the node the newer one.
  function on(node, type, act) {
    if (!node._on) node._on = {};
    if (!(type in node._on)) node.addEventListener(type, (event) => node._on[type](event));
    node._on[type] = act;
  }
  /* Update a screen in place, so what the pointer is over keeps its hover and focus while
     the data plays, a few times a second (Ray, 29 Oct: "when mouse over here the field is
     blinking a lot which looks bad"): only what changed is touched. */
  function morph(into, from) {
    if (into.nodeType !== from.nodeType || into.nodeName !== from.nodeName) { into.replaceWith(from); return; }
    if (into.nodeType === 3 || into.nodeType === 8) { if (into.nodeValue !== from.nodeValue) into.nodeValue = from.nodeValue; return; }
    if (into.nodeType !== 1) return;
    for (const { name, value } of [...from.attributes]) if (into.getAttribute(name) !== value) into.setAttribute(name, value);
    for (const { name } of [...into.attributes]) if (!from.hasAttribute(name)) into.removeAttribute(name);
    for (const [type, act] of Object.entries(from._on || {})) on(into, type, act);
    if (into.tagName === "INPUT" || into.tagName === "SELECT") {
      if (document.activeElement !== into && into.value !== from.value) into.value = from.value;
      if (into.checked !== from.checked) into.checked = from.checked;
    }
    const a = [...into.childNodes], b = [...from.childNodes];
    b.forEach((node, i) => (a[i] ? morph(a[i], node) : into.appendChild(node)));
    for (let i = b.length; i < a.length; i++) a[i].remove();
  }
  function patch(container, fresh) {
    const old = container.firstChild;
    if (old && container.childNodes.length === 1 && typeof old.isEqualNode === "function" && old.nodeName === fresh.nodeName) morph(old, fresh);
    else container.replaceChildren(fresh);
  }
  /* A row or a name that opens something but is not a button reaches the keyboard as
     well: it takes focus, Enter and Space act as a click, and its key finds it again
     after the screen is rebuilt (keepFocus). */
  function pressable(key, act, attrs = {}) {
    return { ...attrs, tabindex: "0", "data-key": key, onclick: act,
      onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(e); } } };
  }
  /* The screens are rebuilt as the data plays, a few times a second. Keep keyboard focus
     on the same control across a rebuild: the one with the same data-key. */
  function keepFocus(container, rebuild) {
    const active = document.activeElement;
    const key = active && active !== container && container.contains(active) ? active.getAttribute("data-key") : null;
    rebuild();
    if (key == null) return;
    const again = [...container.querySelectorAll("[data-key]")].find((n) => n.getAttribute("data-key") === key);
    if (again) again.focus({ preventScroll: true });
  }
  // A live region is read out on every change: replace its content only when it differs.
  function replaceIfChanged(el, signature, build) {
    if (el.dataset.signature === signature) return;
    el.dataset.signature = signature;
    el.replaceChildren(...build());
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
     east), then the EMODnet depth there: "61.90055°N  4.25673°E  ·  ED 58 m". */
  function positionText(lon, lat, digits = 5) {
    const depth = depthAt(lon, lat);
    return `${lat.toFixed(digits)}°N  ${lon.toFixed(digits)}°E${depth != null ? `  ·  ED ${fmt(depth)} m` : ""}`;
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
    /* A pig the same way (Ray, 29 Oct: "Pig ID: 3420 / ETA: 23:21 / Speed: 5,3 m/s"):
       its ID, when it reaches its receiver (CET), and its speed. */
    if (marker.kind === "pig") {
      return [[marker.pigId != null ? `Pig ${marker.pigId}` : "Pig", COLORS.pig],
        [`ETA ${timeFormat(marker.arrives, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" })}`, COLORS.text],
        [`${fmt(marker.speed, 1)} m/s`, COLORS.text_dim]];
    }
    if (marker.kind === "quality") {
      const gas = QUALITY[marker.gas];
      return [[gas.name, COLORS[gas.color]], [`${marker.amount} ${gas.unit}`, COLORS.text], marker.eta ? [`ETA ${marker.eta}`, COLORS.text_dim] : null].filter(Boolean);
    }
    const parts = [marker.value, marker.eta, detail >= 2 ? marker.to : ""].filter(Boolean);
    return [[parts.join("  "), COLORS.text]];
  }
  function markerLabel(ctx, marker, x, y, size, detail, taken) {
    if (marker.kind !== "pig" && (!marker.value || (!detail && !marker.level && marker.kind !== "quality"))) return;
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
    ctx.strokeStyle = COLORS.paper; // a paper halo, no window round the text (Ray, 29 Oct)
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

  /* Which way an interconnector's gas goes, and how much (Ray, 29 Oct: "should be able to
     subtle see which way the gas is flowing for the interconnector and what quantities are
     going which way"): small chevrons along the line pointing with the flow, and under its
     middle the flow and where it goes ("12.3 to Zeebrugge"). `at(t)` gives a point and its
     angle along the line's drawn part; both maps draw it. */
  function drawFlowDirection(ctx, id, at, u = 1, taken = []) {
    const d = assets[id], v = live.values[id];
    if (!d || d.type !== "interconnector" || state.mode !== "live" || v == null) return;
    const m = Math.abs(v), forward = v >= 0;
    ctx.save();
    ctx.strokeStyle = COLORS.text_dim;
    ctx.lineWidth = 1.3 * u;
    ctx.lineCap = "round";
    if (m >= 0.05) for (const t of [0.2, 0.35, 0.65, 0.8]) {
      const p = at(t), a = p.angle + (forward ? 0 : Math.PI), s = 4 * u;
      ctx.beginPath();
      ctx.moveTo(p.x - Math.cos(a - 0.6) * s, p.y - Math.sin(a - 0.6) * s);
      ctx.lineTo(p.x, p.y);
      ctx.lineTo(p.x - Math.cos(a + 0.6) * s, p.y - Math.sin(a + 0.6) * s);
      ctx.stroke();
    }
    const mid = at(0.5), text = m < 0.05 ? "no flow" : `${fmt(m, 1)} to ${nameOf(forward ? d.to : d.from)}`;
    ctx.font = `${11 * u}px Archivo, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(text).width, y = mid.y + 11 * u, box = [mid.x - w / 2 - 2 * u, y - 7 * u, mid.x + w / 2 + 2 * u, y + 7 * u];
    if (!taken.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) {
      taken.push(box);
      ctx.lineJoin = "round";
      ctx.lineWidth = 3 * u;
      ctx.strokeStyle = COLORS.paper; // a paper halo: no line runs through the text
      ctx.strokeText(text, mid.x, y);
      ctx.fillStyle = COLORS.text_dim;
      ctx.fillText(text, mid.x, y);
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
    // `soft`: a second ink for numbers that matter less (incoming flows), still easy to read
    // on the card (Ray, 29 Oct: "the numbers are sometimes difficult to see").
    const card = (fill, ink, dim, edge) => ({ fill, ink, dim, edge, soft: mix(ink, fill, 0.15) });
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
  /* A pressure at an upper limit (nora.toml [pressure_limits]): Ray, 29 Oct, "pressure
     number inside rectangles should change color when meeting a limit, high = yellow,
     high high = red, integrity = dark red"; "only the number itself should turn yellow
     ... not the whole square"; "we want to use strong colors sparingly". The number
     (and, zoomed in, its H, HH or INT) takes the colour, in a shade that reads on the
     tag; the alarm list says which limit in words. */

  // Strong enough to see at a glance (Ray, 29 Oct: "its a bit difficult to see the yellow
  // color of the low or high warning numbers, maybe it can be a bit stronger for those and
  // the red color as well"): a vivid golden yellow and the full alarm red on the light tag.
  function limitInk(lvl) {
    return theme === "dark"
      ? [null, COLORS.warning, COLORS.critical, mix(COLORS.integrity, COLORS.critical, 0.55)][lvl] // on the dark tag
      : [null, mix(COLORS.warning, "#000000", 0.25), COLORS.critical, COLORS.integrity][lvl];
  }
  // Its limits are [low-low, low, high, high-high, integrity]: L and H yellow, LL and HH
  // red, INT dark red (`level` 1, 2, 3 for the colour).
  // The state the views draw: the data now, or the what-if's (its own flows and pressures).
  const whatifOn = () => state.mode === "whatif";
  const viewFrame = () => (whatifOn() ? whatifState().frame : frame());
  const lineFlow = (pid) => (whatifOn() ? whatifState().frame.flows[pid] : live.values[pid]);
  function pressureMark(id, p = metric("pressure_bar", id, viewFrame())) {
    const limits = (C.pressure_limits || {})[(assets[id] || {}).type];
    if (!limits || p == null) return null;
    const [ll, low, high, hh, top] = limits;
    const at = p >= top ? ["INT", "integrity", top, 3] : p >= hh ? ["HH", "high-high", hh, 2] : p >= high ? ["H", "high", high, 1]
      : p <= ll ? ["LL", "low-low", ll, 2] : p <= low ? ["L", "low", low, 1] : null;
    if (!at) return null;
    const [code, name, limit, lvl] = at;
    return { level: lvl, code, name, limit, ink: limitInk(lvl) };
  }
  // A line's flow against its capacity (nora.toml thresholds.load): its number yellow
  // over the warning level, red past the critical one, like a pressure's.
  function flowMark(pid, v = lineFlow(pid)) {
    const d = assets[pid];
    if (!d || !d.capacity || v == null) return null;
    const lvl = level(Math.abs(v) / d.capacity, T.load);
    return lvl ? { level: lvl === 3 ? 2 : 1, ink: limitInk(lvl === 3 ? 2 : 1) } : null;
  }
  /* Each priority has its own shape and number as well as its colour; a warning (3) has
     none (Ray, 29 Oct: "remove all warning triangles") and reads as words only. */
  function shapeMarkup(lvl, x = 8, y = 8, s = 7) {
    if (lvl < 2) return "";
    const fill = LEVEL_COLOR[lvl], ink = COLORS.text;
    const outline = `fill="${fill}" stroke="${ink}" stroke-width="1.3" stroke-linejoin="round"`;
    const shape = lvl === 3 ? `<rect x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}" rx="1" ${outline}/>`
      : `<path d="M${x} ${y - s - 1}L${x + s + 1} ${y}L${x} ${y + s + 1}L${x - s - 1} ${y}Z" ${outline}/>`;
    const number = `<text x="${x}" y="${y + 3.6}" text-anchor="middle" font-size="${s * 1.35}" font-weight="600" font-family="Archivo, sans-serif" fill="${ink}">${4 - lvl}</text>`;
    return shape + number;
  }
  function badge(lvl, text) {
    if (!lvl) return h("span", { class: "badge text-only dim" }, text ?? LEVEL[0]);
    if (lvl === 1) return h("span", { class: "badge text-only", title: LEVEL[1] }, text ?? LEVEL[1]);
    return h("span", { class: "badge", title: LEVEL[lvl] }, svg("0 0 16 16", shapeMarkup(lvl)), text ?? LEVEL[lvl]);
  }
  // The same badge on a canvas (the views): shape, colour, dark outline and number.
  function drawBadge(ctx, lvl, x, y, size = 8) {
    if (lvl < 2) return; // a warning: no triangle
    ctx.save();
    ctx.beginPath();
    if (lvl === 3) ctx.rect(x - size, y - size, 2 * size, 2 * size);
    else { ctx.moveTo(x, y - size - 1); ctx.lineTo(x + size + 1, y); ctx.lineTo(x, y + size + 1); ctx.lineTo(x - size - 1, y); ctx.closePath(); }
    ctx.fillStyle = LEVEL_COLOR[lvl];
    ctx.fill();
    ctx.lineWidth = Math.max(1, size / 6);
    ctx.strokeStyle = COLORS.text;
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 ${size * 1.3}px Archivo, sans-serif`; // nothing heavier than semibold
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(4 - lvl), x, y + size * 0.08);
    ctx.restore();
  }
  /* A pig (a dot-sized solid triangle pointing downstream) or a peak (a calm circle)
     at x, y, turned along the line by `angle`. Each kind has its own shape AND its
     own calm colour, so nothing reads as an alarm badge (triangle/diamond/square in
     amber/orange/red). */
  /* `closeness` (0 to 1) is how far the view is zoomed in: a marker grows to twice its
     size, or pigs read as specks beside the squares (Ray, 29 Oct: "when i zoom into a
     pipeline the pigs become extremely small and difficult to see"). */
  function markerSize(kind, closeness = 0) {
    const base = kind === "pig" ? 13 : 6.5; // visible in a dense view, not dominant (Ray, 29 Oct: "a bit smaller")
    return base * (1 + Math.max(0, Math.min(1, closeness)));
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
    markerLabel(ctx, marker, x, y, size, detail, taken);
  }

  // ------------------------------------------------------------------ settings
  const DEFAULT_SETTINGS = {
    names: C.labels.names,
    lineValues: C.labels.line_values,
    pack: C.labels.pack,
    pressureChange: C.labels.pressure_change,
    temperature: C.labels.temperature,
    pigs: C.markers.pigs,
    gasQuality: C.markers.gas_quality,
    hide: C.assets.hide,
    gridEntries: C.assets.grid_entries,
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
    return asked >= 0.75 && asked <= 4 ? asked : autoScaleFor(profile);
  }
  /* A wall is read from metres away (review #49802: desk × 1.5 read to about 1.5 m).
     Control-room practice (ISO 9241-303, ISA-101) wants capitals of about 20 arcmin at
     the reading distance; a browser cannot measure the screen, so nora.toml says how far
     it is read from and how wide its picture is. 13 px Archivo has capitals of ~9 px.
     A 4 m wide 3840 px wall read from 5 m comes to about 3. */
  function wallScale(width) {
    const distance = C.screen.wall_distance_m || 5, wide = C.screen.wall_width_m || 4;
    const capital = distance * 1000 * Math.tan((20 / 60) * (Math.PI / 180)); // mm
    const perPixel = (wide * 1000) / width; // mm per CSS pixel
    return Math.min(4, Math.max(1.5, capital / perPixel / 9));
  }
  const autoScaleFor = (profile) => (profile === "wall" ? wallScale(window.innerWidth) : autoScale(window.innerWidth));
  // Returns true when the profile or scale changed, so the views can re-fit.
  /* The bar is one row while it fits (Ray, 29 Oct: "everything here should be on one
     line"). The UI scale zooms it, so a 1440 px wall screen at 1.5 has 960 px of room:
     the fit is judged on that, which a media query cannot see. */
  function barLayout(scale) {
    const room = window.innerWidth / scale;
    document.documentElement.dataset.bar = room < 1060 ? "two" : room < 1240 ? "tight" : "one";
  }
  /* Two rows may still not hold the bar on a phone: measure what its rows need, so no
     control is cut off above the screen and the screens start below the bar. */
  function fitBar(scale) {
    const root = document.documentElement, bar = document.querySelector(".bar");
    if (!bar) return;
    root.style.removeProperty("--bar-h");
    if (root.dataset.bar !== "two") return;
    bar.style.height = "auto";
    const needed = Math.ceil(bar.getBoundingClientRect().height / scale) + 16;
    bar.style.height = "";
    if (needed > parseFloat(getComputedStyle(root).getPropertyValue("--bar-h"))) root.style.setProperty("--bar-h", `${needed}px`);
  }
  function applyDisplay() {
    const profile = chosenProfile(), scale = Math.round(chosenScale(profile) * 100) / 100;
    barLayout(scale);
    const changed = profile !== display.profile || scale !== display.scale;
    if (changed) {
      display.profile = profile;
      display.scale = scale;
      document.documentElement.dataset.display = profile;
      document.documentElement.style.setProperty("--ui-scale", String(scale));
    }
    fitBar(scale);
    return changed;
  }
  applyDisplay();
  // The web font changes how much room the bar's text takes: fit it again once loaded.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitBar(display.scale));
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
    conditions: [], // active abnormal conditions, worst first (shelved ones left out)
    shelved: [], // active conditions an operator has shelved for a while
    levelOf: {}, // asset -> worst active level
    onset: new Map(), // `${kind}|${id}` -> when that alarm began ({t, before})
    jumped: true, // the playhead jumped (a seek, a new stream): onsets start over
  };
  const frame = () => live.frames[Math.max(0, live.index)] || { flows: {}, metrics: {}, plan: null };
  const metric = (name, id, f = frame()) => ((f.metrics || {})[name] || {})[id];

  // ------------------------------------------------------------------ line pack
  /* The gas held in a pipeline: its volume and the mean pressure along it, from the
     pressures at its two ends (2/3 (p1 + p2 - p1 p2 / (p1 + p2)), absolute), at 5 °C on
     the seabed and a compressibility of 0.85. A model estimate, as a pipeline modelling
     system (PMS) gives, for every line with a known length and diameter. Ray, 29 Oct:
     the pack rate "normally we want to stay close to 0"; the rate of change of
     pressure matters "especially in and out of SLR, DRP S and DRP E"; and "a trend
     showing total inventory in the whole system". */
  const PACK = { pStd: 1.01325, tStd: 288.15, tSea: 278.15, z: 0.85 };
  const lineVolume = {}; // m³
  for (const pid of pipeIds) {
    const d = assets[pid];
    if (d.length && d.diameter) lineVolume[pid] = (Math.PI / 4) * (d.diameter * 0.0254) ** 2 * d.length * 1000;
  }
  /* Settle-out pressure (bar g): what a line settles to, shut in at both ends, with the
     gas it holds now: the mean of its end pressures for compressible flow. Operators
     read it on the lines (the old Area D screen's "sop"). */
  function settleOut(pid, f = frame()) {
    if (!f || !assets[pid]) return null;
    const a = metric("pressure_bar", assets[pid].from, f), b = metric("pressure_bar", assets[pid].to, f);
    if (a == null && b == null) return null;
    const p1 = (a ?? b) + PACK.pStd, p2 = (b ?? a) + PACK.pStd;
    return (2 / 3) * (p1 + p2 - (p1 * p2) / (p1 + p2)) - PACK.pStd;
  }
  function linepack(pid, f) { // MSm³
    const sop = lineVolume[pid] ? settleOut(pid, f) : null;
    if (sop == null) return null;
    return ((lineVolume[pid] * (sop + PACK.pStd)) / PACK.pStd) * (PACK.tStd / PACK.tSea) / PACK.z / 1e6;
  }
  const frameNo = (i) => live.frames[Math.max(0, Math.min(live.frames.length - 1, i))];
  // The frame an hour before now, and now: rates are over the last hour.
  function hourPair() {
    const step = (live.stream && live.stream.step) || 3600, now = frameNo(live.index);
    const before = frameNo(live.index - Math.max(1, Math.round(3600 / step)));
    return now && before && now !== before && now.t > before.t ? [before, now] : null;
  }
  function packRate(pid) { // MSm³/d
    const pair = hourPair(), a = pair && linepack(pid, pair[0]), b = pair && linepack(pid, pair[1]);
    return a == null || b == null ? null : ((b - a) * 86400) / (pair[1].t - pair[0].t);
  }
  function pressureRate(id) { // bar/h (a what-if is a steady state: none)
    if (whatifOn()) return null;
    const pair = hourPair(), a = pair && metric("pressure_bar", id, pair[0]), b = pair && metric("pressure_bar", id, pair[1]);
    return a == null || b == null ? null : ((b - a) * 3600) / (pair[1].t - pair[0].t);
  }
  const inventories = new WeakMap(); // frame -> MSm³ (a stream's frames do not change)
  function inventory(f) {
    if (!f) return null;
    if (!inventories.has(f)) {
      let total = 0, any = false;
      for (const pid of Object.keys(lineVolume)) {
        const lp = linepack(pid, f);
        if (lp != null) { total += lp; any = true; }
      }
      inventories.set(f, any ? total : null);
    }
    return inventories.get(f);
  }

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
  // The trends in the indicator banks: the last TREND_STEPS data steps (12 h of hourly
  // data, 12 gas days of daily data), and their column says so.
  const TREND_STEPS = 12;
  function series(fn, n = TREND_STEPS + 1) {
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
  const dayDelivery = (id) => cached("day", id, () => (whatifOn() ? whatifDay(id) : dayDeliveryNow(id)));
  // In a what-if: its delivery against the nomination it starts from (now's, or the next gas day's).
  function whatifDay(id) {
    const w = whatifState(), nom = w.nominations[id], got = w.delivered[id];
    if (!(nom > 0) || got == null) return null;
    const share = (got - nom) / nom;
    return { share, level: level(Math.abs(share), T.nomination), trail: [] };
  }
  /* The gas day so far at an exit: delivered against nominated, and how that stood after
     each hour of the day (`trail`, oldest first; Ray, 29 Oct: "the end of day target to
     exit points changes over time and this need to be illustrated as well"). `hours`
     keeps each hour's MSm³ for the panel's chart. */
  function dayDeliveryNow(id) {
    const start = T.gas_day_start_utc == null ? 5 : T.gas_day_start_utc, now = frame();
    if (now.t == null || metric("nomination_msm3d", id, now) == null) return null;
    const dayStart = Math.floor((now.t - start * 3600) / 86400) * 86400 + start * 3600;
    let first = live.index;
    while (first > 0 && live.frames[first - 1] && live.frames[first - 1].t >= dayStart) first--;
    let actual = 0, nominated = 0;
    const trail = [], hours = [];
    for (let i = first; i <= live.index; i++) {
      const f = live.frames[i], nom = metric("nomination_msm3d", id, f), got = throughput(id, f.flows);
      if (nom == null || got == null) continue;
      actual += got;
      nominated += nom;
      hours.push({ t: f.t, nominated: nom, delivered: got });
      if (nominated > 0) trail.push((actual - nominated) / nominated);
    }
    if (nominated <= 0) return null;
    const share = (actual - nominated) / nominated;
    return { share, level: level(Math.abs(share), T.nomination), trail: trail.slice(0, -1), hours, dayStart };
  }
  // How fast gas through a node is changing, MSm³/d per hour, over the last 2 hours.
  const flowRate = (id) => (whatifOn() ? null : rate(window4h(id).past));
  /* The 4-hour window shown in each flow-view card: the last 2 hours of actual flow,
     and the next 2 hours of what shippers have nominated (from the recorded data, or
     the `ahead` block of a live-feed frame). */
  function window4h(id) { return whatifOn() ? { past: [], future: null, tol: 0 } : cached("w4h", id, () => window4hNow(id)); }
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
      // Each hour's nomination and booking (a live feed's `ahead` block, or the
      // recorded data's following hours).
      const hourOf = (name, k, future) => (k === 0 ? metric(name, id, current)
        : live.feed ? (((current.ahead || {})[name] || {})[id] || [])[k - 1]
        : metric(name, id, future || {}));
      for (let k = 0; k < 6; k++) {
        const future = live.frames[live.index + k];
        const value = hourOf("nomination_msm3d", k, future), booked = hourOf("booked_msm3d", k, future);
        out.push({ t: future && future.t != null ? future.t : current.t + k * 3600, value: value ?? null, booked: booked ?? null });
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ alarm handling
  /* Acknowledge and shelve (ISA-18.2 style; hub 3612). An alarm is raised unacknowledged.
     Acknowledging one occurrence dims its badge; it stays listed until it clears, and if
     it comes back it is a new occurrence, unacknowledged again (an acknowledgement is
     kept per kind, asset and onset). Shelving takes an alarm out of the counts and the
     views for 1, 8 or 12 hours, with a reason; it returns by itself at the expiry and
     stays listed under Shelved meanwhile. Operator actions run on the wall clock and are
     kept in this browser only (localStorage), not shared with anyone else. */
  const ALARM_STATE = "nora-alarm-handling";
  const SHELVE_REASONS = ["Known cause", "Maintenance", "Nuisance"];
  const SHELVE_HOURS = [1, 8, 12];
  const alarmKey = (c) => `${c.kind}|${c.id}`;
  const occurrence = (c) => `${alarmKey(c)}|${c.since && c.since.t != null ? c.since.t : ""}`;
  const alarmHandling = (() => {
    const state = { acked: {}, shelved: {} };
    try { Object.assign(state, JSON.parse(localStorage.getItem(ALARM_STATE) || "{}")); } catch (error) { /* start empty */ }
    const save = () => {
      const acked = Object.entries(state.acked).sort((a, b) => b[1] - a[1]).slice(0, 500); // the newest 500 are plenty
      state.acked = Object.fromEntries(acked);
      try { localStorage.setItem(ALARM_STATE, JSON.stringify(state)); } catch (error) { /* kept for this page only */ }
    };
    return {
      acked: (c) => state.acked[occurrence(c)] != null,
      ack(conditions, now = Date.now()) {
        for (const c of conditions) state.acked[occurrence(c)] ??= now;
        save();
      },
      shelf: (c, now = Date.now()) => { const s = state.shelved[alarmKey(c)]; return s && s.until > now ? s : null; },
      shelve(c, reason, hours, now = Date.now()) {
        state.shelved[alarmKey(c)] = { reason, since: now, until: now + hours * 3600e3 };
        save();
      },
      unshelve(c) { delete state.shelved[alarmKey(c)]; save(); },
      expire(now = Date.now()) {
        const gone = Object.keys(state.shelved).filter((k) => state.shelved[k].until <= now);
        for (const k of gone) delete state.shelved[k];
        if (gone.length) save();
      },
    };
  })();

  // ------------------------------------------------------------------ conditions
  /* Everything abnormal right now, as {level, id, kind, text, since}. The views, the
     alarm counts, the overview and the asset screens all read this one list. `since`
     is when the alarm began, in data time: {t, before} with `before` set when it was
     already active as the playhead arrived (a seek), so it may have begun earlier. */
  function evaluate() {
    const f = frame(), out = [];
    const add = (lvl, id, kind, text, since = null) => { if (lvl > 0) out.push({ level: lvl, id, kind, text, since }); };
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
      const [low, high] = window, span = high - low, mark = pressureMark(id, p);
      if (mark) { // at a limit: low and high a warning; low-low, high-high and integrity critical
        add(mark.level === 1 ? 1 : 3, id, "pressure", `${nameOf(id)} ${fmt(p, 1)} bar, at its ${mark.name} limit (${fmt(mark.limit)} bar)`);
        continue;
      }
      if ((C.pressure_limits || {})[assets[id].type]) continue; // inside its limits
      // A type with no limits warns as the pressure nears its window's edges.
      const margin = Math.min(p - low, high - p) / span;
      add(level(margin, T.pressure_margin, false), id, "pressure",
        `${nameOf(id)} ${fmt(p, 1)} bar, near the ${p - low < high - p ? "minimum" : "maximum"} (${fmt(low)}–${fmt(high)} bar)`);
    }
    for (const peak of live.peaks) {
      add(peak.level, peak.id, "peak", `${nameOf(peak.id)}: flow ${peak.delta > 0 ? "rose" : "fell"} ${fmt(Math.abs(peak.delta), 1)} MSm³/d in one step`);
    }
    for (const s of slugs()) {
      if (s.exit && s.exitLevel) {
        add(slugAlarm(s), s.exit.node, "quality", `${qualityText(s.q.metric, s.exit.conc)} expected at ${nameOf(s.exit.node)} ${etaText(s.exit.t)}; limit ${C.quality[s.q.metric][2]} ${QUALITY[s.q.metric].unit}`);
      } else if (s.level) {
        add(slugAlarm(s), s.q.origin, "quality", `${qualityText(s.q.metric, s.q.conc)} from ${nameOf(s.q.origin)}${s.exit ? `, diluted to ${fmt(s.exit.conc, QUALITY[s.q.metric].digits)} by ${nameOf(s.exit.node)}` : ""}`);
      }
    }
    const events = (live.stream && live.stream.events) || live.feedEvents || [];
    for (const event of events) {
      if (live.time >= event.start && live.time < event.end && !event.planned) add(2, event.asset, "event", event.label, { t: event.start, before: false });
    }
    if (f.plan && f.plan.now[0]) add(f.plan.now[0], f.plan.now[2] || "plan", "plan", `Plan: ${f.plan.now[1]}`, planSince());
    if (live.stale) add(2, "feed", "feed", `Live feed stale, values from ${live.time ? formatTime(live.time) : "before"}: ${live.stale.text}`, { t: live.stale.since / 1000, before: false });
    out.sort((a, b) => b.level - a.level || a.text.localeCompare(b.text));
    // The rest began when first seen; an alarm active as the playhead arrives may be older.
    const onset = new Map();
    for (const c of out) {
      const key = `${c.kind}|${c.id}`;
      c.since = c.since || live.onset.get(key) || onset.get(key) || { t: live.time, before: live.jumped };
      if (!onset.has(key)) onset.set(key, c.since);
    }
    live.onset = onset;
    live.jumped = false;
    // Shelved alarms leave the counts, the views and the lists; they are listed apart.
    alarmHandling.expire();
    for (const c of out) { c.acked = alarmHandling.acked(c); c.shelf = alarmHandling.shelf(c); }
    live.conditions = out.filter((c) => !c.shelf);
    live.shelved = out.filter((c) => c.shelf);
    live.levelOf = {};
    for (const c of live.conditions) live.levelOf[c.id] = Math.max(live.levelOf[c.id] || 0, c.level);
  }
  // When the plan began to fall short: the first of the frames in a row that do.
  function planSince() {
    let i = Math.max(0, live.index);
    while (i > 0 && live.frames[i - 1] && live.frames[i - 1].plan && live.frames[i - 1].plan.now[0]) i--;
    return { t: live.frames[i].t, before: i === 0 };
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
    const pigs = settings.pigs ? (live.stream && live.stream.pigs) || live.feedPigs || [] : [];
    for (const pig of pigs) {
      const place = pigPlace(pig, live.time);
      if (!place) continue;
      const trip = pigTrip(pig, live.time);
      out.push({ kind: "pig", id: place.pid, along: place.along, label: "", level: 0, title: pig.label,
        eta: clock(place.exitAt), to: nameOf(place.next), key: `pig:${pig.label}|${pig.launch}`, ref: pig,
        pigId: pig.id != null ? pig.id + trip.run : null, arrives: trip.arrives, speed: pig.speed });
    }
    // No marker for a change in flow (Ray, 29 Oct: "mainly stick to illustrating H2S, CO2
    // and pigs"); a large one is still an alarm.
    if (!settings.gasQuality) return out; // Settings: H₂S and CO₂ peaks off
    advanceQuality(); // the clock moves every frame, the parcels with it
    const leads = new Map(slugs().map((s) => [s.q.slug, s])), bySlug = new Map();
    for (const q of live.quality) bySlug.set(q.slug, [...(bySlug.get(q.slug) || []), q]);
    for (const [slug, parcels] of bySlug) {
      parcels.sort((a, b) => a.born - b.born);
      // Each parcel's share of the slug: the gas sent from its birth until the next
      // parcel's, or until now while the field still sends it.
      const windows = parcels.map((q, k) => [q.born, Math.min(q.born + q.len, k + 1 < parcels.length ? parcels[k + 1].born : Infinity, live.time)]);
      const bands = new Map();
      parcels.forEach((q, k) => {
        for (const piece of gasStretch(q, windows[k][0], windows[k][1])) {
          const band = bands.get(piece.pid);
          if (band) { band.tail = Math.min(band.tail, piece.tail); band.head = Math.max(band.head, piece.head); }
          else bands.set(piece.pid, { ...piece });
        }
      });
      if (!bands.size) continue;
      // The dot: the gas sent midway between the head still in the network and the tail.
      const inside = parcels.map((q, k) => [Math.max(windows[k][0], live.time - pathSeconds(q)), windows[k][1]]);
      const front = inside.find(([a, b]) => b >= a), back = windows[windows.length - 1][1];
      const mid = ((front ? front[0] : back) + back) / 2;
      const k = Math.max(0, windows.findIndex(([, b], i) => mid <= b || i === windows.length - 1));
      const dot = gasPlace(parcels[k], mid), s = leads.get(slug), q0 = parcels[0];
      for (const band of bands.values()) {
        const flip = (x) => (band.forward ? x : 1 - x), extent = [flip(band.tail), flip(band.head)];
        const base = { kind: "quality", gas: q0.metric, id: band.pid, extent, key: `quality:${slug}`, ref: slug };
        if (!s || !dot || dot.pid !== band.pid) { out.push({ ...base, along: (extent[0] + extent[1]) / 2, lead: false, noDot: true, level: 0, value: "" }); continue; }
        const along = Math.max(band.tail, Math.min(band.head, dot.at));
        out.push({ ...base, along: flip(along), lead: true, level: slugAlarm(s),
          value: `${QUALITY[q0.metric].name} ${fmt(s.q.conc, QUALITY[q0.metric].digits)}`, amount: fmt(s.q.conc, QUALITY[q0.metric].digits),
          eta: s.q.arrived ? "" : clock(s.next.t), to: nameOf(s.q.arrived ? s.q.arrived.node : s.next.node) });
      }
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
  /* A slug's alarm priority, the same in the alarm list, the overview and on the lines:
     what is expected where it leaves the network, else a warning while it is followed
     (a high reading at the field that is diluted below the limits is no worse). */
  const slugAlarm = (s) => s.exitLevel || (s.level ? 1 : 0);
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
        /* Each parcel is one data step of the field's gas (`len` seconds of it): the
           slug's volume adds them up as they leave the field, so it stays whole after
           its head has left. `path` is the lines it has taken, in order. */
        const step = previous ? current.t - previous.t : (live.stream && live.stream.step) || 3600;
        live.quality.push({ metric: name, origin: node, slug, conc: value, pid: route.pid, forward: route.forward, t0: current.t, born: current.t, len: step,
          path: [{ pid: route.pid, forward: route.forward }], arrived: null });
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
        else { Object.assign(q, { pid: next.pid, forward: next.forward, t0: at }); q.path.push({ pid: next.pid, forward: next.forward }); }
      }
      return !q.arrived || time - q.arrived.t < q.len; // until the gas sent after it has left too
    });
  }
  /* Where the gas a field sent at `sent` is now, following the parcel ahead of it: the
     line and how far along it (0..1 the way the gas goes); null once it has left. */
  function gasPlace(q, sent, time = live.time) {
    let left = Math.max(0, time - sent);
    for (const [k, hop] of q.path.entries()) {
      const travel = travelSeconds(hop.pid);
      if (left < travel || (k === q.path.length - 1 && !q.arrived)) return { pid: hop.pid, forward: hop.forward, at: Math.min(1, left / travel) };
      left -= travel;
    }
    return null;
  }
  /* The gas sent between `from` and `to` on each line of the parcel's path: [tail, head].
     Just sent, it is a point at the field. */
  function gasStretch(q, from, to, time = live.time) {
    const front = time - from, back = Math.max(0, time - to), out = [];
    let start = 0;
    for (const [k, hop] of q.path.entries()) {
      const travel = travelSeconds(hop.pid), lo = Math.max(back, start), hi = Math.min(front, start + travel);
      const point = front === back && back >= start && (back < start + travel || k === q.path.length - 1);
      if (hi > lo || point) out.push({ pid: hop.pid, forward: hop.forward, tail: (lo - start) / travel, head: (hi - start) / travel });
      start += travel;
    }
    return out;
  }
  // How long the gas takes along a parcel's whole path, once it has reached an exit.
  const pathSeconds = (q) => (q.arrived ? q.path.reduce((t, hop) => t + travelSeconds(hop.pid), 0) : Infinity);
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
     fast and always gives the same answer. The graph follows analysis.flow_graph:
     only operating assets (graph.build_graph); every other capacitated node that
     is neither a supplier nor an exit split into an entry twin; exits' booked
     shares filled before the rest (review #49802). */
  const WHATIF_SOURCE = "__supply__", WHATIF_SINK = "__markets__", EPS = 1e-9;
  const whatif = { offline: new Set(), cache: null, supply: {}, offtake: {}, pressure: {}, pack: {}, scenario: "now", version: 0, key: null, state: null };
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
    // offline, not operating (graph.build_graph), or not built in the year shown
    const inService = (id) => !whatif.offline.has(id) && assets[id].status === "operating" && yearActive(id);
    for (const id of nodeIds) {
      if (!inService(id)) continue;
      const d = assets[id];
      adj[id] = adj[id] || [];
      if (d.supply && d.capacity) add(WHATIF_SOURCE, id, d.capacity);
      if (d.exit) sinkArc[id] = add(id, WHATIF_SINK, d.capacity || Infinity); // as analysis.flow_graph
    }
    /* Any other node with a capacity (a processing plant) is a bottleneck, split as
       analysis.flow_graph does: incoming arcs land on an entry twin, one capacity
       arc joins the twin to the node, outgoing arcs leave the node itself. */
    const plantEntry = {};
    for (const id of nodeIds) {
      const d = assets[id];
      if (inService(id) && !d.supply && !d.exit && d.capacity) plantEntry[id] = add(`${id}__in`, id, d.capacity);
    }
    for (const id of pipeIds) {
      const p = assets[id];
      if (p.status !== "operating" || !adj[p.from] || !adj[p.to]) continue; // not operating, or an end is out
      const cap = p.capacity == null ? Infinity : p.capacity;
      // gas leaves a node from the node itself and enters a split one at its twin
      const into = (node) => (plantEntry[node] !== undefined ? `${node}__in` : node);
      add(p.from, into(p.to), cap, id, 1);
      if (p.bidirectional) add(p.to, into(p.from), cap, id, -1);
    }
    /* Bookings first: the sink arcs open only to the exits' booked shares, then fully.
       An augmenting path ends at the sink, so it never takes gas back from a booked
       exit, and the total is the same maximum either way. */
    const full = {}, booked = {};
    for (const [id, i] of Object.entries(sinkArc)) {
      full[id] = arcs[i].cap;
      if (assets[id].booked) booked[id] = Math.min(assets[id].booked, full[id]);
    }
    let value = 0;
    if (Object.keys(booked).length) {
      for (const [id, i] of Object.entries(sinkArc)) arcs[i].cap = booked[id] || 0;
      value += augment(arcs, adj);
      for (const [id, i] of Object.entries(sinkArc)) arcs[i].cap = full[id];
    }
    value += augment(arcs, adj);
    const pipelines = {};
    for (const a of arcs) if (a.pipeline && Math.abs(a.f) > EPS) pipelines[a.pipeline] = (pipelines[a.pipeline] || 0) + a.f * a.sign;
    const delivered = {};
    for (const [id, i] of Object.entries(sinkArc)) delivered[id] = arcs[i].f;
    return { value, delivered, pipelines, max: Math.max(1, ...Object.values(pipelines).map(Math.abs)) };
  }
  // Edmonds-Karp: shortest augmenting paths, in sorted order, so the split is stable.
  function augment(arcs, adj) {
    let value = 0;
    for (;;) {
      const prev = { [WHATIF_SOURCE]: WHATIF_SOURCE }, prevArc = {}, queue = [WHATIF_SOURCE];
      while (queue.length && !prev[WHATIF_SINK]) {
        const u = queue.shift();
        for (const i of adj[u]) {
          const a = arcs[i];
          if (!prev[a.v] && a.cap - a.f > EPS) { prev[a.v] = u; prevArc[a.v] = i; queue.push(a.v); }
          if (prev[WHATIF_SINK]) break;
        }
      }
      if (!prev[WHATIF_SINK]) return value;
      let push = Infinity;
      for (let v = WHATIF_SINK; v !== WHATIF_SOURCE; v = prev[v]) push = Math.min(push, arcs[prevArc[v]].cap - arcs[prevArc[v]].f);
      for (let v = WHATIF_SINK; v !== WHATIF_SOURCE; v = prev[v]) { arcs[prevArc[v]].f += push; arcs[arcs[prevArc[v]].rev].f -= push; }
      value += push;
    }
  }
  function whatifResult() {
    if (!whatif.cache) whatif.cache = whatifFlow();
    return whatif.cache;
  }
  // ------------------------------------------------------------------ what-if: a steady state
  /* A steady-state what-if (Ray, 29 Oct): "users change production deliveries and pipeline
     packing to see how the network balance and pipeline flows change. it then uses
     pipeline-specific regression formulas and correction factor to estimate pressures
     and the flow of gas stored in each pipeline"; "when clicking on a node i should be able
     to add my own flow and pressure values that are temporary ... see how the rest of the
     overview of pressure and flows change"; "how the whole overview will look based on
     nominations for the next gas day".

     It starts from the state now. Now: each field's production (yours, or today's) runs
     down the lines in the direction gas flows today, each node splitting what it sends on
     in today's shares (by capacity where it sends nothing); a line that packs delivers that
     much less than it takes in; an exit takes what reaches it. Next gas day: each exit
     takes the next gas day's nomination (or yours), and the lines carry that back up to
     the fields in today's shares, which says what each must produce.

     Pressures: each line's regression (data/pipeline_models.csv, as a PMS keeps them),
     p_in² − p_out² = c (a Q² + b Q), Q its mean flow, bar a. The correction c tunes it to
     today: the measured drop over the regression's at today's flow (kept between 0.05 and
     20), else the file's own. The change in each line's drop is laid on today's pressures,
     so with nothing changed every pressure is today's. Exits and gas plants hold today's
     pressure (onshore control, compressors) unless a pressure you set upstream feeds them;
     your pressures hold. Line pack follows from the end pressures (the line-pack model).
     All model estimates, and labelled so. */
  const MODELS = NORA.pipeModels || {};
  const absBar = (p) => p + PACK.pStd;
  const whatifLinesAt = {};
  for (const pid of pipeIds) for (const end of [assets[pid].from, assets[pid].to]) (whatifLinesAt[end] = whatifLinesAt[end] || []).push(pid);
  // A line's flow now, or the model's where the data has none.
  const baseFlow = (pid, f) => (f.flows[pid] !== undefined ? f.flows[pid] : assets[pid].utilization != null && assets[pid].capacity ? assets[pid].utilization * assets[pid].capacity : 0);
  // A supply node's own production now: what it sends out beyond what it takes in.
  function productionNow(id, f = frame()) {
    let sent = 0;
    for (const pid of whatifLinesAt[id] || []) sent += (assets[pid].from === id ? 1 : -1) * baseFlow(pid, f);
    return Math.max(0, sent);
  }
  // Each exit's average hourly nomination over the next gas day (the data's, else now's).
  function nextDayNominations(f = frame()) {
    const start = T.gas_day_start_utc == null ? 5 : T.gas_day_start_utc, out = {};
    if (f.t == null) return out;
    const from = Math.floor((f.t - start * 3600) / 86400) * 86400 + start * 3600 + 86400, to = from + 86400;
    const day = live.frames.filter((g) => g.t >= from && g.t < to);
    for (const id of exitPoints) {
      const values = day.map((g) => metric("nomination_msm3d", id, g)).filter((v) => v != null);
      out[id] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : metric("nomination_msm3d", id, f) ?? null;
    }
    return out;
  }
  // Every exit: the terminals, and a market at the end of a line (Poland VTP, Tjeldbergodden).
  const whatifExits = nodeIds.filter((id) => assets[id].exit);
  const settleOutOf = (a, b) => {
    if (a == null && b == null) return null;
    const p1 = absBar(a ?? b), p2 = absBar(b ?? a);
    return (2 / 3) * (p1 + p2 - (p1 * p2) / (p1 + p2)) - PACK.pStd;
  };
  const linepackOf = (pid, sop) => (lineVolume[pid] && sop != null ? ((lineVolume[pid] * absBar(sop)) / PACK.pStd) * (PACK.tStd / PACK.tSea) / PACK.z / 1e6 : null);
  function whatifState() {
    const key = `${live.index}|${whatif.version}`;
    if (whatif.key !== key) { whatif.key = key; whatif.state = whatifSolve(); }
    return whatif.state;
  }
  // `opts`: other inputs than yours (the pressure outlook uses none), and nominations to
  // meet instead of now's or the next gas day's.
  function whatifSolve(opts = {}) {
    const W = opts.inputs || whatif, f = frame(), off = W.offline, next = Boolean(opts.nominations) || W.scenario === "next";
    const out = (id) => off.has(id) || assets[id].status !== "operating" || !yearActive(id);
    const cut = (pid) => out(pid) || out(assets[pid].from) || out(assets[pid].to);
    const outs = {}, ins = {}, sign = {}, share = {};
    for (const pid of pipeIds) {
      if (cut(pid)) continue;
      const v = baseFlow(pid, f), p = assets[pid];
      sign[pid] = v < 0 ? -1 : 1;
      share[pid] = Math.abs(v);
      const [u, w] = v < 0 ? [p.to, p.from] : [p.from, p.to];
      (outs[u] = outs[u] || []).push(pid);
      (ins[w] = ins[w] || []).push(pid);
    }
    const head = (pid) => (sign[pid] < 0 ? assets[pid].from : assets[pid].to);
    const tail = (pid) => (sign[pid] < 0 ? assets[pid].to : assets[pid].from);
    const order = [], indeg = {};
    for (const id of nodeIds) indeg[id] = (ins[id] || []).length;
    const queue = nodeIds.filter((id) => !indeg[id]);
    while (queue.length) {
      const u = queue.shift();
      order.push(u);
      for (const pid of outs[u] || []) if (--indeg[head(pid)] === 0) queue.push(head(pid));
    }
    for (const id of nodeIds) if (!order.includes(id)) order.push(id); // a loop: taken as it comes
    /* Only the changes are routed, on top of today's flows (so with nothing changed every
       flow is today's, even where the data does not balance): each node passes what it
       gains or loses on in today's shares; an exit takes it. */
    const lines = {}, supply = {}, delivered = {}, stranded = {}, short = {};
    const packed = (pid) => W.pack[pid] || 0, add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
    const nominations = opts.nominations || (next ? nextDayNominations(f) : null) || Object.fromEntries(whatifExits.map((id) => [id, metric("nomination_msm3d", id, f) ?? null]));
    const gain = {}, more = {}; // what each node gains (MSm³/d), what each line takes in more
    for (const id of nodeIds) if (assets[id].supply) {
      const made = productionNow(id, f), then = out(id) ? 0 : next ? made : W.supply[id] ?? made;
      supply[id] = then;
      add(gain, id, then - made);
    }
    for (const pid of pipeIds) { // a line out of service: its gas stays at its tail to go another way
      if (!cut(pid) || Math.abs(baseFlow(pid, f)) < 1e-9) continue;
      const v = baseFlow(pid, f), [u, w] = v < 0 ? [assets[pid].to, assets[pid].from] : [assets[pid].from, assets[pid].to];
      add(gain, u, Math.abs(v));
      add(gain, w, -Math.abs(v));
    }
    for (const pid of Object.keys(sign)) if (packed(pid)) add(gain, head(pid), -packed(pid)); // packing keeps gas in the line
    const shares = (list, weightOf) => {
      let w = list.map(weightOf), sum = w.reduce((a, b) => a + b, 0);
      if (sum < 1e-9) { w = list.map((pid) => assets[pid].capacity || 1); sum = w.reduce((a, b) => a + b, 0); }
      return w.map((x) => x / sum);
    };
    for (const u of order) {
      if (out(u) || Math.abs(gain[u] || 0) < 1e-12) continue;
      const go = outs[u] || [];
      if (assets[u].exit || !go.length) { if (!assets[u].exit && gain[u] > 0.05) stranded[u] = gain[u]; continue; }
      shares(go, (pid) => share[pid]).forEach((k, i) => { add(more, go[i], gain[u] * k); add(gain, head(go[i]), gain[u] * k); });
    }
    const arrives = (id) => { // what reaches an exit, with the changes so far
      let into = 0;
      for (const pid of ins[id] || []) into += Math.max(0, share[pid] + (more[pid] || 0) - packed(pid));
      return into;
    };
    if (next) { // the next gas day: each exit's nomination (or yours) pulls the difference up the lines
      const need = {};
      for (const id of whatifExits) if (!out(id)) need[id] = (W.offtake[id] ?? nominations[id] ?? arrives(id)) - arrives(id);
      for (const u of [...order].reverse()) {
        if (out(u)) continue;
        let n = need[u] || 0;
        for (const pid of outs[u] || []) n += lines[pid] ? lines[pid] : 0;
        if (Math.abs(n) < 1e-12) continue;
        const come = ins[u] || [], own = assets[u].supply;
        if (!come.length && !own) continue; // nothing upstream to make it
        const parts = shares([...come, own ? "__own__" : null].filter(Boolean), (pid) => (pid === "__own__" ? productionNow(u, f) : share[pid]));
        come.forEach((pid, i) => { lines[pid] = (lines[pid] || 0) + n * parts[i]; });
        if (own) supply[u] += n * parts[parts.length - 1];
      }
      for (const [pid, x] of Object.entries(lines)) add(more, pid, x);
    }
    for (const k of Object.keys(lines)) delete lines[k];
    for (const pid of Object.keys(sign)) {
      const into = share[pid] + (more[pid] || 0);
      if (into < -1e-9) short[pid] = true;
      const i = Math.max(0, into), o = Math.max(0, i - packed(pid));
      if (packed(pid) > i + 1e-9) short[pid] = true;
      lines[pid] = { into: i, out: o };
    }
    for (const id of whatifExits) if (!out(id)) delivered[id] = (ins[id] || []).reduce((sum, pid) => sum + lines[pid].out, 0);
    // Pressures, in s = p² (bar a), on the lines that carry gas today.
    const now = (id) => metric("pressure_bar", id, f), s0 = {}, model = (pid, q) => (MODELS[pid] ? MODELS[pid].a * q * q + MODELS[pid].b * q : 0);
    for (const id of nodeIds) if (now(id) != null) s0[id] = absBar(now(id)) ** 2;
    const edges = Object.keys(sign), correction = {}, from = {};
    for (const pid of edges) {
      const measured = s0[tail(pid)] != null && s0[head(pid)] != null ? s0[tail(pid)] - s0[head(pid)] : null, m0 = model(pid, share[pid]);
      const k = measured != null && measured > 0 && m0 > 1e-9 ? measured / m0 : null;
      if (k != null) { correction[pid] = Math.max(0.05, Math.min(20, k)); from[pid] = "today's pressures"; }
      else { correction[pid] = MODELS[pid] ? MODELS[pid].correction : 1; from[pid] = MODELS[pid] ? "pipeline_models.csv" : "no model"; }
    }
    const relax = (fixed, target, start) => { // least squares over the lines, Gauss-Seidel
      const s = { ...start };
      const free = nodeIds.filter((id) => !out(id) && !(id in fixed) && (whatifLinesAt[id] || []).some((pid) => sign[pid]));
      for (let sweep = 0; sweep < 400; sweep++) {
        let moved = 0;
        for (const u of free) {
          let sum = 0, n = 0;
          for (const pid of whatifLinesAt[u] || []) {
            if (!sign[pid] || target[pid] == null) continue; // a line with an end that has no pressure
            const other = tail(pid) === u ? head(pid) : tail(pid), here = fixed[other] ?? s[other];
            if (here == null) continue;
            sum += tail(pid) === u ? here + target[pid] : here - target[pid];
            n++;
          }
          if (!n) continue;
          const v = Math.max(1, sum / n);
          moved = Math.max(moved, Math.abs(v - (s[u] ?? v)));
          s[u] = v;
        }
        if (moved < 1e-6) break;
      }
      return { ...s, ...fixed };
    };
    // a node with no reading of its own (a tie-in) takes today's from its lines
    const today = relax(s0, Object.fromEntries(edges.map((pid) => [pid, correction[pid] * model(pid, share[pid])])), {});
    const mean = (pid) => (lines[pid] ? (lines[pid].into + lines[pid].out) / 2 : 0);
    const target = Object.fromEntries(edges.filter((pid) => today[tail(pid)] != null && today[head(pid)] != null).map((pid) => [pid,
      today[tail(pid)] - today[head(pid)] + correction[pid] * (model(pid, mean(pid)) - model(pid, share[pid]))]));
    const anchors = {};
    for (const [id, p] of Object.entries(W.pressure)) if (!out(id)) anchors[id] = absBar(p) ** 2;
    const fed = new Set(), walk = Object.keys(anchors);
    while (walk.length) { const u = walk.pop(); for (const pid of outs[u] || []) if (!fed.has(head(pid))) { fed.add(head(pid)); walk.push(head(pid)); } }
    // Exits and gas plants hold today's pressure (onshore control, compressors), unless
    // a pressure you set feeds them.
    const fixed = { ...anchors };
    for (const id of nodeIds) {
      const held = assets[id].exit || assets[id].type === "processing";
      if (held && !out(id) && !fed.has(id) && !(id in anchors) && today[id] != null) fixed[id] = today[id];
    }
    const s = relax(fixed, target, today);
    const pressure = {}, pressureNow = {}; // a tie-in's pressure now is the model's, from its neighbours
    for (const id of nodeIds) {
      if (today[id] != null && (s0[id] != null || assets[id].type === "tee")) pressureNow[id] = Math.sqrt(today[id]) - PACK.pStd;
      if (!out(id) && s[id] != null && (s0[id] != null || assets[id].type === "tee")) pressure[id] = Math.sqrt(s[id]) - PACK.pStd;
    }
    const flows = {}, pack = {};
    for (const pid of pipeIds) {
      flows[pid] = lines[pid] ? sign[pid] * mean(pid) : 0;
      const at = (p, node) => p[node];
      if (lineVolume[pid]) pack[pid] = { now: linepackOf(pid, settleOutOf(at(pressureNow, assets[pid].from), at(pressureNow, assets[pid].to))), then: linepackOf(pid, settleOutOf(at(pressure, assets[pid].from), at(pressure, assets[pid].to))) };
    }
    const sum = (o) => Object.values(o).reduce((a, b) => a + (b || 0), 0);
    const nominated = sum(Object.fromEntries(whatifExits.filter((id) => !out(id)).map((id) => [id, nominations[id]])));
    // against the nominations, over the exits that have one
    const offNominations = whatifExits.filter((id) => !out(id) && nominations[id] != null).reduce((n, id) => n + (delivered[id] || 0) - nominations[id], 0);
    return {
      frame: { t: f.t, flows, metrics: { pressure_bar: pressure, nomination_msm3d: nominations }, plan: null },
      lines, supply, delivered, stranded, short, nominations, correction, from, pack, pressure, pressureNow,
      balance: { produced: sum(supply), packed: sum(Object.fromEntries(Object.entries(lines).map(([k, l]) => [k, l.into - l.out]))), delivered: sum(delivered), nominated, offNominations },
    };
  }
  /* A pressure's last 6 hours and the next 6 as the model sees them: one steady state an
     hour, from that hour's nominations, without your what-if values (Ray, 29 Oct: "if i
     mouse over one of the pressure squares it should show a comprehensive graph showing
     the pressure last 6 hours and then modelled pressure next 6 hour if we have
     steady-state"). Worked out once per data step for every node. */
  const NO_INPUTS = { offline: new Set(), supply: {}, offtake: {}, pressure: {}, pack: {}, scenario: "now" };
  let outlookCache = { key: null, hours: [] };
  function steadyAhead() {
    const key = `${live.index}|${live.stream ? live.stream.name : ""}`;
    if (outlookCache.key === key) return outlookCache.hours;
    const step = (live.stream && live.stream.step) || 3600, now = frame(), hours = [];
    for (let k = 1; k <= 6; k++) {
      const f = live.frames[live.index + Math.round((k * 3600) / step)], nominations = {};
      for (const id of whatifExits) {
        const ahead = live.feed ? (((now.ahead || {}).nomination_msm3d || {})[id] || [])[k - 1] : null;
        nominations[id] = (f ? metric("nomination_msm3d", id, f) : ahead) ?? metric("nomination_msm3d", id, now) ?? null;
      }
      hours.push({ t: (now.t || 0) + k * 3600, pressure: whatifSolve({ inputs: NO_INPUTS, nominations }).pressure });
    }
    outlookCache = { key, hours };
    return hours;
  }
  function pressureOutlook(id) {
    const step = (live.stream && live.stream.step) || 3600, n = Math.round((6 * 3600) / step), past = [];
    for (let i = Math.max(0, live.index - n); i <= live.index; i++) {
      const f = live.frames[i];
      if (f && metric("pressure_bar", id, f) != null) past.push({ t: f.t, p: metric("pressure_bar", id, f) });
    }
    const future = steadyAhead().map((hour) => ({ t: hour.t, p: hour.pressure[id] })).filter((r) => r.p != null);
    return { past, future, limits: (C.pressure_limits || {})[(assets[id] || {}).type] || null };
  }
  function pressureChart(id) {
    const o = pressureOutlook(id), now = frame().t, last = o.past[o.past.length - 1];
    if (!last || now == null) return null;
    const values = [...o.past, ...o.future].map((r) => r.p);
    let lo = Math.min(...values), hi = Math.max(...values);
    const room = Math.max(2, hi - lo), names = ["LL", "L", "H", "HH"];
    const near = (o.limits || []).slice(0, 4).map((v, i) => [names[i], v, i]).filter(([, v]) => v >= lo - room && v <= hi + room);
    lo = Math.min(lo, ...near.map(([, v]) => v)) - 0.5;
    hi = Math.max(hi, ...near.map(([, v]) => v)) + 0.5;
    const W = 300, H = 124, top = 10, plot = 86, x = (t) => 8 + ((t - (now - 6 * 3600)) / (12 * 3600)) * (W - 16);
    const y = (v) => top + plot - ((v - lo) / (hi - lo || 1)) * plot;
    const path = (rows) => rows.map((r, k) => `${k ? "L" : "M"}${x(r.t).toFixed(1)},${y(r.p).toFixed(1)}`).join("");
    const text = "stroke:none;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif";
    // the scale: the top and bottom of the plot, on the left
    let body = `<text x="8" y="${top + 8}" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(hi, 1))}</text><text x="8" y="${top + plot - 2}" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(lo, 1))}</text>`;
    for (const [name, v, i] of near) {
      body += `<line x1="8" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" stroke="${limitInk(i === 0 || i === 3 ? 2 : 1)}" stroke-width="1" stroke-dasharray="2 3"/>`;
      body += `<text x="${W - 8}" y="${y(v) - 3}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${name} ${fmt(v)}</text>`;
    }
    body += `<line x1="${x(now)}" x2="${x(now)}" y1="${top - 4}" y2="${top + plot}" stroke="${COLORS.text_dim}" stroke-width="1"/>`;
    body += `<path class="measured" d="${path(o.past)}" fill="none" stroke="${COLORS.text}" stroke-width="1.8"/>`;
    if (o.future.length) body += `<path class="modelled" d="${path([last, ...o.future])}" fill="none" stroke="${COLORS.peak}" stroke-width="1.8" stroke-dasharray="4 3"/>`;
    const end = o.future[o.future.length - 1];
    body += `<text x="8" y="${H - 4}" fill="${COLORS.text_dim}" style="${text}">−6 h</text>`;
    body += `<text x="${x(now)}" y="${H - 4}" text-anchor="middle" fill="${COLORS.text}" style="${text}">now ${esc(fmt(last.p, 1))}</text>`;
    body += `<text x="${W - 8}" y="${H - 4}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">+6 h ${end ? esc(fmt(end.p, 1)) : "–"}</text>`;
    return { title: `${nameOf(id)}, pressure in bar`, chart: svg(`0 0 ${W} ${H}`, body, "pressure-outlook"),
      note: "Solid: measured. Dashed: model, a steady state each hour from that hour's nominations." };
  }
  // Your values: set one, or clear it with null. Each change redraws everything.
  function setWhatif(kind, id, value) {
    const store = whatif[kind];
    if (value == null || value === "" || Number.isNaN(Number(value))) delete store[id];
    else store[id] = Number(value);
    whatifChanged();
  }
  function whatifChanged() {
    whatif.version++;
    whatif.cache = null;
    restyle();
    renderWhatif();
    renderSidebar(true);
    renderWhatifEditor(true);
  }
  /* What-if on the view itself (Ray, 29 Oct: "for the what if i should be able to add the
     number i want directly on the page view and then see what happens when i pull the
     timeline to the timeline in the future that i need to check"). In What-if a click on a
     node or a line opens its numbers right where you clicked: type one, Enter, and the
     network takes it; drag the timeline and the window follows the hour shown. */
  const editor = { el: null, id: null, at: null };
  function openWhatifEditor(id, at) {
    closeWhatifEditor();
    Object.assign(editor, { id, at, el: h("div", { class: "pop whatif-pop", role: "dialog", "aria-label": `What-if: ${nameOf(id)}` }) });
    document.body.append(editor.el);
    renderWhatifEditor(true);
    const first = editor.el.querySelector && editor.el.querySelector("input");
    if (first) first.focus();
  }
  function closeWhatifEditor() {
    if (editor.el) editor.el.remove();
    Object.assign(editor, { el: null, id: null, at: null });
  }
  function renderWhatifEditor(force = false) {
    if (!editor.el) return;
    if (state.mode !== "whatif") { closeWhatifEditor(); return; }
    const typing = document.activeElement && editor.el.contains && editor.el.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    if (typing && !force) return; // never under your fingers
    patch(editor.el, h("div", null,
      h("button", { type: "button", class: "close", "aria-label": "Close", title: "Close", onclick: closeWhatifEditor }, "×"),
      whatifCard(editor.id, true)));
    // Beside the click, inside the window (the pop is zoomed by the UI scale).
    const k = display.scale || 1, w = (editor.el.offsetWidth || 280) * k, ht = (editor.el.offsetHeight || 220) * k;
    const vw = globalThis.innerWidth || 1280, vh = globalThis.innerHeight || 800;
    editor.el.style.left = `${Math.max(8, Math.min(editor.at.x + 14, vw - w - 8)) / k}px`;
    editor.el.style.top = `${Math.max(8, Math.min(editor.at.y + 14, vh - ht - 8)) / k}px`;
  }
  // A press outside the window closes it (the click that opened it does not), except on the
  // timeline: moving it is the point, the window follows the hour.
  const inside = (el, target) => Boolean(el && el.contains && el.contains(target));
  addEventListener("pointerdown", (e) => { if (editor.el && !inside(editor.el, e.target) && !inside($("player"), e.target)) closeWhatifEditor(); }, true);
  addEventListener("keydown", (e) => { if (e.key === "Escape") closeWhatifEditor(); });
  function resetWhatif() {
    whatif.offline.clear();
    for (const kind of ["supply", "offtake", "pressure", "pack"]) whatif[kind] = {};
    whatifChanged();
  }
  const whatifChanges = () => whatif.offline.size + ["supply", "offtake", "pressure", "pack"].reduce((n, kind) => n + Object.keys(whatif[kind]).length, 0);
  function toggleOffline(id) {
    if (whatif.offline.has(id)) whatif.offline.delete(id);
    else whatif.offline.add(id);
    whatifChanged();
  }
  /* The What-if mode's own bar, bottom left of the network (clear of the panel on the
     right; Ray, 29 Oct: "when i click on take offline the restore button is blinking"): the
     scenario (now, or the next gas day's nominations), the balance in and out, how many
     values are yours, and Reset. Rebuilt only when what it says changes. */
  let whatifBar = null;
  function renderWhatif() {
    renderTop();
    if (state.mode !== "whatif") { if (whatifBar) { whatifBar.remove(); whatifBar = null; } return; }
    if (!whatifBar) {
      whatifBar = h("div", { class: "edits-bar whatif-bar", role: "status", "aria-live": "polite" });
      document.body.append(whatifBar);
    }
    const w = whatifState(), b = w.balance, n = whatifChanges(), off = b.offNominations;
    const said = `In ${fmt(b.produced, 1)}${Math.abs(b.packed) >= 0.05 ? `, packed ${signed(b.packed, 1)}` : ""}, out ${fmt(b.delivered, 1)} MSm³/d${b.nominated ? ` (${signed(off, 1)} on nominations)` : ""}`;
    replaceIfChanged(whatifBar, `${whatif.scenario}|${said}|${n}`, () => [
      h("div", { class: "seg whatif-scenario", role: "tablist", "aria-label": "What-if starts from" },
        ...[["now", "Now"], ["next", "Next gas day"]].map(([key, label]) => h("button", { type: "button", role: "tab", "aria-selected": String(whatif.scenario === key),
          onclick: () => { whatif.scenario = key; whatifChanged(); } }, label))),
      h("span", { class: "count" }, said),
      h("span", { class: "dim" }, n ? `${n} of your values` : "click an asset to change it"),
      n ? h("button", { type: "button", onclick: resetWhatif }, "Reset") : null,
    ].filter(Boolean));
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
  /* What a named line is, for the zoomed-in map (Ray, 28 Oct: "if i zoom in to areas on
     the map view more details should appear like pipeline diameter, pipline length"):
     its diameter and laid length from pipelines.csv, whichever are known. */
  const DETAIL_ZOOM = 6.5;
  function pipeDetail(id) {
    const d = assets[id];
    if (!d) return "";
    return [d.diameter ? `${fmt(d.diameter)}″` : "", d.length ? `${fmt(d.length)} km` : ""].filter(Boolean).join(" · ");
  }
  function pipeMapName(id) {
    const d = assets[id];
    if (!d || (!["trunk", "export", "interconnector"].includes(d.type) && id !== "ogt")) return "";
    if (id.startsWith("europipe_2")) return "Europipe II";
    if (id.startsWith("langeled_")) return "Langeled";
    if (d.name.startsWith("Heimskringla")) return "Heimskringla"; // one line, Oseberg to St Fergus and Draupner
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
    if (mode === "live" || mode === "whatif") {
      const v = lineFlow(id), w = mode === "whatif" ? whatifState() : null;
      if (w && (whatif.offline.has(id) || whatif.offline.has(d.from) || whatif.offline.has(d.to))) Object.assign(out, { color: COLORS.inactive, width: 1, dashed: true });
      else if (v === undefined) Object.assign(out, { color: COLORS.inactive, width: 1, dashed: true });
      else {
        const m = Math.abs(v);
        out.width = 1 + 4 * Math.sqrt(m / live.maxAbs);
        out.color = m < 0.05 ? COLORS.inactive : COLORS.active;
        // On the line its settle-out pressure (Ray read the line values as "settle out
        // pressure", and his Area D screen shows them there); its flow is in the squares.
        // The number alone (Ray, 29 Oct: "everyone knows what it is as it is in the center
        // of the pipeline").
        const sop = settleOut(id, viewFrame());
        out.label = sop == null ? "" : fmt(sop, 1);
        // shown only when the line packs or unpacks (in a what-if: your packing)
        const pack = w ? (w.lines[id] ? w.lines[id].into - w.lines[id].out : null) : packRate(id);
        out.pack = settings.pack && pack != null && Math.abs(pack) >= 0.5 ? `pack ${signed(pack, 1)}` : "";
        out.level = w ? 0 : levelOf(id);
        if (d.bidirectional) Object.assign(out, { forward: v >= 0, backward: v < 0 });
      }
    } else if (mode === "load") {
      out.color = d.utilization == null ? COLORS.inactive : COLORS.active;
      // How full, at a glance: a hairline when empty, thick when running full. A model
      // answer, not an alarm: no badge, no alarm colour (review #49802; alarms are Live).
      if (d.utilization != null) out.width = 0.6 + 2.6 * Math.min(1, d.utilization);
      out.label = d.utilization == null ? "" : `${fmt(d.utilization * 100)}%`;
      out.model = true; // the maps keep its weight and its number at every zoom
    } else if (mode === "risk") {
      // What a trip would cost, by line weight and the number: the model's N-1 answer,
      // never the alarm shapes and colours (review #49802: 15 red and orange badges
      // here while the top bar counted 4 alarms).
      if (d.lost && !onshore) out.width = 0.6 + 3.4 * Math.sqrt(d.lost / worst);
      out.label = d.lost ? `−${fmt(d.lost)}` : "";
      out.model = true;
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
    if (mode === "whatif" && whatif.offline.has(id)) { out.inactive = true; out.sub = "offline"; }
    else if (mode === "live" || mode === "whatif") {
      const f = viewFrame(), through = throughput(id, f.flows), p = metric("pressure_bar", id, f);
      const nom = metric("nomination_msm3d", id, f);
      out.level = mode === "live" ? levelOf(id) : 0;
      if (through != null && through < 0.05) out.inactive = true;
      out.flow = nom > 0 ? `${fmt(through, 1)} / ${fmt(nom, 1)}` : through != null ? fmt(through, 1) : "";
      out.pressure = p != null ? `${fmt(p)} bar` : "";
      out.sub = "";
    } else if (mode === "load" && d.modelFlow != null) {
      out.sub = `${fmt(d.modelFlow)} MSm³/d`;
    } else if (mode === "risk" && d.type !== "market") {
      out.scale = 0.75 + 0.9 * Math.sqrt(d.lost / worst);
      out.sub = d.lost ? `−${fmt(d.lost)} if it trips` : "No loss if it trips";
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
    // Only the critical limits (Ray, 29 Oct: "too much clutter here, simplify it a bit"):
    // the band is the normal range, the marker the value.
    for (const tick of ticks.filter((t) => t.level === 3)) {
      const tx = x(tick.at), tall = 3 + 2 * tick.level;
      m += `<line x1="${tx}" x2="${tx}" y1="${14.5 - tall}" y2="${14.5 + tall}" stroke="${COLORS.text}" stroke-width="${tick.level === 3 ? 1.6 : 1}"/>`;
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
  /* Time to a limit (hub 3604; Ray, 27 Oct: "more visual ways of showing how values are
     heading towards what limit"): at the rate of the last steps, the nearest limit ahead
     in the direction the value moves, when it is reached within the plan's look-ahead.
     Plain words, no colour: a projection, not an alarm. */
  function toLimit(ind) {
    const known = ind.series.filter((v) => v != null), v = known[known.length - 1], r = rate(ind.series);
    if (!ind.limits || r == null || v == null || Math.abs(r) < 1e-6) return null;
    const ahead = ind.limits.filter((l) => (r > 0 ? l.at > v : l.at < v)).sort((a, b) => Math.abs(a.at - v) - Math.abs(b.at - v))[0];
    const hours = ahead ? (ahead.at - v) / r : null;
    if (!(hours > 0 && hours <= (T.plan_lookahead_hours || 6))) return null;
    return `${ahead.name} in ~${hours < 1 ? `${Math.max(5, Math.round((hours * 60) / 5) * 5)} min` : `${fmt(hours, 1)} h`}`;
  }
  const toLimitText = (ind) => { const text = toLimit(ind); return text ? h("span", { class: "to-limit" }, text) : null; };
  function rateText(r, unit) {
    if (r == null) return h("span", { class: "dim" }, "–");
    if (Math.abs(r) < 0.05) return h("span", { class: "dim" }, ""); // steady: nothing to say
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
      // Booked capacity only: delivery follows a moving nomination, so the nomination's
      // own band is no fixed limit to project toward.
      limits: booked ? [{ at: booked, name: "booked capacity" }] : [],
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
      limits: (C.pressure_limits || {})[assets[id].type]
        ? C.pressure_limits[assets[id].type].map((at, i) => ({ at, name: ["low-low limit", "low limit", "high limit", "high-high limit", "integrity limit"][i] }))
        : [{ at: low, name: "minimum" }, { at: high, name: "maximum" }],
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
      limits: [{ at: limits[0], name: "warning level" }, { at: limits[2], name: "limit" }],
      value: `${qualityText(name, v)}, limit ${limits[2]}`,
    };
  }
  function loadIndicator(id) {
    const d = assets[id], v = Math.abs(frame().flows[id] || 0), u = v / d.capacity;
    return {
      id, measure: "Load", unit: "pts", lvl: level(u, T.load), band: [0, T.load[0] * 100],
      bar: rangeBar({ min: 0, max: 1.1, value: u, lvl: level(u, T.load), band: [0, T.load[0]], ticks: T.load.map((at, i) => ({ at, level: i + 1 })) }),
      series: series((f) => (f.flows[id] == null ? null : (Math.abs(f.flows[id]) / d.capacity) * 100)),
      limits: [{ at: 100, name: "capacity" }],
      value: `${fmt(u * 100)}%: ${fmt(v, 1)} of ${fmt(d.capacity)} MSm³/d`,
    };
  }
  /* A bank of indicators. Across assets (the overview) each row is named after its
     asset; for one asset (its page or sidebar) after what it measures, so the rows
     read "Delivery", "Pressure" instead of the asset's name twice. */
  function bank(indicators, empty, { byMeasure = false } = {}) {
    if (!indicators.length) return h("p", { class: "empty" }, empty);
    // One asset's values (a panel) need no column heads: the rows say what they are.
    const heads = byMeasure ? [] : [h("div", { class: "head" }, "Asset"), h("div", { class: "head" }, "Value in its range"),
      h("div", { class: "head" }, `Last ${spanLabel(TREND_STEPS * stepHours() * 3600)}`), h("div", { class: "head optional" }, "Change"), h("div", { class: "head optional" }, "State")];
    return h("div", { class: `bank${byMeasure ? " by-measure" : ""}` },
      ...heads,
      ...indicators.flatMap((ind) => [
        byMeasure ? h("div", { class: "name measure" }, ind.measure || nameOf(ind.id))
          : h("div", pressable(`asset:${ind.id}`, () => go({ screen: "asset", asset: ind.id }), { class: "name", role: "link", title: "Open the asset" }), nameOf(ind.id)),
        h("div", null, ind.bar, h("div", { class: "value" }, ind.value, h("span", { class: "rate-inline" }, rateText(rate(ind.series), ind.unit), toLimitText(ind)))),
        trend(ind.series, { band: ind.band, lvl: ind.lvl }),
        h("div", { class: "rate" }, rateText(rate(ind.series), ind.unit), toLimitText(ind)),
        h("div", { class: "state optional" }, badge(ind.lvl)),
      ]));
  }
  // When an alarm began; "by" when it was already active as the playhead arrived.
  function sinceTime(since) {
    if (!since || since.t == null) return h("time", null, "");
    return since.before
      ? h("time", { title: "Already active when the playhead arrived: it may have begun earlier" }, `by ${shortTime(since.t)}`)
      : h("time", { title: "When this alarm began" }, shortTime(since.t));
  }
  // Acknowledge: the operator has seen it. The button never opens the asset under it.
  function ackButton(conditions, label = "Ack") {
    const open = conditions.filter((c) => !c.acked);
    if (!open.length) return null;
    return h("button", { type: "button", class: "ack", "data-key": `ack:${open.map(alarmKey).join(",")}`,
      title: open.length === 1 ? "Acknowledge this alarm" : `Acknowledge ${open.length} alarms`,
      onkeydown: (e) => { if (e && e.stopPropagation) e.stopPropagation(); }, // Enter acks; it never opens the row
      onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); alarmHandling.ack(open); evaluate(); refreshScreens(); } }, label);
  }
  function alarmList(conditions) {
    if (!conditions.length) return h("p", { class: "empty" }, "No active alarms. Everything is in its normal range.");
    return h("ul", { class: "alarm-list" }, conditions.map((c) =>
      h("li", { ...(assets[c.id] ? pressable(`alarm:${c.kind}|${c.id}`, () => go({ screen: "asset", asset: c.id }), { role: "link", title: `Open ${nameOf(c.id)}` }) : {}),
        class: c.acked ? "acked" : null },
        badge(c.level, ""), h("span", null, c.text), h("span", { class: "alarm-end" }, sinceTime(c.since), c.acked ? h("span", { class: "dim small" }, "Acked") : ackButton([c])))));
  }
  /* The alarm summary on the Overview: how many wait for an acknowledgement, the oldest
     of them, and the rate over the last hour of data, with a flood above 10 in 10
     minutes (ISA-18.2's benchmark for one operator). */
  function alarmSummary() {
    const all = live.conditions, open = all.filter((c) => !c.acked), now = live.time;
    if (!all.length && !live.shelved.length) return null;
    const began = (c, s) => c.since && !c.since.before && c.since.t != null && now - c.since.t <= s;
    const hour = all.filter((c) => began(c, 3600)).length, ten = all.filter((c) => began(c, 600)).length;
    const oldest = open.map((c) => c.since && c.since.t).filter((t) => t != null).sort((a, b) => a - b)[0];
    return h("div", { class: "alarm-summary" },
      h("span", null, open.length ? `${open.length} unacknowledged${oldest != null ? `, oldest ${shortTime(oldest)}` : ""}` : "All acknowledged"),
      h("span", { class: "dim" }, `${hour} raised in the last hour`),
      ten > 10 ? h("span", { class: "flood" }, badge(2, `Alarm flood: ${ten} in 10 min`)) : null,
      live.shelved.length ? h("span", { class: "dim" }, `${live.shelved.length} shelved`) : null,
      ackButton(all, "Acknowledge all"));
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
        h("tbody", null, rows.map((s) => h("tr", pressable(`slug:${s.q.slug}`, () => go({ screen: "asset", asset: s.q.arrived ? s.q.arrived.node : s.q.pid }), { title: "Open where it is now" }),
          h("td", null, swatch(s.q.metric), ` ${QUALITY[s.q.metric].name} from ${nameOf(s.q.origin)}`),
          h("td", null, fmt(s.q.conc, QUALITY[s.q.metric].digits), ` ${QUALITY[s.q.metric].unit}`),
          h("td", null, s.q.arrived ? `Arrived at ${nameOf(s.q.arrived.node)}` : `${nameOf(s.next.node)}, ${etaText(s.next.t)}`),
          h("td", null, s.exit ? `${nameOf(s.exit.node)}, ${fmt(s.exit.conc, QUALITY[s.q.metric].digits)} ${QUALITY[s.q.metric].unit}, ${etaText(s.exit.t)}` : "No exit on today's flows"),
          h("td", null, badge(slugAlarm(s), ""))))))
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
      return h("button", { type: "button", "data-key": `unit:${u.id}`, onclick: () => go({ screen: "unit", unit: u.id }) },
        h("span", null, u.name), badge(Math.max(0, ...conds.map((c) => c.level)), conds.length ? `${conds.length} active` : "Normal"));
    });
    keepFocus(screens.overview, () => patch(screens.overview, h("div", { class: "screen-body" },
      h("div", { class: `box banner${bannerLevel ? " alarm" : ""}`, style: bannerLevel ? `border-color:${LEVEL_COLOR[bannerLevel]}` : null },
        bannerLevel ? badge(bannerLevel, "") : null,
        h("div", null, h("div", { class: `big${plan ? "" : " dim"}` }, headline), h("div", { class: "context" }, context))),
      plan && plan.advice ? decisionBox(plan.advice) : null,
      h("div", { class: "cols" },
        h("div", { class: "box" }, h("h2", null, "Exit points: actual flow against the hourly nomination"),
          bank(exits.map(exitIndicator), "No exit-point readings in this dataset.")),
        nominationsBox(exits),
        h("div", { class: "box" }, h("h2", null, "Active alarms"), alarmSummary(), alarmList(live.conditions.slice(0, 12))),
        qualityBox(),
        h("div", { class: "box" }, h("h2", null, "Pressures at plants, hubs and terminals"),
          bank(pressures.slice(0, 10).map(pressureIndicator), "No pressure readings in this dataset.")),
        h("div", { class: "box" }, h("h2", null, "Busiest pipelines"), bank(loaded.map(loadIndicator), "No flow readings yet.")),
        h("div", { class: "box" }, h("h2", null, "Units"), h("div", { class: "units" }, units))))));
  }

  /* The next 6 hours of nominations at each exit point (Ray, 29 Oct: "origo integration
     for hourly nominations from the shippers at each exitpoint, this should be shown in
     both absolute numbers but in a visual minimalistic way. what is important are rate
     of change at each exit point for the next 6 hours"). Per exit: the nomination now
     and in six hours, the hourly steps as a hairline, and the steepest hourly change
     ahead with when it starts; a fast ramp is marked (nora.toml [thresholds] step, as
     a share of the nomination now). */
  function rampAhead(id) {
    if (whatifOn()) return null; // the what-if is one steady hour
    const hours = nominationWindow(id);
    if (hours[0].value == null) return null;
    let steepest = null;
    for (let k = 1; k < hours.length; k++) {
      if (hours[k].value == null || hours[k - 1].value == null) continue;
      const change = hours[k].value - hours[k - 1].value;
      if (!steepest || Math.abs(change) > Math.abs(steepest.change)) steepest = { change, t: hours[k].t };
    }
    const values = hours.map((r) => r.value).filter((v) => v != null);
    const share = steepest ? Math.abs(steepest.change) / Math.max(1, hours[0].value) : 0;
    return { hours, now: hours[0].value, last: values[values.length - 1], steepest, level: level(share, T.step) };
  }
  /* Lookahead (Ray, 29 Oct: "it should be easy to see if a nomination increase at an exit
     point in the future and we dont increase the input flow into that pipeline, we wont be
     able to reach the nomination level because the exit point pressure will be too low.
     seeing this into the future as a lookahead function should be ongoing calculations being
     done and shown / illustrated in a suble and minimalstic way"). Worked out at every step
     for each exit and its next hours: with the gas into its line(s) held at now's rate,
     each hour the exit is nominated more than that draws on the line pack, and the line's
     pressure falls by the gas drawn over the line's pack per bar (its volume). An hour the
     exit's pressure would fall under its low limit (nora.toml [pressure_limits]) is short:
     marked in place, a model estimate. */
  const packPerBar = (pid) => (lineVolume[pid] / PACK.pStd) * (PACK.tStd / PACK.tSea) / PACK.z / 1e6; // MSm³ per bar
  function reachAhead(id) {
    return cached("reach", id, () => {
      const ramp = rampAhead(id), f = frame(), d = assets[id], limits = (C.pressure_limits || {})[d.type];
      const pNow = metric("pressure_bar", id, f);
      if (!ramp || !limits || pNow == null || pNow < limits[1]) return null; // already under it: that is an alarm now
      const lines = pipeIds.filter((pid) => { const v = f.flows[pid] || 0; return lineVolume[pid] && ((assets[pid].to === id && v > 0.05) || (assets[pid].from === id && v < -0.05)); });
      if (!lines.length) return null;
      const input = lines.reduce((sum, pid) => sum + Math.abs(f.flows[pid]), 0), perBar = lines.reduce((sum, pid) => sum + packPerBar(pid), 0);
      const low = limits[1];
      let drawn = 0; // MSm³ out of the line(s) more than into them
      const hours = ramp.hours.map((hour, k) => {
        if (k === 0) return { ...hour, pressure: pNow, short: false };
        if (hour.value == null) return { ...hour, pressure: null, short: false };
        drawn += Math.max(0, hour.value - input) * ((hour.t - ramp.hours[k - 1].t) / 86400);
        const pressure = pNow - drawn / perBar;
        return { ...hour, pressure, short: pressure < low };
      });
      return { hours, low, input, first: hours.find((hour) => hour.short) || null };
    });
  }
  function nominationSteps(hours, reach = null) {
    const values = hours.map((r) => r.value), known = values.filter((v) => v != null);
    const lo = Math.min(...known), hi = Math.max(...known), span = hi - lo || 1;
    const y = (v) => (18 - ((v - lo) / span) * 14).toFixed(1);
    let path = "";
    values.forEach((v, k) => {
      if (v == null) return;
      path += `${path ? "L" : "M"}${k * 18},${y(v)}H${(k + 1) * 18}`;
    });
    // An hour the exit's pressure would be short (reachAhead): its step in the warning colour.
    const short = (reach ? reach.hours : []).map((hour, k) => (hour.short && values[k] != null
      ? `<path d="M${k * 18},${y(values[k])}H${(k + 1) * 18}" fill="none" stroke="${limitInk(1)}" stroke-width="2.2"/>` : "")).join("");
    return svg("0 0 108 22", `<path d="${path}" fill="none" stroke="${COLORS.text}" stroke-width="1.2"/>${short}`, "steps"); // numbers and palette colours only
  }
  function nominationsBox(exits) {
    const rows = exits.map((id) => ({ id, ramp: rampAhead(id), reach: reachAhead(id) })).filter((r) => r.ramp)
      .sort((a, b) => b.ramp.level - a.ramp.level || Math.abs((b.ramp.steepest || {}).change || 0) - Math.abs((a.ramp.steepest || {}).change || 0));
    const hm = (t) => timeFormat(t, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" });
    const source = live.feed ? "From Origo, the shippers' nominations." : `From the dataset${live.stream && live.stream.synthetic ? " (synthetic)" : ""}; live, from Origo.`;
    return h("div", { class: "box" }, h("h2", null, "Nominations at the exit points, next 6 hours"),
      rows.length ? h("ul", { class: "noms" }, rows.map(({ id, ramp, reach }) => {
        const s = ramp.steepest, steady = !s || Math.abs(s.change) < 0.05;
        // A button, so the keyboard reaches every row (as everything on this screen)
        return h("li", null, h("button", { type: "button", class: "nom-row", onclick: () => go({ screen: "asset", asset: id }), title: "Hourly nominations, now and the next 5 hours (MSm³/d)" },
          h("span", { class: "name" }, nameOf(id)),
          h("span", { class: "values" }, `${fmt(ramp.now, 1)} → ${fmt(ramp.last, 1)}`),
          nominationSteps(ramp.hours, reach),
          h("span", { class: "ramp" }, steady ? h("span", { class: "dim" }, "steady")
            : `${s.change > 0 ? "▲" : "▼"} ${fmt(Math.abs(s.change), 1)}/h at ${hm(s.t)}`),
          reach && reach.first
            ? h("span", { class: "short", style: `color:${limitInk(1)}`, title: `Model estimate: with the input as now, ${nameOf(id)} would be at ${fmt(reach.first.pressure, 1)} bar at ${hm(reach.first.t)}, under its ${fmt(reach.low)} bar low limit: raise the input to the line before then.` }, `short ${hm(reach.first.t)}`)
            : ramp.level ? badge(ramp.level, "Fast ramp") : h("span", null)));
      })) : h("p", { class: "empty" }, "No nominations in this dataset."),
      h("p", { class: "dim small" }, `${source} MSm³/d; times CET.`));
  }

  /* The next 6 hours at an exit: for each hour the booked capacity (outlined) and the
     nomination (filled) side by side (Ray, 29 Oct: "two bars next to eachother for each
     hour, booking level and nomination level"). A nomination over its booking takes a
     muted yellow, and from the booking's critical level (nora.toml booking) a muted red
     ("not strong color"); the hour's nomination is written over its pair. */
  const muted = (lvl) => mix(LEVEL_COLOR[lvl], COLORS.surface, 0.35);
  function bookingLevel(nominated, booked) {
    if (nominated == null || !(booked > 0) || nominated <= booked) return 0;
    return nominated / booked >= T.booking[2] ? 3 : 1;
  }
  /* The gas day at an exit, cumulative: the nominated gas as a dashed line to the end of
     the day (its end-of-day target; later hours from the data's nominations, else the last
     one held), the delivered gas solid up to now (Ray, 29 Oct: "the end of day target to
     exit points changes over time and this need to be illustrated as well"). */
  function gasDayChart(id) {
    const day = dayDelivery(id);
    if (!day || !day.hours.length) return null;
    const step = stepHours(), per = step / 24; // MSm³ per data step at a rate in MSm³/d
    const n = Math.round(24 / step), past = day.hours.length;
    const noms = day.hours.map((r) => r.nominated);
    for (let k = 1; noms.length < n; k++) {
      const f = live.frames[live.index + k], ahead = live.feed ? (((frame().ahead || {}).nomination_msm3d || {})[id] || [])[k - 1] : null;
      const v = f ? metric("nomination_msm3d", id, f) : ahead;
      noms.push(v ?? noms[noms.length - 1]);
    }
    const cum = (values) => values.reduce((out, v) => [...out, (out.length ? out[out.length - 1] : 0) + v * per], []);
    const nominated = cum(noms), delivered = cum(day.hours.map((r) => r.delivered));
    const target = nominated[n - 1], top = Math.max(target, ...delivered) * 1.06 || 1;
    const W = 360, H = 104, plot = 76, x = (k) => ((k + 1) / n) * (W - 4) + 2, y = (v) => 8 + plot - (v / top) * plot;
    const text = "stroke:none;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif";
    const path = (values) => values.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
    let body = `<line x1="0" y1="${8 + plot}" x2="${W}" y2="${8 + plot}" stroke="${COLORS.border}"/>`;
    body += `<path class="gasday-nominated" d="M2,${8 + plot}L${path(nominated).slice(1)}" fill="none" stroke="${COLORS.peak}" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    body += `<path class="gasday-delivered" d="M2,${8 + plot}L${path(delivered).slice(1)}" fill="none" stroke="${COLORS.text}" stroke-width="1.8"/>`;
    body += `<line x1="${x(past - 1)}" y1="6" x2="${x(past - 1)}" y2="${8 + plot}" stroke="${COLORS.text_dim}" stroke-width="1"/>`;
    body += `<text x="${W}" y="${Math.max(11, y(target) - 4)}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">Target ${esc(fmt(target, 1))}</text>`;
    const start = String(new Date(day.dayStart * 1000).getUTCHours()).padStart(2, "0");
    body += `<text x="2" y="${H - 4}" fill="${COLORS.text_dim}" style="${text}">${start}:00</text><text x="${W}" y="${H - 4}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${start}:00</text>`;
    body += `<text x="${x(past - 1)}" y="${H - 4}" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">now ${esc(fmt(delivered[past - 1], 1))} of ${esc(fmt(nominated[past - 1], 1))}</text>`;
    return svg(`0 0 ${W} ${H}`, body, "gasday-chart");
  }
  function nominationHistogram(id) {
    const readings = nominationWindow(id);
    if (!readings.some((reading) => reading.value != null)) return null;
    const W = 360, H = 130, baseline = 88, slot = W / 6, bar = 15;
    const peak = Math.max(1, ...readings.flatMap((reading) => [reading.value || 0, reading.booked || 0]));
    const text = "stroke:none;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif";
    let body = `<line x1="0" y1="${baseline}" x2="${W}" y2="${baseline}" stroke="${COLORS.border}" stroke-width="1"/>`;
    readings.forEach((reading, index) => {
      const center = slot * (index + 0.5), hour = String(new Date(reading.t * 1000).getUTCHours()).padStart(2, "0");
      const tall = (v) => Math.max(1, (v / peak) * 56);
      if (reading.booked != null) {
        const height = tall(reading.booked);
        body += `<rect class="booking-bar" x="${center - bar - 1}" y="${baseline - height + 0.5}" width="${bar}" height="${height - 0.5}" rx="2" fill="${COLORS.active}" stroke="${COLORS.text_dim}" stroke-width="1"/>`;
      }
      if (reading.value != null) {
        const height = tall(reading.value), y = baseline - height, lvl = bookingLevel(reading.value, reading.booked);
        const fill = lvl ? muted(lvl) : COLORS.peak; // a calm grey-blue, apart from the light booking
        body += `<rect class="nomination-bar${lvl ? " over" : ""}" x="${center + 1}" y="${y}" width="${bar}" height="${height}" rx="2" fill="${fill}" opacity="${index === 0 || lvl ? 1 : 0.72}"/>`;
        const top = Math.min(y, reading.booked != null ? baseline - tall(reading.booked) : y);
        body += `<text x="${center}" y="${Math.max(11, top - 4)}" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(reading.value, reading.value < 10 ? 1 : 0))}</text>`;
      }
      body += `<text x="${center}" y="106" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">${hour}</text>`;
    });
    // A key: booked outlined, nominated filled.
    body += `<rect x="0.5" y="117" width="10" height="9" rx="1.5" fill="${COLORS.active}" stroke="${COLORS.text_dim}"/><text x="14" y="125" fill="${COLORS.text_dim}" style="${text}">Booked</text>`;
    body += `<rect x="64" y="117" width="10" height="9" rx="1.5" fill="${COLORS.peak}"/><text x="78" y="125" fill="${COLORS.text_dim}" style="${text}">Nominated</text>`;
    body += `<rect x="146" y="117" width="10" height="9" rx="1.5" fill="${muted(1)}"/><text x="160" y="125" fill="${COLORS.text_dim}" style="${text}">over booking</text>`;
    return svg(`0 0 ${W} ${H}`, body, "nomination-histogram");
  }

  /* An asset in the what-if: your values (temporary: Reset clears them) and what follows
     from them, now → what-if (Ray, 29 Oct: "when clicking on a node i should be able to
     add my own flow and pressure values that are temporary"). */
  function whatifCard(id, compact = false) {
    const d = assets[id], w = whatifState(), f = frame(), next = whatif.scenario === "next";
    const row = (label, value) => [h("dt", null, label), h("dd", null, value)];
    const turn = (a, b, unit, digits = 1) => (a == null && b == null ? "–" : `${a == null ? "–" : fmt(a, digits)} → ${b == null ? "–" : fmt(b, digits)} ${unit}`);
    const input = (kind, label, placeholder, unit) => {
      const yours = whatif[kind][id] != null;
      const el = h("input", { type: "number", step: "0.1", inputmode: "decimal", class: yours ? "yours" : "", "data-key": `whatif:${kind}:${id}`, "aria-label": `${label} (${unit})`, placeholder });
      if (yours) el.value = String(whatif[kind][id]);
      el.addEventListener("change", () => setWhatif(kind, id, el.value.trim() === "" ? null : Number(el.value)));
      return h("label", null, `${label}, ${unit}`, el);
    };
    const offline = h("button", { type: "button", "data-key": `whatif:offline:${id}`, onclick: () => toggleOffline(id) },
      whatif.offline.has(id) ? "Bring back" : "Take offline");
    const inputs = [], facts = [];
    if (d.kind === "node") {
      const through = throughput(id, w.frame.flows), pNow = metric("pressure_bar", id, f), pThen = w.pressure[id];
      if (d.supply && !next) inputs.push(input("supply", "Production", fmt(productionNow(id, f), 1), "MSm³/d"));
      if (d.exit && next) inputs.push(input("offtake", "Offtake", w.nominations[id] == null ? "" : fmt(w.nominations[id], 1), "MSm³/d"));
      if (pNow != null) inputs.push(input("pressure", "Pressure", fmt(pNow, 1), "bar"));
      facts.push(row("Flow", turn(throughput(id, f.flows), through, "MSm³/d")));
      if (d.supply && next) facts.push(row("Production needed", `${fmt(w.supply[id] || 0, 1)} MSm³/d${d.capacity && (w.supply[id] || 0) > d.capacity ? `, over its ${fmt(d.capacity)}` : ""}`));
      if (d.exit) facts.push(row("Delivered", `${fmt(w.delivered[id] || 0, 1)} of ${w.nominations[id] == null ? "–" : fmt(w.nominations[id], 1)} nominated`));
      if (pNow != null || pThen != null) {
        const mark = pThen != null ? pressureMark(id, pThen) : null;
        facts.push(row("Pressure", h("span", mark ? { style: `color:${mark.ink}` } : null, `${turn(pNow, pThen, "bar")}${mark ? ` (${mark.code})` : ""}`)));
      }
      if (w.stranded[id]) facts.push(row("Nowhere to go", `${fmt(w.stranded[id], 1)} MSm³/d`));
    } else {
      const l = w.lines[id], m = MODELS[id], pack = w.pack[id], end = (node) => [w.pressureNow[node], w.pressure[node]];
      inputs.push(input("pack", "Packing", "0", "MSm³/d"));
      facts.push(row("Flow", l ? (Math.abs(l.into - l.out) >= 0.05 ? `${fmt(l.into, 1)} in, ${fmt(l.out, 1)} out MSm³/d` : `${fmt(l.into, 1)} MSm³/d`) : "none"));
      if (d.capacity && l) facts.push(row("Load", `${fmt((Math.max(l.into, l.out) / d.capacity) * 100)} % of ${fmt(d.capacity)}`));
      facts.push(row(`Pressure at ${nameOf(d.from)}`, turn(...end(d.from), "bar")));
      facts.push(row(`Pressure at ${nameOf(d.to)}`, turn(...end(d.to), "bar")));
      if (pack) facts.push(row("Line pack", `${turn(pack.now, pack.then, "MSm³", 2)}${pack.now != null && pack.then != null ? ` (${signed(pack.then - pack.now, 2)})` : ""}`));
      if (w.short[id]) facts.push(row("Packing", "more than it takes in: it delivers nothing"));
      facts.push(row("Regression", m ? `p₁² − p₂² = c (${fmt(m.a, 3)} Q² + ${fmt(m.b, 3)} Q), c ${fmt(w.correction[id] ?? m.correction, 2)} from ${w.from[id] || "the file"}` : "none: its pressure passes through"));
    }
    return h("div", { class: `box whatif-card${compact ? " compact" : ""}` }, h("h2", null, compact ? nameOf(id) : next ? "What-if: next gas day" : "What-if"),
      inputs.length ? h("div", { class: "whatif-inputs" }, ...inputs) : null,
      h("dl", { class: "facts" }, ...facts.flat()),
      h("div", { class: "actions" }, offline),
      compact ? null : h("p", { class: "dim small" }, "Model estimate, steady state: flows in today's directions and shares; pressures from each line's regression, corrected to today's pressures, with exits and gas plants holding theirs. Your values are temporary: Reset clears them."));
  }
  /* A field's export gas as its GC reads it (Ray, 29 Oct: "when i for instance click on a
     field like Oseberg i need to see the GC (gass chromotograph) values in a table like C1
     Metan, C2 Etan, C3 Propan etc all the way to C6+ and then CO2, N2, how rich the gas is
     ..., wobbe index, H2S, O2, WDP and HCDP"). How rich the gas is (its gross calorific
     value), the Wobbe index and the relative density are worked out from the composition
     (ISO 6976, ideal gas, 15 °C / 15 °C); the rest are readings. A value past its sales-gas
     limit takes the limit colour on its number. */
  const GC = [ // key, symbol, name, molar mass (g/mol), gross calorific value (MJ/m³)
    ["c1", "C1", "Methane", 16.043, 37.706], ["c2", "C2", "Ethane", 30.069, 66.07], ["c3", "C3", "Propane", 44.097, 93.94],
    ["ic4", "iC4", "i-Butane", 58.123, 121.4], ["nc4", "nC4", "n-Butane", 58.123, 121.79], ["ic5", "iC5", "i-Pentane", 72.15, 149.36],
    ["nc5", "nC5", "n-Pentane", 72.15, 149.66], ["c6plus", "C6+", "Hexanes and heavier", 86.177, 177.55],
    ["co2", "CO₂", "Carbon dioxide", 44.01, 0], ["n2", "N₂", "Nitrogen", 28.014, 0],
  ];
  // Sales-gas limits for the colour: typical of North Sea export specifications, illustrative.
  const GC_LIMITS = { wobbe: [47.2, 51.41], hcdp: [null, -2], wdp: [null, -8], o2: [null, 10] };
  function gasQuality(id, f = frame()) {
    const mol = Object.fromEntries(GC.map(([k]) => [k, metric(`${k}_molpct`, id, f)]));
    if (mol.c1 == null) return null;
    let gcv = 0, molar = 0;
    for (const [k, , , m, hv] of GC) { const x = (mol[k] || 0) / 100; gcv += x * hv; molar += x * m; }
    const density = molar / 28.9626;
    return { mol, gcv, density, wobbe: gcv / Math.sqrt(density), h2s: metric("h2s_ppm", id, f), o2: metric("o2_ppm", id, f), wdp: metric("wdp_c", id, f), hcdp: metric("hcdp_c", id, f) };
  }
  function gcBox(id) {
    const q = gasQuality(id);
    if (!q) return null;
    const past = (v, [lo, hi] = []) => v != null && ((lo != null && v < lo) || (hi != null && v > hi));
    const cell = (v, digits, limits) => h("td", past(v, limits) ? { style: `color:${limitInk(1)};font-weight:600` } : null, v == null ? "–" : fmt(v, digits));
    const h2sLimit = C.quality.h2s_ppm[2];
    return h("div", { class: "box gc" }, h("h2", { title: "The field's export gas, as its gas chromatograph reads it" }, "Gas composition (GC)"),
      h("table", { class: "data gc-table" },
        h("thead", null, h("tr", null, h("th", null, "Component"), h("th", null, "mol %"))),
        h("tbody", null, ...GC.map(([k, symbol, name]) => h("tr", null, h("td", null, `${symbol} ${name}`), cell(q.mol[k], k === "c1" ? 2 : 3))))),
      h("table", { class: "data gc-table" },
        h("thead", null, h("tr", null, h("th", null, "Property"), h("th", null, "Value"), h("th", null, "Limit"))),
        h("tbody", null,
          h("tr", null, h("td", null, "Calorific value (GCV), MJ/Sm³"), cell(q.gcv, 2), h("td", { class: "dim" }, "")),
          h("tr", null, h("td", null, "Wobbe index, MJ/Sm³"), cell(q.wobbe, 2, GC_LIMITS.wobbe), h("td", { class: "dim" }, `${GC_LIMITS.wobbe[0]}–${GC_LIMITS.wobbe[1]}`)),
          h("tr", null, h("td", null, "Relative density"), cell(q.density, 3), h("td", { class: "dim" }, "")),
          h("tr", null, h("td", null, "H₂S, ppm"), cell(q.h2s, 1, [null, h2sLimit]), h("td", { class: "dim" }, `≤ ${h2sLimit}`)),
          h("tr", null, h("td", null, "O₂, ppm"), cell(q.o2, 1, GC_LIMITS.o2), h("td", { class: "dim" }, `≤ ${GC_LIMITS.o2[1]}`)),
          h("tr", null, h("td", null, "Water dew point (WDP), °C"), cell(q.wdp, 1, GC_LIMITS.wdp), h("td", { class: "dim" }, `≤ ${GC_LIMITS.wdp[1]}`)),
          h("tr", null, h("td", null, "Hydrocarbon dew point (HCDP), °C"), cell(q.hcdp, 1, GC_LIMITS.hcdp), h("td", { class: "dim" }, `≤ ${GC_LIMITS.hcdp[1]}`)))),
      h("p", { class: "dim small" }, `${live.stream && live.stream.synthetic ? "Synthetic readings. " : ""}Calorific value, Wobbe index and density worked out from the composition (ISO 6976, ideal gas, 15 °C); limits typical of export gas, illustrative.`));
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
      inSidebar && whatifOn() ? whatifCard(id) : null,
      inSidebar ? null : h("h1", null, d.name),
      inSidebar ? null : h("p", { class: "sub" }, d.kind === "node"
        ? `${NORA.nodeTypes[d.type]}, ${d.country}. Unit: ${(unitById[unitOf[id]] || {}).name || "none"}.`
        : `${NORA.pipelineTypes[d.type]}, ${nameOf(d.from)} to ${nameOf(d.to)}.`),
      h("div", { class: "cols" },
        h("div", { class: "box" }, h("h2", { title: "Flowing in above the asset, out below it" }, "In context"), schematic(id)),
        h("div", { class: "box" }, h("h2", { title: "Live readings in their ranges, from the data being played" }, "Values"),
          metric("air_temp_c", id) != null ? h("p", { class: "outside" }, `Outside ${fmt(metric("air_temp_c", id), 1)} °C`) : null,
          bank(indicators, "No live readings for this asset in the dataset.", { byMeasure: true }),
          exitPoints.includes(id) && dayDelivery(id) ? h("div", { class: "nomination-outlook" }, h("h2", { style: "margin-top:14px" }, "Gas day · MSm³ delivered against nominated"), gasDayChart(id)) : null,
          exitPoints.includes(id) ? h("div", { class: "nomination-outlook" }, h("h2", { style: "margin-top:14px" }, "Next 6 hours · MSm³/d"), nominationHistogram(id)) : null,
          inSidebar ? null : h("h2", { style: "margin-top:14px" }, "State"),
          conds.length ? alarmList(conds)
            : h("p", { class: "state-quiet" }, "Normal · no alarms right now"),
          conds.length ? (() => { const cause = upstreamCause(id); return h("p", { class: "cause" }, h("strong", null, "Likely cause: "), cause.text, h("span", { class: "dim" }, ` (confidence ${cause.confidence}; traced through the network model)`)); })() : null),
        gcBox(id),
        h("div", { class: "box" }, h("h2", null, "Facts"), facts(id))),
      h("div", { class: "actions" },
        d.kind === "node" ? h("button", { type: "button", class: "text", "data-key": "action:whatif", onclick: () => {
          state.mode = "whatif";
          markTabs();
          toggleOffline(id);
          if (side.id === id) renderSidebar(); else renderAsset();
        } }, `${whatif.offline.has(id) ? "Restore" : "Take offline"} in the what-if`) : null,
        inSidebar ? h("button", { type: "button", class: "text", "data-key": "action:page", onclick: () => go({ screen: "asset", asset: id }) }, "Open the full page") : null,
        !inSidebar ? h("button", { type: "button", class: "text", "data-key": "action:unit", onclick: () => go({ screen: "unit", unit: unitOf[id] || "all", focus: id }) }, "Show in its unit") : null,
        h("button", { type: "button", class: "text", "data-key": "action:diag", onclick: () => go({ screen: "diag", asset: id }) }, "Diagnostics")));
  }
  function renderAsset() {
    const detail = assetDetail(route.asset);
    if (detail) keepFocus(screens.asset, () => patch(screens.asset, detail));
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
  function renderSidebar(force = false) {
    // While you type a what-if value, the data's steps leave the panel alone.
    const typing = document.activeElement && document.activeElement.tagName === "INPUT" && $("asset-side").contains && $("asset-side").contains(document.activeElement);
    if (typing && !force) return;
    if (side.marker) {
      const body = $("side-body"), top = body.scrollTop, detail = markerDetail(side.marker);
      $("side-title").textContent = detail.title;
      $("side-sub").textContent = detail.sub;
      keepFocus(body, () => patch(body, detail.body));
      body.scrollTop = top;
      return;
    }
    if (!side.id || !assets[side.id]) return;
    const d = assets[side.id], body = $("side-body"), top = body.scrollTop;
    $("side-title").textContent = d.name;
    $("side-sub").textContent = d.kind === "node"
      ? `${NORA.nodeTypes[d.type]} · ${d.operator || d.country}`
      : `${NORA.pipelineTypes[d.type]} · ${nameOf(d.from)} to ${nameOf(d.to)}`;
    keepFocus(body, () => patch(body, assetDetail(side.id, true)));
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
    if (m.kind === "pig") return pigDetail(m, { row, box, note });
    return qualityDetail(m, { row, box, note, volume });
  }
  /* An H₂S or CO₂ peak (Ray, 29 Oct: "volume (MSm3), Head KP, Tail KP, Sent (CET), ETA
     (CET), Duration, Max/Min value, Avg value, Notified (yes/no), Origo ref number (5
     digits), also Network, Location and peakID as well description. make it look nice
     and easy to understand"). Its head is the parcel that left the field first, its
     tail the last; a KP is the distance from the start of the line it is on. Notified
     and the Origo reference are the operator's: kept in this browser per peak. */
  const cet = (t) => timeFormat(t, { timeZone: "Europe/Oslo", weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  function kpOf(q, time = live.time) {
    if (!q) return null;
    const km = assets[q.pid].km || 0;
    if (q.arrived) return { pid: q.pid, km: q.forward ? km : 0 };
    const gone = Math.min(km, Math.max(0, ((time - q.t0) * C.pipelines.gas_velocity_mps) / 1000));
    return { pid: q.pid, km: q.forward ? gone : km - gone };
  }
  function peakId(slug) {
    const gas = slug.metric.split("_")[0].toUpperCase(), place = nameOf(slug.origin).replace(/[^A-Za-zÆØÅæøå]/g, "").slice(0, 3).toUpperCase();
    return `${gas}-${place}-${timeFormat(slug.first, { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/[^0-9]/g, "")}`;
  }
  const PEAK_NOTES = "nora-peak-notes";
  function peakNotes() { try { return JSON.parse(localStorage.getItem(PEAK_NOTES) || "{}"); } catch (error) { return {}; } }
  function savePeakNote(slug, change) {
    const all = peakNotes();
    all[slug] = { ...(all[slug] || {}), ...change };
    try { localStorage.setItem(PEAK_NOTES, JSON.stringify(all)); } catch (error) { /* kept for this view only */ }
  }
  /* A pig set out like a peak (Ray, 29 Oct: "a pig needs the same kind of setup for
     information as a peak"): its ID, ETA and speed first, its run as Launched → now →
     ETA, a line in words, then where it is and when. */
  function pigDetail(m, { row, box, note }) {
    const pig = m.ref, trip = pigTrip(pig, live.time), d = assets[m.id];
    const hm = (t) => timeFormat(t, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" });
    const kp = (d.km || 0) * Math.max(0, Math.min(1, m.along));
    const stat = (label, value, sub) => h("div", { class: "stat" }, h("span", { class: "label" }, label), h("strong", null, value), sub ? h("span", { class: "sub" }, sub) : null);
    const origin = trip.start != null ? (assets[pig.pipeline] || {}).from : null;
    const id = m.pigId != null ? String(m.pigId) : "–";
    return { title: m.pigId != null ? `Pig ${m.pigId}` : pig.label, sub: `${pig.label} · ${nameOf(origin)} to ${nameOf(trip.receiver)}`,
      body: h("div", { class: "side-detail peak-detail" },
        h("div", { class: "peak-stats" },
          stat("Pig ID", id, pig.every ? `run ${trip.run + 1}` : ""),
          stat("ETA", hm(trip.arrives), `CET · ${nameOf(trip.receiver)}`),
          stat("Speed", `${fmt(pig.speed, 1)} m/s`, `${fmt(pig.speed * 3.6, 1)} km/h`)),
        h("ol", { class: "journey" },
          h("li", null, h("span", { class: "label" }, "Launched"), h("strong", null, nameOf(origin)), h("span", { class: "sub" }, cet(trip.start))),
          h("li", { class: "now" }, h("span", { class: "label" }, "Now"), h("strong", null, nameOf(m.id)), h("span", { class: "sub" }, `KP ${fmt(kp, 0)}`)),
          h("li", null, h("span", { class: "label" }, "ETA"), h("strong", null, nameOf(trip.receiver)), h("span", { class: "sub" }, cet(trip.arrives)))),
        h("p", { class: "peak-description" }, `${pig.label}, launched ${cet(trip.start)}, now on ${nameOf(m.id)} at KP ${fmt(kp, 0)}. Next ${nameOf(trip.next)} ${cet(trip.nextAt)}; expected at ${nameOf(trip.receiver)} ${cet(trip.arrives)}.`),
        box("Position",
          row("Location", nameOf(m.id)),
          row("KP", `${fmt(kp, 1)} of ${fmt(d.km || 0)} km`),
          row("Next stop", `${nameOf(trip.next)}, ${cet(trip.nextAt)}`),
          row("Network", unitOf[m.id] ? unitById[unitOf[m.id]].name : origin && unitOf[origin] ? unitById[unitOf[origin]].name : "–")),
        box("Timing (CET)",
          row("Launched", cet(trip.start)),
          row("ETA", `${cet(trip.arrives)}, ${nameOf(trip.receiver)}`),
          row("Run", `${fmt((trip.arrives - trip.start) / 3600, 1)} h`),
          pig.every ? row("Relaunched", `every ${fmt(pig.every / 3600)} h`) : []),
        note("Estimate from the pig's speed and the route the gas takes through each node.")) };
  }
  function qualityDetail(m, { row, box, volume }) {
    const slug = live.slugs.get(m.ref), parcels = live.quality.filter((q) => q.slug === m.ref), q0 = QUALITY[m.gas];
    const head = parcels.reduce((a, b) => (a && a.born <= b.born ? a : b), null), tail = parcels.reduce((a, b) => (a && a.born >= b.born ? a : b), null);
    const headGo = head ? project(head) : null, conc = (value) => (value == null ? "–" : `${fmt(value, q0.digits)} ${q0.unit}`);
    const values = parcels.map((q) => q.conc), limit = C.quality[m.gas][2];
    const max = values.length ? Math.max(...values) : null, min = values.length ? Math.min(...values) : null;
    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const headKp = kpOf(head), tailKp = kpOf(tail), step = (live.stream && live.stream.step) || 3600;
    const exit = headGo && headGo.exit, origin = slug ? slug.origin : null, notes = slug ? peakNotes()[slug.slug] || {} : {};
    const kp = (place) => (place ? `KP ${fmt(place.km, 1)} on ${nameOf(place.pid)}` : "–");
    const stat = (label, value, sub) => h("div", { class: "stat" }, h("span", { class: "label" }, label), h("strong", null, value), sub ? h("span", { class: "sub" }, sub) : null);
    // The route at a glance: sent from the field, where the peak is now, where and when it lands.
    const journey = h("ol", { class: "journey" },
      h("li", null, h("span", { class: "label" }, "Sent"), h("strong", null, origin ? nameOf(origin) : "–"), h("span", { class: "sub" }, slug ? cet(slug.first) : "")),
      h("li", { class: "now" }, h("span", { class: "label" }, "Head now"), h("strong", null, headKp ? nameOf(headKp.pid) : nameOf(m.id)), h("span", { class: "sub" }, headKp ? `KP ${fmt(headKp.km, 0)}` : "")),
      h("li", null, h("span", { class: "label" }, exit ? "ETA" : "Next"), h("strong", null, exit ? nameOf(exit.node) : headGo ? nameOf(headGo.next.node) : "–"),
        h("span", { class: "sub" }, exit ? cet(exit.t) : headGo ? cet(headGo.next.t) : "")));
    // Notified and the Origo reference: set by the operator, kept per peak in this browser.
    const notified = h("button", { type: "button", class: `toggle${notes.notified ? " on" : ""}`, "aria-pressed": String(Boolean(notes.notified)),
      onclick: () => { if (!slug) return; savePeakNote(slug.slug, { notified: !notes.notified }); renderSidebar(); } }, notes.notified ? "Yes" : "No");
    const origo = h("input", { class: "origo", inputmode: "numeric", maxlength: "5", placeholder: "5 digits", "aria-label": "Origo reference number" });
    origo.value = notes.origo || "";
    const origoNote = h("span", { class: "sub", role: "alert" });
    origo.addEventListener("change", () => {
      const value = origo.value.trim();
      if (value && !/^\d{5}$/.test(value)) { origoNote.textContent = "Five digits, such as 40217"; return; }
      origoNote.textContent = "";
      if (slug) savePeakNote(slug.slug, { origo: value });
    });
    const description = slug ? `${q0.name} from ${nameOf(origin)}, sent ${cet(slug.first)}, its head now on ${nameOf(headKp ? headKp.pid : m.id)}.`
      + (exit ? ` Expected at ${nameOf(exit.node)} ${cet(exit.t)} at about ${conc(exit.conc)}${exit.conc >= limit ? ", over the limit" : ""}.` : "") : "";
    return { title: `${q0.name} peak`, sub: slug ? `${peakId(slug)} · ${nameOf(origin)} to ${exit ? nameOf(exit.node) : "the network"}` : `on ${nameOf(m.id)}`,
      body: h("div", { class: "side-detail peak-detail" },
        h("div", { class: "peak-stats" },
          stat("Max", conc(max), `limit ${conc(limit)}`),
          stat("Volume", slug ? volume(slug.volume) : "–", "gas over the follow level"),
          stat("ETA", exit ? timeFormat(exit.t, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }) : "–", exit ? `CET · ${nameOf(exit.node)}` : "")),
        journey,
        description ? h("p", { class: "peak-description" }, description) : null,
        slugProfile(m, parcels),
        box("Position",
          row("Location", headKp && tailKp && headKp.pid !== tailKp.pid ? `${nameOf(tailKp.pid)} to ${nameOf(headKp.pid)}` : nameOf(headKp ? headKp.pid : m.id)),
          row("Head", kp(headKp)),
          row("Tail", kp(tailKp)),
          row("Network", origin && unitOf[origin] ? unitById[unitOf[origin]].name : "–")),
        box("Timing (CET)",
          row("Sent", slug ? cet(slug.first) : "–"),
          row("ETA", exit ? `${cet(exit.t)}, ${nameOf(exit.node)}` : "–"),
          row("Duration", slug ? `${fmt((slug.last - slug.first + step) / 3600, 1)} h` : "–")),
        box(`${q0.name} along the peak`,
          row("Max", conc(max)), row("Min", conc(min)), row("Average", conc(avg)),
          row("At the origin", slug ? `${conc(slug.max)} at its strongest` : "–")),
        box("Handling",
          row("Peak ID", slug ? peakId(slug) : "–"),
          row("Notified", notified),
          row("Origo ref", h("span", { class: "origo-field" }, origo, origoNote)))) }; // no closing note (Ray, 29 Oct: "it doesnt add any value")
  }
  /* A peak's profile along its route (hub 3607; Ray, 27 Oct: "the profile of the H2S in
     the pipeline"): the concentration against the distance from the field. Solid: the
     slug's parcels where they are now. Dashed: what its strongest parcel is expected to
     become ahead, stepping down where other gas joins (mixAt). The warning and alarm
     limits as on every chart, and a tick at each node on the way. An estimate from the
     model's gas speed and today's flows. */
  function slugProfile(m, parcels) {
    const lead = parcels.reduce((a, b) => (a && a.conc >= b.conc ? a : b), null);
    if (!lead) return null;
    const q0 = QUALITY[m.gas], limits = C.quality[m.gas], v = C.pipelines.gas_velocity_mps, f = frame();
    const kmOf = (pid) => Math.max(1, assets[pid].km || 1);
    const endOf = (hop) => (hop.forward ? assets[hop.pid].to : assets[hop.pid].from);
    // How far a parcel has come from the field, in km along the lines it took.
    const travelled = (q) => {
      let d = 0;
      for (let k = 0; k < q.path.length - 1; k++) d += kmOf(q.path[k].pid);
      return d + (q.arrived ? kmOf(q.pid) : Math.min(kmOf(q.pid), Math.max(0, ((live.time - q.t0) * v) / 1000)));
    };
    const now = parcels.map((q) => [travelled(q), q.conc]).sort((a, b) => a[0] - b[0]);
    const ticks = [[0, lead.origin]];
    let x = 0;
    for (const hop of lead.path) { x += kmOf(hop.pid); ticks.push([x, endOf(hop)]); }
    const ahead = [[travelled(lead), lead.conc]];
    if (!lead.arrived) {
      let pid = lead.pid, node = endOf(lead), conc = lead.conc;
      for (let hops = 0; hops < 20; hops++) {
        const mixed = mixAt(node, pid, conc, lead.metric, f);
        ahead.push([x, conc], [x, mixed]);
        conc = mixed;
        const r = isExit(node) ? null : onward(node, f.flows);
        if (!r || r.pid === pid) break;
        pid = r.pid;
        node = r.forward ? assets[pid].to : assets[pid].from;
        x += kmOf(pid);
        ticks.push([x, node]);
      }
    }
    const W = 340, H = 168, left = 8, right = W - 8, top = 12, plot = 108, total = Math.max(1, x);
    const hi = Math.max(limits[2], ...now.map(([, c]) => c), ...ahead.map(([, c]) => c)) * 1.12;
    const X = (km) => left + (km / total) * (right - left), Y = (c) => top + plot - (c / hi) * plot;
    const line = (rows) => rows.map(([km, c], k) => `${k ? "L" : "M"}${X(km).toFixed(1)},${Y(c).toFixed(1)}`).join("");
    const text = `stroke:${COLORS.surface};stroke-width:3px;paint-order:stroke;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif`;
    let body = "";
    for (const [label, value, lvl] of [["Warning", limits[0], 1], ["Alarm", limits[2], 2]]) {
      body += `<line x1="${left}" x2="${right}" y1="${Y(value).toFixed(1)}" y2="${Y(value).toFixed(1)}" stroke="${limitInk(lvl)}" stroke-width="1" stroke-dasharray="2 3"/>`;
      body += `<text x="${right}" y="${(Y(value) - 3).toFixed(1)}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${label} ${esc(fmt(value, q0.digits))}</text>`;
    }
    // Node ticks; a name only where it has room (never text over text).
    let room = -Infinity;
    for (const [k, [km, node]] of ticks.entries()) {
      const px = X(km), last = k === ticks.length - 1;
      body += `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${top + plot}" y2="${top + plot + 4}" stroke="${COLORS.text_dim}" stroke-width="1"/>`;
      const name = nameOf(node), width = name.length * 5.6;
      const anchor = k === 0 ? "start" : last ? "end" : "middle", from = anchor === "start" ? px : anchor === "end" ? px - width : px - width / 2;
      if (from > room + 6 && (last || from + width < right - 60)) {
        body += `<text x="${px.toFixed(1)}" y="${top + plot + 16}" text-anchor="${anchor}" fill="${COLORS.text_dim}" style="${text}">${esc(name)}</text>`;
        room = from + width;
      }
    }
    body += `<line x1="${left}" x2="${right}" y1="${top + plot}" y2="${top + plot}" stroke="${COLORS.text_dim}" stroke-width="0.6"/>`;
    if (ahead.length > 1) body += `<path class="ahead" d="${line(ahead)}" fill="none" stroke="${COLORS[q0.color]}" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    body += `<path class="now" d="${line(now.length > 1 ? now : [[now[0][0], 0], ...now])}" fill="none" stroke="${COLORS[q0.color]}" stroke-width="2"/>`;
    const [leadKm, leadConc] = ahead[0];
    body += `<circle cx="${X(leadKm).toFixed(1)}" cy="${Y(leadConc).toFixed(1)}" r="3" fill="${COLORS[q0.color]}" stroke="${COLORS.casing}" stroke-width="0.8"/>`;
    body += `<text x="${X(leadKm).toFixed(1)}" y="${(Y(leadConc) - 7).toFixed(1)}" text-anchor="${X(leadKm) > W / 2 ? "end" : "start"}" fill="${COLORS.text}" style="${text}">now ${esc(fmt(leadConc, q0.digits))} ${esc(q0.unit)}</text>`;
    body += `<text x="${right}" y="${H - 2}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(total, 0))} km</text>`;
    return h("div", { class: "box slug-profile" }, h("h2", null, `${q0.name} along the route`),
      svg(`0 0 ${W} ${H}`, body, "profile"),
      h("p", { class: "dim small" }, "Solid: the peak now. Dashed: expected ahead, diluted where other gas joins. An estimate from the gas speed and today's flows."));
  }
  // A pig's run: the next node, the receiver at the end of its route, and when.
  function pigTrip(pig, time) {
    const since = time - pig.launch, every = pig.every > 0 ? pig.every : 0;
    const run = every ? Math.floor(since / every) : 0, start = pig.launch + run * every;
    const place = pigPlace(pig, time), route = pigRoute(pig, run, Infinity), last = route[route.length - 1];
    return {
      run, start, next: place.next, nextAt: place.exitAt,
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
        ["Pressure window", C.pressure[d.type] ? `${C.pressure[d.type][0]}–${C.pressure[d.type][1]} bar` : null],
        ["Pressure limits", (C.pressure_limits || {})[d.type] ? (([ll, l, hi, hh, top]) => `low-low ${ll}, low ${l}, high ${hi}, high-high ${hh}, integrity ${top} bar`)(C.pressure_limits[d.type]) : null], ["Status", d.status],
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

  /* Level 4 trends (hub 3614): the exact history behind the values. One chart per
     reading the asset has, up to the playhead, with its limits (amber for a warning,
     red for an alarm, labelled at the right), outages shaded (planned ones dashed) and a
     crosshair with the exact numbers. 2 h / 12 h / 24 h / All, or drag across a chart to
     zoom; "Compare with" draws a second asset on the same axes; Export CSV writes the
     window shown. Inline SVG, no library. */
  const diagView = { asset: null, span: 0, from: null, to: null, cursor: null, compare: "", drag: null };
  const DIAG_SERIES = [
    { key: "flow", name: (d) => (d.kind === "pipeline" ? "Flow" : "Throughput"), unit: "MSm³/d", digits: 2 },
    { key: "pressure_bar", name: () => "Pressure", unit: "bar", digits: 1 },
    { key: "nomination_msm3d", name: () => "Nomination", unit: "MSm³/d", digits: 2 },
    { key: "booked_msm3d", name: () => "Booked", unit: "MSm³/d", digits: 2 },
    { key: "h2s_ppm", name: () => "H₂S", unit: "ppm", digits: 2 },
    { key: "co2_molpct", name: () => "CO₂", unit: "mol %", digits: 2 },
  ];
  function diagRead(series, id, f) {
    if (series.key !== "flow") return metric(series.key, id, f);
    const v = assets[id].kind === "pipeline" ? f.flows[id] : throughput(id, f.flows);
    return v == null ? null : v;
  }
  // Limits drawn on a chart: [label, value, level], level 1 a warning (amber), 2 or 3 an alarm (red).
  function diagLimits(series, id) {
    const d = assets[id];
    if (series.key === "pressure_bar") {
      const limits = (C.pressure_limits || {})[d.type];
      if (!limits) return [];
      const [ll, low, high, hh, top] = limits;
      return [["LL", ll, 2], ["L", low, 1], ["H", high, 1], ["HH", hh, 2], ["INT", top, 3]];
    }
    if (series.key === "flow" && d.kind === "pipeline" && d.capacity) return [["Capacity", d.capacity, 1], ["Over", d.capacity * T.load[2], 3]];
    if (C.quality && C.quality[series.key]) return [["Warning", C.quality[series.key][0], 1], ["Alarm", C.quality[series.key][2], 3]];
    return [];
  }
  // The frames shown: up to the playhead, within the chosen window.
  function diagFrames() {
    const upto = live.frames.slice(0, live.index + 1).filter(Boolean);
    if (!upto.length) return [];
    const end = diagView.to ?? upto[upto.length - 1].t;
    const start = diagView.from ?? (diagView.span ? end - diagView.span : upto[0].t);
    return upto.filter((f) => f.t >= start && f.t <= end);
  }
  function diagChart(series, id, other, frames) {
    // Drawn at the screen's own width, so the 11 px type stays 11 px.
    const W = Math.round(Math.max(320, Math.min(1600, (screens.diag.clientWidth || 720) - 96))), H = 132, left = 8, right = W - 8, top = 10, plot = 92;
    const mine = frames.map((f) => [f.t, diagRead(series, id, f)]).filter(([, v]) => v != null);
    const theirs = other ? frames.map((f) => [f.t, diagRead(series, other, f)]).filter(([, v]) => v != null) : [];
    if (!mine.length && !theirs.length) return null;
    const t0 = frames[0].t, t1 = frames[frames.length - 1].t, span = Math.max(1, t1 - t0);
    const values = [...mine, ...theirs].map(([, v]) => v);
    let lo = Math.min(...values), hi = Math.max(...values);
    // Limits within 15 % of the readings are drawn, so the chart shows how far away they are.
    const room = Math.max((hi - lo) * 0.5, Math.abs(hi) * 0.15, 0.5);
    const limits = diagLimits(series, id).filter(([, v]) => v >= lo - room && v <= hi + room);
    lo = Math.min(lo, ...limits.map(([, v]) => v));
    hi = Math.max(hi, ...limits.map(([, v]) => v));
    // A steady reading stays a steady line: never less than 4 % of its size top to bottom.
    const least = Math.max(Math.abs(hi + lo) * 0.02, 0.01);
    if (hi - lo < 2 * least) { const mid = (hi + lo) / 2; lo = mid - least; hi = mid + least; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const x = (t) => left + ((t - t0) / span) * (right - left);
    const y = (v) => top + plot - ((v - lo) / (hi - lo)) * plot;
    const path = (rows) => rows.map(([t, v], k) => `${k ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
    // Labels carry a halo in the box's colour, so no limit line runs through a number.
    const text = `stroke:${COLORS.surface};stroke-width:3px;paint-order:stroke;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif`;
    let body = "";
    const events = (live.stream && live.stream.events) || live.feedEvents || [];
    for (const e of events) {
      if (e.asset !== id || e.end < t0 || e.start > t1) continue;
      const a = x(Math.max(e.start, t0)), b = x(Math.min(e.end, t1));
      body += `<rect x="${a.toFixed(1)}" y="${top}" width="${Math.max(1, b - a).toFixed(1)}" height="${plot}" fill="${COLORS.band}" stroke="${COLORS.text_dim}" stroke-width="0.6"${e.planned ? ' stroke-dasharray="3 3"' : ""}><title>${esc(e.label)}${e.planned ? " (planned)" : ""}</title></rect>`;
    }
    for (const [label, v, lvl] of limits) {
      body += `<line x1="${left}" x2="${right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${limitInk(lvl >= 2 ? 2 : 1)}" stroke-width="1" stroke-dasharray="2 3"/>`;
      body += `<text x="${right}" y="${(y(v) - 3).toFixed(1)}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${esc(label)} ${esc(fmt(v, series.digits > 1 ? 1 : 0))}</text>`;
    }
    body += `<text x="${left}" y="${top + 9}" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(hi, series.digits))}</text>`;
    body += `<text x="${left}" y="${top + plot - 2}" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(lo, series.digits))}</text>`;
    if (theirs.length) body += `<path class="compare" d="${path(theirs)}" fill="none" stroke="${COLORS.text_dim}" stroke-width="1.4" stroke-dasharray="5 3"/>`;
    if (mine.length) body += `<path class="measured" d="${path(mine)}" fill="none" stroke="${COLORS.text}" stroke-width="1.6"/>`;
    if (diagView.cursor != null && diagView.cursor >= t0 && diagView.cursor <= t1) {
      body += `<line class="crosshair" x1="${x(diagView.cursor).toFixed(1)}" x2="${x(diagView.cursor).toFixed(1)}" y1="${top}" y2="${top + plot}" stroke="${COLORS.text}" stroke-width="0.8"/>`;
    }
    if (diagView.drag && diagView.drag.at != null) {
      const a = x(Math.min(diagView.drag.from, diagView.drag.at)), b = x(Math.max(diagView.drag.from, diagView.drag.at));
      body += `<rect x="${a.toFixed(1)}" y="${top}" width="${Math.max(1, b - a).toFixed(1)}" height="${plot}" fill="${COLORS.text_dim}" fill-opacity="0.15"/>`;
    }
    body += `<text x="${left}" y="${H - 4}" fill="${COLORS.text_dim}" style="${text}">${esc(shortTime(t0))}</text>`;
    body += `<text x="${right}" y="${H - 4}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${esc(shortTime(t1))}</text>`;
    // Pointer: a press and a drag picks a window, a move sets the crosshair.
    const at = (e) => {
      const r = e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
      const share = r && r.width ? (e.clientX - r.left) / r.width : (e.offsetX ?? 0) / W;
      return t0 + Math.min(1, Math.max(0, (share * W - left) / (right - left))) * span;
    };
    const nearest = (t) => frames.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), frames[0]).t;
    return h("div", { class: "diag-chart", "data-series": series.key,
      onpointerdown: (e) => { diagView.drag = { from: at(e), at: null }; },
      onpointermove: (e) => {
        const t = at(e);
        if (diagView.drag) diagView.drag.at = t;
        else diagView.cursor = nearest(t);
        renderDiag();
      },
      onpointerup: (e) => {
        const drag = diagView.drag, t = at(e);
        diagView.drag = null;
        if (drag && Math.abs(t - drag.from) > span / 40) {
          diagView.from = Math.min(drag.from, t);
          diagView.to = Math.max(drag.from, t);
          diagView.span = 0;
        } else diagView.cursor = nearest(t);
        renderDiag();
      },
      onpointerleave: () => { if (diagView.drag) { diagView.drag = null; renderDiag(); } } },
    h("div", { class: "diag-chart-title" }, `${series.name(assets[id])} · ${series.unit}`),
    svg(`0 0 ${W} ${H}`, body, "diag-trend"));
  }
  function diagCsv(id, other, series, frames) {
    const cols = [];
    for (const s of series) {
      cols.push([`${nameOf(id)} ${s.name(assets[id])} (${s.unit})`, (f) => diagRead(s, id, f)]);
      if (other) cols.push([`${nameOf(other)} ${s.name(assets[other])} (${s.unit})`, (f) => diagRead(s, other, f)]);
    }
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [["time_utc", ...cols.map(([name]) => name)].map(cell).join(",")];
    for (const f of frames) lines.push([new Date(f.t * 1000).toISOString(), ...cols.map(([, read]) => { const v = read(f); return v == null ? "" : v; })].map(cell).join(","));
    return `${lines.join("\n")}\n`;
  }
  function diagDownload(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function trendsBox(id) {
    if (diagView.asset !== id) Object.assign(diagView, { asset: id, span: 0, from: null, to: null, cursor: null, compare: "", drag: null });
    const d = assets[id], frames = diagFrames();
    if (frames.length < 2) return null;
    const other = diagView.compare && assets[diagView.compare] ? diagView.compare : null;
    const series = DIAG_SERIES.filter((s) => frames.some((f) => diagRead(s, id, f) != null));
    if (!series.length) return null;
    const preset = (label, seconds) => h("button", { type: "button", role: "tab", "data-key": `diag-span:${seconds}`,
      "aria-selected": String(!diagView.from && diagView.span === seconds),
      onclick: () => { Object.assign(diagView, { span: seconds, from: null, to: null }); renderDiag(); } }, label);
    const peers = (d.kind === "pipeline" ? pipeIds : nodeIds).filter((p) => p !== id).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const cursorFrame = diagView.cursor != null ? frames.find((f) => f.t === diagView.cursor) : null;
    const charts = series.map((s) => diagChart(s, id, other, frames)).filter(Boolean);
    return h("div", { class: "box wide diag-trends" },
      h("h2", null, "Trends"),
      h("div", { class: "diag-controls" },
        h("div", { class: "seg", role: "tablist", "aria-label": "Window" },
          preset("2 h", 2 * 3600), preset("12 h", 12 * 3600), preset("24 h", 24 * 3600), preset("All", 0)),
        h("select", { "aria-label": "Compare with", "data-key": "diag-compare", onchange: (e) => { diagView.compare = e.target.value; renderDiag(); } },
          h("option", { value: "", selected: other ? null : "" }, "Compare with…"),
          ...peers.map((p) => h("option", { value: p, selected: p === other ? "" : null }, nameOf(p)))),
        h("button", { type: "button", class: "text", "data-key": "diag-csv",
          onclick: () => diagDownload(`${id}${other ? `-vs-${other}` : ""}.csv`, diagCsv(id, other, series, frames)) }, "Export CSV")),
      h("p", { class: "dim small" }, `Drag across a chart to zoom. ${other ? `Dashed: ${nameOf(other)}. ` : ""}Shaded: outages on this asset, planned ones dashed.`),
      charts,
      cursorFrame ? h("table", { class: "data diag-cursor" },
        h("thead", null, h("tr", null, h("th", null, "At the crosshair"), ...series.map((s) => h("th", null, `${s.name(d)} (${s.unit})`)))),
        h("tbody", null,
          h("tr", null, h("td", null, formatTime(cursorFrame.t)), ...series.map((s) => h("td", null, fmt(diagRead(s, id, cursorFrame), s.digits)))),
          other ? h("tr", null, h("td", null, nameOf(other)), ...series.map((s) => h("td", null, fmt(diagRead(s, other, cursorFrame), s.digits)))) : null))
        : h("p", { class: "dim small" }, "Point at a chart for the exact values."));
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
    // In place, as the Overview: the charts keep the pointer and the select its focus while the data plays.
    keepFocus(screens.diag, () => patch(screens.diag, h("div", { class: "screen-body" },
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
        trendsBox(id),
        h("div", { class: "box wide" }, h("h2", null, "Readings, newest first (MSm³/d unless noted)"),
          h("table", { class: "data" },
            h("thead", null, h("tr", null, h("th", null, "Time"), h("th", null, d.kind === "pipeline" ? "Flow" : "Throughput"), ...here.map((m) => h("th", null, names[m])))),
            h("tbody", null, rows)))))));
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
      const view = views[state.view], fresh = !view.mounted || view.shownUnit !== route.unit;
      if (!view.mounted) { view.mounted = true; view.mount(containers[state.view]); }
      else view.resize();
      if (view.ready) {
        // Back to a view, it is where you left it; another unit fits that unit (Ray, 29 Oct:
        // "the page should stay in the exact same location and not zoom out every time").
        if (fresh) view.setUnit(route.unit);
        view.shownUnit = route.unit;
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
    const counts = [3, 2, 1].map((l) => {
      const at = live.conditions.filter((c) => c.level === l);
      return [l, at.length, at.filter((c) => !c.acked).length];
    }).filter(([, n]) => n);
    // Both are live regions, refreshed with every data step: rebuilt only when they change.
    replaceIfChanged($("alarm-counts"), counts.map(([l, n, open]) => `${l}:${n}:${open}`).join(",") || "none",
      () => (counts.length ? counts.map(([l, n, open]) => h("span", { class: open ? null : "acked", title: `${n} ${LEVEL[l].toLowerCase()}, ${open ? `${open} unacknowledged` : "all acknowledged"}` },
        badge(l, l === 1 ? `${n} warning${n === 1 ? "" : "s"}` : String(n))))
        : [h("span", { class: "dim" }, "No alarms")]));
    buildAlarms();
    // No plan chip (Ray, 29 Oct: "remove this. it serves no purpose"): the plan's state
    // is on the Overview, and its shortfalls are alarms in the counts.
  }

  /* The alarm list (Ray, 29 Oct: "when clicking this, an alarm list should show. make it
     well made, minimalistic as a popup window that shows alarm categories by level,
     network, ID"; "integrity alarms needs its own category, with time first, then location,
     then note, then level, then network. Same for scada alarms but thats its own
     category"). Integrity: pressures at their limits and lines over capacity, what
     protects the pipelines; SCADA: everything else the readings raise. Newest first; a
     level and a network narrow it; a location opens the asset. */
  const INTEGRITY = new Set(["pressure", "load"]);
  const ALARM_TAG = { pressure: "PI", load: "FI", trip: "FT", quality: "QI", peak: "FS", nomination: "NOM", booking: "BKG" };
  const alarmFilter = { level: 0, unit: "all" };
  let shelving = null; // the alarm whose shelve form is open
  const alarmUnit = (id) => unitOf[id] || (assets[id] && assets[id].kind === "pipeline" ? unitOf[assets[id].from] : null);
  const alarmId = (c) => `${ALARM_TAG[c.kind] || c.kind.slice(0, 3).toUpperCase()}-${c.id.toUpperCase()}`;
  function alarmNote(c) {
    const name = nameOf(c.id), note = c.text.startsWith(name) ? c.text.slice(name.length).replace(/^[\s:,]+/, "") : c.text;
    return note.charAt(0).toUpperCase() + note.slice(1);
  }
  function buildAlarms() {
    const panel = $("alarms");
    if (!panel || panel.hidden) return;
    const all = live.conditions, shown = all.filter((c) => (!alarmFilter.level || c.level === alarmFilter.level)
      && (alarmFilter.unit === "all" || alarmUnit(c.id) === alarmFilter.unit));
    const sig = (c) => `${c.kind}:${c.id}:${c.level}:${c.text}:${c.since ? c.since.t : ""}:${c.acked ? 1 : 0}`;
    const key = `${alarmFilter.level}|${alarmFilter.unit}|${shelving}|${all.map(sig).join(";")}|${live.shelved.map((c) => `${sig(c)}:${c.shelf.until}`).join(";")}`;
    replaceIfChanged(panel, key, () => {
      const chip = (lvl, label) => h("button", { type: "button", role: "tab", "aria-selected": String(alarmFilter.level === lvl),
        onclick: () => { alarmFilter.level = lvl; buildAlarms(); } }, label);
      const count = (lvl) => all.filter((c) => c.level === lvl).length;
      const location = (c) => (assets[c.id] ? h("button", { type: "button", class: "link", "data-key": `alarm:${c.kind}|${c.id}`,
        onclick: () => { closePops(); if (route.screen === "unit") openSidebar(c.id); else go({ screen: "asset", asset: c.id }); } }, nameOf(c.id)) : c.id);
      const redo = () => { evaluate(); refreshScreens(); buildAlarms(); };
      const actions = (c) => h("td", { class: "alarm-do" }, h("span", { class: "alarm-actions" },
        c.acked ? h("span", { class: "dim" }, "Acked") : ackButton([c]),
        shelving === alarmKey(c) ? null : h("button", { type: "button", class: "ack", "data-key": `shelve:${alarmKey(c)}`, title: "Take it out of the counts for a while, with a reason",
          onclick: () => { shelving = alarmKey(c); buildAlarms(); } }, "Shelve")));
      // The shelve form opens on its own row under the alarm: why, and for how long.
      const shelveRow = (c) => {
        if (shelving !== alarmKey(c)) return null;
        const reason = h("select", { "aria-label": "Reason" }, ...SHELVE_REASONS.map((r) => h("option", { value: r }, r)));
        const hours = h("select", { "aria-label": "For" }, ...SHELVE_HOURS.map((n) => h("option", { value: String(n) }, n === 12 ? "12 h (a shift)" : `${n} h`)));
        return h("tr", { class: "shelving" }, h("td", { colspan: "7" }, h("span", { class: "alarm-actions" },
          h("span", { class: "dim" }, `Shelve ${nameOf(c.id)}:`), reason, hours,
          h("button", { type: "button", class: "ack", "data-key": `shelve-ok:${alarmKey(c)}`,
            onclick: () => { alarmHandling.shelve(c, reason.value, Number(hours.value)); shelving = null; redo(); } }, "Shelve"),
          h("button", { type: "button", class: "ack", onclick: () => { shelving = null; buildAlarms(); } }, "Cancel"))));
      };
      const table = (title, rows) => [
        h("h3", null, `${title} · ${rows.length}`),
        rows.length ? h("table", { class: "data alarm-table" },
          h("thead", null, h("tr", null, ...["Time", "Location", "Note", "Level", "Network", "ID", ""].map((t) => h("th", null, t)))),
          h("tbody", null, ...rows.flatMap((c) => [h("tr", { class: c.acked ? "acked" : null },
            h("td", null, sinceTime(c.since)),
            h("td", null, location(c)),
            h("td", { class: "note" }, alarmNote(c)),
            h("td", null, badge(c.level, LEVEL[c.level])),
            h("td", { class: "network" }, (unitById[alarmUnit(c.id)] || {}).name || "–"),
            h("td", { class: "dim id" }, alarmId(c)),
            actions(c)), shelveRow(c)].filter(Boolean))))
          : h("p", { class: "dim" }, "None"),
      ];
      const shelved = live.shelved.filter((c) => !alarmFilter.level || c.level === alarmFilter.level);
      const shelf = shelved.length ? [
        h("h3", null, `Shelved · ${shelved.length}`),
        h("table", { class: "data alarm-table" },
          h("thead", null, h("tr", null, ...["Location", "Note", "Level", "Reason", "Back at (your clock)", ""].map((t) => h("th", null, t)))),
          h("tbody", null, ...shelved.map((c) => h("tr", { class: "acked" },
            h("td", null, location(c)),
            h("td", { class: "note" }, alarmNote(c)),
            h("td", null, badge(c.level, LEVEL[c.level])),
            h("td", null, c.shelf.reason),
            h("td", null, h("time", { title: "Wall-clock time, this browser" }, new Date(c.shelf.until).toTimeString().slice(0, 5))),
            h("td", { class: "alarm-do" }, h("button", { type: "button", class: "ack", "data-key": `unshelve:${alarmKey(c)}`,
              onclick: () => { alarmHandling.unshelve(c); redo(); } }, "Unshelve")))))),
      ] : [];
      const newest = (a, b) => ((b.since && b.since.t) || 0) - ((a.since && a.since.t) || 0);
      return [
        h("div", { class: "alarm-filters" },
          h("div", { class: "seg", role: "tablist", "aria-label": "Level" }, chip(0, `All ${all.length}`),
            ...[3, 2, 1].map((l) => chip(l, `${4 - l} ${LEVEL[l]} ${count(l)}`))),
          ackButton(shown, "Acknowledge all"),
          h("select", { "aria-label": "Network", onchange: (e) => { alarmFilter.unit = e.target.value; buildAlarms(); } },
            h("option", { value: "all", selected: alarmFilter.unit === "all" ? "" : null }, "All networks"),
            ...Object.values(unitById).map((u) => h("option", { value: u.id, selected: alarmFilter.unit === u.id ? "" : null }, u.name)))),
        ...table("Integrity", shown.filter((c) => INTEGRITY.has(c.kind)).sort(newest)),
        ...table("SCADA", shown.filter((c) => !INTEGRITY.has(c.kind)).sort(newest)),
        ...shelf,
        h("p", { class: "dim small" }, "Acknowledgements and shelving are kept in this browser only."),
      ];
    });
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
            item(h("span", null, "⋯"), "Edit: drag to move; right-click to add, connect or remove"))),
        section("Moving", false, h("ul", null,
          item(svg("0 0 26 14", `<path d="M17 7l-8-4.5v9z" fill="${COLORS.pig}" stroke="${COLORS.casing}"/>`), "Pig"),
          item(svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.h2s}" stroke="${COLORS.casing}"/>`), "H₂S · ppm"),
          item(svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.co2}" stroke="${COLORS.casing}"/>`), "CO₂ · mol %"))),
        section("Status", false, h("ul", null,
          ...[3, 2, 1].map((l) => item(badge(l), ["", "Watch", "Medium", "Act now"][l])),
          item(sample(COLORS.active, 3), "Active"),
          item(sample(COLORS.normal, 3), "Normal"),
          item(sample(COLORS.inactive, 3), "Inactive"),
          item(sample(COLORS.inactive, 1.5, ' stroke-dasharray="3 3"'), "No data"))),
        section("Flow", true, flow, h("p", { class: "key-caption" }, "Flow in MSm³/d: incoming faint, outgoing full · line ends: pressure, ▲▼ bar per hour · mid-line: settle-out pressure (bar), and pack, its line pack change (MSm³/d)"), exit, h("p", { class: "key-caption" }, "Exit delivery")),
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
  /* Settings (Ray, 29 Oct: "options need to be updated and improved"): what is in the
     network, what the squares and lines show, what moves along them, and the display.
     Only the asset types the network has, by their short names; defaults from nora.toml. */
  function buildSettings() {
    const check = (label, key) => h("label", null, h("input", { type: "checkbox", checked: settings[key] ? "" : null, onchange: (e) => update({ [key]: e.target.checked }) }), label);
    const choose = (label, key, options, act = (v) => update({ [key]: v }), value = settings[key]) => h("div", { class: "row" }, h("span", null, label),
      h("select", { "aria-label": label, onchange: (e) => act(e.target.value) }, options.map(([v, t]) => h("option", { value: v, selected: value === v ? "" : null }, t))));
    const path = ["field", "hub", "tee", "processing", "terminal", "market", "lng", "storage"]; // as the gas goes
    const present = [...new Set([...path, ...Object.keys(NORA.nodeTypes)])].filter((type) => nodeIds.some((id) => assets[id].type === type));
    $("settings").replaceChildren(
      h("h3", null, "Network"),
      ...present.map((type) => h("label", { title: NORA.nodeTypes[type] },
        h("input", { type: "checkbox", checked: settings.hide.includes(type) ? null : "",
          onchange: (e) => update({ hide: e.target.checked ? settings.hide.filter((t) => t !== type) : [...settings.hide, type] }) }),
        (NORA.plural || {})[type] || NORA.nodeTypes[type])),
      h("h3", null, "On the squares"),
      check("Names", "names"),
      check("Pressure change in the last hour", "pressureChange"),
      check("Outside temperature", "temperature"),
      h("h3", null, "On the lines"),
      choose("Values", "lineValues", [["auto", "Auto"], ["on", "Always"], ["off", "Never"]]),
      check("Line pack change", "pack"),
      check("Moving flow", "animation"),
      h("h3", null, "Moving markers"),
      check("Pigs", "pigs"),
      check("H₂S and CO₂ peaks", "gasQuality"),
      h("h3", null, "Display"),
      choose("Theme", "theme", [["light", "Light"], ["dark", "Dark"]], (v) => setTheme(v), theme),
      choose("Spacing", "density", [["compact", "Compact"], ["comfortable", "Comfortable"], ["spacious", "Spacious"]]),
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
  // NORA: back to the map of the whole network (Ray, 29 Oct: "clicking on NORA should take
  // me back to map overview and not download file"; it linked to the folder).
  if ($("brand")) $("brand").addEventListener("click", (event) => {
    event.preventDefault();
    closePops();
    closeSidebar();
    state.view = "map";
    markTabs();
    go({ screen: "unit", unit: "all" });
    if (views.map && views.map.ready && views.map.fit) views.map.fit();
  });
  const POPS = [["key-toggle", "key"], ["settings-toggle", "settings"], ["alarm-counts", "alarms"]];
  function closePops() {
    for (const [button, panel] of POPS) { if ($(panel)) $(panel).hidden = true; if ($(button)) $(button).setAttribute("aria-expanded", "false"); }
  }
  for (const [button, panel] of POPS) {
    if (!$(button)) continue;
    $(button).addEventListener("click", (event) => {
      const open = $(panel).hidden;
      closePops();
      $(panel).hidden = !open;
      event.currentTarget.setAttribute("aria-expanded", String(open));
      if (open && panel === "alarms") { $(panel).dataset.signature = ""; buildAlarms(); }
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
    if (live.frames.length) rulerLabels(timelineWindow());
    if (live.feed) {
      when.hidden = !live.stale;
      when.textContent = live.stale ? "Stale" : "";
      when.title = live.stale ? live.stale.text : "";
      when.classList.toggle("model", Boolean(live.stale));
      return;
    }
    when.hidden = !ts;
    when.textContent = timeText(ts);
    const away = Boolean(ts && Math.abs(ts.ahead) > NOW_SLACK);
    when.classList.toggle("away", away);
    when.setAttribute("tabindex", away ? "0" : "-1");
    when.setAttribute("role", away ? "button" : "status");
    when.title = away ? "Back to now" : "";
    // The centre of the timeline is the playhead: "Real time" only while it is now.
    if (ts) $("tl-now").textContent = Math.abs(ts.ahead) <= NOW_SLACK ? "Real time · UTC" : ts.model ? "Model · UTC" : "History · UTC";
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
    // A daily or monthly dataset at 10 min/s would take minutes per step: play it at the
    // slowest speed that shows a step about every two seconds (the menu still changes it).
    if (stream.step / live.speed > 30) live.speed = speeds.find((v) => stream.step / v <= 2) || Math.max(...speeds);
    /* Data re-timed to now opens at now and, unless someone picked a speed, plays at
       nora.toml's now_speed: 10 min/s (Ray, 29 Oct: "10 min / s should be the default view
       when opening the page"). */
    if (stream.offset != null && !settings.speedChosen && speeds.includes(C.screen.now_speed)) live.speed = C.screen.now_speed;
    $("speed").value = String(live.speed);
    const half = timelineHalf(), retimed = stream.offset != null;
    scrub.min = String(-half);
    scrub.max = String(half);
    scrub.step = String(Math.max(3600, stream.step));
    scrub.value = "0";
    // Only re-timed synthetic data has the wall clock on it; a recording has the time chosen.
    $("tl-now").textContent = retimed ? "Real time · UTC" : "Selected time · UTC";
    const centre = retimed ? "Real time" : "The selected time", oneStep = spanLabel(Math.max(3600, stream.step));
    scrub.setAttribute("aria-label", `Move around ${retimed ? "real time" : "the selected time"}: ${spanLabel(half)} back or ahead`);
    if (scrub.parentElement) scrub.parentElement.title = `${centre} stays in the centre. Drag right for later values or left for earlier ones. Arrow keys move ${oneStep.replace(/^1 /, "one ")}.`;
    seek(retimed ? nowPosition() : 0); // synthetic data opens at now; recordings keep their start
  }
  function seek(position) {
    const s = live.stream;
    live.playhead = Math.max(0, Math.min(s.times.length - 1, position));
    live.index = Math.floor(live.playhead);
    live.down = {};
    live.peaks = [];
    live.onset = new Map();
    live.jumped = true;
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
    renderWhatifEditor(); // its numbers follow the hour the timeline shows
    drawSpark();
    drawInventory();
  }
  /* Total inventory (Ray, 29 Oct: "a trend showing total inventory in the whole system
     would be nice to see as well. it should be minimalistic"): the number now and a
     hairline over the last 24 hours, the model's next 4 hours dashed. */
  function drawInventory() {
    const box = $("inventory");
    if (!box || $("player").hidden) return;
    const now = inventory(frameNo(live.index));
    box.hidden = now == null;
    if (now == null) return;
    $("inventory-value").textContent = `${fmt(now)} MSm³`;
    const step = (live.stream && live.stream.step) || 3600, back = Math.round((24 * 3600) / step), ahead = Math.round((4 * 3600) / step);
    const points = [];
    for (let i = live.index - back; i <= live.index + ahead; i++) {
      if (i < 0 || i >= live.frames.length) continue;
      const v = inventory(live.frames[i]);
      if (v != null) points.push([i - live.index, v]);
    }
    if (points.length < 2) { $("inventory-spark").innerHTML = ""; return; }
    const values = points.map(([, v]) => v), lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const x = (k) => (((k + back) / (back + ahead)) * 96).toFixed(1), y = (v) => (19 - ((v - lo) / span) * 16).toFixed(1);
    const line = (part) => part.map(([k, v]) => `${x(k)},${y(v)}`).join(" ");
    const past = points.filter(([k]) => k <= 0), future = points.filter(([k]) => k >= 0);
    $("inventory-spark").innerHTML = `<polyline points="${line(past)}" fill="none" stroke="${COLORS.text}" stroke-width="1.2"/>`
      + (future.length > 1 ? `<polyline points="${line(future)}" fill="none" stroke="${COLORS.text_dim}" stroke-width="1.2" stroke-dasharray="3 2"/>` : "")
      + `<line x1="${x(0)}" y1="1" x2="${x(0)}" y2="21" stroke="${COLORS.text_dim}" stroke-width="1"/>`; // built from numbers and palette colours only
  }
  /* The selected time is the centre of the timeline: four data steps of history on the
     left and four ahead on the right, never less than four hours. Hourly data shows four
     hours either way, a daily dataset four days, a monthly one four months. */
  const timelineHalf = () => Math.max(4 * 3600, 4 * ((live.stream && live.stream.step) || 3600));
  const spanLabel = (seconds) => (seconds < 2 * 86400 ? `${Math.round(seconds / 3600)} h`
    : seconds < 60 * 86400 ? `${Math.round(seconds / 86400)} d` : `${Math.round(seconds / (30 * 86400))} mo`);
  /* The timeline (Ray, 29 Oct: "im not happy with how the timeline works and functions at
     the bottom and the feel and look of it. make up your own version and improve it"). A
     ruler over the whole dataset, or the 240 steps around the playhead of a longer one,
     that stays put while the data plays: history solid, the model's hours ahead dashed, a
     line at now and the playhead to drag or click to any time. Along it, the gas days and
     what is coming: alarms on the plan, pressures at their limits, outages and when each
     H₂S or CO₂ peak reaches its exit. The keys still step one data step at a time. */
  const RULER_STEPS = 240;
  function timelineWindow() {
    const frames = live.frames, n = frames.length;
    if (!n) { const now = live.time == null ? 0 : live.time; return { start: now - 1, now, end: now + 1 }; }
    let first = 0, last = n - 1;
    if (n > RULER_STEPS + 1) { // a page of the data around the playhead, moved a quarter at a time
      const quarter = RULER_STEPS / 4, at = live.feed ? n - 1 : live.playhead;
      first = Math.max(0, Math.min(n - 1 - RULER_STEPS, Math.floor((at - RULER_STEPS / 2) / quarter) * quarter));
      last = first + RULER_STEPS;
    }
    return { start: frames[first].t, now: live.time, end: Math.max(frames[last].t, frames[first].t + 1) };
  }
  const gasDayStart = (t) => timeFormat(t, { timeZone: "Europe/Oslo", hour: "2-digit", hourCycle: "h23" }) === "06";
  // The worst pressure limit each frame passes, kept per dataset (a frame's pressures do not change).
  const limitLevels = new WeakMap();
  function frameLimitLevel(f) {
    if (limitLevels.has(f)) return limitLevels.get(f);
    let worst = 0;
    for (const [id, p] of Object.entries((f.metrics || {}).pressure_bar || {})) {
      const mark = p == null || !assets[id] ? null : pressureMark(id, p);
      if (mark) worst = Math.max(worst, mark.level);
    }
    limitLevels.set(f, worst);
    return worst;
  }
  // The ruler's ends, said for screen readers (the ruler draws its days).
  function rulerLabels(win) {
    const day = (t) => timeFormat(t, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    $("tl-past").textContent = day(win.start);
    $("tl-future").textContent = day(win.end);
  }
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
    const win = timelineWindow(), span = win.end - win.start, x = (t) => ((t - win.start) / span) * width;
    const step = (live.stream && live.stream.step) || 3600, stepW = Math.max(1.5, (step / span) * width);
    const bar = 17, lane = 24; // the track's middle, and the row of what is coming
    // Days: a tick where each gas day starts (06:00 Norwegian time) and its name over it.
    ctx.font = "10px Archivo, system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    const days = [];
    if (step < 86400) {
      for (let t = Math.ceil(win.start / 3600) * 3600; t <= win.end; t += 3600) if (gasDayStart(t)) days.push(t);
    }
    ctx.strokeStyle = COLORS.text_dim;
    ctx.lineWidth = 1;
    days.forEach((t, i) => {
      const left = x(t), right = i + 1 < days.length ? x(days[i + 1]) : x(t + 86400);
      ctx.beginPath(); ctx.moveTo(Math.round(left) + 0.5, 11); ctx.lineTo(Math.round(left) + 0.5, height); ctx.stroke();
      const label = timeFormat(t, { timeZone: "Europe/Oslo", weekday: "short", day: "numeric" }), mid = (Math.max(0, left) + Math.min(width, right)) / 2;
      if (Math.min(width, right) - Math.max(0, left) > ctx.measureText(label).width + 8) { ctx.fillStyle = COLORS.text_dim; ctx.fillText(label, mid, 0); }
    });
    // The track: history solid, the model's hours ahead dashed (what the model expects).
    const nowAt = timeState() ? wallClock() : null, nowX = nowAt == null ? width : Math.max(0, Math.min(width, x(nowAt)));
    ctx.fillStyle = COLORS.dots;
    ctx.fillRect(0, bar - 2, nowX, 4);
    if (nowX < width) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = COLORS.text_dim;
      ctx.strokeRect(nowX, bar - 2, width - nowX, 4);
      ctx.setLineDash([]);
    }
    // What is coming, under the track: the plan's alarms, pressures at their limits, outages.
    for (const f of frames) {
      if (f.t < win.start || f.t > win.end) continue;
      const lvl = Math.max(f.plan ? f.plan.now[0] : 0, frameLimitLevel(f) >= 2 ? 3 : frameLimitLevel(f) ? 1 : 0);
      if (!lvl) continue;
      ctx.globalAlpha = 0.8; // a thin row: strong colours sparingly (Ray, 29 Oct)
      ctx.fillStyle = LEVEL_COLOR[lvl];
      ctx.fillRect(x(f.t), lane + 1, stepW, 2.5);
      ctx.globalAlpha = 1;
    }
    for (const event of (live.stream && live.stream.events) || []) {
      if (event.end < win.start || event.start > win.end) continue;
      const left = Math.max(0, x(event.start)), right = Math.min(width, x(event.end));
      ctx.strokeStyle = COLORS.text;
      ctx.setLineDash(event.planned ? [3, 2] : []);
      ctx.strokeRect(left, lane - 1.5, Math.max(2, right - left), 7);
    }
    ctx.setLineDash([]);
    // When each H₂S or CO₂ peak reaches its exit: a dot in its gas's colour, ringed when it
    // arrives over a limit.
    for (const s of slugs()) {
      const at = s.exit ? s.exit.t : null;
      if (at == null || at < win.start || at > win.end) continue;
      ctx.beginPath();
      ctx.arc(x(at), lane + 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[QUALITY[s.q.metric].color];
      ctx.fill();
      if (s.exitLevel) { ctx.strokeStyle = LEVEL_COLOR[s.exitLevel]; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
    }
    // Now, and the playhead on top.
    if (nowAt != null && nowX > 0 && nowX < width) {
      ctx.fillStyle = COLORS.text_dim;
      ctx.fillRect(Math.round(nowX), 11, 1, height - 11);
    }
    if (live.time != null && live.time >= win.start && live.time <= win.end) {
      const px = x(live.time);
      ctx.fillStyle = COLORS.text;
      ctx.fillRect(px - 1, 11, 2, height - 11);
      ctx.beginPath();
      ctx.arc(px, bar, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.panel || COLORS.paper;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
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
  /* The ruler under the pointer: a click or a drag puts the playhead at that time (once a
     frame however fast the pointer moves), and the time under the pointer shows above it. */
  const track = spark.parentElement, rulerTip = h("div", { class: "ruler-tip", "aria-hidden": "true" });
  rulerTip.hidden = true;
  if (track) track.append(rulerTip);
  let dragging = false, wanted = null;
  const rulerTime = (clientX) => {
    const r = spark.getBoundingClientRect(), win = timelineWindow();
    return win.start + Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))) * (win.end - win.start);
  };
  function showTip(clientX) {
    if (!live.frames.length || !track) return;
    const t = rulerTime(clientX), r = spark.getBoundingClientRect(), ahead = timeState() ? t - wallClock() : null;
    rulerTip.textContent = `${timeFormat(t, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${ahead != null && ahead > NOW_SLACK ? " · model" : ""}`;
    rulerTip.style.left = `${(((clientX - r.left) / (r.width || 1)) * 100).toFixed(2)}%`;
    rulerTip.hidden = false;
  }
  function seekTime(t, now = false) {
    const s = live.stream;
    if (!s || live.feed) return;
    if (now) { wanted = null; seek((t - s.times[0]) / s.step); return; }
    if (wanted == null) requestAnimationFrame(() => { const at = wanted; wanted = null; if (at != null) seek((at - s.times[0]) / s.step); });
    wanted = t;
  }
  if (track) {
    track.addEventListener("pointerdown", (e) => {
      if (!live.stream || live.feed || e.button > 0) return;
      dragging = true;
      if (track.setPointerCapture) track.setPointerCapture(e.pointerId);
      seekTime(rulerTime(e.clientX), true);
      showTip(e.clientX);
    });
    track.addEventListener("pointermove", (e) => { if (dragging) seekTime(rulerTime(e.clientX)); showTip(e.clientX); });
    const release = () => { dragging = false; };
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", release);
    track.addEventListener("pointerleave", () => { if (!dragging) rulerTip.hidden = true; });
  }
  // "Model · in 6 h" or "3 h ago" beside the clock is also the way back to now.
  const backToNow = () => { const at = nowPosition(); if (at != null && live.stream) seek(at); };
  $("when").addEventListener("click", backToNow);
  $("when").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); backToNow(); } });
  $("speed").addEventListener("change", (e) => {
    live.speed = Number(e.target.value);
    settings.speed = live.speed;  // remembered with the other settings, and in ?s= links
    settings.speedChosen = true;  // a chosen speed also holds for data re-timed to now
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
      } else if (live.feed && glideFeed(dt) && now - lastStep > 250) { lastStep = now; step(); }
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
  /* The feeds ?live= may connect to: this site (`nora live` serves the page and its
     feed together) or this computer. Any other site is refused, so a link to the public
     page cannot show someone else's numbers and alarms as NORA's live data. */
  const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
  function liveFeedUrl(value) {
    let url;
    try { url = new URL(value, location.href); } catch (error) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    const here = new URL(location.href);
    return url.origin === here.origin || LOCAL_HOSTS.includes(url.hostname) ? url.href : null;
  }
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
      receiveMeta(meta);
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
  function receiveMeta(meta) {
    live.feedEvents = meta.events || [];
    live.feedPigs = meta.pigs || [];
    // A feed re-timed to the wall clock (`nora live --now`) says how fast its clock runs.
    live.feedSpeed = meta.retimed && meta.retimed.speed > 0 ? meta.retimed.speed : null;
  }
  /* Between a re-timed feed's frames the clock runs on at the feed's speed, so pigs and
     peaks glide instead of jumping once an hour; never past one step beyond the last
     frame, where the next one is due. The values stay the last frame's. */
  function glideFeed(dt) {
    const n = live.frames.length;
    if (!live.feedSpeed || !n || live.stale) return false;
    const last = live.frames[n - 1], gap = n > 1 ? last.t - live.frames[n - 2].t : 3600;
    const next = Math.min(last.t + gap, Math.max(live.time ?? last.t, last.t) + dt * live.feedSpeed);
    if (next === live.time) return false;
    live.time = next;
    return true;
  }
  function receiveFrame(f) {
    const last = live.frames[live.frames.length - 1], entry = { t: f.t, flows: f.values, metrics: f.metrics || {}, plan: f.plan || null };
    if (last && f.t < last.t) {
      live.frames = []; live.peaks = []; live.quality = []; live.slugs = new Map(); live.down = {};
      live.onset = new Map(); live.jumped = true;
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
  /* A tab left open keeps the build it was opened with, and then shows bugs fixed since as
     if they were still there (Ray, 29 Oct). Every 5 minutes the page asks the site which
     build it serves (version.json beside it). A newer one: the page reloads itself once
     nobody has touched it for a minute, or the bar offers "New version · Reload" while
     someone is at it or has What-if values that a reload would clear. Edits and notes are
     kept in the browser and survive a reload. */
  const BUILD = ((document.querySelector && document.querySelector('meta[name="nora-build"]')) || {}).content || "";
  let lastInput = Date.now();
  for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
  async function checkBuild(now = Date.now()) {
    if (!BUILD) return null; // opened from a file or a dev build: nothing to compare
    let published = null;
    try {
      const response = await fetch(`version.json?at=${now}`, { cache: "no-store" });
      published = response.ok ? (await response.json()).build : null;
    } catch (error) { return null; } // offline, or the site has no version.json: keep this build
    if (!published || published === BUILD) return "current";
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName || "");
    if (now - lastInput >= 60000 && !typing && !whatifChanges()) { location.reload(); return "reloaded"; }
    $("update").hidden = false;
    return "offered";
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
    if (ctx.note) items.push({ label: "Add a note here", act: ctx.note });
    items.push("-");
    if (d.kind === "node") items.push({
      label: whatif.offline.has(id) ? "Restore in the what-if" : "Take offline in the what-if",
      act: () => { if (state.mode !== "whatif") { state.mode = "whatif"; markTabs(); restyle(); } toggleOffline(id); renderSidebar(); renderWhatif(); },
    });
    items.push({ label: "Open the full page", act: () => go({ screen: "asset", asset: id }) });
    if (d.kind === "node") items.push({ label: "Diagnostics", act: () => go({ screen: "diag", asset: id }) });
    if (!embed && state.mode === "edit") { // changing the network only in Edit
      items.push("-");
      if (d.kind === "node" && ctx.connect) items.push({ label: "Connect to another node…", act: ctx.connect });
      items.push(d.kind === "node"
        ? { label: "Remove from the network", act: () => commitEdit({ op: "removeNode", id }) }
        : { label: "Remove this line", act: () => commitEdit({ op: "removeLine", id }) });
    }
    return items;
  }

  /* Safari pinches with gesture events, where other browsers send Ctrl + wheel: the
     same zoom either way (Ray, 29 Oct: "zooming in and out should be seamless ...
     regardless of browser"). `zoom(factor, at)`, `at` in the element's pixels. */
  function onPinch(el, zoom) {
    let last = 1;
    el.addEventListener("gesturestart", (e) => { e.preventDefault(); last = 1; });
    el.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.scale > 0) zoom(e.scale / last, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      last = e.scale || last;
    });
    el.addEventListener("gestureend", (e) => e.preventDefault());
  }

  // ------------------------------------------------------------------ map notes
  /* A note on a pipeline (Ray, 29 Oct: "on the map i should be able to add a note to that
     spesific location on the pipeline with arrow pointing to it and then write inside a
     minimalsistic note window"). Right-click a line on the Map, "Add a note here": a
     small window opens beside that point of the laid route with a hairline arrow to it,
     ready to type in. Drag the window by its frame; × or leaving it empty removes it.
     Kept in this browser, like a peak's Notified and Origo reference. */
  const NOTES = "nora-map-notes";
  const notes = { list: readNotes(), listeners: new Set(), version: 0 };
  function readNotes() {
    try {
      const all = JSON.parse(localStorage.getItem(NOTES) || "[]");
      return (Array.isArray(all) ? all : []).filter((n) => n && assets[n.pid] && Number.isFinite(n.lon) && Number.isFinite(n.lat))
        .map((n) => ({ id: String(n.id), pid: n.pid, lon: n.lon, lat: n.lat, text: String(n.text || ""), dx: Number(n.dx) || 28, dy: Number(n.dy) || -64 }));
    } catch (error) { return []; }
  }
  function notesChanged(save = true) {
    notes.version++;
    if (save) {
      const kept = notes.list.map(({ id, pid, lon, lat, text, dx, dy }) => ({ id, pid, lon, lat, text, dx, dy }));
      try { localStorage.setItem(NOTES, JSON.stringify(kept)); } catch (error) { /* kept for this view only */ }
    }
    for (const fn of notes.listeners) fn();
  }
  function addNote(pid, lon, lat) {
    const note = { id: `n${Date.now().toString(36)}${notes.list.length}`, pid, lon, lat, text: "", dx: 28, dy: -64, fresh: true };
    notes.list.push(note);
    notesChanged();
    return note;
  }
  function removeNote(id) {
    if (!notes.list.some((n) => n.id === id)) return;
    notes.list = notes.list.filter((n) => n.id !== id);
    notesChanged();
  }
  // The point of a laid route ([lon, lat] points) nearest a point on screen.
  function snapToRoute(line, toScreen, sx, sy) {
    let best = null;
    for (let i = 1; i < line.length; i++) {
      const a = toScreen(line[i - 1]), b = toScreen(line[i]), dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((sx - a.x) * dx + (sy - a.y) * dy) / len2)), d = Math.hypot(a.x + t * dx - sx, a.y + t * dy - sy);
      if (!best || d < best.d) best = { d, at: [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t] };
    }
    return best ? best.at : line[0];
  }
  /* The notes over one map: a window per note in `container`, placed at every draw
     from `toScreen` ([lon, lat] to pixels in the container), its arrow drawn on `ctx`.
     A note whose line is hidden, or that is off screen, hides its window. Returns where
     each window went. */
  function noteLayer(container) {
    const layer = h("div", { class: "map-notes" }), cards = new Map();
    container.append(layer);
    function card(note) {
      const text = h("textarea", { rows: "1", maxlength: "500", placeholder: "Note", "aria-label": `Note on ${nameOf(note.pid)}` });
      text.value = note.text;
      const fit = () => { text.style.height = "auto"; text.style.height = `${text.scrollHeight}px`; };
      text.addEventListener("input", () => { note.text = text.value; fit(); notesChanged(); });
      text.addEventListener("blur", () => { if (!note.text.trim()) removeNote(note.id); });
      text.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") text.blur(); });
      const close = h("button", { type: "button", class: "close", title: "Remove the note", "aria-label": "Remove the note", onclick: () => removeNote(note.id) }, "×");
      const el = h("div", { class: "map-note-card" }, text, close);
      // The map's own gestures stay off the window; its frame drags it.
      for (const type of ["wheel", "mousedown", "click", "dblclick", "contextmenu"]) el.addEventListener(type, (e) => e.stopPropagation());
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.target !== el) return;
        e.preventDefault();
        const from = { x: e.clientX, y: e.clientY, dx: note.dx, dy: note.dy }, k = display.scale || 1;
        const move = (m) => { note.dx = from.dx + (m.clientX - from.x) / k; note.dy = from.dy + (m.clientY - from.y) / k; notesChanged(false); };
        const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); notesChanged(); };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
      });
      layer.append(el);
      const made = { el, text, fit };
      cards.set(note.id, made);
      if (note.fresh) { delete note.fresh; setTimeout(() => { fit(); text.focus(); }, 0); } else setTimeout(fit, 0);
      return made;
    }
    function draw(ctx, toScreen, visible = () => true) {
      const k = display.scale || 1, w = container.clientWidth, hgt = container.clientHeight, seen = new Set(), placed = [];
      ctx.save();
      ctx.strokeStyle = COLORS.text;
      ctx.fillStyle = COLORS.text;
      ctx.lineWidth = 1;
      for (const note of notes.list) {
        const c = cards.get(note.id) || card(note), p = toScreen([note.lon, note.lat]);
        seen.add(note.id);
        const shown = visible(note.pid) && p.x > -20 && p.y > -20 && p.x < w + 20 && p.y < hgt + 20;
        c.el.hidden = !shown;
        if (!shown) { placed.push({ id: note.id, hidden: true }); continue; }
        const x = p.x + note.dx * k, y = p.y + note.dy * k, cw = c.el.offsetWidth || 120 * k, ch = c.el.offsetHeight || 28 * k;
        c.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        placed.push({ id: note.id, x: Math.round(x), y: Math.round(y), hidden: false });
        // The arrow: from the nearest point of the window's edge to the point on the line.
        const sx = Math.max(x, Math.min(x + cw, p.x)), sy = Math.max(y, Math.min(y + ch, p.y)), len = Math.hypot(p.x - sx, p.y - sy);
        if (len < 6 * k) continue;
        const ux = (p.x - sx) / len, uy = (p.y - sy) / len, head = 6 * k;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(p.x - ux * head * 0.6, p.y - uy * head * 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - ux * head - uy * head * 0.45, p.y - uy * head + ux * head * 0.45);
        ctx.lineTo(p.x - ux * head + uy * head * 0.45, p.y - uy * head - ux * head * 0.45);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
      return placed;
    }
    return { draw, element: layer };
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
     and the site rebuilds; anywhere else (a file, the hosted site) the three files download,
     ready to put in data/ and commit. */
  async function saveEdits() {
    editNote("Saving…");
    let current = null;
    try {
      const response = await fetch("api/network", { cache: "no-store" });
      if (response.ok) current = await response.json();
    } catch (error) { current = null; }
    if (!current) { downloadEdits(); return; }
    // Hosted (NORA_EDIT_TOKEN on the server), a save carries the edit key: asked for once
    // and kept in this browser (Ray: "i will later host this solution").
    const send = (key) => fetch("api/save", {
      method: "POST", body: JSON.stringify(editedNetwork(current)),
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    try {
      let key = null;
      try { key = localStorage.getItem("nora-edit-key"); } catch (error) { key = null; }
      let response = await send(key);
      if (response.status === 401 && typeof window.prompt === "function") {
        key = window.prompt("This NORA server needs its edit key to save:") || "";
        if (key) { try { localStorage.setItem("nora-edit-key", key); } catch (error) { /* asked again next time */ } response = await send(key); }
      }
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.saved) { edits.length = 0; storeEdits(edits); reloadKeepingView(); return; }
      if (response.status === 401) { try { localStorage.removeItem("nora-edit-key"); } catch (error) { /* nothing kept */ } }
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
  /* The edits bar shows only in Edit (Ray, 29 Oct, of "13 changes to the network kept in
     this browser until saved": "what is the purpose of this? maybe remove it?"). Edits are
     made in Edit, where the bar lists them with Undo, Save and Discard. */
  function renderEditsBar() {
    if (!edits.length || state.mode !== "edit") { if (editsBar) { editsBar.remove(); editsBar = null; } return; }
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

  // A mode tab: what the lines show (and Edit, where the network can be changed).
  function setMode(mode) {
    state.mode = mode;
    markTabs();
    restyle();
    renderWhatif();
    renderEditsBar();
    renderSidebar();
    if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
  }
  function markTabs() {
    for (const tab of document.querySelectorAll("[data-view]")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    for (const tab of document.querySelectorAll("[data-mode]")) tab.setAttribute("aria-selected", String(tab.dataset.mode === state.mode));
  }

  function start() {
    $("update").addEventListener("click", () => location.reload());
    if (BUILD) setInterval(checkBuild, 5 * 60 * 1000);
    $("crumb-overview").addEventListener("click", () => go({ screen: "overview" }));
    $("crumb-asset").addEventListener("click", () => go({ screen: "asset", asset: route.asset }));
    $("theme-toggle").addEventListener("click", () => setTheme(theme === "light" ? "dark" : "light"));
    $("side-close").addEventListener("click", closeSidebar);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && (side.id || side.marker || side.form)) closeSidebar(); });
    addEventListener("click", closeMenu);
    addEventListener("resize", closeMenu);
    addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closePops(); } });
    for (const tab of document.querySelectorAll("[data-view]")) {
      tab.addEventListener("click", () => {
        state.view = tab.dataset.view;
        markTabs();
        // The bar is identical on every page: a view tab from another screen opens it.
        if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
        else render();
      });
    }
    for (const tab of document.querySelectorAll("[data-mode]")) tab.addEventListener("click", () => setMode(tab.dataset.mode));
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
    if (["live", "load", "risk", "whatif", "plain", "edit"].includes(params.get("mode"))) state.mode = params.get("mode");
    state.year = new Date().getFullYear();
    restored = takeRestore(); // after an edit: the same view and mode as before the reload
    if (restored) {
      if (views[restored.view]) state.view = restored.view;
      if (["live", "load", "risk", "whatif", "plain", "edit"].includes(restored.mode)) state.mode = restored.mode;
    }
    renderEditsBar();
    markTabs();
    renderWhatif();
    buildKey();
    buildSettings();
    if (!embed && !storedFlag("nora-guide-seen")) openGuide();
    const feed = params.has("live") ? liveFeedUrl(params.get("live")) : null;
    if (params.has("live") && !feed) console.warn(`NORA: live feed ${params.get("live")} refused: only this site or this computer can feed the page`);
    if (NORA.streams.length || feed) {
      document.body.classList.add("has-player");
      $("player").hidden = false;
    }
    if (feed) connectFeed(feed);
    else if (NORA.streams.length) {
      const select = $("stream-select");
      select.replaceChildren(...NORA.streams.map((s) => h("option", { value: s.name }, `${s.title}${s.synthetic ? " (synthetic)" : ""}`)));
      select.disabled = NORA.streams.length < 2;
      const wanted = NORA.streams.find((s) => s.name === params.get("stream")) || NORA.streams[0];
      select.value = wanted.name;
      setStream(wanted);
    }
    go(fromHash() || (C.screen.start === "network" ? { screen: "unit", unit: "all" } : { screen: "overview" }), false);
    if (params.get("autoplay") === "1" || (C.screen.autoplay && params.get("autoplay") !== "0" && !feed)) play();
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
      result: whatifResult, // the most the network can deliver with assets offline (the analysis' max flow)
      state: whatifState, // the steady state: flows, pressures, line pack, balance
      set: setWhatif, // ("supply" | "offtake" | "pressure" | "pack", id, value or null)
      scenario: (key) => { if (key) { whatif.scenario = key; whatifChanged(); } return whatif.scenario; },
      reset: resetWhatif,
      toggle: toggleOffline,
      clear: () => { whatif.offline.clear(); whatif.cache = null; whatif.version++; },
      offline: () => [...whatif.offline],
      card: whatifCard,
    },
    routes: { nextOut, pigPlace, peakPlace, seeded },
    colors: COLORS, levelColor: LEVEL_COLOR, shapeMarkup, drawBadge, drawMarker, drawBand, markerSize, markerTip, levelOf, alarmHandling, buildAlarms, fmt, esc, nameOf, unitOf, units: unitById,
    linepack, packRate, pressureRate, inventory, settleOut, // the line-pack model (PMS-style estimates)
    pressureMark, flowMark, limitInk, drawFlowDirection, gasDayChart, gasQuality, pressureOutlook, pressureChart,
    airTemp: (id) => metric("air_temp_c", id),
    rampAhead, // the next 6 hours of nominations at an exit point
    reachAhead, // and whether its pressure holds for them with the input as now
    pipeStyle, pipeMapName, pipeDetail, detailZoom: DETAIL_ZOOM, visibleRange, bandStops, nodeStyle, markers, window4h, nominationWindow, nominationHistogram, flowRate, thresholds: T,
    // Where the playhead stands against the wall clock ({ahead, model}), or null.
    timeState, timelineWindow, seek,
    // The display profile (desk, wall or compact) and the one UI scale (1 = 100 %).
    display: () => display.profile,
    uiScale: () => display.scale,
    mix, onPinch, checkBuild, // for tests
    // Seconds between repaints of what moves while the data plays: about 20 a second, every
    // third frame at 60 (Ray, 29 Oct: "fix performance, it is lagging"); a pan, a zoom or
    // new data still draws at once. Under 0.05 so frame jitter never skips a fourth.
    movingStep: 0.045,
    build: () => BUILD,
    notes: {
      list: () => notes.list, add: addNote, remove: removeNote, snap: snapToRoute, layer: noteLayer,
      version: () => notes.version, onChange: (fn) => notes.listeners.add(fn),
    },
    // Flow through a node now (MSm³/d) and its pressure (bar), for the views to show.
    reading: (id) => cached("reading", id, () => { const f = viewFrame(); return { flow: throughput(id, f.flows), pressure: metric("pressure_bar", id, f) }; }),
    lineFlow, stateShown: () => state.mode === "live" || state.mode === "whatif",
    frame: frameApi, cached,
    dayDelivery, register, restyle, go, start, setMode, theme: () => theme, buildSettings,
    // `at`: where the click was (client px), for What-if's window on the view.
    select: (id, at = null) => {
      if (!id || !assets[id]) { if (route.screen === "unit" && state.mode !== "whatif") closeSidebar(); return; }
      if (state.mode === "whatif" && at) { openWhatifEditor(id, at); return; } // your numbers, right there
      if (state.mode === "whatif") { openSidebar(id); return; } // its what-if card: your values
      // On the unit screen the details slide in from the right instead of taking over the page.
      if (route.screen === "unit") { openSidebar(id); return; }
      go({ screen: "asset", asset: id });
    },
    sidebar: { open: (id) => openSidebar(id), close: closeSidebar, id: () => side.id, marker: () => side.marker },
    depth: { at: depthAt, ready: () => depthGrid.ready }, // water depth (m) under a position
    positionText,
    selectMarker: openMarker, // a click on a pig or a peak, from any view
    feed: { frame: receiveFrame, trouble: feedTrouble, meta: receiveMeta, glide: glideFeed }, // the live feed's handlers, for tests
    menu: { open: openMenu, close: closeMenu, for: menuFor },
    // The editor: the Flow view's right-click on empty paper, its connect step, the
    // edited data files and network, and the viewport to restore after an edit.
    edit: {
      canvasMenu: (ctx) => (embed || state.mode !== "edit" ? [] : [{ label: "Add a node here", act: () => openNodeForm(ctx) }]),
      lineForm: openLineForm,
      move: commitMove,
      list: () => edits.slice(),
      files: editedFiles,
      network: editedNetwork,
      save: saveEdits,
      viewport: () => (restored && restored.flow) || null,
    },
  };
})();
