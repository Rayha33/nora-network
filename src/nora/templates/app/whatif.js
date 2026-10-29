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

