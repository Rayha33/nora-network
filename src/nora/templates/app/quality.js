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

