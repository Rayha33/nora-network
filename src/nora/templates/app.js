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
  function fmt(value, digits = 0) {
    if (value == null || Number.isNaN(value)) return "–";
    return Number(value).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
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
  const assets = NORA.assets;
  const nameOf = (id) => (assets[id] || {}).name || id;
  const timeFormat = (epoch, opts) => new Date(epoch * 1000).toLocaleString("en-GB", { timeZone: "UTC", ...opts });
  const formatTime = (t) => timeFormat(t, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";
  const shortTime = (t) => timeFormat(t, { weekday: "short", hour: "2-digit", minute: "2-digit" });

  /* The label beside a moving marker: its value, then the ETA in a dimmer tone, in
     small regular type with a paper halo (no box, so nothing covers the map). `detail`
     follows the zoom: 0 labels only gas quality and alarms, 1 every marker, 2 adds the
     next stop. */
  function markerLabel(ctx, marker, x, y, size, detail) {
    if (!marker.value || (!detail && !marker.level && marker.kind !== "quality")) return;
    const font = 10.5, gap = 5, lx = x + size * 1.7, ly = y - size * 1.4;
    const parts = [[marker.value, COLORS.text], [marker.eta || "", COLORS.text_dim]];
    if (detail >= 2 && marker.to) parts.push([marker.to, COLORS.text_dim]);
    ctx.save();
    ctx.font = `${font}px Archivo, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = COLORS.paper;
    let cx = lx;
    for (const [text, color] of parts) {
      if (!text) continue;
      ctx.strokeText(text, cx, ly);
      ctx.fillStyle = color;
      ctx.fillText(text, cx, ly);
      cx += ctx.measureText(text).width + gap;
    }
    ctx.restore();
    if (marker.level) drawBadge(ctx, marker.level, cx + 2, ly - font * 0.6, Math.max(5, size * 0.8));
  }
  // A gas quality parcel: a calm-coloured dot; the strongest parcel of a slug is labelled.
  function drawParcel(ctx, marker, x, y, size, detail) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, size * (marker.lead ? 0.85 : 0.6), 0, Math.PI * 2);
    ctx.fillStyle = COLORS[QUALITY[marker.gas].color];
    ctx.fill();
    ctx.lineWidth = Math.max(1, size / 6);
    ctx.strokeStyle = COLORS.casing;
    ctx.stroke();
    ctx.restore();
    if (marker.lead) markerLabel(ctx, marker, x, y, size, detail);
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
        inactive: card(mix(c.paper, "#000000", 0.3), c.text_dim, c.inactive, c.inactive),
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
    const number = `<text x="${x}" y="${y + (lvl === 1 ? 4.2 : 3.6)}" text-anchor="middle" font-size="${s * 1.35}" font-weight="700" font-family="Archivo, sans-serif" fill="${ink}">${4 - lvl}</text>`;
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
    ctx.font = `700 ${size * 1.3}px Archivo, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(4 - lvl), x, y + (lvl === 1 ? size * 0.28 : size * 0.08));
    ctx.restore();
  }
  /* A pig (a dot-sized solid triangle pointing downstream) or a peak (a calm circle)
     at x, y, turned along the line by `angle`. Each kind has its own shape AND its
     own calm colour, so nothing reads as an alarm badge (triangle/diamond/square in
     amber/orange/red). */
  function drawMarker(ctx, marker, x, y, angle, size = 7, detail = 1) {
    if (marker.kind === "quality") { drawParcel(ctx, marker, x, y, size, detail); return; }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    if (marker.kind === "pig") {
      const s = Math.max(4, size * 0.8);
      ctx.moveTo(s, 0); ctx.lineTo(-s * 0.8, -s * 0.7); ctx.lineTo(-s * 0.8, s * 0.7); ctx.closePath();
    } else {
      ctx.arc(0, 0, Math.max(4, size * 0.75), 0, Math.PI * 2);
    }
    ctx.fillStyle = marker.kind === "pig" ? COLORS.pig : COLORS.peak;
    ctx.fill();
    ctx.lineWidth = Math.max(1, size / 6);
    ctx.strokeStyle = COLORS.casing;
    ctx.stroke();
    ctx.restore();
    if (marker.kind !== "pig") markerLabel(ctx, marker, x, y, size, detail);
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

  // ---------------------------------------------------------------- timeline
  /* Planned and decommissioned assets on a timeline: the year on the track
     decides which assets both views show, on top of App.nodeStyle / pipeStyle.
     A node is shown from its startup year until the year before its shutdown
     year; a blank year means the data does not know, so the asset has always
     been there. The track is data-driven and deterministic: it spans the years
     in the CSVs, starts at today and only restyles (no animation). */
  const YEARS = [...nodeIds, ...pipeIds].flatMap((id) => {
    const d = assets[id];
    return [d.startup, d.shutdown, d.commissioned].filter((y) => y != null);
  });
  const yearInput = $("year"), yearOut = $("year-out");
  function yearActive(id) {
    const d = assets[id], year = state.year;
    if (year == null) return true;
    if (d.kind === "pipeline") return yearActive(d.from) && yearActive(d.to);
    return !(d.startup && year < d.startup) && !(d.shutdown && year >= d.shutdown);
  }
  function setYear(year) {
    state.year = year;
    whatif.cache = null;  // the what-if network is the one standing in that year
    yearInput.value = String(year);
    const appearing = nodeIds.filter((id) => assets[id].startup === year);
    const shutting = nodeIds.filter((id) => assets[id].shutdown === year);
    yearOut.replaceChildren(String(year), h("span", { class: "dim" },
      `${appearing.length ? ` +${appearing.length}` : ""}${shutting.length ? ` −${shutting.length}` : ""}`));
    yearInput.title = [
      appearing.length ? `Appearing in ${year}: ${appearing.map(nameOf).join(", ")}` : "",
      shutting.length ? `No longer shown from ${year}: ${shutting.map(nameOf).join(", ")}` : "",
    ].filter(Boolean).join("; ") || "No asset starts or shuts down in this year";
    restyle();
  }
  yearInput.addEventListener("input", () => setYear(Number(yearInput.value)));
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

  // How fast gas through a node is changing, MSm³/d per hour, over the last 2 hours.
  const flowRate = (id) => rate(window4h(id).past);
  /* The 4-hour window shown in each flow-view card: the last 2 hours of actual flow,
     and the next 2 hours of what shippers have nominated (from the recorded data, or
     the `ahead` block of a live-feed frame). */
  function window4h(id) {
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
    return { pid: seg.pid, along: seg.forward ? along : 1 - along };
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
      if (place) out.push({ kind: "pig", id: place.pid, along: place.along, label: "", level: 0, title: pig.label });
    }
    for (const peak of live.peaks) {
      const place = peakPlace(peak);
      if (!place) continue;
      const d = assets[place.pid];
      out.push({ kind: "peak", id: place.pid, along: place.along, level: peak.level, rising: place.delta > 0,
        value: `${place.delta > 0 ? "+" : "−"}${fmt(Math.abs(place.delta), 1)}`, eta: clock(place.exitAt),
        to: nameOf(place.forward ? d.to : d.from) });
    }
    const leads = new Map(slugs().map((s) => [s.q, s]));
    for (const q of live.quality) {
      const along = q.arrived ? 1 : Math.min(1, (live.time - q.t0) / travelSeconds(q.pid)), s = leads.get(q);
      out.push({ kind: "quality", gas: q.metric, id: q.pid, along: q.forward ? along : 1 - along, lead: Boolean(s),
        level: s ? Math.max(s.level, s.exitLevel) : 0,
        value: s ? `${QUALITY[q.metric].name} ${fmt(q.conc, QUALITY[q.metric].digits)}` : "",
        eta: s && !q.arrived ? clock(s.next.t) : "", to: s ? nameOf(q.arrived ? q.arrived.node : s.next.node) : "" });
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
        live.quality.push({ metric: name, origin: node, slug, conc: value, pid: route.pid, forward: route.forward, t0: current.t, arrived: null });
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
      if (d.type === "market") sinkArc[id] = add(id, WHATIF_SINK, Infinity);
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
        : `What-if: ${fmt(value, 1)} of ${fmt(base, 1)} MSm³/d deliverable`),
      h("span", { class: "dim" }, ` · ${n} offline · restore all`));
    chip.title = "Restore every asset: the what-if becomes the intact network again";
  }

  // ------------------------------------------------------------------ styling rules (both views)
  /* A pipeline: grey by state (dark grey without flow, lightest grey flowing); colour
     only for an abnormal condition. */
  function pipeStyle(id) {
    const d = assets[id], mode = state.mode, onshore = d.type === "onshore";
    const out = {
      color: COLORS.normal, width: d.capacity ? 0.6 + 0.9 * Math.sqrt(d.capacity / maxCapacity) : 0.6,
      dashed: onshore || d.status !== "operating", label: "", level: 0,
      forward: true, backward: Boolean(d.bidirectional),
      hidden: !visible(id), dim: route.unit !== "all" && unitOf[id] !== route.unit,
    };
    if (d.status !== "operating") out.color = COLORS.inactive;
    if (mode === "live") {
      const v = live.values[id];
      if (v === undefined) Object.assign(out, { color: COLORS.inactive, width: 1, dashed: true });
      else {
        const m = Math.abs(v);
        out.width = 1 + 4 * Math.sqrt(m / live.maxAbs);
        out.color = m < 0.05 ? COLORS.inactive : COLORS.active;
        out.label = fmt(m, 1);
        out.level = levelOf(id);
        if (d.bidirectional) Object.assign(out, { forward: v >= 0, backward: v < 0 });
      }
    } else if (mode === "load") {
      out.color = d.utilization == null ? COLORS.inactive : COLORS.active;
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
        out.label = fmt(m, 1);
      }
    }
    if (out.level) out.color = LEVEL_COLOR[out.level];
    if (settings.lineValues === "off" || (settings.lineValues === "auto" && mode === "plain")) out.label = "";
    if (settings.lineValues === "on" && !out.label && d.capacity) out.label = fmt(d.capacity);
    return out;
  }
  /* A node: neutral icon, dark grey when inactive, an alarm badge when abnormal. */
  function nodeStyle(id) {
    const d = assets[id], mode = state.mode;
    const out = { level: 0, inactive: d.status !== "operating", sub: NORA.short[d.type], scale: 1,
      hidden: !visible(id), dim: route.unit !== "all" && unitOf[id] !== route.unit };
    if (mode === "live") {
      const f = frame(), through = throughput(id, f.flows), p = metric("pressure_bar", id, f);
      const nom = metric("nomination_msm3d", id, f);
      out.level = levelOf(id);
      if (through != null && through < 0.05) out.inactive = true;
      const parts = [];
      if (nom > 0) parts.push(`${fmt(through, 1)} / ${fmt(nom, 1)} nom`);
      else if (through != null) parts.push(`${fmt(through, 1)} MSm³/d`);
      if (p != null) parts.push(`${fmt(p)} bar`);
      out.sub = parts.join("  ") || out.sub;
    } else if (mode === "load" && d.modelFlow != null) {
      out.sub = `${fmt(d.modelFlow)} MSm³/d`;
    } else if (mode === "risk" && d.type !== "market") {
      out.level = level(d.share, T.risk);
      out.scale = 0.75 + 0.9 * Math.sqrt(d.lost / worst);
      out.sub = d.lost ? `−${fmt(d.lost)} if it trips` : "No loss if it trips";
    } else if (mode === "whatif") {
      if (whatif.offline.has(id)) { out.inactive = true; out.sub = "offline"; }
      else if (d.type === "market") out.sub = `${fmt(whatifResult().delivered[id] || 0, 1)} MSm³/d`;
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
      id, unit: "MSm³/d", lvl, band,
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
      id, unit: "bar", lvl, band,
      bar: rangeBar({ min: low - 0.1 * span, max: high + 0.1 * span, value: p, lvl, band,
        ticks: [{ at: low, level: 3 }, { at: high, level: 3 }, { at: low + pm[1] * span, level: 2 }, { at: high - pm[1] * span, level: 2 }] }),
      series: series((f) => metric("pressure_bar", id, f)),
      value: `${fmt(p, 1)} bar, window ${fmt(low)}–${fmt(high)}`,
    };
  }
  function qualityIndicator(id, name) {
    const v = metric(name, id), limits = C.quality[name], lvl = level(v, limits);
    return {
      id, unit: QUALITY[name].unit, lvl, band: [0, limits[0]],
      bar: rangeBar({ min: 0, max: limits[2] * 1.5, value: v, lvl, band: [0, limits[0]],
        ticks: limits.map((at, i) => ({ at, level: i + 1 })) }),
      series: series((f) => metric(name, id, f)),
      value: `${qualityText(name, v)}, limit ${limits[2]}`,
    };
  }
  function loadIndicator(id) {
    const d = assets[id], v = Math.abs(frame().flows[id] || 0), u = v / d.capacity;
    return {
      id, unit: "pts", lvl: level(u, T.load), band: [0, T.load[0] * 100],
      bar: rangeBar({ min: 0, max: 1.1, value: u, lvl: level(u, T.load), band: [0, T.load[0]], ticks: T.load.map((at, i) => ({ at, level: i + 1 })) }),
      series: series((f) => (f.flows[id] == null ? null : (Math.abs(f.flows[id]) / d.capacity) * 100)),
      value: `${fmt(u * 100)}%: ${fmt(v, 1)} of ${fmt(d.capacity)} MSm³/d`,
    };
  }
  function bank(indicators, empty) {
    if (!indicators.length) return h("p", { class: "empty" }, empty);
    return h("div", { class: "bank" },
      h("div", { class: "head" }, "Asset"), h("div", { class: "head" }, "Value in its range"),
      h("div", { class: "head" }, "Trend"), h("div", { class: "head optional" }, "Change"), h("div", { class: "head optional" }, "State"),
      ...indicators.flatMap((ind) => [
        h("div", { class: "name", onclick: () => go({ screen: "asset", asset: ind.id }), title: "Open the asset" }, nameOf(ind.id)),
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
      : nowLevel ? `${plan.now[1]} now`
      : plan.ahead[0] ? `In ${fmt(plan.ahead[3])} h: ${plan.ahead[1]}`
      : "Plan holds at every exit point";
    const context = plan ? `Nominated ${fmt(plan.nominated)} MSm³/d, deliverable ${fmt(plan.deliverable)} MSm³/d. Busiest line: ${nameOf(plan.bottleneck)} at ${fmt(plan.maxLoad * 100)}%.` : "";
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
        h("div", { class: "box" }, h("h2", { title: "Live readings in their ranges, from the data being played" }, "Values"), bank(indicators, "No live readings for this asset in the dataset."),
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
     plant or icon is clicked on the unit screen, and follows the data as it plays. */
  const side = { id: null };
  function openSidebar(id) {
    if (!assets[id]) return;
    side.id = id;
    renderSidebar();
    $("asset-side").classList.add("open");
    $("asset-side").setAttribute("aria-hidden", "false");
  }
  function closeSidebar() {
    side.id = null;
    $("asset-side").classList.remove("open");
    $("asset-side").setAttribute("aria-hidden", "true");
  }
  function renderSidebar() {
    if (!side.id || !assets[side.id]) return;
    const d = assets[side.id], body = $("side-body"), top = body.scrollTop;
    $("side-title").textContent = d.name;
    $("side-sub").textContent = d.kind === "node"
      ? `${NORA.nodeTypes[d.type]} · ${d.operator || d.country}`
      : `${NORA.pipelineTypes[d.type]} · ${nameOf(d.from)} to ${nameOf(d.to)}`;
    body.replaceChildren(assetDetail(side.id, true));
    body.scrollTop = top;
  }
  function facts(id) {
    const d = assets[id];
    const lost = d.lost ? `${fmt(d.lost)} MSm³/d (${fmt(d.share * 100, 1)}%)` : "Nothing lost";
    const position = d.lat != null ? `${d.lat.toFixed(4)}°N, ${d.lon.toFixed(4)}°E` : null;
    const rows = d.kind === "node"
      ? [["Operator", d.operator], ["Capacity", d.capacity == null ? null : `${fmt(d.capacity)} MSm³/d`], ["If it trips", lost],
        ["Pressure window", C.pressure[d.type] ? `${C.pressure[d.type][0]}–${C.pressure[d.type][1]} bar` : null], ["Status", d.status],
        ["Position", h("a", { href: `https://www.google.com/maps?q=${d.lat},${d.lon}`, target: "_blank", rel: "noopener", title: "Open this exact location in Google Maps" }, position)]]
      : [["Capacity", d.capacity == null ? "Not modelled" : `${fmt(d.capacity)} MSm³/d`], ["Length", `${fmt(d.km)} km`],
        ["Diameter", d.diameter == null ? null : `${fmt(d.diameter)} in`], ["In service since", d.commissioned], ["If it trips", lost], ["Status", d.status]];
    return h("dl", { class: "facts" }, rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  }
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
    const W = 360, H = 230, mid = 112;
    const place = (list, y) => list.map((pid, i) => ({ pid, x: ((i + 1) / (list.length + 1)) * W, y }));
    let m = "";
    for (const { pid, x, y } of [...place(inbound, 26), ...place(outbound, 200)]) {
      const s = pipeStyle(pid), v = f.flows[pid], above = y < mid;
      const color = s.level ? LEVEL_COLOR[s.level] : v == null || Math.abs(v) < 0.05 ? COLORS.inactive : COLORS.active;
      const y1 = y + (above ? 8 : -8), y2 = mid + (above ? -20 : 20);
      if (s.level) m += `<line x1="${x}" y1="${y1}" x2="${W / 2}" y2="${y2}" stroke="${COLORS.casing}" stroke-width="${s.width + 2.4}"/>`;
      m += `<line x1="${x}" y1="${y1}" x2="${W / 2}" y2="${y2}" stroke="${color}" stroke-width="${Math.max(1.2, s.width)}"/>`;
      if (s.level) m += `<g transform="translate(${(x + W / 2) / 2 - 8} ${(y1 + y2) / 2 - 8})">${shapeMarkup(s.level)}</g>`;
      const label = `${nameOf(pid)}${v == null ? "" : `: ${fmt(Math.abs(v), 1)}`}`;
      m += `<text x="${x}" y="${above ? y : y + 14}" text-anchor="middle">${esc(label.length > 34 ? `${label.slice(0, 33)}…` : label)}</text>`;
    }
    if (d.kind === "node") m += `<image href="${NORA.icons[d.type]}" x="${W / 2 - 18}" y="${mid - 18}" width="36" height="36"/>`;
    else {
      const s = pipeStyle(id);
      m += `<text x="${W / 2}" y="40" text-anchor="middle">${esc(nameOf(d.from))}</text><text x="${W / 2}" y="${H - 14}" text-anchor="middle">${esc(nameOf(d.to))}</text>`;
      m += `<line x1="${W / 2}" y1="52" x2="${W / 2}" y2="${H - 34}" stroke="${s.level ? COLORS.casing : "none"}" stroke-width="${s.width + 2.4}"/><line x1="${W / 2}" y1="52" x2="${W / 2}" y2="${H - 34}" stroke="${s.level ? LEVEL_COLOR[s.level] : s.color}" stroke-width="${Math.max(1.2, s.width)}"/>`;
    }
    const lvl = levelOf(id);
    if (lvl) m += `<g transform="translate(${W / 2 + 12} ${mid - 30})">${shapeMarkup(lvl)}</g>`;
    if (d.kind === "node") m += `<text x="${W / 2 + 24}" y="${mid + 4}" font-weight="600">${esc(d.name)}</text>`;
    if (d.kind === "node" && !inbound.length && !outbound.length) m += `<text x="${W / 2}" y="200" text-anchor="middle" class="dimtext">No connected pipelines</text>`;
    return svg(`0 0 ${W} ${H}`, m, "schematic");
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
    const unitSelect = $("crumb-unit");
    unitSelect.value = s === "asset" || s === "diag" ? unitOf[route.asset] || "all" : route.unit;
    unitSelect.setAttribute("aria-current", s === "unit" ? "page" : "false");
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
    chip.hidden = !plan;
    if (!plan) return;
    const [lvl, text] = plan.now, [aheadLvl, aheadText, , hours] = plan.ahead;
    chip.replaceChildren(...(lvl ? [badge(lvl, ""), h("span", null, text)]
      : aheadLvl ? [badge(Math.min(aheadLvl, 2), ""), h("span", null, `In ${fmt(hours)} h: ${aheadText}`)]
      : [h("span", { class: "dim" }, "✓ Plan holds")]));
    chip.title = "Open the overview";
  }

  // ------------------------------------------------------------------ key and settings
  function buildKey() {
    const sample = (color, w, dash = "") => svg("0 0 26 14", `<line x1="1" y1="7" x2="25" y2="7" stroke="${COLORS.text}" stroke-width="${w + 2}"${dash}/><line x1="1" y1="7" x2="25" y2="7" stroke="${color}" stroke-width="${w}"${dash}/>`);
    $("key").replaceChildren(
      h("button", { type: "button", class: "text close", onclick: closeGuide }, "Close"),
      h("h3", null, "What this shows"),
      h("p", null, "The gas network under the North Sea: fields that produce gas, the pipelines that carry it, and the exit points where it is delivered to the UK and the Continent. ",
        "The data is played back like a recording; the dataset's name at the bottom says whether it is synthetic."),
      h("h3", null, "How to use it"),
      h("ol", null,
        h("li", null, "Overview answers one question: is the plan holding? Problems are listed with their likely cause and what to do."),
        h("li", null, "Press ▶ to play the data, drag the timeline, or press Next problem."),
        h("li", null, "Peaks (circles) and pigs (small triangles) move with the gas; slow the player to watch them cross a line."),
        h("li", null, "Choose a unit, or All units, to see it on the Map or as a Flow: gas moves from the top to the bottom."),
        h("li", null, "Drag the year, top right, to show the network as it was, or will be: planned assets appear at their startup year, shut-down ones disappear from their shutdown year."),
        h("li", null, "Choose What-if, then click assets to take them offline: the pipeline loads and the deliverable gas update. Click the chip in the header to restore them all."),
        h("li", null, "Click any asset or line for its detail. Diagnostics shows the numbers behind it.")),
      h("h3", null, "Grey means all is well"),
      h("p", { class: "dim" }, "Colour appears only when something needs attention, always with a shape and a number as well:"),
      h("ul", null, [3, 2, 1].map((l) => h("li", null, badge(l), h("span", { class: "dim" }, ["", "pre-warning", "medium priority", "act now"][l])))),
      h("h3", null, "Shades of grey"),
      h("ul", null,
        h("li", null, sample(COLORS.active, 3), "Open, flowing, active"),
        h("li", null, sample(COLORS.normal, 3), "Normal state"),
        h("li", null, sample(COLORS.inactive, 3), "Closed, no flow, inactive"),
        h("li", null, sample(COLORS.inactive, 1.5, ' stroke-dasharray="3 3"'), "No reading, or a notional grid entry")),
      h("h3", null, "Moving along the lines"),
      h("ul", null,
        h("li", null, svg("0 0 26 14", `<path d="M17 7l-8-4.5v9z" fill="${COLORS.pig}" stroke="${COLORS.casing}"/>`), "Pig: a small triangle creeping along, at its own speed"),
        h("li", null, svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.peak}" stroke="${COLORS.casing}"/>`), "Peak: a change in flow, moving with the gas"),
        h("li", null, svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.h2s}" stroke="${COLORS.casing}"/>`), "H₂S peak: ppm, next stop and when it gets there"),
        h("li", null, svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.co2}" stroke="${COLORS.casing}"/>`), "CO₂ peak: mol %, next stop and when it gets there")),
      h("h3", null, "Indicators"),
      rangeBar({ min: 0, max: 10, value: 6, band: [3, 7], ticks: [{ at: 1.5, level: 3 }, { at: 8.5, level: 3 }], target: 5 }),
      h("p", { class: "dim", style: "margin:4px 0 0" }, "Light band: normal range. Ticks: alarm limits. Hollow diamond: the target (nomination). Pointer: the value now. Trends show the last hours, dashed where they are heading."),
      h("p", { class: "dim", style: "margin:6px 0 0" }, "Each box in the Flow view shows the flow and pressure now, and a 4-hour line: the last 2 hours solid, the next 2 hours of nominations dashed."),
      h("h3", null, "Asset types"),
      h("ul", null, Object.keys(NORA.icons).map((k) => h("li", null, h("img", { src: NORA.icons[k], alt: "" }), NORA.nodeTypes[k]))));
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
      h("div", { class: "actions" },
        h("button", { type: "button", class: "text", onclick: copyLink }, "Copy link"),
        h("button", { type: "button", class: "text", onclick: () => update({ ...DEFAULT_SETTINGS }) }, "Reset")),
      h("p", { class: "dim", style: "margin:8px 0 0" }, "Defaults come from nora.toml in the repository."));
  }
  function update(changes) {
    settings = { ...settings, ...changes };
    saveSettings();
    buildSettings();
    for (const view of Object.values(views)) if (view.ready && view.applySettings) view.applySettings();
    restyle();
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
  function setStream(stream) {
    live.stream = prepare(stream);
    live.frames = stream.frames;
    live.typical = stream.typical;
    live.maxAbs = stream.maxAbs;
    const speeds = [...$("speed").options].map((o) => Number(o.value));
    live.speed = speeds.includes(Number(settings.speed))
      ? Number(settings.speed)
      : speeds.includes(C.screen.speed) ? C.screen.speed : speeds[0];
    $("speed").value = String(live.speed);
    scrub.max = String(Math.max(0, stream.times.length - 1));
    seek(0);
    const none = !stream.frames.some((f) => f.plan && (f.plan.now[0] || f.plan.ahead[0]));
    $("next-problem").disabled = none;
    $("next-problem").title = none ? "The plan holds throughout this dataset" : "Jump to the next hour where the plan is at risk";
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
      scrub.value = String(live.index);
    }
    prunePeaks();
    advanceQuality();
    evaluate();
    if (live.time != null) $("clock").textContent = formatTime(live.time);
    restyle();
    refreshScreens();
    if (side.id && route.screen === "unit") renderSidebar();
    drawSpark();
  }
  // The track shows the plan status over time: plain where it holds, marked where not.
  function drawSpark() {
    if ($("player").hidden) return;
    const ratio = window.devicePixelRatio || 1, width = spark.clientWidth, height = spark.clientHeight;
    if (!width) return;
    spark.width = width * ratio;
    spark.height = height * ratio;
    const ctx = spark.getContext("2d");
    ctx.scale(ratio, ratio);
    const frames = live.frames, n = frames.length;
    if (n < 2) return;
    const x = (i) => (i / (n - 1)) * width;
    ctx.fillStyle = COLORS.dots;
    ctx.fillRect(0, height / 2 - 3, width, 6);
    frames.forEach((f, i) => {
      const lvl = f.plan ? f.plan.now[0] : 0;
      if (!lvl) return;
      ctx.fillStyle = LEVEL_COLOR[lvl];
      ctx.fillRect(x(i), height / 2 - 6, Math.max(1.5, width / n), 12);
    });
    for (const event of (live.stream && live.stream.events) || []) {
      const a = frames.findIndex((f) => f.t >= event.start), b = frames.findIndex((f) => f.t >= event.end);
      if (a < 0) continue;
      ctx.strokeStyle = COLORS.text;
      ctx.setLineDash(event.planned ? [3, 2] : []);
      ctx.strokeRect(x(a), height / 2 - 8, Math.max(2, x(b < 0 ? n - 1 : b) - x(a)), 16);
    }
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(x(live.feed ? n - 1 : live.playhead) - 1, 0, 2, height);
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
  scrub.addEventListener("input", () => seek(Number(scrub.value)));
  /* The next hour where the plan is at risk, now or within the look-ahead, after the
     problem being shown (if any). Wraps round to the start of the data. */
  function nextProblem(from = live.index) {
    const frames = live.frames, n = frames.length;
    const risky = (i) => { const p = frames[i] && frames[i].plan; return Boolean(p && (p.now[0] || p.ahead[0])); };
    for (let k = 1; k < n; k++) {
      const i = (from + k) % n;
      if (risky(i) && !(risky((i - 1 + n) % n) && i !== 0)) return i;
    }
    return null;
  }
  $("next-problem").addEventListener("click", () => {
    const i = nextProblem();
    if (i == null) return;
    pause();
    seek(i);
    if (route.screen !== "overview") go({ screen: "overview" });
  });
  $("speed").addEventListener("change", (e) => {
    live.speed = Number(e.target.value);
    settings.speed = live.speed;  // remembered with the other settings, and in ?s= links
    saveSettings();
  });
  $("stream-select").addEventListener("change", (e) => setStream(NORA.streams.find((s) => s.name === e.target.value)));

  let lastTick = 0, lastStep = 0;
  function tick(now) {
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
    live.feed.addEventListener("meta", (message) => {
      const meta = JSON.parse(message.data);
      live.feedEvents = meta.events || [];
      live.feedPigs = meta.pigs || [];
      select.replaceChildren(h("option", null, `${meta.title || "Live feed"} (live)`));
    });
    live.feed.addEventListener("frame", (message) => {
      const f = JSON.parse(message.data);
      for (const [id, v] of Object.entries(f.values)) {
        live.typical[id] = Math.max((live.typical[id] || 0) * 0.995, Math.abs(v));
        live.maxAbs = Math.max(live.maxAbs, Math.abs(v));
      }
      const previous = live.frames[live.frames.length - 1];
      live.frames.push({ t: f.t, flows: f.values, metrics: f.metrics || {}, plan: f.plan || null });
      if (live.frames.length > 240) live.frames.shift();
      live.index = live.frames.length - 1;
      live.values = f.values;
      live.time = f.t;
      trackTrips(frame());
      spawnPeaks(previous, frame());
      spawnQuality(previous, frame());
      if (!live.playing) play();
      step();
    });
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
  function markTabs() {
    for (const tab of document.querySelectorAll("[data-view]")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    for (const tab of document.querySelectorAll("[data-mode]")) tab.setAttribute("aria-selected", String(tab.dataset.mode === state.mode));
  }

  function start() {
    $("crumb-overview").addEventListener("click", () => go({ screen: "overview" }));
    const unitSelect = $("crumb-unit");
    unitSelect.replaceChildren(h("option", { value: "all" }, "2 All units"), ...NORA.units.map((u) => h("option", { value: u.id }, `2 ${u.name}`)));
    unitSelect.addEventListener("change", () => go({ screen: "unit", unit: unitSelect.value }));
    unitSelect.addEventListener("mousedown", () => { if (route.screen !== "unit") go({ screen: "unit", unit: unitSelect.value }); });
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
    addEventListener("keydown", (e) => { if (e.key === "Escape" && side.id) closeSidebar(); });
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
    addEventListener("resize", () => { const view = current(); if (view && view.mounted) view.resize(); drawSpark(); });
    if (embed) document.body.classList.add("embed");
    if (views[params.get("view")]) state.view = params.get("view");
    if (["live", "load", "risk", "whatif", "plain"].includes(params.get("mode"))) state.mode = params.get("mode");
    if (YEARS.length) {
      const today = new Date().getFullYear(); // the default view is today, in the browser
      yearInput.min = String(Math.min(...YEARS));
      yearInput.max = String(Math.max(...YEARS, today));
      setYear(Math.min(Math.max(today, Number(yearInput.min)), Number(yearInput.max)));
    } else $("year-wrap").hidden = true;
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
    requestAnimationFrame(tick);
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
    colors: COLORS, levelColor: LEVEL_COLOR, shapeMarkup, drawBadge, drawMarker, levelOf, fmt, esc, nameOf, unitOf, units: unitById,
    pipeStyle, nodeStyle, markers, window4h, flowRate, thresholds: T, register, restyle, go, start, theme: () => theme,
    select: (id) => {
      if (!id || !assets[id]) { if (route.screen === "unit" && state.mode !== "whatif") closeSidebar(); return; }
      // In What-if mode a click takes a node offline or brings it back instead.
      if (state.mode === "whatif" && assets[id].kind === "node") { toggleOffline(id); renderSidebar(); return; }
      // On the unit screen the details slide in from the right instead of taking over the page.
      if (route.screen === "unit") { openSidebar(id); return; }
      go({ screen: "asset", asset: id });
    },
    sidebar: { open: (id) => openSidebar(id), close: closeSidebar, id: () => side.id },
  };
})();
