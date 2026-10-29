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

