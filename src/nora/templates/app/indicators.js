  // ------------------------------------------------------------------ indicators
  /* A range bar: the normal band, alarm-limit ticks, an optional target, and a moving
     pointer. All grey until the value is abnormal; then the pointer takes the alarm
     colour, with its dark outline. */
  function rangeBar({ min, max, value, band, ticks = [], target, lvl = 0 }) {
    const W = 200, x = (v) => Math.max(0, Math.min(W, ((v - min) / (max - min || 1)) * W));
    let m = `<rect x="0" y="11" width="${W}" height="7" rx="1" fill="${COLORS.dots}"/>`;
    if (band) m += `<rect x="${x(band[0])}" y="11" width="${Math.max(1, x(band[1]) - x(band[0]))}" height="7" fill="${COLORS.band}"/>`;
    // Only the critical limits (Ray, 29 Oct: "too much clutter here, simplify it a bit"):
    // the band is the normal range, the marker the value.
    for (const tick of ticks.filter((t) => t.level === 3)) {
      const tx = x(tick.at), tall = 3 + 2 * tick.level;
      m += `<line x1="${tx}" x2="${tx}" y1="${14.5 - tall}" y2="${14.5 + tall}" stroke="${COLORS.text}" stroke-width="${tick.level === 3 ? 1.6 : 1}"/>`;
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
  /* Time to a limit (hub 3604; Ray, 27 Oct: "more visual ways of showing how values are
     heading towards what limit"): at the rate of the last steps, the nearest limit ahead
     in the direction the value moves, when it is reached within the plan's look-ahead.
     Plain words, no colour: a projection, not an alarm. */
  function toLimit(ind) {
    const known = ind.series.filter((v) => v != null), v = known[known.length - 1], r = rate(ind.series);
    if (!ind.limits || r == null || v == null || Math.abs(r) < 1e-6) return null;
    const ahead = ind.limits.filter((l) => (r > 0 ? l.at > v : l.at < v)).sort((a, b) => Math.abs(a.at - v) - Math.abs(b.at - v))[0];
    const hours = ahead ? (ahead.at - v) / r : null;
    if (!(hours > 0 && hours <= (T.plan_lookahead_hours || 6))) return null;
    return `${ahead.name} in ~${hours < 1 ? `${Math.max(5, Math.round((hours * 60) / 5) * 5)} min` : `${fmt(hours, 1)} h`}`;
  }
  const toLimitText = (ind) => { const text = toLimit(ind); return text ? h("span", { class: "to-limit" }, text) : null; };
  function rateText(r, unit) {
    if (r == null) return h("span", { class: "dim" }, "–");
    if (Math.abs(r) < 0.05) return h("span", { class: "dim" }, ""); // steady: nothing to say
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
      id, measure: "Delivery", unit: "MSm³/d", lvl, band,
      bar: rangeBar({ min: 0, max: top, value: actual, target: nom, lvl, band,
        ticks: [...(nom ? [nom * (1 - tol[2]), nom * (1 + tol[2])].map((at) => ({ at, level: 3 })) : []), ...(booked ? [{ at: booked, level: 2 }] : [])] }),
      series: series((f) => throughput(id, f.flows)),
      // Booked capacity only: delivery follows a moving nomination, so the nomination's
      // own band is no fixed limit to project toward.
      limits: booked ? [{ at: booked, name: "booked capacity" }] : [],
      value: nom ? `${fmt(actual, 1)} of ${fmt(nom, 1)} nominated${booked ? `, ${fmt(booked)} booked` : ""}` : `${fmt(actual, 1)} MSm³/d`,
    };
  }
  function pressureIndicator(id) {
    const p = metric("pressure_bar", id), [low, high] = C.pressure[assets[id].type], span = high - low;
    const pm = T.pressure_margin, band = [low + pm[0] * span, high - pm[0] * span];
    const lvl = levelFor(id, ["pressure"]);
    return {
      id, measure: "Pressure", unit: "bar", lvl, band,
      bar: rangeBar({ min: low - 0.1 * span, max: high + 0.1 * span, value: p, lvl, band,
        ticks: [{ at: low, level: 3 }, { at: high, level: 3 }, { at: low + pm[1] * span, level: 2 }, { at: high - pm[1] * span, level: 2 }] }),
      series: series((f) => metric("pressure_bar", id, f)),
      limits: (C.pressure_limits || {})[assets[id].type]
        ? C.pressure_limits[assets[id].type].map((at, i) => ({ at, name: ["low-low limit", "low limit", "high limit", "high-high limit", "integrity limit"][i] }))
        : [{ at: low, name: "minimum" }, { at: high, name: "maximum" }],
      value: `${fmt(p, 1)} bar, window ${fmt(low)}–${fmt(high)}`,
    };
  }
  /* A line's pack (review, 30 Oct: a pipeline's page showed its load and nothing else):
     the gas it holds, the model's estimate from its end pressures as on the Flow and in
     the inventory trend, against the least and most it held in the data so far, with its
     settle-out pressure and how fast it packs. Grey: a model answer, never an alarm. */
  function packIndicator(id) {
    const f = frame(), lp = linepack(id, f), sop = settleOut(id, f), r = packRate(id);
    const held = live.frames.slice(0, live.index + 1).map((x) => linepack(id, x)).filter((v) => v != null);
    const lo = Math.min(lp, ...held), hi = Math.max(lp, ...held), pad = Math.max((hi - lo) * 0.1, lp * 0.01);
    return {
      id, measure: "Line pack", unit: "MSm³", lvl: 0, band: [lo, hi],
      noRate: true, // its packing is said in MSm³/d, as on the Flow's "pack +1.7", not again per hour
      bar: rangeBar({ min: lo - pad, max: hi + pad, value: lp, band: [lo, hi] }),
      series: series((x) => linepack(id, x)),
      limits: [],
      value: `${fmt(lp, 1)} MSm³ at ${fmt(sop, 1)} bar settle-out${r != null && Math.abs(r) >= 0.5 ? `, packing ${signed(r, 1)} MSm³/d` : ""}, an estimate`,
    };
  }
  function qualityIndicator(id, name) {
    const v = metric(name, id), limits = C.quality[name], lvl = level(v, limits);
    return {
      id, measure: QUALITY[name].name, unit: QUALITY[name].unit, lvl, band: [0, limits[0]],
      bar: rangeBar({ min: 0, max: limits[2] * 1.5, value: v, lvl, band: [0, limits[0]],
        ticks: limits.map((at, i) => ({ at, level: i + 1 })) }),
      series: series((f) => metric(name, id, f)),
      limits: [{ at: limits[0], name: "warning level" }, { at: limits[2], name: "limit" }],
      value: `${qualityText(name, v)}, limit ${limits[2]}`,
    };
  }
  function loadIndicator(id) {
    const d = assets[id], v = Math.abs(frame().flows[id] || 0), u = v / d.capacity;
    return {
      id, measure: "Load", unit: "pts", lvl: level(u, T.load), band: [0, T.load[0] * 100],
      bar: rangeBar({ min: 0, max: 1.1, value: u, lvl: level(u, T.load), band: [0, T.load[0]], ticks: T.load.map((at, i) => ({ at, level: i + 1 })) }),
      series: series((f) => (f.flows[id] == null ? null : (Math.abs(f.flows[id]) / d.capacity) * 100)),
      limits: [{ at: 100, name: "capacity" }],
      value: `${fmt(u * 100)}%: ${fmt(v, 1)} of ${fmt(d.capacity)} MSm³/d`,
    };
  }
  /* A bank of indicators. Across assets (the overview) each row is named after its
     asset; for one asset (its page or sidebar) after what it measures, so the rows
     read "Delivery", "Pressure" instead of the asset's name twice. */
  function bank(indicators, empty, { byMeasure = false } = {}) {
    if (!indicators.length) return h("p", { class: "empty" }, empty);
    // One asset's values (a panel) need no column heads: the rows say what they are.
    const heads = byMeasure ? [] : [h("div", { class: "head" }, "Asset"), h("div", { class: "head" }, "Value in its range"),
      h("div", { class: "head" }, `Last ${spanLabel(hourly(TREND_STEPS) * stepHours() * 3600)}`), h("div", { class: "head optional" }, "Change"), h("div", { class: "head optional" }, "State")];
    return h("div", { class: `bank${byMeasure ? " by-measure" : ""}` },
      ...heads,
      ...indicators.flatMap((ind) => [
        byMeasure ? h("div", { class: "name measure" }, ind.measure || nameOf(ind.id))
          : h("div", pressable(`asset:${ind.id}`, () => go({ screen: "asset", asset: ind.id }), { class: "name", role: "link", title: "Open the asset" }), nameOf(ind.id)),
        h("div", null, ind.bar, h("div", { class: "value" }, ind.value, h("span", { class: "rate-inline" }, (ind.noRate ? null : rateText(rate(ind.series), ind.unit)), toLimitText(ind)))),
        trend(ind.series, { band: ind.band, lvl: ind.lvl }),
        h("div", { class: "rate" }, (ind.noRate ? null : rateText(rate(ind.series), ind.unit)), toLimitText(ind)),
        h("div", { class: "state optional" }, badge(ind.lvl)),
      ]));
  }
  // When an alarm began; "by" when it was already active as the playhead arrived.
  function sinceTime(since) {
    if (!since || since.t == null) return h("time", null, "");
    return since.before
      ? h("time", { title: "Already active when the playhead arrived: it may have begun earlier" }, `by ${shortTime(since.t)}`)
      : h("time", { title: "When this alarm began" }, shortTime(since.t));
  }
  // Acknowledge: the operator has seen it. The button never opens the asset under it.
  function ackButton(conditions, label = "Ack") {
    const open = conditions.filter((c) => !c.acked);
    if (!open.length) return null;
    return h("button", { type: "button", class: "ack", "data-key": `ack:${open.map(alarmKey).join(",")}`,
      title: open.length === 1 ? "Acknowledge this alarm" : `Acknowledge ${open.length} alarms`,
      onkeydown: (e) => { if (e && e.stopPropagation) e.stopPropagation(); }, // Enter acks; it never opens the row
      onclick: (e) => { if (e && e.stopPropagation) e.stopPropagation(); alarmHandling.ack(open); evaluate(); refreshScreens(); } }, label);
  }
  function alarmList(conditions) {
    if (!conditions.length) return h("p", { class: "empty" }, "No active alarms. Everything is in its normal range.");
    return h("ul", { class: "alarm-list" }, conditions.map((c) =>
      h("li", { ...(assets[c.id] ? pressable(`alarm:${c.kind}|${c.id}`, () => go({ screen: "asset", asset: c.id }), { role: "link", title: `Open ${nameOf(c.id)}` }) : {}),
        class: c.acked ? "acked" : null },
        badge(c.level, ""), h("span", null, c.text), h("span", { class: "alarm-end" }, sinceTime(c.since), c.acked ? h("span", { class: "dim small" }, "Acked") : ackButton([c])))));
  }
  /* The alarm summary on the Overview: how many wait for an acknowledgement, the oldest
     of them, and the rate over the last hour of data, with a flood above 10 in 10
     minutes (ISA-18.2's benchmark for one operator). */
  function alarmSummary() {
    const all = live.conditions, open = all.filter((c) => !c.acked), now = live.time;
    if (!all.length && !live.shelved.length) return null;
    const began = (c, s) => c.since && !c.since.before && c.since.t != null && now - c.since.t <= s;
    const hour = all.filter((c) => began(c, 3600)).length, ten = all.filter((c) => began(c, 600)).length;
    const oldest = open.map((c) => c.since && c.since.t).filter((t) => t != null).sort((a, b) => a - b)[0];
    return h("div", { class: "alarm-summary" },
      h("span", null, open.length ? `${open.length} unacknowledged${oldest != null ? `, oldest ${shortTime(oldest)}` : ""}` : "All acknowledged"),
      h("span", { class: "dim" }, `${hour} raised in the last hour`),
      ten > 10 ? h("span", { class: "flood" }, badge(2, `Alarm flood: ${ten} in 10 min`)) : null,
      live.shelved.length ? h("span", { class: "dim" }, `${live.shelved.length} shelved`) : null,
      ackButton(all, "Acknowledge all"));
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

