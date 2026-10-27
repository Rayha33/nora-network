/* NORA chart behaviour. Runs after vis-network has drawn `network` from the `nodes`
   and `edges` DataSets that pyvis produced. `NORA` (built in render.py) carries the
   projection, basemap, streams and links.

   URL parameters: mode=network|load|risk|live  stream=<name>  autoplay=1
                   live=<event-stream url>  theme=day|night  embed=1 */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const container = document.getElementById("map");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ helpers
  function fmt(value, digits = 0) {
    if (value == null || Number.isNaN(value)) return "–";
    return Number(value).toLocaleString("en-GB", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
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
  const svgNS = "http://www.w3.org/2000/svg";
  function svg(markup, width = 22, height = 14) {
    const node = document.createElementNS(svgNS, "svg");
    node.setAttribute("viewBox", `0 0 ${width} ${height}`);
    node.setAttribute("aria-hidden", "true");
    node.innerHTML = markup; // static markup built here, never from data
    return node;
  }
  const nameOf = (id) => NORA.names[id] || id;
  const formatTime = (epoch) =>
    new Date(epoch * 1000).toLocaleString("en-GB", {
      weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    }) + " UTC";
  const shortTime = (epoch) =>
    new Date(epoch * 1000).toLocaleString("en-GB", {
      weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    });

  // ------------------------------------------------------------------ theme
  const THEMES = {
    day: {
      land: "#ece3cb", coast: "#a3ad9f", grid: "rgba(26,60,80,0.09)", gridText: "rgba(26,60,80,0.45)",
      seaText: "rgba(28,74,99,0.55)", landText: "rgba(90,78,50,0.6)",
      ink: "#1a2a33", halo: "#f4f7f6", pipe: "#a3266f", onshore: "rgba(26,42,51,0.38)",
      muted: "rgba(26,42,51,0.16)", alarm: "#c8401b", particle: "#ffffff", particleEdge: "rgba(26,42,51,0.55)",
      node: { field: "#2d7a55", hub: "#1a2a33", processing: "#6b4e9b", terminal: "#1f69a0", lng: "#b5730f", storage: "#7a5a2c", market: "#ffffff" },
      load: ["#ecd3e0", "#d48ab3", "#b14686", "#7c1349"],
      risk: ["#cfdce6", "#8eabc1", "#3e6b90", "#14385a"],
    },
    night: {
      land: "#1c2622", coast: "#3e4d49", grid: "rgba(160,200,215,0.07)", gridText: "rgba(160,200,215,0.42)",
      seaText: "rgba(120,170,195,0.5)", landText: "rgba(190,180,150,0.42)",
      ink: "#d3dee3", halo: "#0c1a22", pipe: "#d669a8", onshore: "rgba(211,222,227,0.32)",
      muted: "rgba(211,222,227,0.13)", alarm: "#ff7a4d", particle: "#fff2f9", particleEdge: null,
      node: { field: "#5fb98a", hub: "#c9d6dc", processing: "#a68ad6", terminal: "#5aa7dc", lng: "#e0a345", storage: "#b8955e", market: "#0c1a22" },
      load: ["#3b2533", "#7e3866", "#c2549a", "#ff9fd2"],
      risk: ["#1d2e3a", "#2f5675", "#4f8bb8", "#9fd0f5"],
    },
  };
  function storedTheme() {
    try { return localStorage.getItem("nora-theme"); } catch (error) { return null; }
  }
  let themeName = params.get("theme") || storedTheme() ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day");
  const theme = () => THEMES[themeName];

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
  const solid = (c) => ({ color: c, highlight: c, hover: c, inherit: false, opacity: 1 });

  // ------------------------------------------------------------------ geography
  const P = NORA.projection;
  const KX = Math.cos((P.lat0 * Math.PI) / 180) * P.scale;
  const px = (lon) => (lon - P.lon0) * KX;
  const py = (lat) => -(lat - P.lat0) * P.scale;
  const land = new Path2D();
  for (const ring of NORA.basemap) {
    land.moveTo(px(ring[0]), py(ring[1]));
    for (let i = 2; i < ring.length; i += 2) land.lineTo(px(ring[i]), py(ring[i + 1]));
    land.closePath();
  }
  const SEAS = [["North Sea", 56.4, 0.7], ["Norwegian Sea", 65.6, 2.4], ["Skagerrak", 57.75, 9.2], ["English Channel", 50.25, -1.6]];
  const LANDS = [
    ["Norway", 61.6, 8.8], ["United Kingdom", 54.4, -2.7], ["Netherlands", 52.7, 6.45], ["Germany", 52.05, 10.0],
    ["Denmark", 56.25, 9.05], ["Belgium", 50.55, 5.05], ["France", 49.6, 2.6], ["Sweden", 58.6, 13.3],
  ];

  network.on("beforeDrawing", (ctx) => {
    const t = theme(), s = network.getScale();
    ctx.save();
    ctx.fillStyle = t.land;
    ctx.fill(land);
    ctx.lineWidth = 0.8 / s;
    ctx.strokeStyle = t.coast;
    ctx.stroke(land);
    ctx.beginPath();
    for (let lat = 48; lat <= 70; lat += 1) { ctx.moveTo(px(-8), py(lat)); ctx.lineTo(px(18), py(lat)); }
    for (let lon = -8; lon <= 18; lon += 2) { ctx.moveTo(px(lon), py(48)); ctx.lineTo(px(lon), py(70)); }
    ctx.lineWidth = 1 / s;
    ctx.strokeStyle = t.grid;
    ctx.stroke();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = t.seaText;
    ctx.font = `italic ${16 / s}px Newsreader, Georgia, serif`;
    for (const [label, lat, lon] of SEAS) ctx.fillText(label, px(lon), py(lat));
    ctx.fillStyle = t.landText;
    ctx.font = `500 ${11.5 / s}px Archivo, system-ui, sans-serif`;
    for (const [label, lat, lon] of LANDS) ctx.fillText(label, px(lon), py(lat));
    const corner = network.DOMtoCanvas({ x: 0, y: 0 });
    const far = network.DOMtoCanvas({ x: container.clientWidth, y: container.clientHeight });
    ctx.fillStyle = t.gridText;
    ctx.font = `${10 / s}px "Archivo Narrow", system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    for (let lat = 48; lat <= 70; lat += 1) {
      const y = py(lat);
      if (y > corner.y && y < far.y) ctx.fillText(`${lat}°N`, corner.x + 6 / s, y - 2 / s);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (let lon = -8; lon <= 18; lon += 2) {
      const x = px(lon);
      if (x > corner.x + 40 / s && x < far.x) ctx.fillText(`${Math.abs(lon)}°${lon < 0 ? "W" : "E"}`, x, far.y - 16 / s - bottomInset() / s);
    }
    ctx.restore();
  });

  function bottomInset() {
    return document.body.classList.contains("has-player") ? $("player").offsetHeight + 12 : 0;
  }
  function fitBox(south, west, north, east) {
    const top = 60, bottom = 16 + bottomInset(), side = 16;
    const width = Math.max(100, container.clientWidth - 2 * side);
    const height = Math.max(100, container.clientHeight - top - bottom);
    const x1 = px(west), x2 = px(east), y1 = py(north), y2 = py(south);
    const scale = Math.min(width / (x2 - x1), height / (y2 - y1));
    const centre = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 + (bottom - top) / 2 / scale };
    network.moveTo({ position: centre, scale, animation: false });
  }
  const fitNorthSea = () => {
    fitBox(50.4, -2.6, 63.2, 10.6);
    fitLabels();
  };

  // ------------------------------------------------------------------ data indexes
  const nodeData = {}, edgeData = {}, edgeEnds = {}, baseSize = {};
  nodes.forEach((n) => { nodeData[n.id] = n.nora; baseSize[n.id] = n.size; });
  edges.forEach((e) => { edgeData[e.id] = e.nora; edgeEnds[e.id] = [e.from, e.to]; });
  const markets = new Set(Object.keys(nodeData).filter((id) => nodeData[id].type === "market"));
  const maxCapacity = Math.max(1, ...Object.values(edgeData).map((d) => d.capacity || 0));
  const capacityOf = (id) => (edgeData[id] || nodeData[id] || {}).capacity || null;

  // ------------------------------------------------------------------ styling
  let mode = "network";
  let labelSize = 0; // set by fitLabels from the zoom level

  function nodeStyle(id) {
    const t = theme(), d = nodeData[id], fill = t.node[d.type] || t.ink;
    const alarmed = mode === "live" && live.activeEvents.has(id);
    let size = baseSize[id];
    if (mode === "risk" && d.type !== "market") size = 4 + 15 * Math.sqrt(d.lost / (NORA.worstOutage || 1));
    return {
      id,
      size,
      borderWidth: alarmed ? 3 : 1.5,
      color: {
        background: fill,
        border: alarmed ? t.alarm : d.type === "market" ? t.ink : t.halo,
        highlight: { background: fill, border: t.pipe },
        hover: { background: fill, border: t.ink },
      },
      font: { color: t.ink, strokeColor: t.halo, size: labelSize || 11 },
      opacity: d.status === "operating" ? 1 : 0.45,
    };
  }

  function edgeStyle(id) {
    const t = theme(), d = edgeData[id];
    const style = {
      id,
      dashes: d.type === "onshore" || d.status !== "operating" ? [4, 4] : false,
      width: d.capacity ? 1 + 3.2 * Math.sqrt(d.capacity / maxCapacity) : 1,
      arrows: d.bidirectional
        ? { to: { enabled: true, scaleFactor: 0.35 }, from: { enabled: true, scaleFactor: 0.35 } }
        : { to: { enabled: true, scaleFactor: 0.35 }, from: { enabled: false } },
    };
    if (mode === "load") {
      style.color = solid(d.utilization == null ? (d.type === "onshore" ? t.onshore : t.muted) : ramp(t.load, d.utilization));
    } else if (mode === "risk") {
      style.color = solid(d.type === "onshore" ? t.muted : ramp(t.risk, d.lost / (NORA.worstOutage || 1)));
    } else if (mode === "live") {
      const v = live.values[id];
      if (v === undefined) {
        style.color = solid(t.muted);
        style.width = 1;
      } else {
        const magnitude = Math.abs(v);
        style.width = 1 + 4.5 * Math.sqrt(magnitude / live.maxAbs);
        style.color = solid(
          live.state[id] === "down" || live.activeEvents.has(id) ? t.alarm
            : d.capacity ? ramp(t.load, magnitude / d.capacity) : t.onshore
        );
        if (d.bidirectional) {
          style.arrows = { to: { enabled: v >= 0, scaleFactor: 0.35 }, from: { enabled: v < 0, scaleFactor: 0.35 } };
        }
      }
    } else {
      style.color = solid(d.type === "onshore" ? t.onshore : t.pipe);
    }
    return style;
  }

  const allNodeIds = nodes.getIds(), allEdgeIds = edges.getIds();
  function restyleNodes() { nodes.update(allNodeIds.map(nodeStyle)); }

  // vis-network scales labels with the zoom; keep them near 12px on screen instead,
  // so zooming in separates crowded labels rather than enlarging them.
  function fitLabels() {
    const size = Math.round(Math.max(5, Math.min(14, 12 / network.getScale())) * 2) / 2;
    if (size === labelSize) return;
    labelSize = size;
    restyleNodes();
  }
  network.on("zoom", () => requestAnimationFrame(fitLabels));
  function restyleEdges() { edges.update(allEdgeIds.map(edgeStyle)); }
  function restyle() {
    document.documentElement.dataset.theme = themeName;
    restyleNodes();
    restyleEdges();
    buildLegend();
    drawSpark();
  }

  // ------------------------------------------------------------------ key
  const SHAPES = {
    field: '<circle cx="11" cy="7" r="4.5"/>',
    hub: '<rect x="7" y="3" width="8" height="8"/>',
    processing: '<path d="M11 1.5 16.5 7 11 12.5 5.5 7z"/>',
    terminal: '<path d="M11 2 16 12H6z"/>',
    lng: '<path d="m11 1.5 1.6 3.6 3.9.4-2.9 2.6.8 3.9-3.4-2-3.4 2 .8-3.9-2.9-2.6 3.9-.4z"/>',
    storage: '<path d="M11 12 16 2H6z"/>',
    market: '<path d="m11 1.5 4.8 2.75v5.5L11 12.5l-4.8-2.75v-5.5z"/>',
  };
  function line(color, opts = {}) {
    const dash = opts.dashed ? ' stroke-dasharray="3 3"' : "";
    const heads = opts.both ? `<path d="M5 4 1 7l4 3M17 4l4 3-4 3" fill="none" stroke="${color}" stroke-width="1.4"/>` : "";
    return svg(`<path d="M1 7h20" stroke="${color}" stroke-width="${opts.width || 2}"${dash}/>${heads}`);
  }
  function rampBar(stops, low, high, caption) {
    return [
      h("div", { class: "ramp", style: `background: linear-gradient(90deg, ${stops.join(", ")})` }),
      h("div", { class: "scale" }, h("span", null, low), h("span", null, high)),
      caption ? h("p", { class: "note" }, caption) : null,
    ];
  }
  function buildLegend() {
    const t = theme();
    const present = new Set(Object.values(nodeData).map((d) => d.type));
    const symbols = Object.keys(SHAPES).filter((k) => present.has(k)).map((kind) => {
      const fill = t.node[kind], stroke = kind === "market" ? t.ink : t.halo;
      return h("li", null, svg(`<g fill="${fill}" stroke="${stroke}" stroke-width="1.2">${SHAPES[kind]}</g>`), NORA.nodeTypes[kind]);
    });
    let lines;
    if (mode === "load") {
      lines = rampBar(t.load, "0%", "100%", "Share of each pipeline's capacity used when the network delivers as much gas as it can (max-flow model).");
    } else if (mode === "risk") {
      lines = rampBar(t.risk, "0", `${fmt(NORA.worstOutage)} MSm³/d`, "Gas the markets lose if this asset trips. Bigger symbols are bigger single points of failure.");
    } else if (mode === "live") {
      lines = [
        ...rampBar(t.load, "0%", "100% of capacity", null),
        h("ul", { style: "margin-top:8px" },
          h("li", null, line(t.alarm), "Tripped or affected by an event"),
          h("li", null, line(t.muted, { width: 1 }), "No reading in this dataset")),
        h("p", { class: "note" }, reduceMotion
          ? "Line width shows the flow."
          : "Moving dots show the direction and speed of the flow; line width shows its size."),
      ];
    } else {
      lines = [h("ul", null,
        h("li", null, line(t.pipe), "Pipeline (width shows capacity)"),
        h("li", null, line(t.pipe, { both: true }), "Can flow both ways"),
        h("li", null, line(t.onshore, { dashed: true, width: 1.5 }), "Notional grid entry"))];
    }
    $("legend-body").replaceChildren(
      h("h3", null, "Assets"), h("ul", null, symbols),
      h("h3", null, { network: "Lines", load: "Model load", risk: "Outage impact", live: "Live flow" }[mode]),
      ...lines.filter(Boolean),
    );
  }

  // ------------------------------------------------------------------ details
  let selected = null;
  function row(label, value, cls) {
    return value == null || value === "" ? [] : [h("dt", null, label), h("dd", { class: cls }, value)];
  }
  function sourceLink(source) {
    if (!source) return h("p", { class: "muted" }, "No source recorded yet. If you know one, suggest it below.");
    return /^https?:\/\//.test(source)
      ? h("p", null, "Source: ", h("a", { href: source, target: "_blank", rel: "noopener" }, new URL(source).hostname))
      : h("p", null, `Source: ${source}`);
  }
  function showDetails(kind, id) {
    selected = { kind, id };
    const d = kind === "node" ? nodeData[id] : edgeData[id];
    const links = NORA.links || {};
    const file = kind === "node" ? "nodes.csv" : "pipelines.csv";
    const liveValue = mode === "live" ? live.values[id] : undefined;
    const tripped = d.lost ? `${fmt(d.lost)} MSm³/d (${fmt(d.share * 100, 1)}%)` : "Nothing lost";
    let heading, facts;
    if (kind === "node") {
      heading = [h("h2", null, nameOf(id)), h("p", { class: "kind" }, `${NORA.nodeTypes[d.type]}, ${d.country}`)];
      facts = [
        ...row("Live now", liveValue === undefined ? null : `${fmt(liveValue, 1)} MSm³/d`, "live"),
        ...row("Operator", d.operator),
        ...row("Capacity", d.capacity == null ? null : `${fmt(d.capacity)} MSm³/d`),
        ...row(d.type === "market" ? "Model delivers" : "Model supplies", d.modelFlow == null ? null : `${fmt(d.modelFlow, 1)} MSm³/d`),
        ...row("If it trips", d.type === "market" ? null : tripped),
        ...row("Status", d.status),
        ...row("Position", `${fmt(Math.abs(d.lat), 2)}°${d.lat >= 0 ? "N" : "S"}, ${fmt(Math.abs(d.lon), 2)}°${d.lon >= 0 ? "E" : "W"}`),
      ];
    } else {
      const [from, to] = edgeEnds[id];
      heading = [h("h2", null, nameOf(id)), h("p", { class: "kind" }, `${NORA.pipelineTypes[d.type]}, ${nameOf(from)} to ${nameOf(to)}`)];
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
    const issue = links.issues
      ? `${links.issues}/new?template=data_correction.yml&title=${encodeURIComponent(`Data: ${nameOf(id)}`)}&asset=${encodeURIComponent(id)}`
      : null;
    $("details-body").replaceChildren(
      ...heading,
      h("dl", null, facts),
      d.notes ? h("p", null, d.notes) : null,
      sourceLink(d.source),
      h("div", { class: "actions" },
        links.blob ? h("a", { href: `${links.blob}/data/${file}#L${d.line}`, target: "_blank", rel: "noopener" }, "View the data row") : null,
        issue ? h("a", { href: issue, target: "_blank", rel: "noopener" }, "Suggest a correction") : null),
    );
    $("details").hidden = false;
  }
  function hideDetails() {
    selected = null;
    $("details").hidden = true;
    network.unselectAll();
  }
  function focusAsset(id) {
    if (nodeData[id]) {
      network.selectNodes([id]);
      network.focus(id, { scale: Math.max(network.getScale(), 1.6), animation: !reduceMotion && { duration: 500 } });
      showDetails("node", id);
    } else if (edgeData[id]) {
      network.selectEdges([id]);
      const [a, b] = edgeEnds[id];
      const p = network.getPositions([a, b]);
      network.moveTo({ position: { x: (p[a].x + p[b].x) / 2, y: (p[a].y + p[b].y) / 2 }, animation: !reduceMotion && { duration: 500 } });
      showDetails("edge", id);
    }
  }
  network.on("click", (event) => {
    if (event.nodes.length) showDetails("node", event.nodes[0]);
    else if (event.edges.length) showDetails("edge", event.edges[0]);
    else hideDetails();
  });
  $("details-close").addEventListener("click", hideDetails);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideDetails(); });

  // ------------------------------------------------------------------ search
  const byName = {};
  for (const id of [...allNodeIds, ...allEdgeIds]) byName[nameOf(id).toLowerCase()] = id;
  $("asset-names").replaceChildren(...Object.keys(byName).sort().map((n) => h("option", { value: nameOf(byName[n]) })));
  $("search").addEventListener("change", (event) => {
    const id = byName[event.target.value.trim().toLowerCase()];
    if (id) focusAsset(id);
  });

  // ------------------------------------------------------------------ modes
  const tabs = [...document.querySelectorAll(".modes button")];
  function setMode(next) {
    mode = next;
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
    document.body.classList.toggle("has-player", mode === "live");
    $("player").hidden = mode !== "live";
    $("alarms").hidden = mode !== "live";
    if (mode !== "live") pause();
    restyle();
    if (selected) showDetails(selected.kind, selected.id);
    network.redraw();
  }
  tabs.forEach((tab) => tab.addEventListener("click", () => setMode(tab.dataset.mode)));

  // ------------------------------------------------------------------ live: shared state
  const live = {
    stream: null, // recorded stream being replayed
    feed: null, // EventSource when connected to a live feed
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
    history: [], // live feed totals, for the sparkline
  };

  function totalOf(values) {
    let delivered = 0, sum = 0, entries = 0;
    for (const [id, v] of Object.entries(values)) {
      sum += Math.abs(v);
      const ends = edgeEnds[id];
      if (ends && markets.has(ends[1])) { delivered += Math.max(v, 0); entries += 1; }
      else if (ends && markets.has(ends[0])) { delivered += Math.max(-v, 0); entries += 1; }
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
        const m = Math.abs(v);
        columns[j].push(m);
        if (m > maxAbs) maxAbs = m;
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

  // ------------------------------------------------------------------ alarms
  function evaluate(values, time, silent) {
    const fired = [];
    for (const [id, raw] of Object.entries(values)) {
      const v = Math.abs(raw), typical = live.typical[id] || 0, before = live.state[id] || "ok";
      let now = before;
      if (typical > 1 && v < 0.1 * typical) now = "down";
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
    const eventsChanged = active.size !== live.activeEvents.size || [...active].some((a) => !live.activeEvents.has(a));
    live.activeEvents = active;
    if (eventsChanged) restyleNodes();
    for (const alarm of fired) raise(time, alarm);
  }
  function raise(time, alarm) {
    const list = $("alarms");
    list.prepend(h("li", { class: alarm.cls, onclick: () => focusAsset(alarm.id) },
      h("time", null, shortTime(time)), h("span", null, alarm.text)));
    while (list.children.length > 5) list.lastChild.remove();
  }
  function resetAlarms(values, time) {
    live.state = {};
    $("alarms").replaceChildren();
    live.activeEvents = new Set();
    evaluate(values, time, true);
  }

  // ------------------------------------------------------------------ player
  const player = $("player");
  const scrub = $("scrub");
  const spark = $("spark");

  function setStream(stream) {
    live.stream = prepare(stream);
    live.typical = stream.typical;
    live.maxAbs = stream.maxAbs;
    // About one data step per second: hourly data plays an hour a second, daily a day.
    const speeds = [...$("speed").options].map((o) => Number(o.value)).filter((v) => v > 1);
    live.speed = speeds.find((v) => v >= stream.step) || speeds[speeds.length - 1];
    $("speed").value = String(live.speed);
    live.playhead = 0;
    live.index = -1;
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
    if (mode === "live") restyleEdges();
    drawSpark();
    if (selected && mode === "live") showDetails(selected.kind, selected.id);
  }

  function drawSpark() {
    if (player.hidden) return;
    const ratio = window.devicePixelRatio || 1;
    const width = spark.clientWidth, height = spark.clientHeight;
    if (!width) return;
    spark.width = width * ratio;
    spark.height = height * ratio;
    const ctx = spark.getContext("2d");
    ctx.scale(ratio, ratio);
    const t = theme();
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
    const head = live.feed ? series.length - 1 : live.playhead;
    ctx.fillStyle = t.ink;
    ctx.fillRect(x(head) - 1, 0, 2, height);
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

  // One animation loop: advances the playhead, restyles a few times a second, and
  // redraws every frame while playing so the dots move.
  let lastTick = 0, lastStyle = 0;
  function tick(now) {
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;
    if (mode === "live" && live.playing) {
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
      if (!reduceMotion) network.redraw();
    }
    requestAnimationFrame(tick);
  }

  // Moving dots along every pipeline with flow: faster when fuller, bigger when larger.
  network.on("afterDrawing", (ctx) => {
    if (mode !== "live" || reduceMotion || !live.playing) return;
    const t = theme(), s = network.getScale(), positions = network.getPositions();
    ctx.save();
    ctx.fillStyle = t.particle;
    if (t.particleEdge) { ctx.strokeStyle = t.particleEdge; ctx.lineWidth = 0.6 / s; }
    for (const [id, v] of Object.entries(live.values)) {
      const ends = edgeEnds[id];
      if (!ends || Math.abs(v) < 0.05) continue;
      const a = positions[ends[0]], b = positions[ends[1]];
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (length < 4) continue;
      const magnitude = Math.abs(v), cap = edgeData[id].capacity;
      const rate = cap ? Math.min(1, magnitude / cap) : Math.min(1, magnitude / live.maxAbs);
      const spacing = 22, speed = 6 + 34 * rate, radius = 1.1 + 1.6 * Math.sqrt(magnitude / live.maxAbs);
      const shift = (live.clock * speed) % spacing;
      for (let d = shift; d < length; d += spacing) {
        const f = (v >= 0 ? d : length - d) / length;
        ctx.beginPath();
        ctx.arc(a.x + dx * f, a.y + dy * f, radius, 0, Math.PI * 2);
        ctx.fill();
        if (t.particleEdge) ctx.stroke();
      }
    }
    ctx.restore();
  });

  // ------------------------------------------------------------------ live feed
  function connectFeed(url) {
    live.feed = new EventSource(url);
    document.body.classList.add("feed-mode");
    const select = $("stream-select");
    select.replaceChildren(h("option", null, "Connecting to live feed"));
    select.disabled = true;
    const tag = $("stream-tag");
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
        if (m > live.maxAbs) live.maxAbs = m;
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
  $("theme").addEventListener("click", () => {
    themeName = themeName === "day" ? "night" : "day";
    try { localStorage.setItem("nora-theme", themeName); } catch (error) { /* private mode */ }
    restyle();
    network.redraw();
  });
  const zoomBy = (factor) => {
    network.moveTo({ scale: network.getScale() * factor });
    fitLabels();
  };
  $("zoom-in").addEventListener("click", () => zoomBy(1.4));
  $("zoom-out").addEventListener("click", () => zoomBy(1 / 1.4));
  $("zoom-fit").addEventListener("click", fitNorthSea);

  if (matchMedia("(max-width: 760px)").matches) $("legend").open = false;
  if (params.get("embed") === "1") {
    document.body.classList.add("embed");
    network.setOptions({ interaction: { zoomView: false } });
    const brand = $("brand");
    brand.href = location.pathname;
    brand.target = "_blank";
    brand.title = "Open the full chart";
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

  restyle();
  const startMode = params.has("live") || params.get("autoplay") === "1" ? "live" : params.get("mode");
  if (startMode && tabs.some((t) => t.dataset.mode === startMode && !t.hidden)) setMode(startMode);
  fitNorthSea();
  if (params.has("live")) connectFeed(params.get("live"));
  else if (params.get("autoplay") === "1" && mode === "live") play();
  addEventListener("resize", () => drawSpark());
  if (document.fonts) document.fonts.ready.then(() => network.redraw());
  requestAnimationFrame(tick);
})();
