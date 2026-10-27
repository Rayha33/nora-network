/* Flow view (level 2): the whole network as a gas flow overview on dotted paper, top to
   bottom by default (fields at the top, markets at the bottom), with straight lines.
   vis-network draws the nodes, edges and options pyvis produced; each node is drawn as
   a card: icon, name, value, and a 4-hour trend (the last 2 hours of flow, solid, and
   the next 2 hours of nominations, dashed). Stage and rank come from layout.py
   (NORA.grid); direction and spacing from the settings; colours, widths and labels from
   App.pipeStyle / App.nodeStyle. Alarm badges, pigs and peaks are drawn on top. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  const C = App.colors; // updated in place when the theme switches
  const CARD = { w: 150, h: 50 };
  const SPACING = { // [stage, rank] in canvas units
    vertical: { compact: [96, 160], comfortable: [124, 178], spacious: [160, 210] },
    horizontal: { compact: [210, 62], comfortable: [250, 72], spacious: [300, 90] },
  };
  let network = null, el = null, direction = "vertical";
  const images = {};

  function loadIcons() {
    for (const [kind, uri] of Object.entries(NORA.icons)) {
      const image = new Image();
      image.onload = () => network && network.redraw();
      image.src = uri;
      images[kind] = image;
    }
  }
  function chooseDirection() {
    const wanted = App.settings().direction;
    if (wanted !== "auto") return wanted;
    return el && el.clientWidth > el.clientHeight * 1.3 ? "horizontal" : "vertical";
  }
  /* Positions from the stage grid, for the chosen direction and spacing. The gap between
     stages stretches (up to 2.5 times) so the drawing fills the window's shape: steeper
     lines are easier to follow. */
  function layout() {
    direction = chooseDirection();
    const [baseGap, rankGap] = SPACING[direction][App.settings().density] || SPACING[direction].comfortable;
    const cells = Object.values(NORA.grid), ranks = cells.map((c) => c[1]);
    const stagesSpan = Math.max(1, Math.max(...cells.map((c) => c[0])));
    const across = (Math.max(...ranks) - Math.min(...ranks) + 1) * rankGap;
    const aspect = direction === "vertical" ? el.clientHeight / el.clientWidth : el.clientWidth / el.clientHeight;
    const stageGap = Math.min(baseGap * 2.5, Math.max(baseGap, (across * (aspect || 1)) / stagesSpan));
    nodes.update(Object.entries(NORA.grid).map(([id, [stage, rank]]) => (direction === "vertical"
      ? { id, x: rank * rankGap, y: stage * stageGap }
      : { id, x: stage * stageGap, y: rank * rankGap })));
  }

  // The paper: a dot grid in canvas units, so it pans and zooms with the drawing.
  function paper(ctx) {
    const scale = network.getScale();
    let step = 24;
    while (step * scale < 12) step *= 2;
    const a = network.DOMtoCanvas({ x: 0, y: 0 }), b = network.DOMtoCanvas({ x: el.clientWidth, y: el.clientHeight });
    const r = 1.1 / scale;
    ctx.save();
    ctx.fillStyle = C.dots;
    for (let x = Math.floor(a.x / step) * step; x <= b.x; x += step) {
      for (let y = Math.floor(a.y / step) * step; y <= b.y; y += step) ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function fitText(ctx, text, width) {
    if (ctx.measureText(text).width <= width) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1);
    return `${t}…`;
  }
  /* The 4-hour trend inside a card: past 2 h solid, "now" tick, next 2 h of nominations
     dashed, over the nomination's normal band. */
  function drawTrend(ctx, id, x, y, w, h, look) {
    const { past, future, tol } = App.window4h(id);
    const values = [...past, ...(future || [])].filter((v) => v != null);
    if (values.length < 2) return;
    const nowNom = future ? future[0] : null;
    const lo = Math.min(...values, nowNom != null ? nowNom * (1 - tol) : Infinity);
    const hi = Math.max(...values, nowNom != null ? nowNom * (1 + tol) : -Infinity);
    const span = hi - lo || Math.max(1, hi * 0.1);
    const yy = (v) => y + h - ((v - lo) / span) * h;
    const slots = past.length - 1 + (future ? future.length - 1 : past.length - 1);
    const xx = (i) => x + (i / Math.max(1, slots)) * w;
    const nowX = xx(past.length - 1);
    if (nowNom != null) {
      ctx.fillStyle = C.band;
      ctx.fillRect(x, yy(nowNom * (1 + tol)), w, Math.max(1, yy(nowNom * (1 - tol)) - yy(nowNom * (1 + tol))));
    }
    ctx.strokeStyle = look.ink;
    ctx.lineWidth = 1.3;
    ctx.setLineDash([]);
    ctx.beginPath();
    let started = false;
    past.forEach((v, i) => { if (v == null) return; if (started) ctx.lineTo(xx(i), yy(v)); else { ctx.moveTo(xx(i), yy(v)); started = true; } });
    ctx.stroke();
    if (future) {
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      started = false;
      future.forEach((v, k) => { if (v == null) return; const i = past.length - 1 + k; if (started) ctx.lineTo(xx(i), yy(v)); else { ctx.moveTo(xx(i), yy(v)); started = true; } });
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = look.dim;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nowX, y - 1); ctx.lineTo(nowX, y + h + 1); ctx.stroke();
  }
  // vis-network custom shape: the card for one node.
  function card(id) {
    return ({ ctx, x, y, state: { selected, hover } }) => ({
      drawNode() {
        const s = App.nodeStyle(id), d = NORA.assets[id];
        const live = App.state.mode === "live";
        const look = C.card[s.inactive ? "inactive" : live ? "active" : "normal"];
        const left = x - CARD.w / 2, top = y - CARD.h / 2;
        ctx.save();
        ctx.globalAlpha = s.dim ? 0.35 : 1;
        roundRect(ctx, left, top, CARD.w, CARD.h, 6);
        ctx.fillStyle = look.fill;
        ctx.fill();
        if (s.level) { // alarm: dark outline, colour inside it, never colour alone
          ctx.lineWidth = 5; ctx.strokeStyle = C.casing; ctx.stroke();
          ctx.lineWidth = 3; ctx.strokeStyle = App.levelColor[s.level]; ctx.stroke();
        } else {
          ctx.lineWidth = selected ? 2.4 : hover ? 1.6 : 1;
          ctx.strokeStyle = selected || hover ? look.ink : look.edge;
          ctx.stroke();
        }
        const icon = images[d.type];
        if (icon && icon.complete) ctx.drawImage(icon, left + 6, top + 6, 22, 22);
        // Rate of change, top right: arrow and MSm³/d per hour; bold when it is fast.
        let room = CARD.w - 40;
        const r = live ? App.flowRate(id) : null;
        ctx.textBaseline = "alphabetic";
        if (r != null && Math.abs(r) >= 0.05) {
          const through = App.window4h(id).past.slice(-1)[0] || 0;
          const fast = through > 0 && Math.abs(r) / through >= App.thresholds.step[0];
          const text = `${r > 0 ? "▲" : "▼"} ${App.fmt(Math.abs(r), 1)}/h`;
          ctx.font = `${fast ? 700 : 400} 10px Archivo, system-ui, sans-serif`;
          ctx.fillStyle = fast ? look.ink : look.dim;
          ctx.textAlign = "right";
          ctx.fillText(text, left + CARD.w - 7, top + 15);
          room -= ctx.measureText(text).width + 6;
        }
        ctx.fillStyle = look.ink;
        ctx.font = "600 11.5px Archivo, system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(fitText(ctx, d.name, room), left + 34, top + 15);
        ctx.fillStyle = look.dim;
        ctx.font = "10px Archivo, system-ui, sans-serif";
        ctx.fillText(fitText(ctx, s.sub || "", CARD.w - 40), left + 34, top + 27);
        if (live) drawTrend(ctx, id, left + 34, top + 32, CARD.w - 42, 12, look);
        ctx.restore();
        if (s.level) App.drawBadge(ctx, s.level, left + CARD.w - 2, top + 2, 8);
      },
      nodeDimensions: { width: CARD.w, height: CARD.h },
    });
  }

  /* Row names, pinned to the left edge (or the top, left to right) so they stay readable
     while panning. Rows before the terminals mix fields, hubs and plants, so they share
     one name on their first row; terminals, LNG and markets each get their own. */
  function rowNames() {
    const types = {}, member = {};
    for (const [id, [stage]] of Object.entries(NORA.grid)) {
      (types[stage] = types[stage] || new Set()).add(NORA.assets[id].type);
      member[stage] = member[stage] || id;
    }
    const own = (stage) => types[stage].size === 1 && ["terminal", "lng", "market"].includes([...types[stage]][0]);
    const stages = Object.keys(types).map(Number).sort((a, b) => a - b);
    const upstream = stages.filter((stage) => !own(stage));
    const kinds = Object.keys(NORA.plural).filter((t) => upstream.some((stage) => types[stage].has(t)));
    const names = kinds.map((t, i) => (i ? NORA.plural[t].replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase()) : NORA.plural[t]));
    const upstreamName = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    const rows = [];
    if (upstream.length) rows.push({ id: member[upstream[0]], name: upstreamName });
    for (const stage of stages) if (own(stage)) rows.push({ id: member[stage], name: NORA.plural[[...types[stage]][0]] });
    return rows;
  }
  const ROWS = rowNames();
  function drawRowNames(ctx, positions) {
    const ratio = (network.canvas && network.canvas.pixelRatio) || window.devicePixelRatio || 1;
    const scale = network.getScale();
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.font = "600 11px Archivo, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (const row of ROWS) {
      const p = positions[row.id];
      if (!p) continue;
      const dom = network.canvasToDOM(p);
      const width = ctx.measureText(row.name).width;
      const [x, y] = direction === "vertical"
        ? [10, dom.y - (CARD.h / 2) * scale - 10]
        : [dom.x - width / 2, 12];
      if (y < 0 || y > el.clientHeight || x > el.clientWidth) continue;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = C.paper;
      ctx.fillRect(x - 4, y - 8, width + 8, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.text_dim;
      ctx.textAlign = "left";
      ctx.fillText(row.name, x, y);
    }
    ctx.fillStyle = C.text_dim;
    ctx.font = "11px Archivo, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(direction === "vertical" ? "Gas flows from top to bottom ↓" : "Gas flows from left to right →", el.clientWidth - 10, el.clientHeight - 12);
    ctx.restore();
  }

  function pointAlong(edge, along, positions) {
    const a = positions[edge.from], b = positions[edge.to];
    return { x: a.x + (b.x - a.x) * along, y: a.y + (b.y - a.y) * along, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  function overlay(ctx) {
    const positions = network.getPositions();
    drawRowNames(ctx, positions);
    for (const id of App.pipeIds) {
      const s = App.pipeStyle(id), e = edges.get(id);
      if (s.level && !s.hidden && e) { const m = pointAlong(e, 0.5, positions); App.drawBadge(ctx, s.level, m.x + 12, m.y, 7); }
    }
    if (App.state.mode !== "live") return;
    if (App.settings().animation && App.live.playing && !App.reduceMotion) {
      /* Simulated flow at the nodes, not on the lines (same as the Map view):
         short solid bands sliding into the icon where gas arrives and out of it
         where gas leaves, scaled by how much the line carries. */
      const scale = network.getScale();
      ctx.lineCap = "round";
      ctx.strokeStyle = C.active;
      for (const nid of App.nodeIds) {
        const pn = positions[nid];
        if (!pn) continue;
        for (const pid of App.pipeIds) {
          const v = App.live.values[pid], p = NORA.assets[pid], e = edges.get(pid);
          if (!v || Math.abs(v) < 0.05 || !p || !e || (p.from !== nid && p.to !== nid)) continue;
          if (App.pipeStyle(pid).hidden) continue;
          const on = positions[p.from === nid ? p.to : p.from];
          if (!on) continue;
          const dx = on.x - pn.x, dy = on.y - pn.y, len = Math.hypot(dx, dy);
          if (len < 8) continue;
          const ux = dx / len, uy = dy / len;
          // The stub shrinks with short lines and with zoom, like on the Map.
          const stubScreen = Math.min(26, len * scale * 0.4);
          const stub = stubScreen / scale, band = Math.max(3, Math.min(8, stubScreen * 0.5)) / scale;
          const inflow = (p.to === nid) === (v > 0);
          const share = Math.min(1, Math.abs(v) / (p.capacity || 30));
          ctx.lineWidth = (1.6 + share * 2.2) / scale;
          for (let k = 0; k < 2; k++) {
            const t = (App.live.clock * 0.45 + k / 2) % 1;
            const d = inflow ? (stub - band) * (1 - t) + band : (stub - band) * t + band;
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
    // Pigs, peaks and gas-quality slugs in screen pixels, so they stay visible (and the
    // same size as on the map) however far the drawing is zoomed out.
    const ratio = (network.canvas && network.canvas.pixelRatio) || window.devicePixelRatio || 1;
    const scale = network.getScale(), detail = scale >= 0.9 ? 2 : scale >= 0.5 ? 1 : 0;
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    for (const marker of App.markers()) {
      const e = edges.get(marker.id);
      if (!e || App.pipeStyle(marker.id).hidden) continue;
      const p = pointAlong(e, Math.max(0, Math.min(1, marker.along)), positions);
      const dom = network.canvasToDOM(p);
      App.drawMarker(ctx, marker, dom.x, dom.y, p.angle, 6.5, detail);
    }
    ctx.restore();
  }

  view.mount = (container) => {
    el = container;
    el.style.background = C.paper;
    network = new vis.Network(container, { nodes, edges }, flowOptions);
    view.network = network;
    loadIcons();
    if (App.embed) network.setOptions({ interaction: { zoomView: false } });
    nodes.update(App.nodeIds.map((id) => ({ id, shape: "custom", ctxRenderer: card(id), label: "" })));
    network.on("beforeDrawing", paper);
    network.on("afterDrawing", overlay);
    network.on("click", (event) => { const id = event.nodes[0] || event.edges[0]; if (id) App.select(id); });
    view.ready = true;
    layout();
    view.restyle();
    // the canvas has its real size only after the first draw: fit then
    network.once("afterDrawing", () => { layout(); view.setUnit(App.route.unit); });
  };

  view.restyle = () => {
    if (!view.ready) return;
    nodes.update(App.nodeIds.map((id) => {
      const s = App.nodeStyle(id);
      return { id, hidden: s.hidden, title: `${NORA.assets[id].name}${s.sub ? `\n${s.sub}` : ""}` };
    }));
    edges.update(App.pipeIds.map((id) => {
      const s = App.pipeStyle(id);
      return {
        id, hidden: s.hidden, label: s.label || " ", width: s.width, dashes: s.dashed ? [5, 5] : false,
        color: { color: s.color, highlight: s.color, hover: s.color, inherit: false, opacity: s.dim ? 0.3 : 1 },
        shadow: s.level ? { enabled: true, color: C.casing, size: 3, x: 0, y: 0 } : { enabled: false },
        arrows: { to: { enabled: s.forward, scaleFactor: 0.4 }, from: { enabled: s.backward, scaleFactor: 0.4 } },
        font: { color: C.text_dim, background: C.paper },
      };
    }));
    network.redraw();
  };

  view.draw = () => { if (App.state.mode === "live" && App.live.playing) network.redraw(); };
  view.applySettings = () => { if (view.ready) { layout(); view.restyle(); view.setUnit(App.route.unit); } };
  view.theme = () => {
    if (!view.ready) return;
    el.style.background = C.paper;
    loadIcons();
    view.restyle();
  };

  view.setUnit = (unit) => {
    if (!view.ready) return;
    const members = unit === "all" ? null : App.units[unit].nodes.filter((id) => !App.nodeStyle(id).hidden);
    network.fit(members ? { nodes: members, animation: false } : { animation: false });
    network.moveTo({ scale: network.getScale() * 0.92, animation: false }); // room for row names
  };
  view.highlight = (id) => {
    if (!view.ready) return;
    if (!id) network.unselectAll();
    else if (nodes.get(id)) network.selectNodes([id]);
    else if (edges.get(id)) network.selectEdges([id]);
  };
  view.focus = (id, animate) => {
    if (!view.ready) return;
    const animation = animate && !App.reduceMotion ? { duration: 500 } : false;
    const scale = Math.max(network.getScale(), 1.1);
    if (nodes.get(id)) network.focus(id, { scale, animation });
    else if (edges.get(id)) {
      const e = edges.get(id), p = network.getPositions([e.from, e.to]);
      network.moveTo({ position: { x: (p[e.from].x + p[e.to].x) / 2, y: (p[e.from].y + p[e.to].y) / 2 }, scale, animation });
    }
  };
  view.fit = () => view.setUnit(App.route.unit);
  view.resize = () => {
    if (!view.ready) return;
    layout(); // spacing follows the window's shape
    view.setUnit(App.route.unit);
  };

  App.register("flow", view);
})();
