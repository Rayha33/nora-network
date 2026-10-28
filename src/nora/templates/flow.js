/* Flow view (level 2): the whole network as a gas flow overview on dotted paper, top to
   bottom by default (fields at the top, markets at the bottom), with straight lines.
   vis-network draws the nodes, edges and options pyvis produced; each node is drawn as
   a circle holding its live incoming and outgoing flow (MSm³/d), with pressure (bar),
   its name, rate of change and a 4-hour trend below (the last 2 hours of flow, solid, and the next 2
   hours of nominations, dashed). Stage and rank come from layout.py
   (NORA.grid); direction and spacing from the settings; colours, widths and labels from
   App.pipeStyle / App.nodeStyle. Alarm badges, pigs and peaks are drawn on top. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  const C = App.colors; // updated in place when the theme switches
  /* Circles, not squares: a Flow node is a circle filled by its state grey, holding
     the live numbers (no icon: Ray, 28 Oct, "this is valuable space ... for live flow
     values and pressures"), with its name and rate below and a sparkline under that. */
  const CIRC = { r: 30, name: 14, sub: 12, trend: 12, pad: 8 };
  const NAME_FONT = "600 11.5px Archivo, system-ui, sans-serif", SUB_FONT = "11px Archivo, system-ui, sans-serif";
  /* Right of the timeline's now every reading is the model's: those numbers are set in
     italics (the player says "Model" too), so a forecast never reads as a measurement. */
  const modelFont = (font) => { const ts = App.timeState(); return ts && ts.model ? `italic ${font}` : font; };
  const SPACING = { // [stage, rank] in canvas units
    vertical: { compact: [96, 160], comfortable: [124, 178], spacious: [160, 210] },
    horizontal: { compact: [210, 62], comfortable: [250, 72], spacious: [300, 90] },
  };
  let network = null, el = null, direction = "vertical";
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
    const [baseGap, baseRankGap] = SPACING[direction][App.settings().density] || SPACING[direction].comfortable;
    const cells = Object.values(NORA.grid), ranks = cells.map((c) => c[1]);
    const stagesSpan = Math.max(1, Math.max(...cells.map((c) => c[0])));
    // Measure the current directional readings before spacing the ranks. A circle that
    // needs both in/out labels also gets room from its neighbours.
    framePos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id,
      direction === "vertical" ? { x: rank * baseRankGap, y: stage * baseGap } : { x: stage * baseGap, y: rank * baseRankGap }]));
    const reserved = App.state.mode === "live" ? 70 : CIRC.r; // a quadrant may gain its second direction during playback
    const extra = Math.max(0, Math.max(reserved, ...App.nodeIds.map((id) => circleRadius(id))) - CIRC.r) * 2;
    const rankGap = baseRankGap + extra;
    const across = (Math.max(...ranks) - Math.min(...ranks) + 1) * rankGap;
    const aspect = direction === "vertical" ? el.clientHeight / el.clientWidth : el.clientWidth / el.clientHeight;
    const stageGap = Math.min((baseGap + extra) * 2.5, Math.max(baseGap + extra, (across * (aspect || 1)) / stagesSpan));
    framePos = Object.fromEntries(Object.entries(NORA.grid).map(([id, [stage, rank]]) => [id,
      direction === "vertical" ? { x: rank * rankGap, y: stage * stageGap } : { x: stage * stageGap, y: rank * rankGap }]));
    nodes.update(Object.entries(framePos).map(([id, p]) => ({ id, x: p.x, y: p.y })));
  }

  // The paper: a dot grid in canvas units, so it pans and zooms with the drawing.
  let framePos = {}; // node positions for this frame (nodes can be dragged)
  function paper(ctx) {
    framePos = network.getPositions();
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
  /* Within-day delivery at an exit point, without words: the middle line is the plan
     (delivered = nominated so far today), the lines either side the warning tolerance,
     the ends the critical one. The pointer is where the day stands; it takes the alarm
     colour only outside the tolerance. */
  function drawDayBar(ctx, x, y, day, look) {
    const T = App.thresholds.nomination, half = 11, full = T[2] * 1.2;
    const at = (share) => x + Math.max(-1, Math.min(1, share / full)) * half;
    ctx.save();
    ctx.lineCap = "butt";
    ctx.strokeStyle = look.dim;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - half, y); ctx.lineTo(x + half, y); ctx.stroke(); // the track
    ctx.strokeStyle = look.ink;
    for (const [share, h] of [[-T[0], 3], [T[0], 3], [0, 5]]) { // tolerance lines, plan line
      ctx.lineWidth = share ? 1 : 1.6;
      ctx.beginPath(); ctx.moveTo(at(share), y - h); ctx.lineTo(at(share), y + h); ctx.stroke();
    }
    const px = at(day.share);
    ctx.beginPath(); // the pointer: a small triangle on the track
    ctx.moveTo(px, y - 1.5); ctx.lineTo(px - 3.5, y - 7); ctx.lineTo(px + 3.5, y - 7); ctx.closePath();
    ctx.fillStyle = day.level ? App.levelColor[day.level] : look.ink;
    ctx.fill();
    if (day.level) { ctx.strokeStyle = C.casing; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.restore();
  }
  /* Four quadrants inside each circle. Every visible line contributes to the side
     facing its far end: incoming and outgoing totals are kept separately, and lines
     sharing a direction are summed. Positions come from the current frame, so dragging
     a node also moves the readings. */
  const QUAD = { NE: [1, -1], SE: [1, 1], SW: [-1, 1], NW: [-1, -1] };
  function flowQuadrants(id, positions = framePos) {
    const here = positions[id], out = {};
    if (!here) return out;
    for (const pid of App.pipeIds) {
      const p = NORA.assets[pid], v = App.live.values[pid];
      if (!v || Math.abs(v) < 0.05 || (p.from !== id && p.to !== id) || App.pipeStyle(pid).hidden) continue;
      const other = positions[p.from === id ? p.to : p.from];
      if (!other) continue;
      const side = `${other.y - here.y > 0 ? "S" : "N"}${other.x - here.x >= 0 ? "E" : "W"}`;
      const cell = out[side] = out[side] || { in: 0, out: 0 };
      cell[(p.from === id) === (v > 0) ? "out" : "in"] += Math.abs(v);
    }
    return out;
  }
  function quadrants(id, positions = framePos) {
    const q = flowQuadrants(id, positions), out = {};
    for (const [side, cell] of Object.entries(q)) if (cell.out) out[side] = cell.out;
    return out;
  }
  function circleRadius(id, positions = framePos) {
    const cells = Object.values(flowQuadrants(id, positions));
    if (!cells.length) return CIRC.r;
    return cells.some((cell) => cell.in && cell.out) ? 70 : 62;
  }
  // A reading inside a circle, on a patch of the circle's own fill: the faint + and the
  // day bar never run through a number.
  function reading(ctx, text, x, y, look) {
    const w = ctx.measureText(text).width;
    ctx.save();
    ctx.fillStyle = look.fill;
    ctx.fillRect(x - w / 2 - 1.5, y - 6.5, w + 3, 13);
    ctx.restore();
    ctx.fillText(text, x, y);
  }
  function drawQuadrants(ctx, x, y, id, look, { day, total, r = CIRC.r, positions = framePos }) {
    const q = flowQuadrants(id, positions), at = r * 0.45;
    ctx.save();
    ctx.globalAlpha = 0.35; // the faint +
    ctx.strokeStyle = look.edge;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.8, y); ctx.lineTo(x + r * 0.8, y);
    ctx.moveTo(x, y - r * 0.8); ctx.lineTo(x, y + r * 0.8);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = look.ink;
    ctx.font = modelFont("600 11px Archivo, system-ui, sans-serif");
    for (const [side, cell] of Object.entries(q)) {
      const [ux, uy] = QUAD[side], both = cell.in && cell.out;
      const labels = [];
      if (cell.in) labels.push({ text: `in ${App.fmt(cell.in, cell.in < 10 ? 1 : 0)}M`, dy: both ? -7 : 0, ink: look.dim });
      if (cell.out) labels.push({ text: `out ${App.fmt(cell.out, cell.out < 10 ? 1 : 0)}M`, dy: both ? 7 : 0, ink: look.ink });
      for (const label of labels) {
        ctx.fillStyle = label.ink;
        reading(ctx, fitText(ctx, label.text, r * 1.15), x + ux * at, y + uy * at + label.dy, look);
      }
    }
    // Flow faces both incoming and outgoing lines. Pressure stays outside the circle.
    if (day) drawDayBar(ctx, x, y + 1, day, look);
    if (!Object.keys(q).length && total != null) {
      ctx.font = modelFont("600 11px Archivo, system-ui, sans-serif");
      ctx.fillStyle = look.ink;
      reading(ctx, `${App.fmt(total, total < 10 ? 1 : 0)}M`, x, y + at, look);
    }
    ctx.restore();
  }
  // vis-network custom shape: the circle for one node, name and live numbers below it.
  function card(id) {
    return ({ ctx, x, y, state: { selected, hover } }) => {
      const dimensionsRadius = App.state.mode === "live" ? circleRadius(id) : CIRC.r;
      return ({
      drawNode() {
        const s = App.nodeStyle(id), d = NORA.assets[id];
        const live = App.state.mode === "live";
        const radius = live ? circleRadius(id) : CIRC.r;
        const look = C.card[s.inactive ? "inactive" : live ? "active" : "normal"];
        ctx.save();
        ctx.globalAlpha = s.dim ? 0.35 : 1;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = look.fill;
        ctx.fill();
        if (s.level) { // alarm: dark casing ring, colour inside it, never colour alone
          ctx.lineWidth = 5; ctx.strokeStyle = C.casing; ctx.stroke();
          ctx.lineWidth = 3; ctx.strokeStyle = App.levelColor[s.level]; ctx.stroke();
        } else {
          ctx.lineWidth = selected ? 2.4 : hover ? 1.6 : 1;
          ctx.strokeStyle = selected || hover ? look.ink : look.edge;
          ctx.stroke();
        }
        // Inside the circle: flow now (MSm³/d). Pressure sits outside, below the name.
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const now = live ? App.reading(id) : null;
        const big = live ? (now.flow == null ? "–" : App.fmt(now.flow, now.flow < 10 ? 1 : 0))
          : App.state.mode === "load" && d.modelFlow != null ? App.fmt(d.modelFlow)
          : App.state.mode === "risk" && d.lost ? `−${App.fmt(d.lost)}` : "";
        const day = live ? App.dayDelivery(id) : null; // exit points: within-day delivery bar
        const pressure = now && now.pressure != null ? `${App.fmt(now.pressure)} bar` : "";
        if (live) drawQuadrants(ctx, x, y, id, look, { day, total: now.flow, r: radius });
        else if (big) {
          ctx.fillStyle = look.ink;
          ctx.font = "600 12.5px Archivo, system-ui, sans-serif";
          ctx.fillText(fitText(ctx, big, CIRC.r * 1.6), x, y);
        }
        // Name below the circle, then the rate of change (bold when it is fast) and the
        // trend, on a paper backing: lines leave a node downwards, and no line may run
        // through its text (Ray, 28 Oct).
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "center";
        const nameY = y + radius + CIRC.name, pressureY = nameY + CIRC.sub;
        const subY = pressureY + (pressure ? CIRC.sub : 0);
        ctx.font = NAME_FONT;
        const name = fitText(ctx, d.name, radius * 3);
        let width = ctx.measureText(name).width;
        const r = live ? App.flowRate(id) : null;
        let sub = null;
        if (r != null && Math.abs(r) >= 0.05) {
          const through = App.window4h(id).past.slice(-1)[0] || 0;
          const fast = through > 0 && Math.abs(r) / through >= App.thresholds.step[0];
          sub = { text: `${r > 0 ? "▲" : "▼"} ${App.fmt(Math.abs(r), 1)}/h`, font: `${fast ? 600 : 400} 11px Archivo, system-ui, sans-serif`, ink: fast ? look.ink : look.dim };
        } else if (s.sub && !live) {
          ctx.font = SUB_FONT;
          sub = { text: fitText(ctx, s.sub, CIRC.r * 3), font: SUB_FONT, ink: look.dim };
        }
        if (sub) { ctx.font = sub.font; width = Math.max(width, ctx.measureText(sub.text).width); }
        if (pressure) { ctx.font = modelFont(SUB_FONT); width = Math.max(width, ctx.measureText(pressure).width); }
        if (live) width = Math.max(width, radius * 2);
        const bottom = live ? subY + 4 + CIRC.trend : (sub ? subY : nameY) + 4;
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.paper;
        ctx.fillRect(x - width / 2 - 4, y + radius + 1.5, width + 8, bottom - (y + radius + 1.5));
        ctx.restore();
        ctx.fillStyle = look.ink;
        ctx.font = NAME_FONT;
        ctx.fillText(name, x, nameY);
        if (pressure) {
          ctx.font = modelFont(SUB_FONT);
          ctx.fillStyle = look.dim;
          ctx.fillText(pressure, x, pressureY);
        }
        if (sub) {
          ctx.font = sub.font;
          ctx.fillStyle = sub.ink;
          ctx.fillText(sub.text, x, subY);
        }
        if (live) drawTrend(ctx, id, x - radius, subY + 2, radius * 2, CIRC.trend, look);
        ctx.restore();
        if (s.level) App.drawBadge(ctx, s.level, x + radius - 3, y - radius + 3, 8);
      },
      nodeDimensions: { width: dimensionsRadius * 2, height: dimensionsRadius * 2 + CIRC.name + CIRC.sub * 2 + CIRC.trend + 4 },
      });
    };
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
        ? [10, dom.y - circleRadius(row.id) * scale - 12]
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
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    // Route markers use the visible line segment, not the centres hidden by the
    // enlarged circles. Keep a small gap so neither a dot nor a peak band enters a node.
    const screenScale = network ? network.getScale() : 1;
    const gapA = circleRadius(edge.from, positions) + 8 / screenScale, gapB = circleRadius(edge.to, positions) + 8 / screenScale;
    const start = Math.min(0.45, gapA / len), end = Math.max(0.55, 1 - gapB / len);
    const t = start + (end - start) * along;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  function animateStubs(scale) {
    return scale >= 0.5 && App.settings().animation && App.live.playing && !App.reduceMotion;
  }
  function stubDistance(id, travel, scale, positions = framePos) {
    return circleRadius(id, positions) + 10 / scale + travel;
  }
  function overlay(ctx) {
    const positions = network.getPositions();
    drawRowNames(ctx, positions);
    for (const id of App.pipeIds) {
      const s = App.pipeStyle(id), e = edges.get(id);
      if (s.level && !s.hidden && e) { const m = pointAlong(e, 0.5, positions); App.drawBadge(ctx, s.level, m.x + 12, m.y, 7); }
    }
    if (App.state.mode !== "live") return;
    // At low zoom a stub outside its own node can cross a neighbour. Keep the fitted
    // overview calm; these decorative strokes only appear once the drawing has room.
    if (animateStubs(network.getScale())) {
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
            const d = stubDistance(nid, inflow ? (stub - band) * (1 - t) + band : (stub - band) * t + band, scale, positions);
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
    const marks = App.markers().filter((m) => edges.get(m.id) && !App.pipeStyle(m.id).hidden);
    const at = (m, t) => network.canvasToDOM(pointAlong(edges.get(m.id), Math.max(0, Math.min(1, t)), positions));
    for (const m of marks) if (m.extent) App.drawBand(ctx, m, at(m, m.extent[0]), at(m, m.extent[1]));
    const taken = marks.length ? nodeBoxes(positions, scale) : [];
    for (const m of marks) {
      const p = pointAlong(edges.get(m.id), Math.max(0, Math.min(1, m.along)), positions);
      const dom = network.canvasToDOM(p);
      App.drawMarker(ctx, m, dom.x, dom.y, p.angle, 6.5, detail, taken);
    }
    ctx.restore();
  }

  /* Screen boxes of every circle with the name, pressure, rate and trend under it, so
     the labels of pigs and peaks keep clear of them. Names are at most 3 radii wide. */
  function nodeBoxes(positions, scale) {
    const live = App.state.mode === "live", out = [];
    for (const id of App.nodeIds) {
      const p = positions[id];
      if (!p || App.nodeStyle(id).hidden) continue;
      const r = live ? circleRadius(id, positions) : CIRC.r;
      const top = network.canvasToDOM({ x: p.x, y: p.y - r });
      const bottom = network.canvasToDOM({ x: p.x, y: p.y + r + CIRC.name + CIRC.sub * 2 + CIRC.trend + 4 });
      out.push([top.x - r * 1.5 * scale, top.y, top.x + r * 1.5 * scale, bottom.y]);
    }
    return out;
  }

  view.mount = (container) => {
    el = container;
    el.style.background = C.paper;
    network = new vis.Network(container, { nodes, edges }, flowOptions);
    view.network = network;
    // No zooming out far past the whole network: it would only shrink it to a speck.
    network.on("zoom", () => {
      const min = minScale();
      if (network.getScale() < min) network.moveTo({ scale: min, animation: false });
    });
    if (App.embed) network.setOptions({ interaction: { zoomView: false } });
    nodes.update(App.nodeIds.map((id) => ({ id, shape: "custom", ctxRenderer: card(id), label: "" })));
    network.on("beforeDrawing", paper);
    network.on("afterDrawing", overlay);
    /* vis's own hit test does not see the custom circle shape, so we find the
       asset ourselves: what vis hit (edges), else the nearest node to the click. */
    const hitAt = (event) => {
      const id = event.nodes[0] || event.edges[0];
      if (id) return id;
      const at = event.pointer && event.pointer.DOM;
      if (!at) return null;
      const positions = network.getPositions();
      let best = null, bestD = 30; // px: the circle plus a little slack
      for (const nid of App.nodeIds) {
        const p = positions[nid];
        if (!p) continue; // a node the layout has not placed (hidden units)
        const dom = network.canvasToDOM(p);
        const d = Math.hypot(dom.x - at.x, dom.y - at.y);
        if (d < bestD) { bestD = d; best = nid; }
      }
      return best;
    };
    network.on("click", (event) => { const id = hitAt(event); if (id) App.select(id); });
    /* Right-click a node or a line: the same menu as on the Map. A plain DOM
       listener on the container (the reliable path for real right-clicks);
       we hit-test the point ourselves: nearest circle, else nearest line. */
    container.addEventListener("contextmenu", (e) => {  // capture: vis may stop the event at its canvas
      if (!view.ready) return;
      const rect = container.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const positions = network.getPositions();
      /* What is the click really on? A circle (score: distance to its edge) or
         a pipeline (score: distance to the line). The closest one wins, so a
         click on a pipe is a pipe even when an unrelated node is nearby. */
      let best = null, bestScore = 0;
      for (const nid of App.nodeIds) {
        const p = positions[nid];
        if (!p) continue; // a node the layout has not placed (hidden units)
        const dom = network.canvasToDOM(p);
        const score = Math.hypot(dom.x - at.x, dom.y - at.y) - circleRadius(nid); // to the circle's edge
        if (best === null || score < bestScore) { bestScore = score; best = nid; }
      }
      for (const pid of App.pipeIds) {
        const p = NORA.assets[pid];
        const a = positions[p.from], b = positions[p.to];
        if (!a || !b) continue;
        const da = network.canvasToDOM(a), db = network.canvasToDOM(b);
        const vx = db.x - da.x, vy = db.y - da.y;
        const len = Math.hypot(vx, vy) || 1;
        const t = Math.max(0, Math.min(1, ((at.x - da.x) * vx + (at.y - da.y) * vy) / (len * len)));
        const score = Math.hypot(da.x + vx * t - at.x, da.y + vy * t - at.y) - 4; // the drawn line plus a little slack
        if (score < bestScore) { bestScore = score; best = pid; }
      }
      if (bestScore > 8) best = null;
      if (!best) return; // empty canvas: leave the browser's own menu
      e.preventDefault();
      App.menu.open(e.clientX, e.clientY, App.menu.for(best));
    }, true); // capture phase: vis stops the event at its canvas
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
      const details = App.state.mode === "live"
        ? [s.flow ? `${s.flow} MSm³/d` : "", s.pressure].filter(Boolean).join("\n")
        : s.sub;
      return { id, hidden: s.hidden, title: `${NORA.assets[id].name}${details ? `\n${details}` : ""}` };
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
    view.restyle();
  };

  // The scale at which the whole network fits the window, less a little margin.
  function minScale() {
    const positions = Object.values(network.getPositions());
    if (!positions.length || !el.clientWidth) return 0;
    const xs = positions.map((p) => p.x), ys = positions.map((p) => p.y);
    const margin = Math.max(CIRC.r, ...App.nodeIds.map((id) => circleRadius(id))) * 6;
    const w = Math.max(...xs) - Math.min(...xs) + margin, h = Math.max(...ys) - Math.min(...ys) + margin;
    return Math.min(el.clientWidth / w, el.clientHeight / h) * 0.8;
  }
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

  view.quadrants = quadrants; // for tests: which side of a node each outflow is written on
  view.flowQuadrants = flowQuadrants;
  view.circleRadius = circleRadius;
  view.drawQuadrants = drawQuadrants;
  view.pointAlong = pointAlong;
  view.animateStubs = animateStubs;
  view.stubDistance = stubDistance;
  view.card = card; // for tests: the renderer of one node
  App.register("flow", view);
})();
