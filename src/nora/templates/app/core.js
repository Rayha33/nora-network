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
  /* An existing node or line changed in the editor's form (Ray, 30 Oct: "the editing page
     should be a fully fledged editing program where new nodes can be added or removed,
     named, etc"). Only the fields given change; the id stays, so streams still find it.
     `changed` marks the row for the files Save writes. */
  const NODE_FIELDS = ["name", "type", "country", "lat", "lon", "capacity", "operator", "status", "notes"];
  const LINE_FIELDS = ["name", "type", "capacity", "length", "diameter", "bidirectional", "status", "operator", "notes"];
  function changeNode(id, changes) {
    const d = NORA.assets[id];
    for (const key of NODE_FIELDS) if (key in changes) d[key] = changes[key];
    d.supply = NORA.supplyTypes.includes(d.type);
    d.exit = d.type === "terminal" || d.type === "market";
    d.changed = true;
    if (changes.unit && NORA.units.some((u) => u.id === changes.unit)) {
      for (const unit of NORA.units) unit.nodes = unit.nodes.filter((n) => n !== id);
      NORA.units.find((u) => u.id === changes.unit).nodes.push(id);
      // a line belongs to the unit of the node it leaves (units.py)
      const out = Object.keys(NORA.assets).filter((pid) => NORA.assets[pid].kind === "pipeline" && NORA.assets[pid].from === id);
      for (const unit of NORA.units) unit.pipelines = (unit.pipelines || []).filter((p) => !out.includes(p));
      const unit = NORA.units.find((u) => u.id === changes.unit);
      unit.pipelines = [...(unit.pipelines || []), ...out];
    }
    const feature = NORA.geo.nodes.features.find((f) => f.properties.asset === id);
    if (feature) {
      Object.assign(feature.properties, { name: d.name, type: d.type });
      feature.geometry.coordinates = [d.lon, d.lat];
    }
  }
  function changeLine(pid, changes) {
    const d = NORA.assets[pid];
    for (const key of LINE_FIELDS) if (key in changes) d[key] = changes[key];
    if ("length" in changes) d.km = d.length || kmBetween(NORA.assets[d.from], NORA.assets[d.to]); // markers move by it
    if (changes.reverse) {
      [d.from, d.to] = [d.to, d.from];
      const feature = NORA.geo.pipes.features.find((f) => f.properties.asset === pid);
      if (feature) feature.geometry.coordinates = feature.geometry.coordinates.slice().reverse();
      for (const unit of NORA.units) unit.pipelines = (unit.pipelines || []).filter((p) => p !== pid);
      const unit = NORA.units.find((u) => u.nodes.includes(d.from));
      if (unit) (unit.pipelines = unit.pipelines || []).push(pid);
    }
    d.changed = true;
    const vis = visData();
    if (vis && vis.edges.get(pid)) vis.edges.update({ id: pid, from: d.from, to: d.to, arrows: d.bidirectional ? "to, from" : "to" });
  }
  // One step onto NORA; false when it no longer applies (the data changed under it).
  function applyEdit(step) {
    const A = NORA.assets, has = (id, kind) => A[id] && A[id].kind === kind;
    if (step.op === "removeNode" && has(step.id, "node")) { dropNode(step.id); return true; }
    if (step.op === "removeLine" && has(step.id, "pipeline")) { dropLine(step.id); return true; }
    if (step.op === "addNode" && step.node && !A[step.node.id]) { putNode(step.node); return true; }
    if (step.op === "addLine" && step.line && !A[step.line.id] && has(step.line.from, "node") && has(step.line.to, "node")) { putLine(step.line); return true; }
    if (step.op === "moveNode" && has(step.id, "node") && Array.isArray(step.grid)) { NORA.grid[step.id] = step.grid; return true; }
    if (step.op === "editNode" && has(step.id, "node") && step.changes) { changeNode(step.id, step.changes); return true; }
    if (step.op === "editLine" && has(step.id, "pipeline") && step.changes) { changeLine(step.id, step.changes); return true; }
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

