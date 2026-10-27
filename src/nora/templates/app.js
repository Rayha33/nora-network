/* NORA app shell. One page, two views of the same network:
     Map   real geolocation (map.js: MapLibre with OpenFreeMap tiles)
     Flow  the gas flow overview on dotted paper (flow.js: pyvis / vis-network)
   This file holds what both share: state, the styling rules, the controls, the details
   panel, the key, the stream player, alarms and the live feed. A view registers with
   App.register(name, view) and implements mount(el), restyle(), draw(), focus(id),
   highlight(id), resize() and fit(); `ready` is true once it can be styled. In the
   browser console, App.views.map.map and App.views.flow.network are the live objects.

   URL parameters: view=map|flow  mode=network|load|risk|live  stream=<name>
                   autoplay=1  live=<event-stream url>  theme=day|night  embed=1 */
const App = (() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const embed = params.get("embed") === "1";

  // ------------------------------------------------------------------ helpers
  function fmt(value, digits = 0) {
    if (value == null || Number.isNaN(value)) return "–";
    return Number(value).toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    }
    return node;
  }
  function svg(markup) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    node.setAttribute("viewBox", "0 0 22 12");
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = markup; // static markup built here, never from data
    return node;
  }
  const assets = NORA.assets;
  const nameOf = (id) => (assets[id] || {}).name || id;
  const timeFormat = (epoch, opts) => new Date(epoch * 1000).toLocaleString("en-GB", { timeZone: "UTC", ...opts });
  const formatTime = (t) => timeFormat(t, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " UTC";
  const shortTime = (t) => timeFormat(t, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function ramp(stops, t) {
    const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(x));
    const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]), f = x - i;
    return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
  }

  // ------------------------------------------------------------------ palettes
  const PALETTES = {
    day: {
      paper: "#f6f5f0", dot: "#d2cec2", ink: "#1d2731", ink2: "#5b6670",
      pipe: "#a3266f", onshore: "rgba(29,39,49,0.38)", muted: "rgba(29,39,49,0.16)",
      alarm: "#c8401b", particle: "#ffffff", particleEdge: "rgba(29,39,49,0.55)",
      load: ["#ecd3e0", "#d48ab3", "#b14686", "#7c1349"],
      risk: ["#cfdce6", "#8eabc1", "#3e6b90", "#14385a"],
    },
    night: {
      paper: "#121619", dot: "#2b3338", ink: "#dfe6ea", ink2: "#93a1aa",
      pipe: "#e07ab5", onshore: "rgba(223,230,234,0.34)", muted: "rgba(223,230,234,0.14)",
      alarm: "#ff7a4d", particle: "#fff2f9", particleEdge: null,
      load: ["#3b2533", "#7e3866", "#c2549a", "#ff9fd2"],
      risk: ["#1d2e3a", "#2f5675", "#4f8bb8", "#9fd0f5"],
    },
  };
  function storedTheme() {
    try { return localStorage.getItem("nora-theme"); } catch (error) { return null; }
  }
  let themeName = params.get("theme") || storedTheme() ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day");
  const palette = () => PALETTES[themeName];

  // ------------------------------------------------------------------ indexes
  const nodeIds = Object.keys(assets).filter((id) => assets[id].kind === "node").sort();
  const pipeIds = Object.keys(assets).filter((id) => assets[id].kind === "pipeline").sort();
  const markets = new Set(nodeIds.filter((id) => assets[id].type === "market"));
  const maxCapacity = Math.max(1, ...pipeIds.map((id) => assets[id].capacity || 0));
  const worst = NORA.worstOutage || 1;

  // ------------------------------------------------------------------ state
  const state = { view: "map", mode: "network", selected: null };
  const live = {
    stream: null, // recorded stream being replayed
    feed: null, // EventSource when connected to a live feed
    feedEvents: null,
    playhead: 0, // fractional index into stream.times
    index: -1,
    playing: false,
    speed: 3600, // data-seconds per wall-second
    clock: 0, // drives the moving dots
    time: null,
    values: {},
    maxAbs: 1,
    typical: {},
    state: {},
    activeEvents: new Set(),
    history: [],
  };

  // ------------------------------------------------------------------ styling rules (both views)
  /* How a pipeline looks in the current mode: colour, width (1 to ~5), dashes, the label
     the flow overview writes on it, and which way its arrow points. */
  function pipeStyle(id) {
    const t = palette(), d = assets[id];
    const onshore = d.type === "onshore";
    const style = {
      color: onshore ? t.onshore : t.pipe,
      width: d.capacity ? 1 + 3 * Math.sqrt(d.capacity / maxCapacity) : 1,
      dashed: onshore || d.status !== "operating",
      label: d.capacity ? fmt(d.capacity) : "",
      forward: true,
      backward: Boolean(d.bidirectional),
    };
    if (state.mode === "load") {
      style.color = d.utilization == null ? (onshore ? t.onshore : t.muted) : ramp(t.load, d.utilization);
      style.label = d.utilization == null ? "" : `${fmt(d.utilization * 100)}%`;
    } else if (state.mode === "risk") {
      style.color = onshore ? t.muted : ramp(t.risk, d.lost / worst);
      style.label = d.lost ? `−${fmt(d.lost)}` : "";
    } else if (state.mode === "live") {
      const v = live.values[id];
      if (v === undefined) {
        Object.assign(style, { color: t.muted, width: 1, label: "" });
      } else {
        const magnitude = Math.abs(v);
        style.width = 1 + 4.5 * Math.sqrt(magnitude / live.maxAbs);
        style.color = live.state[id] === "down" || live.activeEvents.has(id) ? t.alarm
          : d.capacity ? ramp(t.load, magnitude / d.capacity) : t.onshore;
        style.label = fmt(magnitude, 1);
        if (d.bidirectional) Object.assign(style, { forward: v >= 0, backward: v < 0 });
      }
    }
    return style;
  }

  /* How a node looks in the current mode: icon scale, an alarm ring, the second line of
     its label in the flow overview, and whether it is dimmed (not operating). */
  function nodeStyle(id) {
    const t = palette(), d = assets[id];
    const style = { scale: 1, ring: null, sub: NORA.short[d.type], dim: d.status !== "operating" };
    if (state.mode === "load" && d.modelFlow != null) {
      style.sub = `${fmt(d.modelFlow)} MSm³/d`;
    } else if (state.mode === "risk" && d.type !== "market") {
      style.scale = 0.7 + 1.1 * Math.sqrt(d.lost / worst);
      style.sub = d.lost ? `−${fmt(d.lost)} if it trips` : "No loss if it trips";
    } else if (state.mode === "live") {
      const through = liveThroughput(id);
      style.sub = through == null ? "No reading" : `${fmt(through, 1)} MSm³/d`;
      if (live.activeEvents.has(id)) style.ring = t.alarm;
    }
    return style;
  }
  function liveThroughput(id) {
    if (live.values[id] !== undefined) return Math.abs(live.values[id]);
    let total = 0, seen = false;
    for (const pid of pipeIds) {
      const v = live.values[pid];
      if (v === undefined) continue;
      const p = assets[pid];
      if (p.to === id && v > 0) { total += v; seen = true; }
      else if (p.from === id && v < 0) { total -= v; seen = true; }
      else if ((p.to === id || p.from === id) && v === 0) seen = true;
    }
    return seen ? total : null;
  }

  /* Moving dots along a path ([[x, y], ...] in the view's drawing units): faster when a
     pipeline is fuller, bigger when it carries more gas, against the arrow when negative. */
  function drawDots(ctx, id, path, unit = 1) {
    const v = live.values[id];
    if (!v || Math.abs(v) < 0.05 || path.length < 2) return;
    const t = palette(), d = assets[id], magnitude = Math.abs(v);
    const rate = d.capacity ? Math.min(1, magnitude / d.capacity) : Math.min(1, magnitude / live.maxAbs);
    const spacing = 22 * unit, speed = (8 + 36 * rate) * unit;
    const radius = (1.2 + 1.7 * Math.sqrt(magnitude / live.maxAbs)) * unit;
    const lengths = [0];
    for (let i = 1; i < path.length; i++) {
      lengths.push(lengths[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
    }
    const total = lengths[lengths.length - 1];
    if (total < spacing / 2) return;
    ctx.fillStyle = t.particle;
    if (t.particleEdge) { ctx.strokeStyle = t.particleEdge; ctx.lineWidth = 0.7 * unit; }
    let segment = 1;
    for (let s = (live.clock * speed) % spacing; s < total; s += spacing) {
      const along = v >= 0 ? s : total - s;
      segment = 1;
      while (segment < lengths.length - 1 && lengths[segment] < along) segment++;
      const a = path[segment - 1], b = path[segment];
      const f = (along - lengths[segment - 1]) / (lengths[segment] - lengths[segment - 1] || 1);
      ctx.beginPath();
      ctx.arc(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, radius, 0, Math.PI * 2);
      ctx.fill();
      if (t.particleEdge) ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ views
  const views = {};
  const containers = { map: $("view-map"), flow: $("view-flow") };
  function register(name, view) { views[name] = view; }
  const current = () => views[state.view];
  function restyle() {
    const view = current();
    if (view && view.ready) view.restyle();
  }
  function setView(name) {
    if (!views[name]) return;
    state.view = name;
    for (const [key, el] of Object.entries(containers)) el.hidden = key !== name;
    for (const tab of document.querySelectorAll("[data-view]")) {
      tab.setAttribute("aria-selected", String(tab.dataset.view === name));
    }
    const view = views[name];
    if (!view.mounted) { view.mounted = true; view.mount(containers[name]); }
    else view.resize();
    restyle();
    if (state.selected) view.focus(state.selected, false);
  }

  // ------------------------------------------------------------------ modes
  const modeTabs = [...document.querySelectorAll("[data-mode]")];
  function setMode(next) {
    state.mode = next;
    for (const tab of modeTabs) tab.setAttribute("aria-selected", String(tab.dataset.mode === next));
    const showPlayer = next === "live";
    document.body.classList.toggle("has-player", showPlayer);
    $("player").hidden = !showPlayer;
    $("alarms").hidden = !showPlayer;
    if (!showPlayer) pause();
    restyle();
    buildKey();
    drawSpark();
    if (state.selected) showDetails(state.selected);
  }

  // ------------------------------------------------------------------ key
  function line(color, opts = {}) {
    const dash = opts.dashed ? ' stroke-dasharray="3 3"' : "";
    const heads = opts.both ? `<path d="M5 3 1 6l4 3M17 3l4 3-4 3" fill="none" stroke="${color}" stroke-width="1.4"/>` : "";
    return svg(`<path d="M1 6h20" stroke="${color}" stroke-width="${opts.width || 2.2}" stroke-linecap="round"${dash}/>${heads}`);
  }
  function rampBar(stops, low, high) {
    return [
      h("div", { class: "ramp", style: `background: linear-gradient(90deg, ${stops.join(", ")})` }),
      h("div", { class: "scale" }, h("span", null, low), h("span", null, high)),
    ];
  }
  const NOTES = {
    network: "Line width shows capacity. Click anything for details.",
    load: "How full each pipeline is when the network delivers as much gas as it can (max-flow model).",
    risk: "Gas the markets lose if an asset trips. Bigger icons are bigger single points of failure.",
    live: "Flow from the selected dataset. Dots move with the gas: faster when a line is fuller.",
  };
  function buildKey() {
    const t = palette();
    const present = new Set(nodeIds.map((id) => assets[id].type));
    const types = Object.keys(NORA.icons).filter((k) => present.has(k));
    let lines;
    if (state.mode === "load") lines = rampBar(t.load, "0%", "100% of capacity");
    else if (state.mode === "risk") lines = rampBar(t.risk, "0", `${fmt(worst)} MSm³/d lost`);
    else if (state.mode === "live") {
      lines = [...rampBar(t.load, "0%", "100% of capacity"), h("ul", { style: "margin-top:8px" },
        h("li", null, line(t.alarm), "Tripped or affected by an event"),
        h("li", null, line(t.muted, { width: 1.4 }), "No reading in this dataset"))];
    } else {
      lines = [h("ul", null,
        h("li", null, line(t.pipe), "Pipeline"),
        h("li", null, line(t.pipe, { both: true }), "Can flow both ways"),
        h("li", null, line(t.onshore, { dashed: true, width: 1.6 }), "Notional grid entry"))];
    }
    $("key-body").replaceChildren(
      h("h3", null, "Assets"),
      h("ul", null, types.map((k) => h("li", null, h("img", { src: NORA.icons[k], alt: "" }), NORA.nodeTypes[k]))),
      h("h3", null, { network: "Lines", load: "Model load", risk: "Outage impact", live: "Live flow" }[state.mode]),
      ...lines,
      h("p", { class: "note" }, NOTES[state.mode]),
    );
  }
  $("key-toggle").addEventListener("click", (event) => {
    const open = $("key").hidden;
    $("key").hidden = !open;
    event.currentTarget.setAttribute("aria-expanded", String(open));
  });

  // ------------------------------------------------------------------ details
  function row(label, value, cls) {
    return value == null || value === "" ? [] : [h("dt", null, label), h("dd", { class: cls }, value)];
  }
  function sourceLine(source) {
    if (!source) return h("p", { class: "muted" }, "No source recorded yet. If you know one, suggest it below.");
    return /^https?:\/\//.test(source)
      ? h("p", null, "Source: ", h("a", { href: source, target: "_blank", rel: "noopener" }, new URL(source).hostname))
      : h("p", null, `Source: ${source}`);
  }
  function showDetails(id) {
    const d = assets[id], links = NORA.links || {};
    const liveValue = state.mode === "live" ? live.values[id] : undefined;
    const tripped = d.lost ? `${fmt(d.lost)} MSm³/d (${fmt(d.share * 100, 1)}%)` : "Nothing lost";
    let icon, kind, facts;
    if (d.kind === "node") {
      icon = NORA.icons[d.type];
      kind = `${NORA.nodeTypes[d.type]}, ${d.country}`;
      const through = state.mode === "live" ? liveThroughput(id) : null;
      facts = [
        ...row("Live now", through == null ? null : `${fmt(through, 1)} MSm³/d`, "live"),
        ...row("Operator", d.operator),
        ...row("Capacity", d.capacity == null ? null : `${fmt(d.capacity)} MSm³/d`),
        ...row(d.type === "market" ? "Model delivers" : "Model flow", d.modelFlow == null ? null : `${fmt(d.modelFlow, 1)} MSm³/d`),
        ...row("If it trips", d.type === "market" ? null : tripped),
        ...row("Status", d.status),
        ...row("Position", `${fmt(Math.abs(d.lat), 2)}°${d.lat >= 0 ? "N" : "S"}, ${fmt(Math.abs(d.lon), 2)}°${d.lon >= 0 ? "E" : "W"}`),
      ];
    } else {
      icon = null;
      kind = `${NORA.pipelineTypes[d.type]}, ${nameOf(d.from)} to ${nameOf(d.to)}`;
      const util = liveValue !== undefined && d.capacity ? ` (${fmt((Math.abs(liveValue) / d.capacity) * 100)}%)` : "";
      facts = [
        ...row("Live now", liveValue === undefined ? null : `${fmt(liveValue, 1)} MSm³/d${util}`, "live"),
        ...row("Capacity", d.capacity == null ? "Not modelled" : `${fmt(d.capacity)} MSm³/d`),
        ...row("Length", d.length == null ? null : `${fmt(d.length)} km`),
        ...row("Diameter", d.diameter == null ? null : `${fmt(d.diameter)} in`),
        ...row("In service since", d.commissioned),
        ...row("Operator", d.operator),
        ...row("Model flow", d.modelFlow == null ? null : `${fmt(Math.abs(d.modelFlow), 1)} MSm³/d${d.utilization == null ? "" : ` (${fmt(d.utilization * 100)}%)`}`),
        ...row("If it trips", d.type === "onshore" ? null : tripped),
        ...row("Status", d.status),
      ];
    }
    const file = d.kind === "node" ? "nodes.csv" : "pipelines.csv";
    const issue = links.issues
      ? `${links.issues}/new?template=data_correction.yml&title=${encodeURIComponent(`Data: ${d.name}`)}&asset=${encodeURIComponent(id)}`
      : null;
    $("details-body").replaceChildren(
      h("div", { class: "head" }, icon ? h("img", { src: icon, alt: "" }) : null,
        h("div", null, h("h2", null, d.name), h("p", { class: "kind" }, kind))),
      h("dl", null, facts),
      d.notes ? h("p", null, d.notes) : null,
      sourceLine(d.source),
      h("div", { class: "actions" },
        links.blob ? h("a", { href: `${links.blob}/data/${file}#L${d.line}`, target: "_blank", rel: "noopener" }, "View the data row") : null,
        issue ? h("a", { href: issue, target: "_blank", rel: "noopener" }, "Suggest a correction") : null),
    );
    $("details").hidden = false;
  }
  function select(id, focus = false) {
    state.selected = id;
    if (!id) {
      $("details").hidden = true;
    } else {
      $("key").hidden = true; // the key and the details share the right-hand side
      $("key-toggle").setAttribute("aria-expanded", "false");
      showDetails(id);
    }
    const view = current();
    if (view && view.ready) {
      view.highlight(id);
      if (id && focus) view.focus(id, true);
    }
  }
  $("details-close").addEventListener("click", () => select(null));
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") select(null); });

  // ------------------------------------------------------------------ search
  const byName = {};
  for (const id of [...nodeIds, ...pipeIds]) byName[nameOf(id).toLowerCase()] = id;
  $("asset-names").replaceChildren(...Object.keys(byName).sort().map((n) => h("option", { value: nameOf(byName[n]) })));
  $("search").addEventListener("change", (event) => {
    const id = byName[event.target.value.trim().toLowerCase()];
    if (id) select(id, true);
  });

  // ------------------------------------------------------------------ live data
  function totalOf(values) {
    let delivered = 0, sum = 0, entries = 0;
    for (const [id, v] of Object.entries(values)) {
      sum += Math.abs(v);
      const d = assets[id];
      if (!d) continue;
      if (d.kind === "pipeline" && markets.has(d.to)) { delivered += Math.max(v, 0); entries += 1; }
      else if (d.kind === "pipeline" && markets.has(d.from)) { delivered += Math.max(-v, 0); entries += 1; }
      else if (markets.has(id)) { delivered += v; entries += 1; }
    }
    return entries ? { value: delivered, label: "delivered to markets" } : { value: sum, label: "across these points" };
  }
  function prepare(stream) {
    const columns = stream.assets.map(() => []);
    let maxAbs = 0;
    for (const values of stream.values) {
      values.forEach((v, j) => {
        if (v == null) return;
        columns[j].push(Math.abs(v));
        maxAbs = Math.max(maxAbs, Math.abs(v));
      });
    }
    stream.typical = {};
    stream.assets.forEach((id, j) => {
      const sorted = columns[j].sort((a, b) => a - b);
      stream.typical[id] = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    });
    stream.maxAbs = maxAbs || 1;
    stream.frameValues = stream.values.map((values) => {
      const out = {};
      stream.assets.forEach((id, j) => { if (values[j] != null) out[id] = values[j]; });
      return out;
    });
    stream.totals = stream.frameValues.map((v) => totalOf(v).value);
    stream.step = stream.times.length > 1 ? stream.times[1] - stream.times[0] : 3600;
    return stream;
  }

  // Alarms: a flow that drops below a tenth of its usual level, its recovery, and the
  // start and end of events listed in the dataset. Only assets that usually carry at
  // least 5% of the largest flow are watched, so small balancing links stay quiet.
  function evaluate(values, time, silent) {
    const fired = [], floor = Math.max(1, 0.05 * live.maxAbs);
    for (const [id, raw] of Object.entries(values)) {
      const v = Math.abs(raw), typical = live.typical[id] || 0, before = live.state[id] || "ok";
      let now = before;
      if (typical > floor && v < 0.1 * typical) now = "down";
      else if (before === "down" && v > 0.3 * typical) now = "ok";
      if (now !== before) {
        live.state[id] = now;
        if (!silent) fired.push(now === "down"
          ? { cls: "", id, text: `${nameOf(id)} dropped to ${fmt(v, 1)} MSm³/d` }
          : { cls: "ok", id, text: `${nameOf(id)} back to ${fmt(v, 1)} MSm³/d` });
      }
    }
    const active = new Set();
    for (const event of live.feedEvents || (live.stream && live.stream.events) || []) {
      const on = time >= event.start && time < event.end;
      if (on) active.add(event.asset);
      if (!silent && on !== live.activeEvents.has(event.asset)) {
        fired.push({ cls: "event", id: event.asset, text: `${event.label} ${on ? "started" : "ended"}` });
      }
    }
    live.activeEvents = active;
    for (const alarm of fired) raise(time, alarm);
  }
  function raise(time, alarm) {
    const list = $("alarms");
    list.prepend(h("li", { class: alarm.cls, onclick: () => select(alarm.id, true) },
      h("time", null, shortTime(time)), h("span", null, alarm.text)));
    while (list.children.length > 4) list.lastChild.remove();
  }
  function resetAlarms(values, time) {
    live.state = {};
    live.activeEvents = new Set();
    $("alarms").replaceChildren();
    evaluate(values, time, true);
  }

  // ------------------------------------------------------------------ player
  const scrub = $("scrub"), spark = $("spark");
  function setStream(stream) {
    live.stream = prepare(stream);
    live.typical = stream.typical;
    live.maxAbs = stream.maxAbs;
    // About one data step per second: hourly data plays an hour a second, daily a day.
    const speeds = [...$("speed").options].map((o) => Number(o.value)).filter((v) => v > 1);
    live.speed = speeds.find((v) => v >= stream.step) || speeds[speeds.length - 1];
    $("speed").value = String(live.speed);
    scrub.max = String(stream.times.length - 1);
    const tag = $("stream-tag");
    tag.textContent = stream.synthetic ? "Synthetic" : "Real data";
    tag.className = `tag ${stream.synthetic ? "" : "real"}`;
    tag.title = stream.source || "";
    seek(0);
  }
  function seek(position) {
    const s = live.stream;
    live.playhead = Math.max(0, Math.min(s.times.length - 1, position));
    live.index = Math.floor(live.playhead);
    resetAlarms(s.frameValues[live.index], s.times[live.index]);
    showFrame();
  }
  function valuesAt(position) {
    const s = live.stream, i = Math.floor(position), f = position - i;
    const a = s.frameValues[i], b = s.frameValues[Math.min(i + 1, s.times.length - 1)];
    if (!f) return a;
    const out = {};
    for (const [id, v] of Object.entries(a)) out[id] = b[id] === undefined ? v : v + (b[id] - v) * f;
    return out;
  }
  function showFrame() {
    if (live.stream && !live.feed) {
      live.values = valuesAt(live.playhead);
      const i = Math.floor(live.playhead);
      live.time = live.stream.times[i] + (live.playhead - i) * live.stream.step;
      scrub.value = String(i);
    }
    if (live.time != null) $("clock").textContent = formatTime(live.time);
    const total = totalOf(live.values);
    $("total").textContent = fmt(total.value);
    $("total-label").textContent = total.label;
    if (state.mode === "live") restyle();
    drawSpark();
    if (state.selected && state.mode === "live") showDetails(state.selected);
  }
  function drawSpark() {
    if ($("player").hidden) return;
    const ratio = window.devicePixelRatio || 1, width = spark.clientWidth, height = spark.clientHeight;
    if (!width) return;
    spark.width = width * ratio;
    spark.height = height * ratio;
    const ctx = spark.getContext("2d"), t = palette();
    ctx.scale(ratio, ratio);
    const series = live.feed ? live.history.map((p) => p.total) : live.stream ? live.stream.totals : [];
    if (series.length < 2) return;
    const max = Math.max(...series) * 1.08 || 1, min = Math.min(...series) * 0.9;
    const x = (i) => (i / (series.length - 1)) * width;
    const y = (v) => height - 3 - ((v - min) / (max - min || 1)) * (height - 8);
    if (live.stream && !live.feed) {
      const s = live.stream, span = s.times[s.times.length - 1] - s.times[0] || 1;
      ctx.fillStyle = t.alarm;
      ctx.globalAlpha = 0.14;
      for (const event of s.events) {
        const a = ((event.start - s.times[0]) / span) * width, b = ((event.end - s.times[0]) / span) * width;
        ctx.fillRect(a, 0, Math.max(2, b - a), height);
      }
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.strokeStyle = t.pipe;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = t.ink;
    ctx.fillRect(x(live.feed ? series.length - 1 : live.playhead) - 1, 0, 2, height);
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
  $("speed").addEventListener("change", (event) => { live.speed = Number(event.target.value); });
  $("stream-select").addEventListener("change", (event) => {
    setStream(NORA.streams.find((s) => s.name === event.target.value));
  });

  // One animation loop: advances the playhead, restyles a few times a second, and asks
  // the visible view to draw its moving dots every frame while playing.
  let lastTick = 0, lastStyle = 0;
  function tick(now) {
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;
    if (state.mode === "live" && live.playing) {
      live.clock += dt;
      if (live.stream && !live.feed) {
        const s = live.stream;
        live.playhead += (dt * live.speed) / s.step;
        if (live.playhead >= s.times.length - 1) live.playhead = 0;
        const i = Math.floor(live.playhead);
        if (i !== live.index) {
          if (i < live.index) resetAlarms(s.frameValues[i], s.times[i]);
          else evaluate(s.frameValues[i], s.times[i], false);
          live.index = i;
        }
        if (now - lastStyle > 140) { lastStyle = now; showFrame(); }
      }
      const view = current();
      if (!reduceMotion && view && view.ready) view.draw();
    }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ live feed
  function connectFeed(url) {
    live.feed = new EventSource(url);
    document.body.classList.add("feed-mode");
    const select = $("stream-select"), tag = $("stream-tag");
    select.replaceChildren(h("option", null, "Connecting to live feed"));
    select.disabled = true;
    tag.textContent = "Live feed";
    tag.className = "tag feed";
    $("speed").parentElement.hidden = true;
    live.feed.addEventListener("meta", (message) => {
      const meta = JSON.parse(message.data);
      live.stream = null;
      live.feedEvents = meta.events || [];
      select.replaceChildren(h("option", null, meta.title || "Live feed"));
      tag.title = meta.source || "";
    });
    live.feed.addEventListener("frame", (message) => {
      const frame = JSON.parse(message.data);
      for (const [id, v] of Object.entries(frame.values)) {
        const m = Math.abs(v);
        live.typical[id] = Math.max((live.typical[id] || 0) * 0.995, m);
        live.maxAbs = Math.max(live.maxAbs, m);
      }
      live.values = frame.values;
      live.time = frame.t;
      evaluate(frame.values, frame.t, live.history.length === 0);
      live.history.push({ t: frame.t, total: totalOf(frame.values).value });
      if (live.history.length > 240) live.history.shift();
      if (!live.playing) play();
      showFrame();
    });
    live.feed.addEventListener("error", () => { tag.textContent = "Reconnecting"; });
    live.feed.addEventListener("open", () => { tag.textContent = "Live feed"; });
  }

  // ------------------------------------------------------------------ start
  function applyTheme() {
    document.documentElement.dataset.theme = themeName;
    for (const view of Object.values(views)) if (view.mounted && view.theme) view.theme(themeName);
    restyle();
    buildKey();
    drawSpark();
  }
  function start() {
    $("theme").addEventListener("click", () => {
      themeName = themeName === "day" ? "night" : "day";
      try { localStorage.setItem("nora-theme", themeName); } catch (error) { /* private mode */ }
      applyTheme();
    });
    $("fit").addEventListener("click", () => { const view = current(); if (view && view.ready) view.fit(); });
    for (const tab of document.querySelectorAll("[data-view]")) tab.addEventListener("click", () => setView(tab.dataset.view));
    modeTabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));
    addEventListener("resize", () => { const view = current(); if (view && view.mounted) view.resize(); drawSpark(); });

    if (embed) {
      document.body.classList.add("embed");
      $("brand").href = location.pathname;
      $("brand").target = "_blank";
      $("brand").title = "Open the full app";
    } else if (NORA.links && NORA.links.home) {
      $("brand").href = NORA.links.home;
    }

    const hasStreams = NORA.streams.length > 0 || params.has("live");
    document.querySelector('[data-mode="live"]').hidden = !hasStreams;
    if (NORA.streams.length) {
      const select = $("stream-select");
      select.replaceChildren(...NORA.streams.map((s) => h("option", { value: s.name }, s.title)));
      select.disabled = NORA.streams.length < 2;
      const wanted = NORA.streams.find((s) => s.name === params.get("stream")) || NORA.streams[0];
      select.value = wanted.name;
      setStream(wanted);
    }

    document.documentElement.dataset.theme = themeName;
    setView(views[params.get("view")] ? params.get("view") : "map");
    const startMode = params.has("live") || params.get("autoplay") === "1" ? "live" : params.get("mode");
    setMode(modeTabs.some((t) => t.dataset.mode === startMode && !t.hidden) ? startMode : "network");
    if (params.has("live")) connectFeed(params.get("live"));
    else if (params.get("autoplay") === "1" && state.mode === "live") play();
    requestAnimationFrame(tick);
  }

  return {
    state, live, views, embed, reduceMotion, nodeIds, pipeIds,
    palette, theme: () => themeName, fmt, nameOf,
    pipeStyle, nodeStyle, drawDots, register, select, restyle,
    setView, start,
  };
})();
