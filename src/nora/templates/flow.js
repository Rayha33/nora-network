/* Flow view (level 2): the whole network as a gas flow overview on dotted paper, top to
   bottom by default (fields at the top, markets at the bottom), with straight lines.
   vis-network draws the nodes, edges and options pyvis produced. Detailed squares hold
   one flow value per connected line; overview squares show readable IN and OUT totals.
   Pressure sits outside: one strong value above each overview square and every line end
   on zoom in. Rate of change and a 4-hour trend remain where the line readings leave room. Stage and rank come
   from layout.py (NORA.grid); direction and spacing come from the settings; colours,
   widths and labels come from App.pipeStyle / App.nodeStyle. */
(() => {
  "use strict";
  const view = { ready: false, mounted: false };
  const C = App.colors; // updated in place when the theme switches
  /* Squares, not circles (Ray, 28 Oct: "we want to use squares instead of circles as
     nodes as we can pack in more information and numbers"; the Map keeps its circles).
     A live square holds one flow reading per connected line, stacked in the column facing
     that line; pressure sits outside at each line end. Rate and trend are secondary and
     yield to dense line readings. The name sits below the square, on the paper. Every live
     square is one size, so the drawing reads as a tidy grid. No icons: space is for numbers. */
  const CIRC = { r: 30, name: 14, sub: 12, trend: 12, pad: 8 };
  const SQUARE = { live: 64, plain: 30, corner: 4 }; // half a side, in canvas units
  function overviewSquareHalf(scale) {
    return scale < 1 ? Math.max(SQUARE.live, 32 / Math.max(0.01, scale)) : SQUARE.live;
  }
  const nodeHalf = () => (App.state.mode === "live" ? overviewSquareHalf(network ? network.getScale() : 1) : SQUARE.plain);
  // How far a line runs inside a square before it leaves it, along the unit vector (ux, uy).
  const edgeGap = (half, ux, uy) => half / Math.max(Math.abs(ux), Math.abs(uy), 1e-6);
  function squarePath(ctx, x, y, half) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x - half, y - half, half * 2, half * 2, SQUARE.corner);
    else ctx.rect(x - half, y - half, half * 2, half * 2);
  }
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
    const extra = Math.max(0, (App.state.mode === "live" ? SQUARE.live : SQUARE.plain) - CIRC.r) * 2; // base square room; overview size follows zoom separately
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
  let pressurePlacements = []; // screen-clear endpoint labels across the whole drawing
  let overviewBoxes = []; // screen-space circles and accepted names at low zoom
  function paper(ctx) {
    App.frame.begin(); // ends after the overlay: one cache for the whole vis frame
    framePos = network.getPositions();
    drawnBoxes = {}; // refilled as the nodes are drawn
    const scale = network.getScale(), half = nodeHalf();
    // Pressures avoid every square as well as every label already placed. This matters
    // most in the fitted overview, where a long label can otherwise cover a neighbour.
    pressurePlacements = Object.values(framePos).map((p) => [p.x - half, p.y - half, p.x + half, p.y + half]);
    overviewBoxes = scale < 1 ? Object.entries(framePos).map(([id, p]) => {
      const point = network.canvasToDOM(p), r = circleRadius(id) * scale;
      return [point.x - r, point.y - r, point.x + r, point.y + r];
    }) : [];
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
  /* Three lines: the minimum and maximum end-of-day target bounds in gray, and the
     current delivery position in a stronger line. The current line takes the alarm
     colour only outside the target bounds. */
  function drawDayBar(ctx, x, y, day, look) {
    const T = App.thresholds.nomination, half = 11, full = T[2] * 1.2;
    const at = (share) => x + Math.max(-1, Math.min(1, share / full)) * half;
    ctx.save();
    ctx.lineCap = "butt";
    ctx.strokeStyle = look.dim;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - half, y); ctx.lineTo(x + half, y); ctx.stroke(); // the track
    for (const share of [-T[0], T[0]]) {
      ctx.beginPath(); ctx.moveTo(at(share), y - 4); ctx.lineTo(at(share), y + 4); ctx.stroke();
    }
    ctx.strokeStyle = day.level ? App.levelColor[day.level] : look.ink;
    ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.moveTo(at(day.share), y - 6); ctx.lineTo(at(day.share), y + 6); ctx.stroke();
    ctx.restore();
  }
  /* Four quadrants inside each circle. Every visible line contributes to the side
     facing its far end: incoming and outgoing totals are kept separately, and lines
     sharing a direction are summed. Positions come from the current frame, so dragging
     a node also moves the readings. */
  const QUAD = { NE: [1, -1], SE: [1, 1], SW: [-1, 1], NW: [-1, -1] };
  // The lines at each node, once: the quadrants look only at a node's own lines.
  const linesAt = {};
  for (const pid of App.pipeIds) {
    const p = NORA.assets[pid];
    for (const end of [p.from, p.to]) (linesAt[end] = linesAt[end] || []).push(pid);
  }
  /* One reading for every visible line at this node. Zero is a real flow and gets a
     label too; only an actually missing value is shown as an en dash. */
  function lineReadings(id, positions = framePos) {
    const here = positions[id], out = [];
    if (!here) return out;
    for (const pid of linesAt[id] || []) {
      const p = NORA.assets[pid], v = App.live.values[pid];
      if ((p.from !== id && p.to !== id) || App.pipeStyle(pid).hidden) continue;
      const otherId = p.from === id ? p.to : p.from, other = positions[otherId];
      if (!other) continue;
      const dx = other.x - here.x, dy = other.y - here.y, length = Math.hypot(dx, dy) || 1;
      const value = v == null ? null : Math.abs(v);
      out.push({
        pid, otherId, value, ux: dx / length, uy: dy / length,
        side: `${dy > 0 ? "S" : "N"}${dx >= 0 ? "E" : "W"}`,
        direction: v == null || v === 0 ? null : (p.from === id) === (v > 0) ? "out" : "in",
        text: value == null ? "–" : `${App.fmt(value, value < 10 ? 1 : 0)}M`,
      });
    }
    return out;
  }
  /* Asked for several times per node per frame (circle size, readings, line ends):
     within one frame each node and set of positions is worked out once. */
  function flowQuadrants(id, positions = framePos) {
    const byId = App.cached("quadrants", positions, () => new Map());
    if (!byId.has(id)) byId.set(id, flowQuadrantsNow(id, positions));
    return byId.get(id);
  }
  function flowQuadrantsNow(id, positions) {
    const here = positions[id], out = {};
    if (!here) return out;
    for (const pid of linesAt[id] || []) {
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
  // Half the side of a node's square (one size for every live node).
  function circleRadius() { return nodeHalf(); }
  function detailedFlow(scale) {
    return scale >= 1; // never render the detailed 11 px labels below their actual size
  }
  function pressureVisibility(mode, scale) {
    return mode === "live" && scale > 0; // endpoint pressures stay readable at every zoom
  }
  function pressureReadings(id, positions = framePos, scale = network ? network.getScale() : 1) {
    const lines = lineReadings(id, positions);
    // A node's pressure is identical at each of its line ends. Do not repeat it seven
    // times in the fitted overview; restore every endpoint as soon as detail is useful.
    return detailedFlow(scale) ? lines : lines.slice(0, 1);
  }
  function overviewReading(scale, radius) {
    return scale < 1 && radius * scale >= 11; // otherwise a clean dot is better than spilled text
  }
  function overviewNameLines(text) {
    if (text.length <= 14) return [text];
    const spaces = [...text.matchAll(/ /g)].map((match) => match.index);
    if (!spaces.length) return [text];
    const split = spaces.sort((a, b) => Math.abs(a - text.length / 2) - Math.abs(b - text.length / 2))[0];
    return [text.slice(0, split), text.slice(split + 1)];
  }
  function drawOverviewName(ctx, id, x, y, radius) {
    if (!network) return;
    const ratio = (network.canvas && network.canvas.pixelRatio) || window.devicePixelRatio || 1;
    const point = network.canvasToDOM({ x, y }), lines = overviewNameLines(App.nameOf(id));
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.font = "600 11.5px Archivo, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const top = point.y + radius * network.getScale() + 4;
    const box = [point.x - width / 2 - 3, top - 2, point.x + width / 2 + 3, top + lines.length * 13 + 2];
    if (overviewBoxes.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) {
      ctx.restore();
      return;
    }
    overviewBoxes.push(box);
    const ca = network.DOMtoCanvas({ x: box[0], y: box[1] }), cb = network.DOMtoCanvas({ x: box[2], y: box[3] });
    pressurePlacements.push([ca.x, ca.y, cb.x, cb.y]); // later pressures avoid this name too
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.paper;
    ctx.fillStyle = C.text;
    lines.forEach((line, index) => {
      ctx.strokeText(line, point.x, top + index * 13);
      ctx.fillText(line, point.x, top + index * 13);
    });
    ctx.restore();
  }
  // A reading inside a circle, on a patch of the circle's own fill so the day bar never
  // runs through a number. Text stays at its real screen size at every zoom.
  function reading(ctx, text, x, y, look, align = "center") {
    const ratio = (network && network.canvas && network.canvas.pixelRatio) || window.devicePixelRatio || 1;
    const point = network ? network.canvasToDOM({ x, y }) : { x, y };
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const w = ctx.measureText(text).width, left = align === "left" ? point.x : align === "right" ? point.x - w : point.x - w / 2;
    const ink = ctx.fillStyle;
    ctx.fillStyle = look.fill;
    ctx.fillRect(left - 2, point.y - 8, w + 4, 16);
    ctx.fillStyle = ink;
    ctx.textAlign = align;
    ctx.fillText(text, point.x, point.y);
    ctx.restore();
  }
  /* Every line gets its own flow reading inside the square. Values are stacked in the
     east/west column facing their lines, north before south; no quadrant totals and no
     dropped zero flows. A node with no visible lines keeps its total in the middle. */
  function drawQuadrants(ctx, x, y, id, look, { total, r = SQUARE.live, positions = framePos }) {
    const readings = lineReadings(id, positions), dx = r * 0.5;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = modelFont("600 12px Archivo, system-ui, sans-serif");
    for (const column of ["W", "E"]) {
      const lines = readings.filter((line) => line.side[1] === column)
        .sort((a, b) => a.side[0].localeCompare(b.side[0]) || a.pid.localeCompare(b.pid));
      const cx = x + (column === "E" ? dx : -dx), step = lines.length > 5 ? 13 : 14, start = y - (lines.length - 1) * step / 2;
      lines.forEach((line, index) => {
        ctx.fillStyle = line.direction === "out" ? look.ink : look.dim;
        reading(ctx, fitText(ctx, line.text, r * 0.9), cx, start + index * step, look);
      });
    }
    if (!readings.length && total != null) {
      ctx.fillStyle = look.ink;
      reading(ctx, `${App.fmt(total, total < 10 ? 1 : 0)}M`, x, y, look);
    }
    ctx.restore();
  }
  /* Zoomed-out semantic detail: keep direction and volume visible without repeating
     every individual pipeline. Show incoming and outgoing totals on separate rows. */
  function drawOverviewFlows(ctx, x, y, id, look, { half, total, positions = framePos }) {
    let incoming = 0, outgoing = 0;
    for (const line of lineReadings(id, positions)) {
      if (line.value == null || line.value < 0.05) continue;
      if (line.direction === "out") outgoing += line.value;
      else if (line.direction === "in") incoming += line.value;
    }
    const labels = [];
    if (incoming >= 0.05) labels.push({ text: `IN ${App.fmt(incoming, incoming < 10 ? 1 : 0)}M`, ink: look.dim });
    if (outgoing >= 0.05) labels.push({ text: `OUT ${App.fmt(outgoing, outgoing < 10 ? 1 : 0)}M`, ink: look.ink });
    if (!labels.length && total != null) labels.push({ text: `${App.fmt(total, total < 10 ? 1 : 0)}M`, ink: look.ink });
    const scale = network ? network.getScale() : 1, row = 7 / scale;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = modelFont("600 11px Archivo, system-ui, sans-serif");
    labels.forEach((label, index) => {
      ctx.fillStyle = label.ink;
      reading(ctx, fitText(ctx, label.text, half * 1.7), x, y + (index - (labels.length - 1) / 2) * row * 2, look);
    });
    ctx.restore();
  }
  /* A live square: one flow value per connected line, with the rate and trend retained
     only where they do not compete with a dense stack of required line readings. */
  function drawSquare(ctx, x, y, id, look, { half, now, day }) {
    const pad = half * 0.14, top = y - half * 0.8;
    const readings = lineReadings(id), maxColumn = Math.max(0,
      ...["W", "E"].map((column) => readings.filter((line) => line.side[1] === column).length));
    ctx.save();
    ctx.textBaseline = "middle";
    const rate = maxColumn <= 4 ? App.flowRate(id) : null;
    if (rate != null && Math.abs(rate) >= 0.05) {
      const through = App.window4h(id).past.slice(-1)[0] || 0;
      const fast = through > 0 && Math.abs(rate) / through >= App.thresholds.step[0];
      ctx.font = modelFont(`${fast ? 600 : 400} 11px Archivo, system-ui, sans-serif`);
      ctx.fillStyle = fast ? look.ink : look.dim;
      reading(ctx, `${rate > 0 ? "▲" : "▼"} ${App.fmt(Math.abs(rate), 1)}/h`, x + half - pad, top, look, "right");
    }
    drawQuadrants(ctx, x, y, id, look, { total: now ? now.flow : null, r: half });
    if (maxColumn <= 2) drawTrend(ctx, id, x - half + pad, y + half * 0.42, (half - pad) * 2, half * 0.26, look);
    if (day) drawDayBar(ctx, x, y + half * 0.84, day, look);
    ctx.restore();
  }
  /* Pressure belongs to a pipeline end, not to the middle of the node. Show one clear
     value per node in the overview and every line end in the detailed view, just beyond
     the square. A node without a measurement says so rather than borrowing a neighbour's. */
  function drawEndpointPressures(ctx, x, y, id, look, { half, positions = framePos, placed = network ? pressurePlacements : [], zoom = network ? network.getScale() : 1 }) {
    const scale = zoom, overview = !detailedFlow(scale), boxes = [];
    const readings = pressureReadings(id, positions, scale), now = App.reading(id);
    const text = now && now.pressure != null ? `${App.fmt(now.pressure)} bar` : "– bar";
    ctx.save();
    ctx.font = modelFont(overview ? "600 12px Archivo, system-ui, sans-serif" : SUB_FONT);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = ctx.measureText(text).width;
    for (const line of readings) {
      const gap = edgeGap(half, line.ux, line.uy);
      const projectedHalf = (Math.abs(line.ux) * width / 2 + Math.abs(line.uy) * 8) / scale;
      let px, py, box;
      // Detailed labels stay on their own pipeline; overview labels move straight up.
      // Either way, move outward until clear. Never drop or overprint a value.
      for (let attempt = 0; ; attempt++) {
        if (overview) {
          px = x;
          py = y - half - (13 + attempt * 18) / scale; // consistently above, never inside
        } else {
          const distance = gap + projectedHalf + (5 + attempt * 18) / scale;
          px = x + line.ux * distance;
          py = y + line.uy * distance;
        }
        box = [px - width / (2 * scale) - 2 / scale, py - 8 / scale,
          px + width / (2 * scale) + 2 / scale, py + 8 / scale];
        if (!placed.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) break;
      }
      ctx.fillStyle = overview ? look.ink : look.dim;
      reading(ctx, text, px, py, { ...look, fill: C.paper });
      boxes.push(box);
      placed.push(box);
    }
    ctx.restore();
    return boxes;
  }
  // vis-network custom shape: the square for one node, its readings inside, its name below.
  function card(id) {
    return ({ ctx, x, y, state: { selected, hover } }) => {
      const size = nodeHalf();
      return ({
      drawNode() {
        const s = App.nodeStyle(id), d = NORA.assets[id];
        const live = App.state.mode === "live";
        const scale = network ? network.getScale() : 1, detailed = detailedFlow(scale);
        const half = nodeHalf();
        const look = C.card[s.inactive ? "inactive" : live ? "active" : "normal"];
        ctx.save();
        ctx.globalAlpha = s.dim ? 0.35 : 1;
        squarePath(ctx, x, y, half);
        ctx.fillStyle = look.fill;
        ctx.fill();
        if (s.level) { // alarm: dark casing, colour inside it, never colour alone
          ctx.lineWidth = 5; ctx.strokeStyle = C.casing; ctx.stroke();
          ctx.lineWidth = 3; ctx.strokeStyle = App.levelColor[s.level]; ctx.stroke();
        } else {
          ctx.lineWidth = selected ? 2.4 : hover ? 1.6 : 1;
          ctx.strokeStyle = selected || hover ? look.ink : look.edge;
          ctx.stroke();
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const now = live ? App.reading(id) : null;
        const big = live ? (now.flow == null ? "–" : App.fmt(now.flow, now.flow < 10 ? 1 : 0))
          : App.state.mode === "load" && d.modelFlow != null ? App.fmt(d.modelFlow)
          : App.state.mode === "risk" && d.lost ? `−${App.fmt(d.lost)}` : "";
        let pressureBoxes = [];
        if (live && !detailed) {
          drawOverviewFlows(ctx, x, y, id, look, { half, total: now.flow });
        } else if (live && detailed) {
          drawSquare(ctx, x, y, id, look, { half, now, day: App.dayDelivery(id) });
        } else if (big) {
          ctx.fillStyle = look.ink;
          ctx.font = "600 12.5px Archivo, system-ui, sans-serif";
          if (detailed) ctx.fillText(fitText(ctx, big, half * 1.6), x, y);
          else if (overviewReading(scale, half)) reading(ctx, big, x, y, look);
        }
        if (pressureVisibility(App.state.mode, scale)) pressureBoxes = drawEndpointPressures(ctx, x, y, id, look, { half });
        if (!detailed) {
          const ownBox = [x - half, y - half, x + half, y + half];
          drawnBoxes[id] = [ownBox, ...pressureBoxes].reduce((all, box) => [
            Math.min(all[0], box[0]), Math.min(all[1], box[1]), Math.max(all[2], box[2]), Math.max(all[3], box[3]),
          ]);
          for (const box of pressureBoxes) {
            const a = network.canvasToDOM({ x: box[0], y: box[1] }), b = network.canvasToDOM({ x: box[2], y: box[3] });
            overviewBoxes.push([a.x, a.y, b.x, b.y]); // names must not cover a pressure
          }
          drawOverviewName(ctx, id, x, y, half);
          ctx.restore();
          if (s.level) App.drawBadge(ctx, s.level, x + half - 2, y - half + 2, 8);
          return;
        }
        /* The name below the square (and, outside Live, what the mode says about the
           node), on a paper backing: lines leave a node downwards, and no line may run
           through its text (Ray, 28 Oct). Text on the paper takes the paper's ink. */
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "center";
        let nameY = y + half + CIRC.name, subY = nameY + CIRC.sub;
        const paperInk = { ...look, ink: C.text, dim: C.text_dim };
        ctx.font = NAME_FONT;
        const name = fitText(ctx, d.name, half * 3);
        let width = Math.max(ctx.measureText(name).width, half);
        let sub = null;
        if (s.sub && !live) {
          ctx.font = SUB_FONT;
          sub = fitText(ctx, s.sub, half * 3);
          width = Math.max(width, ctx.measureText(sub).width);
        }
        const pressures = pressureBoxes || [], left = x - width / 2 - 4, right = x + width / 2 + 4;
        const nameTop = () => nameY - 12;
        for (const box of pressures) {
          if (box[0] < right && box[2] > left && box[3] > nameTop() && box[1] < nameY + 4) {
            nameY = box[3] + 12;
            subY = nameY + CIRC.sub;
          }
        }
        const bottom = (sub ? subY : nameY) + 4;
        const ownBox = [x - Math.max(half, width / 2 + 4), y - half, x + Math.max(half, width / 2 + 4), bottom];
        drawnBoxes[id] = [ownBox, ...pressures].reduce((all, box) => [
          Math.min(all[0], box[0]), Math.min(all[1], box[1]), Math.max(all[2], box[2]), Math.max(all[3], box[3]),
        ]);
        pressurePlacements.push(ownBox); // later nodes' pressures avoid this square and name
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.paper;
        ctx.fillRect(left, nameTop(), width + 8, bottom - nameTop());
        ctx.restore();
        ctx.fillStyle = paperInk.ink;
        ctx.font = NAME_FONT;
        ctx.fillText(name, x, nameY);
        if (sub) {
          ctx.font = SUB_FONT;
          ctx.fillStyle = paperInk.dim;
          ctx.fillText(sub, x, subY);
        }
        ctx.restore();
        if (s.level) App.drawBadge(ctx, s.level, x + half - 2, y - half + 2, 8);
      },
      nodeDimensions: { width: size * 2, height: size * 2 + CIRC.name + CIRC.sub + 4 },
      });
    };
  }

  /* Keep the direction hint, but leave the network edges free of category labels. */
  function drawDirection(ctx) {
    const ratio = (network.canvas && network.canvas.pixelRatio) || window.devicePixelRatio || 1;
    const u = App.uiScale();
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = C.text_dim;
    ctx.font = `${11 * u}px Archivo, system-ui, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(direction === "vertical" ? "Gas flows from top to bottom ↓" : "Gas flows from left to right →", el.clientWidth - 10 * u, el.clientHeight - 12 * u);
    ctx.restore();
  }

  function pointAlong(edge, along, positions) {
    const a = positions[edge.from], b = positions[edge.to];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    // Route markers use the visible line segment, from where it leaves one square to
    // where it enters the next, with a small gap so no dot or peak band enters a node.
    const screenScale = network ? network.getScale() : 1;
    const [start, end] = App.visibleRange(len, edgeGap(nodeHalf(), ux, uy) + 8 / screenScale, edgeGap(nodeHalf(), ux, uy) + 8 / screenScale);
    const t = start + (end - start) * along;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) };
  }
  function bandPath(edge, extent, positions) {
    const steps = Math.max(4, Math.ceil(Math.abs(extent[1] - extent[0]) * 32));
    return Array.from({ length: steps + 1 }, (_, i) => pointAlong(edge, extent[0] + (extent[1] - extent[0]) * (i / steps), positions));
  }
  function animateStubs(scale) {
    return scale >= 0.5 && App.settings().animation && App.live.playing && !App.reduceMotion;
  }
  function stubDistance(id, travel, scale, positions = framePos, ux = 1, uy = 0) {
    return edgeGap(nodeHalf(), ux, uy) + 10 / scale + travel;
  }
  function stubClear(a, b, positions, scale) {
    const vx = b.x - a.x, vy = b.y - a.y, length2 = vx * vx + vy * vy;
    for (const [id, point] of Object.entries(positions)) {
      if (!point) continue;
      const t = length2 ? Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / length2)) : 0;
      const px = a.x + vx * t, py = a.y + vy * t; // nearest point; inside a square is by its larger offset
      if (Math.max(Math.abs(point.x - px), Math.abs(point.y - py)) < nodeHalf() + 2 / scale) return false;
    }
    return true;
  }
  function overlay(ctx) {
    try { overlayNow(ctx); } finally { App.frame.end(); }
  }
  function overlayNow(ctx) {
    const positions = network.getPositions();
    lineValueBoxes = drawLineValues(ctx, positions);
    drawDirection(ctx);
    for (const id of App.pipeIds) {
      const s = App.pipeStyle(id), e = edges.get(id);
      if (s.level && !s.hidden && e) { const m = pointAlong(e, 0.5, positions); App.drawBadge(ctx, s.level, m.x + 12, m.y, 7); }
    }
    drawMarks(); // the moving layer follows every redraw: a pan, a zoom, a dragged node
  }

  /* Moving things (the flow stubs, pigs, peaks and gas quality) live on their own canvas
     over the network. They move every frame; the network itself (70 circles full of
     text) only changes when the data steps or the view moves, and vis redraws it then.
     So the circles are drawn a few times a second, not sixty (Ray, 28 Oct: "the
     application is extremely slow"). */
  let marks = null, marksCtx = null;
  function drawMarks() {
    if (!marksCtx || !network) return;
    App.frame.run(() => {
      const ratio = window.devicePixelRatio || 1, w = el.clientWidth, h = el.clientHeight;
      if (marks.width !== Math.round(w * ratio) || marks.height !== Math.round(h * ratio)) {
        marks.width = Math.round(w * ratio);
        marks.height = Math.round(h * ratio);
        marks.style.width = `${w}px`;
        marks.style.height = `${h}px`;
      }
      const ctx = marksCtx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, marks.width, marks.height);
      if (App.state.mode !== "live") return;
      const scale = network.getScale();
      // At low zoom a stub outside its own node can cross a neighbour. Keep the fitted
      // overview calm; these decorative strokes only appear once the drawing has room.
      if (animateStubs(scale)) {
        const o = network.canvasToDOM({ x: 0, y: 0 }); // the network's own coordinates
        ctx.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * o.x, ratio * o.y);
        drawStubs(ctx, framePos, scale);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawMoving(ctx, framePos, scale);
    });
  }
  /* Simulated flow at the nodes, not on the lines (same as the Map view): short solid
     bands sliding into the icon where gas arrives and out of it where gas leaves, scaled
     by how much the line carries. Drawn in the network's coordinates. */
  function drawStubs(ctx, positions, scale) {
    ctx.lineCap = "round";
    ctx.strokeStyle = C.active;
    for (const nid of App.nodeIds) {
      const pn = positions[nid];
      if (!pn) continue;
      for (const pid of linesAt[nid] || []) {
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
          const d = stubDistance(nid, inflow ? (stub - band) * (1 - t) + band : (stub - band) * t + band, scale, positions, ux, uy);
          ctx.globalAlpha = 0.25 + (inflow ? t : 1 - t) * 0.55;
          const cx = pn.x + ux * d, cy = pn.y + uy * d;
          const x1 = cx - ux * band / 2, y1 = cy - uy * band / 2;
          const x2 = cx + ux * band / 2, y2 = cy + uy * band / 2;
          if (!stubClear({ x: x1, y: y1 }, { x: x2, y: y2 }, positions, scale)) continue; // never across a circle
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  // Pigs, peaks and gas-quality slugs in screen pixels, so they stay visible (and the
  // same size as on the map) however far the drawing is zoomed out.
  function drawMoving(ctx, positions, scale) {
    const detail = scale >= 0.9 ? 2 : scale >= 0.5 ? 1 : 0;
    const marksNow = App.markers().filter((m) => edges.get(m.id) && !App.pipeStyle(m.id).hidden);
    for (const m of marksNow) if (m.extent) {
      const path = bandPath(edges.get(m.id), m.extent, positions).map((p) => network.canvasToDOM(p));
      App.drawBand(ctx, m, path[0], path[path.length - 1], 3.2 * App.uiScale(), path);
    }
    const taken = marksNow.length ? [...nodeBoxes(), ...lineValueBoxes] : []; // labels keep clear of the circles' text and line values
    drawnMarks = [];
    for (const m of marksNow) {
      const p = pointAlong(edges.get(m.id), Math.max(0, Math.min(1, m.along)), positions);
      const dom = network.canvasToDOM(p);
      App.drawMarker(ctx, m, dom.x, dom.y, p.angle, App.markerSize(m.kind), detail, taken);
      if (!m.noDot) drawnMarks.push({ x: dom.x, y: dom.y, m });
    }
  }

  /* What a point on screen is on: a circle (score: the distance to its edge) or a
     pipeline (the distance to the line), the closest within 8 px, so a click on a
     line is the line even beside a node. Everything is in screen pixels: a circle's
     radius is in canvas units and shrinks with the zoom (`scale`). */
  function hitTest(at, positions, toDOM, scale) {
    let best = null, bestScore = Infinity;
    for (const nid of App.nodeIds) {
      const p = positions[nid];
      if (!p || App.nodeStyle(nid).hidden) continue; // not placed, or hidden
      const dom = toDOM(p);
      const score = Math.max(Math.abs(dom.x - at.x), Math.abs(dom.y - at.y)) - nodeHalf() * scale; // to the square's edge
      if (score < bestScore) { bestScore = score; best = nid; }
    }
    for (const pid of App.pipeIds) {
      const p = NORA.assets[pid], a = positions[p.from], b = positions[p.to];
      if (!a || !b || App.pipeStyle(pid).hidden) continue;
      const da = toDOM(a), db = toDOM(b), vx = db.x - da.x, vy = db.y - da.y;
      const len = Math.hypot(vx, vy) || 1;
      const t = Math.max(0, Math.min(1, ((at.x - da.x) * vx + (at.y - da.y) * vy) / (len * len)));
      const score = Math.hypot(da.x + vx * t - at.x, da.y + vy * t - at.y) - 4; // the drawn line plus a little slack
      if (score < bestScore) { bestScore = score; best = pid; }
    }
    return bestScore <= 8 ? best : null;
  }

  /* Screen boxes of every circle drawn this frame with the name, pressure, rate and
     trend under it, so the labels of pigs and peaks keep clear of them. Each node
     records its box (in canvas units) as it is drawn, so this costs no extra pass. */
  let drawnBoxes = {}, lineValueBoxes = [];
  // Where pigs and peaks were drawn this frame (screen pixels), so a click can open one.
  let drawnMarks = [];
  function markAt(x, y) {
    let best = null, bestD = 9 * App.uiScale();
    for (const d of drawnMarks) { const dist = Math.hypot(d.x - x, d.y - y); if (dist < bestD) { best = d.m; bestD = dist; } }
    return best;
  }
  function nodeBoxes() {
    return Object.values(drawnBoxes).map(([x0, y0, x1, y1]) => {
      const a = network.canvasToDOM({ x: x0, y: y0 }), b = network.canvasToDOM({ x: x1, y: y1 });
      return [a.x, a.y, b.x, b.y];
    });
  }

  view.mount = (container) => {
    el = container;
    el.style.background = C.paper;
    network = new vis.Network(container, { nodes, edges }, flowOptions);
    view.network = network;
    marks = document.createElement("canvas"); // the moving layer, above the network
    marks.className = "flow-marks";
    marks.setAttribute("aria-hidden", "true");
    container.append(marks);
    marksCtx = marks.getContext("2d");
    // No zooming out far past the whole network: it would only shrink it to a speck.
    network.on("zoom", () => {
      const min = minScale();
      if (network.getScale() < min) network.moveTo({ scale: min, animation: false });
    });
    if (App.embed) network.setOptions({ interaction: { zoomView: false } });
    nodes.update(App.nodeIds.map((id) => ({ id, shape: "custom", ctxRenderer: card(id), label: "" })));
    network.on("beforeDrawing", paper);
    network.on("afterDrawing", overlay);
    /* vis's own hit test does not see the custom circle shape: what vis hit (edges)
       wins, else hitTest finds the circle or line under the pointer. */
    // The tooltip says what the node is doing now: filled in when the pointer arrives,
    // not on every step of the player (that re-sent every node to vis).
    network.on("hoverNode", ({ node }) => nodes.update({ id: node, title: tooltip(node) }));
    network.on("click", (event) => {
      const at = event.pointer && event.pointer.DOM;
      const mark = at && markAt(at.x, at.y); // a pig or a peak under the pointer wins
      if (mark) { App.selectMarker(mark.key); return; }
      const id = event.nodes[0] || event.edges[0] || (at && hitTest(at, network.getPositions(), (p) => network.canvasToDOM(p), network.getScale()));
      if (id) App.select(id);
    });
    /* Right-click a node or a line: the same menu as on the Map. A plain DOM
       listener on the container (the reliable path for real right-clicks). */
    container.addEventListener("contextmenu", (e) => {  // capture: vis may stop the event at its canvas
      if (!view.ready) return;
      const rect = container.getBoundingClientRect();
      const best = hitTest({ x: e.clientX - rect.left, y: e.clientY - rect.top }, network.getPositions(), (p) => network.canvasToDOM(p), network.getScale());
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

  /* What a node or line looks like to vis-network. The player restyles four times a
     second, and vis re-reads every item it is handed, changed or not: all 144 nodes
     and 75 lines took about 28 ms, a visible stutter four times a second. So only items
     whose look changed are handed over. A node's look is just whether it shows (the
     circle draws its live numbers itself; the tooltip is filled in on hover); a line's
     value is drawn by the overlay, not as a vis label, and its width is rounded to a
     quarter pixel, so playing the data hands vis almost nothing. */
  const sent = new Map(); // id -> the look last handed to vis
  function nodeLook(id) { return { hidden: App.nodeStyle(id).hidden }; }
  function lineLook(id) {
    const s = App.pipeStyle(id);
    return {
      hidden: s.hidden, width: Math.round(s.width * 4) / 4, dashes: s.dashed ? [5, 5] : false,
      color: { color: s.color, highlight: s.color, hover: s.color, inherit: false, opacity: s.dim ? 0.3 : 1 },
      shadow: s.level ? { enabled: true, color: C.casing, size: 3, x: 0, y: 0 } : { enabled: false },
      arrows: { to: { enabled: s.forward, scaleFactor: 0.4 }, from: { enabled: s.backward, scaleFactor: 0.4 } },
    };
  }
  function changes(ids, lookOf) {
    const out = [];
    for (const id of ids) {
      const look = lookOf(id), key = JSON.stringify(look);
      if (sent.get(id) !== key) { sent.set(id, key); out.push({ id, ...look }); }
    }
    return out;
  }
  function tooltip(id) {
    const s = App.nodeStyle(id);
    const details = App.state.mode === "live"
      ? [s.flow ? `${s.flow} MSm³/d` : "", s.pressure].filter(Boolean).join("\n")
      : s.sub;
    return `${NORA.assets[id].name}${details ? `\n${details}` : ""}`;
  }
  view.restyle = () => {
    if (!view.ready) return;
    const nodeChanges = changes(App.nodeIds, nodeLook), lineChanges = changes(App.pipeIds, lineLook);
    if (nodeChanges.length) nodes.update(nodeChanges);
    if (lineChanges.length) edges.update(lineChanges);
    // The circles and line values draw from the live data themselves: ask for one
    // coalesced redraw on the next frame (a DataSet update asks for the same).
    if (!nodeChanges.length && !lineChanges.length) network.body.emitter.emit("_requestRedraw");
  };
  view.changes = () => ({ nodes: changes(App.nodeIds, nodeLook), lines: changes(App.pipeIds, lineLook) }); // for tests

  /* Line values, drawn over the lines at their middle on a paper patch, as vis drew its
     labels (11 px in canvas units, so they scale with the zoom; hidden when too small to
     read). Returns their screen boxes, so marker labels keep clear of them. */
  function drawLineValues(ctx, positions) {
    const scale = network.getScale(), boxes = [];
    if (11 * scale < 5) return boxes;
    ctx.save();
    ctx.font = "11px Archivo, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const id of App.pipeIds) {
      const s = App.pipeStyle(id), p = NORA.assets[id], a = positions[p.from], b = positions[p.to];
      if (!s.label || s.hidden || !a || !b) continue;
      const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2, w = ctx.measureText(s.label).width;
      ctx.globalAlpha = s.dim ? 0.35 : 1;
      ctx.fillStyle = C.paper;
      ctx.fillRect(x - w / 2 - 2, y - 7, w + 4, 14);
      ctx.fillStyle = C.text_dim;
      ctx.fillText(s.label, x, y);
      const lo = network.canvasToDOM({ x: x - w / 2 - 2, y: y - 7 }), hi = network.canvasToDOM({ x: x + w / 2 + 2, y: y + 7 });
      boxes.push([lo.x, lo.y, hi.x, hi.y]);
    }
    ctx.restore();
    return boxes;
  }

  // Every frame while playing: only the moving layer. The circles follow each data step.
  view.draw = () => { if (App.state.mode === "live" && App.live.playing) drawMarks(); };
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
    const margin = (App.state.mode === "live" ? SQUARE.live : SQUARE.plain) * 6;
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
  view.lineReadings = lineReadings;
  view.circleRadius = circleRadius; // half a square's side
  view.drawSquare = drawSquare;
  view.drawQuadrants = drawQuadrants;
  view.drawOverviewFlows = drawOverviewFlows;
  view.drawEndpointPressures = drawEndpointPressures;
  view.drawDayBar = drawDayBar;
  view.pointAlong = pointAlong;
  view.bandPath = bandPath;
  view.animateStubs = animateStubs;
  view.detailedFlow = detailedFlow;
  view.pressureVisibility = pressureVisibility;
  view.pressureReadings = pressureReadings;
  view.overviewSquareHalf = overviewSquareHalf;
  view.overviewReading = overviewReading;
  view.overviewNameLines = overviewNameLines;
  view.stubDistance = stubDistance;
  view.stubClear = stubClear;
  view.card = card; // for tests: the renderer of one node
  view.hitTest = hitTest;
  view.markAt = (x, y) => markAt(x, y); // for tests: the pig or peak at a screen point
  App.register("flow", view);
})();
