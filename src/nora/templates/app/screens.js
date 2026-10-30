  // ------------------------------------------------------------------ screens
  const screens = { overview: $("screen-overview"), asset: $("screen-asset"), diag: $("screen-diag") };
  const containers = { map: $("view-map"), flow: $("view-flow") };
  const views = {};
  function register(name, view) { views[name] = view; }
  const current = () => views[state.view];
  /* Map and Flow side by side on a wide or ultra-wide screen (issue #59: aspect 2.2 or
     more, a video wall or a 32:9 desk), not in the home page's frame or on a phone.
     ?split=1 forces it, ?split=0 turns it off. */
  function splitScreen() {
    const asked = params.get("split");
    if (asked === "0" || embed) return false;
    return asked === "1" || (display.profile !== "compact" && window.innerWidth / Math.max(1, window.innerHeight) >= 2.2);
  }
  const shownViews = () => (splitScreen() ? ["map", "flow"] : [state.view]).map((key) => views[key]).filter(Boolean);
  function restyle() {
    if (route.screen === "unit") for (const view of shownViews()) if (view.ready) view.restyle();
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
        h("tbody", null, rows.map((s) => h("tr", pressable(`slug:${s.q.slug}`, () => go({ screen: "asset", asset: s.q.arrived ? s.q.arrived.node : s.q.pid }), { title: "Open where it is now" }),
          h("td", null, swatch(s.q.metric), ` ${QUALITY[s.q.metric].name} from ${nameOf(s.q.origin)}`),
          h("td", null, fmt(s.q.conc, QUALITY[s.q.metric].digits), ` ${QUALITY[s.q.metric].unit}`),
          // The place, and when under it: the time wrapped as one piece, not "(in 19.1" and "h)" (review, 30 Oct)
          h("td", null, s.q.arrived ? `Arrived at ${nameOf(s.q.arrived.node)}` : [nameOf(s.next.node), h("span", { class: "eta" }, etaText(s.next.t))]),
          h("td", null, s.exit ? [`${nameOf(s.exit.node)}, ${fmt(s.exit.conc, QUALITY[s.q.metric].digits)}\u00a0${QUALITY[s.q.metric].unit.replace(/ /g, "\u00a0")}`, h("span", { class: "eta" }, etaText(s.exit.t))] : "No exit on today's flows"),
          h("td", null, badge(slugAlarm(s), ""))))))
        : h("p", { class: "empty" }, `No H₂S or CO₂ peaks in the network. Limits: ${limits}.`),
      h("p", { class: "dim small" }, `Estimate. Gas travels at ${fmt(C.pipelines.gas_velocity_mps)} m/s along the line taking most of the flow; where gas joins, it is assumed to carry the median field reading. Limits from nora.toml.`));
  }
  /* The pigs under way (Ray, 27 Oct): each pig's tag, its line, its ETA at the receiver
     and what the receiving station was last told. A row opens the pig. */
  function pigsBox() {
    if (live.time == null) return null;
    const hm = (t) => timeFormat(t, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" });
    const rows = allPigs().map((pig) => {
      if (!pigPlace(pig, live.time)) return null;
      const r = pigRun(pig, pigRunIndex(pig, live.time));
      return { pig, r, st: pigStatus(pig, r, live.time) };
    }).filter(Boolean).sort((a, b) => b.st.alarm.level - a.st.alarm.level || a.st.eta - b.st.eta);
    if (!rows.length && !allPigs().length) return null;
    const told = ({ st }) => (st.alarm.what === "missed" ? "Update missed" : st.alarm.level ? `ETA moved ${minutes(st.alarm.drift)}` : st.last ? `ETA sent ${hm(st.last.t)}` : st.launch ? `Notice sent ${hm(st.launch.t)}` : "–");
    const open = (pig) => () => { go({ screen: "unit", unit: "all" }); openMarker(`pig:${pig.label}|${pig.launch}`); };
    return h("div", { class: "box" }, h("h2", null, "Pigs under way"),
      rows.length ? h("table", { class: "data pigs" },
        h("thead", null, h("tr", null, ["Pig", "Pipeline", "ETA (CET)", "Last message", ""].map((t) => h("th", null, t)))),
        h("tbody", null, rows.map((row) => h("tr", pressable(`pig:${row.pig.label}|${row.pig.launch}`, open(row.pig), { title: "Open the pig" }),
          h("td", null, pigTag(row.pig)),
          h("td", null, nameOf(row.pig.pipeline)),
          h("td", null, `${nameOf(row.r.receiver)} ${hm(row.st.eta)}`),
          h("td", null, told(row)),
          h("td", null, badge(row.st.alarm.level, ""))))))
        : h("p", { class: "empty" }, "No pig under way."));
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
      : !plan.nominated ? "No nominations at this hour, so there is no plan to check"
      : nowLevel ? `${plan.now[1]} now`
      : plan.ahead[0] ? `In ${fmt(plan.ahead[3])} h: ${plan.ahead[1]}`
      : "Plan holds at every exit point";
    const ts = timeState(), ahead = ts && ts.model ? `Model, ${spanText(ts.ahead)} ahead of now. ` : "";
    const context = ahead + (plan && plan.nominated ? `Nominated ${fmt(plan.nominated)} MSm³/d, deliverable ${fmt(plan.deliverable)} MSm³/d.`
      + (plan.bottleneck ? ` Busiest line: ${nameOf(plan.bottleneck)} at ${fmt(plan.maxLoad * 100)}%.` : "") : "");
    const units = NORA.units.map((u) => {
      const conds = live.conditions.filter((c) => unitOf[c.id] === u.id);
      return h("button", { type: "button", "data-key": `unit:${u.id}`, onclick: () => go({ screen: "unit", unit: u.id }) },
        h("span", null, u.name), badge(Math.max(0, ...conds.map((c) => c.level)), conds.length ? `${conds.length} active` : "Normal"));
    });
    keepFocus(screens.overview, () => patch(screens.overview, h("div", { class: "screen-body" },
      h("div", { class: `box banner${bannerLevel ? " alarm" : ""}`, style: bannerLevel ? `border-color:${LEVEL_COLOR[bannerLevel]}` : null },
        bannerLevel ? badge(bannerLevel, "") : null,
        h("div", null, h("div", { class: `big${plan ? "" : " dim"}` }, headline), h("div", { class: "context" }, context))),
      plan && plan.advice ? decisionBox(plan.advice) : null,
      h("div", { class: "cols" },
        h("div", { class: "box" }, h("h2", null, "Exit points: actual flow against the hourly nomination"),
          bank(exits.map(exitIndicator), "No exit-point readings in this dataset.")),
        nominationsBox(exits),
        h("div", { class: "box" }, h("h2", null, "Active alarms"), alarmSummary(), alarmList(live.conditions.slice(0, 12))),
        qualityBox(),
        h("div", { class: "box" }, h("h2", null, "Pressures at plants, hubs and terminals"),
          bank(pressures.slice(0, 10).map(pressureIndicator), "No pressure readings in this dataset.")),
        h("div", { class: "box" }, h("h2", null, "Busiest pipelines"), bank(loaded.map(loadIndicator), "No flow readings yet.")),
        pigsBox(),
        h("div", { class: "box" }, h("h2", null, "Units"), h("div", { class: "units" }, units))))));
  }

  /* The next 6 hours of nominations at each exit point (Ray, 29 Oct: "origo integration
     for hourly nominations from the shippers at each exitpoint, this should be shown in
     both absolute numbers but in a visual minimalistic way. what is important are rate
     of change at each exit point for the next 6 hours"). Per exit: the nomination now
     and in six hours, the hourly steps as a hairline, and the steepest hourly change
     ahead with when it starts; a fast ramp is marked (nora.toml [thresholds] step, as
     a share of the nomination now). */
  function rampAhead(id) {
    if (whatifOn()) return null; // the what-if is one steady hour
    const hours = nominationWindow(id);
    if (hours[0].value == null) return null;
    let steepest = null;
    for (let k = 1; k < hours.length; k++) {
      if (hours[k].value == null || hours[k - 1].value == null) continue;
      const change = hours[k].value - hours[k - 1].value;
      if (!steepest || Math.abs(change) > Math.abs(steepest.change)) steepest = { change, t: hours[k].t };
    }
    const values = hours.map((r) => r.value).filter((v) => v != null);
    const share = steepest ? Math.abs(steepest.change) / Math.max(1, hours[0].value) : 0;
    return { hours, now: hours[0].value, last: values[values.length - 1], steepest, level: level(share, T.step) };
  }
  /* Lookahead (Ray, 29 Oct: "it should be easy to see if a nomination increase at an exit
     point in the future and we dont increase the input flow into that pipeline, we wont be
     able to reach the nomination level because the exit point pressure will be too low.
     seeing this into the future as a lookahead function should be ongoing calculations being
     done and shown / illustrated in a suble and minimalstic way"). Worked out at every step
     for each exit and its next hours: with the gas into its line(s) held at now's rate,
     each hour the exit is nominated more than that draws on the line pack, and the line's
     pressure falls by the gas drawn over the line's pack per bar (its volume). An hour the
     exit's pressure would fall under its low limit (nora.toml [pressure_limits]) is short:
     marked in place, a model estimate. */
  const packPerBar = (pid) => (lineVolume[pid] / PACK.pStd) * (PACK.tStd / PACK.tSea) / PACK.z / 1e6; // MSm³ per bar
  function reachAhead(id) {
    return cached("reach", id, () => {
      const ramp = rampAhead(id), f = frame(), d = assets[id], limits = (C.pressure_limits || {})[d.type];
      const pNow = metric("pressure_bar", id, f);
      if (!ramp || !limits || pNow == null || pNow < limits[1]) return null; // already under it: that is an alarm now
      const lines = pipeIds.filter((pid) => { const v = f.flows[pid] || 0; return lineVolume[pid] && ((assets[pid].to === id && v > 0.05) || (assets[pid].from === id && v < -0.05)); });
      if (!lines.length) return null;
      const input = lines.reduce((sum, pid) => sum + Math.abs(f.flows[pid]), 0), perBar = lines.reduce((sum, pid) => sum + packPerBar(pid), 0);
      const low = limits[1];
      let drawn = 0; // MSm³ out of the line(s) more than into them
      const hours = ramp.hours.map((hour, k) => {
        if (k === 0) return { ...hour, pressure: pNow, short: false };
        if (hour.value == null) return { ...hour, pressure: null, short: false };
        drawn += Math.max(0, hour.value - input) * ((hour.t - ramp.hours[k - 1].t) / 86400);
        const pressure = pNow - drawn / perBar;
        return { ...hour, pressure, short: pressure < low };
      });
      return { hours, low, input, first: hours.find((hour) => hour.short) || null };
    });
  }
  function nominationSteps(hours, reach = null) {
    const values = hours.map((r) => r.value), known = values.filter((v) => v != null);
    const lo = Math.min(...known), hi = Math.max(...known), span = hi - lo || 1;
    const y = (v) => (18 - ((v - lo) / span) * 14).toFixed(1);
    let path = "";
    values.forEach((v, k) => {
      if (v == null) return;
      path += `${path ? "L" : "M"}${k * 18},${y(v)}H${(k + 1) * 18}`;
    });
    // An hour the exit's pressure would be short (reachAhead): its step in the warning colour.
    const short = (reach ? reach.hours : []).map((hour, k) => (hour.short && values[k] != null
      ? `<path d="M${k * 18},${y(values[k])}H${(k + 1) * 18}" fill="none" stroke="${limitInk(1)}" stroke-width="2.2"/>` : "")).join("");
    return svg("0 0 108 22", `<path d="${path}" fill="none" stroke="${COLORS.text}" stroke-width="1.2"/>${short}`, "steps"); // numbers and palette colours only
  }
  function nominationsBox(exits) {
    const rows = exits.map((id) => ({ id, ramp: rampAhead(id), reach: reachAhead(id) })).filter((r) => r.ramp)
      .sort((a, b) => b.ramp.level - a.ramp.level || Math.abs((b.ramp.steepest || {}).change || 0) - Math.abs((a.ramp.steepest || {}).change || 0));
    const hm = (t) => timeFormat(t, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" });
    // Honest labels: a dataset's nominations are not Origo's, and synthetic ones say so.
    const source = live.feed ? "From Origo, the shippers' nominations." : live.stream && live.stream.synthetic ? "Synthetic, from the dataset." : "From the dataset.";
    return h("div", { class: "box" }, h("h2", null, "Nominations at the exit points, next 6 hours"),
      rows.length ? h("ul", { class: "noms" }, rows.map(({ id, ramp, reach }) => {
        const s = ramp.steepest, steady = !s || Math.abs(s.change) < 0.05;
        // A button, so the keyboard reaches every row (as everything on this screen)
        return h("li", null, h("button", { type: "button", class: "nom-row", onclick: () => go({ screen: "asset", asset: id }), title: "Hourly nominations, now and the next 5 hours (MSm³/d)" },
          h("span", { class: "name" }, nameOf(id)),
          h("span", { class: "values" }, `${fmt(ramp.now, 1)} → ${fmt(ramp.last, 1)}`),
          nominationSteps(ramp.hours, reach),
          h("span", { class: "ramp" }, steady ? h("span", { class: "dim" }, "steady")
            : `${s.change > 0 ? "▲" : "▼"} ${fmt(Math.abs(s.change), 1)}/h at ${hm(s.t)}`),
          reach && reach.first
            ? h("span", { class: "short", style: `color:${limitInk(1)}`, title: `Model estimate: with the input as now, ${nameOf(id)} would be at ${fmt(reach.first.pressure, 1)} bar at ${hm(reach.first.t)}, under its ${fmt(reach.low)} bar low limit: raise the input to the line before then.` }, `short ${hm(reach.first.t)}`)
            : ramp.level ? badge(ramp.level, "Fast ramp") : h("span", null)));
      })) : h("p", { class: "empty" }, "No nominations in this dataset."),
      h("p", { class: "dim small" }, `${source} MSm³/d; Norwegian time.`)); // Europe/Oslo: CET, CEST in summer
  }

  /* The next 6 hours at an exit: for each hour the booked capacity (outlined) and the
     nomination (filled) side by side (Ray, 29 Oct: "two bars next to eachother for each
     hour, booking level and nomination level"). A nomination over its booking takes a
     muted yellow, and from the booking's critical level (nora.toml booking) a muted red
     ("not strong color"); the hour's nomination is written over its pair. */
  const muted = (lvl) => mix(LEVEL_COLOR[lvl], COLORS.surface, 0.35);
  function bookingLevel(nominated, booked) {
    if (nominated == null || !(booked > 0) || nominated <= booked) return 0;
    return nominated / booked >= T.booking[2] ? 3 : 1;
  }
  /* The gas day at an exit, cumulative: the nominated gas as a dashed line to the end of
     the day (its end-of-day target; later hours from the data's nominations, else the last
     one held), the delivered gas solid up to now (Ray, 29 Oct: "the end of day target to
     exit points changes over time and this need to be illustrated as well"). */
  function gasDayChart(id) {
    const day = dayDelivery(id);
    if (!day || !day.hours.length) return null;
    const step = stepHours(), per = step / 24; // MSm³ per data step at a rate in MSm³/d
    const n = Math.round(24 / step), past = day.hours.length;
    const noms = day.hours.map((r) => r.nominated);
    for (let k = 1; noms.length < n; k++) {
      const f = live.frames[live.index + k], ahead = live.feed ? (((frame().ahead || {}).nomination_msm3d || {})[id] || [])[k - 1] : null;
      const v = f ? metric("nomination_msm3d", id, f) : ahead;
      noms.push(v ?? noms[noms.length - 1]);
    }
    const cum = (values) => values.reduce((out, v) => [...out, (out.length ? out[out.length - 1] : 0) + v * per], []);
    const nominated = cum(noms), delivered = cum(day.hours.map((r) => r.delivered));
    const target = nominated[n - 1], top = Math.max(target, ...delivered) * 1.06 || 1;
    const W = 360, H = 104, plot = 76, x = (k) => ((k + 1) / n) * (W - 4) + 2, y = (v) => 8 + plot - (v / top) * plot;
    const text = "stroke:none;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif";
    const path = (values) => values.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join("");
    let body = `<line x1="0" y1="${8 + plot}" x2="${W}" y2="${8 + plot}" stroke="${COLORS.border}"/>`;
    body += `<path class="gasday-nominated" d="M2,${8 + plot}L${path(nominated).slice(1)}" fill="none" stroke="${COLORS.peak}" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    body += `<path class="gasday-delivered" d="M2,${8 + plot}L${path(delivered).slice(1)}" fill="none" stroke="${COLORS.text}" stroke-width="1.8"/>`;
    body += `<line x1="${x(past - 1)}" y1="6" x2="${x(past - 1)}" y2="${8 + plot}" stroke="${COLORS.text_dim}" stroke-width="1"/>`;
    body += `<text x="${W}" y="${Math.max(11, y(target) - 4)}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">Target ${esc(fmt(target, 1))}</text>`;
    const start = String(new Date(day.dayStart * 1000).getUTCHours()).padStart(2, "0");
    body += `<text x="2" y="${H - 4}" fill="${COLORS.text_dim}" style="${text}">${start}:00</text><text x="${W}" y="${H - 4}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${start}:00</text>`;
    body += `<text x="${x(past - 1)}" y="${H - 4}" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">now ${esc(fmt(delivered[past - 1], 1))} of ${esc(fmt(nominated[past - 1], 1))}</text>`;
    return svg(`0 0 ${W} ${H}`, body, "gasday-chart");
  }
  function nominationHistogram(id) {
    const readings = nominationWindow(id);
    if (!readings.some((reading) => reading.value != null)) return null;
    const W = 360, H = 130, baseline = 88, slot = W / 6, bar = 15;
    const peak = Math.max(1, ...readings.flatMap((reading) => [reading.value || 0, reading.booked || 0]));
    const text = "stroke:none;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif";
    let body = `<line x1="0" y1="${baseline}" x2="${W}" y2="${baseline}" stroke="${COLORS.border}" stroke-width="1"/>`;
    readings.forEach((reading, index) => {
      const center = slot * (index + 0.5), hour = String(new Date(reading.t * 1000).getUTCHours()).padStart(2, "0");
      const tall = (v) => Math.max(1, (v / peak) * 56);
      if (reading.booked != null) {
        const height = tall(reading.booked);
        body += `<rect class="booking-bar" x="${center - bar - 1}" y="${baseline - height + 0.5}" width="${bar}" height="${height - 0.5}" rx="2" fill="${COLORS.active}" stroke="${COLORS.text_dim}" stroke-width="1"/>`;
      }
      if (reading.value != null) {
        const height = tall(reading.value), y = baseline - height, lvl = bookingLevel(reading.value, reading.booked);
        const fill = lvl ? muted(lvl) : COLORS.peak; // a calm grey-blue, apart from the light booking
        body += `<rect class="nomination-bar${lvl ? " over" : ""}" x="${center + 1}" y="${y}" width="${bar}" height="${height}" rx="2" fill="${fill}" opacity="${index === 0 || lvl ? 1 : 0.72}"/>`;
        const top = Math.min(y, reading.booked != null ? baseline - tall(reading.booked) : y);
        body += `<text x="${center}" y="${Math.max(11, top - 4)}" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(reading.value, reading.value < 10 ? 1 : 0))}</text>`;
      }
      body += `<text x="${center}" y="106" text-anchor="middle" fill="${COLORS.text_dim}" style="${text}">${hour}</text>`;
    });
    // A key: booked outlined, nominated filled.
    body += `<rect x="0.5" y="117" width="10" height="9" rx="1.5" fill="${COLORS.active}" stroke="${COLORS.text_dim}"/><text x="14" y="125" fill="${COLORS.text_dim}" style="${text}">Booked</text>`;
    body += `<rect x="64" y="117" width="10" height="9" rx="1.5" fill="${COLORS.peak}"/><text x="78" y="125" fill="${COLORS.text_dim}" style="${text}">Nominated</text>`;
    body += `<rect x="146" y="117" width="10" height="9" rx="1.5" fill="${muted(1)}"/><text x="160" y="125" fill="${COLORS.text_dim}" style="${text}">over booking</text>`;
    return svg(`0 0 ${W} ${H}`, body, "nomination-histogram");
  }

  /* An asset in the what-if: your values (temporary: Reset clears them) and what follows
     from them, now → what-if (Ray, 29 Oct: "when clicking on a node i should be able to
     add my own flow and pressure values that are temporary"). */
  function whatifCard(id, compact = false) {
    const d = assets[id], w = whatifState(), f = frame(), next = whatif.scenario === "next";
    const row = (label, value) => [h("dt", null, label), h("dd", null, value)];
    const turn = (a, b, unit, digits = 1) => (a == null && b == null ? "–" : `${a == null ? "–" : fmt(a, digits)} → ${b == null ? "–" : fmt(b, digits)} ${unit}`);
    const input = (kind, label, placeholder, unit) => {
      const yours = whatif[kind][id] != null;
      const el = h("input", { type: "number", step: "0.1", inputmode: "decimal", class: yours ? "yours" : "", "data-key": `whatif:${kind}:${id}`, "aria-label": `${label} (${unit})`, placeholder });
      if (yours) el.value = String(whatif[kind][id]);
      el.addEventListener("change", () => setWhatif(kind, id, el.value.trim() === "" ? null : Number(el.value)));
      return h("label", null, `${label}, ${unit}`, el);
    };
    const offline = h("button", { type: "button", "data-key": `whatif:offline:${id}`, onclick: () => toggleOffline(id) },
      whatif.offline.has(id) ? "Bring back" : "Take offline");
    const inputs = [], facts = [];
    if (d.kind === "node") {
      const through = throughput(id, w.frame.flows), pNow = metric("pressure_bar", id, f), pThen = w.pressure[id];
      if (d.supply && !next) inputs.push(input("supply", "Production", fmt(productionNow(id, f), 1), "MSm³/d"));
      if (d.exit && next) inputs.push(input("offtake", "Offtake", w.nominations[id] == null ? "" : fmt(w.nominations[id], 1), "MSm³/d"));
      if (pNow != null) inputs.push(input("pressure", "Pressure", fmt(pNow, 1), "bar"));
      facts.push(row("Flow", turn(throughput(id, f.flows), through, "MSm³/d")));
      if (d.supply && next) facts.push(row("Production needed", `${fmt(w.supply[id] || 0, 1)} MSm³/d${d.capacity && (w.supply[id] || 0) > d.capacity ? `, over its ${fmt(d.capacity)}` : ""}`));
      if (d.exit) facts.push(row("Delivered", `${fmt(w.delivered[id] || 0, 1)} of ${w.nominations[id] == null ? "–" : fmt(w.nominations[id], 1)} nominated`));
      if (pNow != null || pThen != null) {
        const mark = pThen != null ? pressureMark(id, pThen) : null;
        facts.push(row("Pressure", h("span", mark ? { style: `color:${mark.ink}` } : null, `${turn(pNow, pThen, "bar")}${mark ? ` (${mark.code})` : ""}`)));
      }
      if (w.stranded[id]) facts.push(row("Nowhere to go", `${fmt(w.stranded[id], 1)} MSm³/d`));
    } else {
      const l = w.lines[id], m = MODELS[id], pack = w.pack[id], end = (node) => [w.pressureNow[node], w.pressure[node]];
      inputs.push(input("pack", "Packing", "0", "MSm³/d"));
      facts.push(row("Flow", l ? (Math.abs(l.into - l.out) >= 0.05 ? `${fmt(l.into, 1)} in, ${fmt(l.out, 1)} out MSm³/d` : `${fmt(l.into, 1)} MSm³/d`) : "none"));
      if (d.capacity && l) facts.push(row("Load", `${fmt((Math.max(l.into, l.out) / d.capacity) * 100)} % of ${fmt(d.capacity)}`));
      facts.push(row(`Pressure at ${nameOf(d.from)}`, turn(...end(d.from), "bar")));
      facts.push(row(`Pressure at ${nameOf(d.to)}`, turn(...end(d.to), "bar")));
      if (pack) facts.push(row("Line pack", `${turn(pack.now, pack.then, "MSm³", 2)}${pack.now != null && pack.then != null ? ` (${signed(pack.then - pack.now, 2)})` : ""}`));
      if (w.short[id]) facts.push(row("Packing", "more than it takes in: it delivers nothing"));
      facts.push(row("Regression", m ? `p₁² − p₂² = c (${fmt(m.a, 3)} Q² + ${fmt(m.b, 3)} Q), c ${fmt(w.correction[id] ?? m.correction, 2)} from ${w.from[id] || "the file"}` : "none: its pressure passes through"));
    }
    return h("div", { class: `box whatif-card${compact ? " compact" : ""}` }, h("h2", null, compact ? nameOf(id) : next ? "What-if: next gas day" : "What-if"),
      inputs.length ? h("div", { class: "whatif-inputs" }, ...inputs) : null,
      h("dl", { class: "facts" }, ...facts.flat()),
      h("div", { class: "actions" }, offline),
      compact ? null : h("p", { class: "dim small" }, "Model estimate, steady state: flows in today's directions and shares; pressures from each line's regression, corrected to today's pressures, with exits and gas plants holding theirs. Your values are temporary: Reset clears them."));
  }
  /* A field's export gas as its GC reads it (Ray, 29 Oct: "when i for instance click on a
     field like Oseberg i need to see the GC (gass chromotograph) values in a table like C1
     Metan, C2 Etan, C3 Propan etc all the way to C6+ and then CO2, N2, how rich the gas is
     ..., wobbe index, H2S, O2, WDP and HCDP"). How rich the gas is (its gross calorific
     value), the Wobbe index and the relative density are worked out from the composition
     (ISO 6976, ideal gas, 15 °C / 15 °C); the rest are readings. A value past its sales-gas
     limit takes the limit colour on its number. */
  const GC = [ // key, symbol, name, molar mass (g/mol), gross calorific value (MJ/m³)
    ["c1", "C1", "Methane", 16.043, 37.706], ["c2", "C2", "Ethane", 30.069, 66.07], ["c3", "C3", "Propane", 44.097, 93.94],
    ["ic4", "iC4", "i-Butane", 58.123, 121.4], ["nc4", "nC4", "n-Butane", 58.123, 121.79], ["ic5", "iC5", "i-Pentane", 72.15, 149.36],
    ["nc5", "nC5", "n-Pentane", 72.15, 149.66], ["c6plus", "C6+", "Hexanes and heavier", 86.177, 177.55],
    ["co2", "CO₂", "Carbon dioxide", 44.01, 0], ["n2", "N₂", "Nitrogen", 28.014, 0],
  ];
  // Sales-gas limits for the colour: typical of North Sea export specifications, illustrative.
  const GC_LIMITS = { wobbe: [47.2, 51.41], hcdp: [null, -2], wdp: [null, -8], o2: [null, 10] };
  function gasQuality(id, f = frame()) {
    const mol = Object.fromEntries(GC.map(([k]) => [k, metric(`${k}_molpct`, id, f)]));
    if (mol.c1 == null) return null;
    let gcv = 0, molar = 0;
    for (const [k, , , m, hv] of GC) { const x = (mol[k] || 0) / 100; gcv += x * hv; molar += x * m; }
    const density = molar / 28.9626;
    return { mol, gcv, density, wobbe: gcv / Math.sqrt(density), h2s: metric("h2s_ppm", id, f), o2: metric("o2_ppm", id, f), wdp: metric("wdp_c", id, f), hcdp: metric("hcdp_c", id, f) };
  }
  function gcBox(id) {
    const q = gasQuality(id);
    if (!q) return null;
    /* Past its limit: the colour with a shape and a word, never colour alone (AGENTS.md).
       The Wobbe index is a sales-gas limit, met where the gas is delivered after the
       plants take out the heavier parts: a field's rich gas is above it in normal running
       (11 of 24 fields lit up), so it is shown against the range, not coloured. */
    const past = (v, [lo, hi] = []) => (v == null ? 0 : lo != null && v < lo ? -1 : hi != null && v > hi ? 1 : 0);
    const cell = (v, digits, limits) => {
      const side = past(v, limits), text = v == null ? "–" : fmt(v, digits);
      return side ? h("td", { style: `color:${limitInk(1)};font-weight:600`, title: side > 0 ? "Over the limit" : "Under the limit" }, `${side > 0 ? "▲" : "▼"} ${text}`)
        : h("td", null, text);
    };
    const h2sLimit = C.quality.h2s_ppm[2];
    return h("div", { class: "box gc" }, h("h2", { title: "The field's export gas, as its gas chromatograph reads it" }, "Gas composition (GC)"),
      h("table", { class: "data gc-table" },
        h("thead", null, h("tr", null, h("th", null, "Component"), h("th", null, "mol %"))),
        h("tbody", null, ...GC.map(([k, symbol, name]) => h("tr", null, h("td", null, `${symbol} ${name}`), cell(q.mol[k], k === "c1" ? 2 : 3))))),
      h("table", { class: "data gc-table" },
        h("thead", null, h("tr", null, h("th", null, "Property"), h("th", null, "Value"), h("th", null, "Limit"))),
        h("tbody", null,
          h("tr", null, h("td", null, "Calorific value (GCV), MJ/Sm³"), cell(q.gcv, 2), h("td", { class: "dim" }, "")),
          h("tr", null, h("td", null, "Wobbe index, MJ/Sm³"), cell(q.wobbe, 2), h("td", { class: "dim", title: "Sales gas, where it is delivered" }, `${GC_LIMITS.wobbe[0]}–${GC_LIMITS.wobbe[1]} sold`)),
          h("tr", null, h("td", null, "Relative density"), cell(q.density, 3), h("td", { class: "dim" }, "")),
          h("tr", null, h("td", null, "H₂S, ppm"), cell(q.h2s, 1, [null, h2sLimit]), h("td", { class: "dim" }, `≤ ${h2sLimit}`)),
          h("tr", null, h("td", null, "O₂, ppm"), cell(q.o2, 1, GC_LIMITS.o2), h("td", { class: "dim" }, `≤ ${GC_LIMITS.o2[1]}`)),
          h("tr", null, h("td", null, "Water dew point (WDP), °C"), cell(q.wdp, 1, GC_LIMITS.wdp), h("td", { class: "dim" }, `≤ ${GC_LIMITS.wdp[1]}`)),
          h("tr", null, h("td", null, "Hydrocarbon dew point (HCDP), °C"), cell(q.hcdp, 1, GC_LIMITS.hcdp), h("td", { class: "dim" }, `≤ ${GC_LIMITS.hcdp[1]}`)))),
      h("p", { class: "dim small" }, `${live.stream && live.stream.synthetic ? "Synthetic readings. " : ""}Calorific value, Wobbe index and density worked out from the composition (ISO 6976, ideal gas, 15 °C); limits typical of export gas, illustrative.`));
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
      inSidebar && whatifOn() ? whatifCard(id) : null,
      inSidebar ? null : h("h1", null, d.name),
      inSidebar ? null : h("p", { class: "sub" }, d.kind === "node"
        ? `${NORA.nodeTypes[d.type]}, ${d.country}. Unit: ${(unitById[unitOf[id]] || {}).name || "none"}.`
        : `${NORA.pipelineTypes[d.type]}, ${nameOf(d.from)} to ${nameOf(d.to)}.`),
      h("div", { class: "cols" },
        inSidebar ? null : pidBox(id), // a field's Level 3 leads with its process (Ray, 30 Oct)
        isBlendingStation(id) ? blendingBox(id, inSidebar) : null,
        h("div", { class: "box" }, h("h2", { title: "Flowing in above the asset, out below it" }, "In context"), schematic(id)),
        h("div", { class: "box" }, h("h2", { title: "Live readings in their ranges, from the data being played" }, "Values"),
          metric("air_temp_c", id) != null ? h("p", { class: "outside" }, `Outside ${fmt(metric("air_temp_c", id), 1)} °C`) : null,
          bank(indicators, "No live readings for this asset in the dataset.", { byMeasure: true }),
          exitPoints.includes(id) && dayDelivery(id) ? h("div", { class: "nomination-outlook" }, h("h2", { style: "margin-top:14px" }, "Gas day · MSm³ delivered against nominated"), gasDayChart(id)) : null,
          exitPoints.includes(id) ? h("div", { class: "nomination-outlook" }, h("h2", { style: "margin-top:14px" }, "Next 6 hours · MSm³/d"), nominationHistogram(id)) : null,
          inSidebar ? null : h("h2", { style: "margin-top:14px" }, "State"),
          conds.length ? alarmList(conds)
            : h("p", { class: "state-quiet" }, "Normal · no alarms right now"),
          conds.length ? (() => { const cause = upstreamCause(id); return h("p", { class: "cause" }, h("strong", null, "Likely cause: "), cause.text, h("span", { class: "dim" }, ` (confidence ${cause.confidence}; traced through the network model)`)); })() : null),
        gcBox(id),
        h("div", { class: "box" }, h("h2", null, "Facts"), facts(id))),
      h("div", { class: "actions" },
        d.kind === "node" ? h("button", { type: "button", class: "text", "data-key": "action:whatif", onclick: () => {
          state.mode = "whatif";
          markTabs();
          toggleOffline(id);
          if (side.id === id) renderSidebar(); else renderAsset();
        } }, `${whatif.offline.has(id) ? "Restore" : "Take offline"} in the what-if`) : null,
        inSidebar ? h("button", { type: "button", class: "text", "data-key": "action:page", onclick: () => go({ screen: "asset", asset: id }) }, "Open the full page") : null,
        !inSidebar ? h("button", { type: "button", class: "text", "data-key": "action:unit", onclick: () => go({ screen: "unit", unit: unitOf[id] || "all", focus: id }) }, "Show in its unit") : null,
        inSidebar && d.type === "field" ? h("button", { type: "button", class: "text", "data-key": "action:pid", title: "The field's process as a P&ID, on its page",
          onclick: () => go({ screen: "asset", asset: id }) }, "P&ID") : null,
        h("button", { type: "button", class: "text", "data-key": "action:diag", onclick: () => go({ screen: "diag", asset: id }) }, "Diagnostics")));
  }
  function renderAsset() {
    const detail = assetDetail(route.asset);
    if (detail) keepFocus(screens.asset, () => patch(screens.asset, detail));
  }

  /* The asset sidebar: a calm column that slides in from the right when a field,
     plant or line is clicked on the unit screen, and follows the data as it plays. */
  const side = { id: null, marker: null, form: false, editing: null }; // form: the editor's; editing: the asset it changes
  function openSidebar(id) {
    if (!assets[id]) return;
    side.id = id;
    side.marker = null;
    renderSidebar();
    $("asset-side").classList.add("open");
    $("asset-side").setAttribute("aria-hidden", "false");
  }
  // A pig or a peak: the sidebar follows it as the data plays (`key` from markers()).
  function openMarker(key) {
    if (!key) return;
    side.id = null;
    side.marker = key;
    renderSidebar();
    $("asset-side").classList.add("open");
    $("asset-side").setAttribute("aria-hidden", "false");
  }
  function closeSidebar() {
    side.id = null;
    side.marker = null;
    side.form = false;
    side.editing = null;
    $("asset-side").classList.remove("open");
    $("asset-side").setAttribute("aria-hidden", "true");
  }
  // A primary press anywhere outside dismisses the panel. Listening on pointerdown
  // means selecting another background asset closes the old panel before the new one
  // opens; interaction inside the panel itself never bubbles into a dismissal.
  document.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (!side.id && !side.marker)) return;
    if (event.target.closest("#asset-side")) return;
    closeSidebar();
  });
  function renderSidebar(force = false) {
    // While you type a what-if value, the data's steps leave the panel alone.
    const typing = document.activeElement && document.activeElement.tagName === "INPUT" && $("asset-side").contains && $("asset-side").contains(document.activeElement);
    if (typing && !force) return;
    if (side.marker) {
      const body = $("side-body"), top = body.scrollTop, detail = markerDetail(side.marker);
      $("side-title").textContent = detail.title;
      $("side-sub").textContent = detail.sub;
      keepFocus(body, () => patch(body, detail.body));
      body.scrollTop = top;
      return;
    }
    if (!side.id || !assets[side.id]) return;
    const d = assets[side.id], body = $("side-body"), top = body.scrollTop;
    $("side-title").textContent = d.name;
    $("side-sub").textContent = d.kind === "node"
      ? `${NORA.nodeTypes[d.type]} · ${d.operator || d.country}`
      : `${NORA.pipelineTypes[d.type]} · ${nameOf(d.from)} to ${nameOf(d.to)}`;
    keepFocus(body, () => patch(body, assetDetail(side.id, true)));
    body.scrollTop = top;
  }
  /* A pig or a peak in the sidebar (Ray, 28 Oct: "head ETA and tail ETA as well as
     total volume of the peak as the origin of the peak (where was it first
     generated)"). Every time is an estimate from the model's gas speed and the flows
     of the data, and says so. */
  function markerDetail(key) {
    const m = markers().find((k) => k.key === key && !k.noDot) || markers().find((k) => k.key === key);
    const row = (label, ...value) => [h("dt", null, label), h("dd", null, ...value)];
    const box = (title, ...rows) => h("div", { class: "box" }, h("h2", null, title), h("dl", { class: "facts" }, ...rows.flat()));
    const note = (text) => h("p", { class: "dim small" }, text);
    const at = (node, t) => (t == null ? nameOf(node) : `${nameOf(node)}, ${etaText(t)}`);
    const v = C.pipelines.gas_velocity_mps, step = (live.stream && live.stream.step) || 3600;
    const volume = (msm3) => `${fmt(msm3, msm3 < 1 ? 2 : 1)} MSm³`;
    if (!m) return { title: "Left the network", sub: "", body: h("div", { class: "side-detail" }, h("p", { class: "empty" }, "This pig or peak has left the network, or the data moved past it. Click another on the map or in the Flow.")) };
    if (m.kind === "pig") return pigDetail(m, { row, box });
    return qualityDetail(m, { row, box, note, volume });
  }
  /* An H₂S or CO₂ peak (Ray, 29 Oct: "volume (MSm3), Head KP, Tail KP, Sent (CET), ETA
     (CET), Duration, Max/Min value, Avg value, Notified (yes/no), Origo ref number (5
     digits), also Network, Location and peakID as well description. make it look nice
     and easy to understand"). Its head is the parcel that left the field first, its
     tail the last; a KP is the distance from the start of the line it is on. Notified
     and the Origo reference are the operator's: kept in this browser per peak. */
  const cet = (t) => timeFormat(t, { timeZone: "Europe/Oslo", weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  function kpOf(q, time = live.time) {
    if (!q) return null;
    const km = assets[q.pid].km || 0;
    if (q.arrived) return { pid: q.pid, km: q.forward ? km : 0 };
    const gone = Math.min(km, Math.max(0, ((time - q.t0) * C.pipelines.gas_velocity_mps) / 1000));
    return { pid: q.pid, km: q.forward ? gone : km - gone };
  }
  function peakId(slug) {
    const gas = slug.metric.split("_")[0].toUpperCase(), place = nameOf(slug.origin).replace(/[^A-Za-zÆØÅæøå]/g, "").slice(0, 3).toUpperCase();
    return `${gas}-${place}-${timeFormat(slug.first, { timeZone: "Europe/Oslo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(/[^0-9]/g, "")}`;
  }
  const PEAK_NOTES = "nora-peak-notes";
  function peakNotes() { try { return JSON.parse(localStorage.getItem(PEAK_NOTES) || "{}"); } catch (error) { return {}; } }
  function savePeakNote(slug, change) {
    const all = peakNotes();
    all[slug] = { ...(all[slug] || {}), ...change };
    try { localStorage.setItem(PEAK_NOTES, JSON.stringify(all)); } catch (error) { /* kept for this view only */ }
  }
  /* A pig set out like a peak (Ray, 29 Oct: "a pig needs the same kind of setup for
     information as a peak"): its ID, ETA and speed first, its run as Launched → now →
     ETA, a line in words; then what its receiving station has been told (Ray, 27 Oct:
     "ETA, tag number, if message has been sent to receiving station, last updated ETA
     sent to receiving station"), the pig, where it is and when. */
  const PIG_MESSAGE = { launch: "Launch notice", update: "ETA update", arrival: "Arrival confirmed" };
  function pigDetail(m, { row, box }) {
    const pig = m.ref, trip = pigTrip(pig, live.time), d = assets[m.id], st = pigStatus(pig, trip.r, live.time);
    const hm = (t) => timeFormat(t, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" });
    const dayHm = (t) => timeFormat(t, { timeZone: "Europe/Oslo", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const kp = (d.km || 0) * Math.max(0, Math.min(1, m.along));
    const stat = (label, value, sub) => h("div", { class: "stat" }, h("span", { class: "label" }, label), h("strong", null, value), sub ? h("span", { class: "sub" }, sub) : null);
    const origin = (assets[pig.pipeline] || {}).from, to = nameOf(trip.receiver), tag = pigTag(pig);
    const kind = pig.kind ? pig.kind[0].toUpperCase() + pig.kind.slice(1) : "Cleaning";
    const id = m.pigId != null ? String(m.pigId) : "–", hours = (trip.arrives - live.time) / 3600;
    const link = (asset) => (assets[asset] ? h("button", { type: "button", class: "link", "data-key": `pig-link:${asset}`,
      onclick: () => (route.screen === "unit" ? openSidebar(asset) : go({ screen: "asset", asset })) }, nameOf(asset)) : nameOf(asset));
    const drift = st.lastEta == null ? null : st.eta - st.lastEta;
    const driftText = drift == null ? "–" : Math.abs(drift) < 60 ? "as sent" : `${minutes(drift)} ${drift > 0 ? "later" : "earlier"} than sent`;
    const log = st.sent.slice().reverse().map((msg) => h("tr", null,
      h("td", null, dayHm(msg.t)),
      h("td", null, msg.reason === "drift" ? "ETA update, ETA moved" : PIG_MESSAGE[msg.kind]),
      h("td", null, hm(msg.eta))));
    return { title: m.pigId != null ? `Pig ${m.pigId}` : tag, sub: `${tag} · ${kind} pig · ${nameOf(origin)} to ${to}`,
      body: h("div", { class: "side-detail peak-detail" },
        h("div", { class: "peak-stats" },
          stat("Pig ID", id, pig.every ? `run ${trip.run + 1}` : ""),
          stat("ETA", hm(trip.arrives), `CET · in ${fmt(Math.max(0, hours), 1)} h`),
          stat("Speed", `${fmt(trip.speed, 1)} m/s`, `with the flow · set ${fmt(pig.speed, 1)}`)),
        h("ol", { class: "journey" },
          h("li", null, h("span", { class: "label" }, "Launched"), h("strong", null, nameOf(origin)), h("span", { class: "sub" }, cet(trip.start))),
          h("li", { class: "now" }, h("span", { class: "label" }, "Now"), h("strong", null, nameOf(m.id)), h("span", { class: "sub" }, `KP ${fmt(kp, 0)}`)),
          h("li", null, h("span", { class: "label" }, "ETA"), h("strong", null, to), h("span", { class: "sub" }, cet(trip.arrives)))),
        h("p", { class: "peak-description" }, `${kind} pig ${tag}, launched ${cet(trip.start)}, now on ${nameOf(m.id)} at KP ${fmt(kp, 0)}. ${trip.next !== trip.receiver ? `Next ${nameOf(trip.next)} ${cet(trip.nextAt)}; e` : "E"}xpected at ${to} ${cet(trip.arrives)}.`),
        box(`Messages to ${to} (synthetic, CET)`,
          row("Launch notice", st.launch ? `sent ${hm(st.launch.t)}` : "–"),
          row("Last ETA update", st.last ? `sent ${hm(st.last.t)} (ETA ${hm(st.last.eta)})` : "none yet"),
          row("ETA now", h("span", { class: "pig-drift" }, `${hm(st.eta)}, ${driftText}`, st.alarm.level ? badge(st.alarm.level, "") : null)),
          row("Next update", st.nextUpdate ? hm(st.nextUpdate.t) : "–"),
          row("Arrival confirmation", st.arrival ? `sent ${hm(st.arrival.t)}` : "pending"),
          log.length ? [h("dt", { class: "pig-log-head" }, "Sent"), h("dd", { class: "pig-log-cell" }, h("table", { class: "data pig-log" },
            h("thead", null, h("tr", null, ["Time", "Message", "ETA"].map((t) => h("th", null, t)))), h("tbody", null, log)))] : []),
        box("Pig",
          row("Tag", tag),
          row("Kind", kind),
          row("Pipeline", link(pig.pipeline)),
          row("Receiver", link(trip.receiver)),
          row("Launched", cet(trip.start))),
        box("Position",
          row("Location", nameOf(m.id)),
          row("KP", `${fmt(kp, 1)} of ${fmt(d.km || 0)} km`),
          row("Next stop", `${nameOf(trip.next)}, ${cet(trip.nextAt)}`),
          row("Network", unitOf[m.id] ? unitById[unitOf[m.id]].name : origin && unitOf[origin] ? unitById[unitOf[origin]].name : "–")),
        box("Timing (CET)",
          row("ETA", `${cet(trip.arrives)}, ${to}`),
          row("Run", `${fmt((trip.arrives - trip.start) / 3600, 1)} h`),
          pig.every ? row("Relaunched", `every ${fmt(pig.every / 3600)} h`) : [])) }; // no closing note (Ray, 29 Oct)
  }
  function qualityDetail(m, { row, box, volume }) {
    const slug = live.slugs.get(m.ref), parcels = live.quality.filter((q) => q.slug === m.ref), q0 = QUALITY[m.gas];
    const head = parcels.reduce((a, b) => (a && a.born <= b.born ? a : b), null), tail = parcels.reduce((a, b) => (a && a.born >= b.born ? a : b), null);
    const headGo = head ? project(head) : null, conc = (value) => (value == null ? "–" : `${fmt(value, q0.digits)} ${q0.unit}`);
    const values = parcels.map((q) => q.conc), limit = C.quality[m.gas][2];
    const max = values.length ? Math.max(...values) : null, min = values.length ? Math.min(...values) : null;
    const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    const headKp = kpOf(head), tailKp = kpOf(tail), step = (live.stream && live.stream.step) || 3600;
    const exit = headGo && headGo.exit, origin = slug ? slug.origin : null, notes = slug ? peakNotes()[slug.slug] || {} : {};
    const kp = (place) => (place ? `KP ${fmt(place.km, 1)} on ${nameOf(place.pid)}` : "–");
    const stat = (label, value, sub) => h("div", { class: "stat" }, h("span", { class: "label" }, label), h("strong", null, value), sub ? h("span", { class: "sub" }, sub) : null);
    // The route at a glance: sent from the field, where the peak is now, where and when it lands.
    const journey = h("ol", { class: "journey" },
      h("li", null, h("span", { class: "label" }, "Sent"), h("strong", null, origin ? nameOf(origin) : "–"), h("span", { class: "sub" }, slug ? cet(slug.first) : "")),
      h("li", { class: "now" }, h("span", { class: "label" }, "Head now"), h("strong", null, headKp ? nameOf(headKp.pid) : nameOf(m.id)), h("span", { class: "sub" }, headKp ? `KP ${fmt(headKp.km, 0)}` : "")),
      h("li", null, h("span", { class: "label" }, exit ? "ETA" : "Next"), h("strong", null, exit ? nameOf(exit.node) : headGo ? nameOf(headGo.next.node) : "–"),
        h("span", { class: "sub" }, exit ? cet(exit.t) : headGo ? cet(headGo.next.t) : "")));
    // Notified and the Origo reference: set by the operator, kept per peak in this browser.
    const notified = h("button", { type: "button", class: `toggle${notes.notified ? " on" : ""}`, "aria-pressed": String(Boolean(notes.notified)),
      onclick: () => { if (!slug) return; savePeakNote(slug.slug, { notified: !notes.notified }); renderSidebar(); } }, notes.notified ? "Yes" : "No");
    const origo = h("input", { class: "origo", inputmode: "numeric", maxlength: "5", placeholder: "5 digits", "aria-label": "Origo reference number" });
    origo.value = notes.origo || "";
    const origoNote = h("span", { class: "sub", role: "alert" });
    origo.addEventListener("change", () => {
      const value = origo.value.trim();
      if (value && !/^\d{5}$/.test(value)) { origoNote.textContent = "Five digits, such as 40217"; return; }
      origoNote.textContent = "";
      if (slug) savePeakNote(slug.slug, { origo: value });
    });
    const description = slug ? `${q0.name} from ${nameOf(origin)}, sent ${cet(slug.first)}, its head now on ${nameOf(headKp ? headKp.pid : m.id)}.`
      + (exit ? ` Expected at ${nameOf(exit.node)} ${cet(exit.t)} at about ${conc(exit.conc)}${exit.conc >= limit ? ", over the limit" : ""}.` : "") : "";
    return { title: `${q0.name} peak`, sub: slug ? `${peakId(slug)} · ${nameOf(origin)} to ${exit ? nameOf(exit.node) : "the network"}` : `on ${nameOf(m.id)}`,
      body: h("div", { class: "side-detail peak-detail" },
        h("div", { class: "peak-stats" },
          stat("Max", conc(max), `limit ${conc(limit)}`),
          stat("Volume", slug ? volume(slug.volume) : "–", "gas over the follow level"),
          stat("ETA", exit ? timeFormat(exit.t, { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }) : "–", exit ? `CET · ${nameOf(exit.node)}` : "")),
        journey,
        description ? h("p", { class: "peak-description" }, description) : null,
        slugProfile(m, parcels),
        box("Position",
          row("Location", headKp && tailKp && headKp.pid !== tailKp.pid ? `${nameOf(tailKp.pid)} to ${nameOf(headKp.pid)}` : nameOf(headKp ? headKp.pid : m.id)),
          row("Head", kp(headKp)),
          row("Tail", kp(tailKp)),
          row("Network", origin && unitOf[origin] ? unitById[unitOf[origin]].name : "–")),
        box("Timing (CET)",
          row("Sent", slug ? cet(slug.first) : "–"),
          row("ETA", exit ? `${cet(exit.t)}, ${nameOf(exit.node)}` : "–"),
          row("Duration", slug ? `${fmt((slug.last - slug.first + step) / 3600, 1)} h` : "–")),
        box(`${q0.name} along the peak`,
          row("Max", conc(max)), row("Min", conc(min)), row("Average", conc(avg)),
          row("At the origin", slug ? `${conc(slug.max)} at its strongest` : "–")),
        box("Handling",
          row("Peak ID", slug ? peakId(slug) : "–"),
          row("Notified", notified),
          row("Origo ref", h("span", { class: "origo-field" }, origo, origoNote)))) }; // no closing note (Ray, 29 Oct: "it doesnt add any value")
  }
  /* A peak's profile along its route (hub 3607; Ray, 27 Oct: "the profile of the H2S in
     the pipeline"): the concentration against the distance from the field. Solid: the
     slug's parcels where they are now. Dashed: what its strongest parcel is expected to
     become ahead, stepping down where other gas joins (mixAt). The warning and alarm
     limits as on every chart, and a tick at each node on the way. An estimate from the
     model's gas speed and today's flows. */
  function slugProfile(m, parcels) {
    const lead = parcels.reduce((a, b) => (a && a.conc >= b.conc ? a : b), null);
    if (!lead) return null;
    const q0 = QUALITY[m.gas], limits = C.quality[m.gas], v = C.pipelines.gas_velocity_mps, f = frame();
    const kmOf = (pid) => Math.max(1, assets[pid].km || 1);
    const endOf = (hop) => (hop.forward ? assets[hop.pid].to : assets[hop.pid].from);
    // How far a parcel has come from the field, in km along the lines it took.
    const travelled = (q) => {
      let d = 0;
      for (let k = 0; k < q.path.length - 1; k++) d += kmOf(q.path[k].pid);
      return d + (q.arrived ? kmOf(q.pid) : Math.min(kmOf(q.pid), Math.max(0, ((live.time - q.t0) * v) / 1000)));
    };
    const now = parcels.map((q) => [travelled(q), q.conc]).sort((a, b) => a[0] - b[0]);
    const ticks = [[0, lead.origin]];
    let x = 0;
    for (const hop of lead.path) { x += kmOf(hop.pid); ticks.push([x, endOf(hop)]); }
    const ahead = [[travelled(lead), lead.conc]];
    if (!lead.arrived) {
      let pid = lead.pid, node = endOf(lead), conc = lead.conc;
      for (let hops = 0; hops < 20; hops++) {
        const mixed = mixAt(node, pid, conc, lead.metric, f);
        ahead.push([x, conc], [x, mixed]);
        conc = mixed;
        const r = isExit(node) ? null : onward(node, f.flows);
        if (!r || r.pid === pid) break;
        pid = r.pid;
        node = r.forward ? assets[pid].to : assets[pid].from;
        x += kmOf(pid);
        ticks.push([x, node]);
      }
    }
    const W = 340, H = 168, left = 8, right = W - 8, top = 12, plot = 108, total = Math.max(1, x);
    const hi = Math.max(limits[2], ...now.map(([, c]) => c), ...ahead.map(([, c]) => c)) * 1.12;
    const X = (km) => left + (km / total) * (right - left), Y = (c) => top + plot - (c / hi) * plot;
    const line = (rows) => rows.map(([km, c], k) => `${k ? "L" : "M"}${X(km).toFixed(1)},${Y(c).toFixed(1)}`).join("");
    const text = `stroke:${COLORS.surface};stroke-width:3px;paint-order:stroke;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif`;
    let body = "";
    for (const [label, value, lvl] of [["Warning", limits[0], 1], ["Alarm", limits[2], 2]]) {
      body += `<line x1="${left}" x2="${right}" y1="${Y(value).toFixed(1)}" y2="${Y(value).toFixed(1)}" stroke="${limitInk(lvl)}" stroke-width="1" stroke-dasharray="2 3"/>`;
      body += `<text x="${right}" y="${(Y(value) - 3).toFixed(1)}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${label} ${esc(fmt(value, q0.digits))}</text>`;
    }
    // Node ticks; a name only where it has room (never text over text).
    let room = -Infinity;
    for (const [k, [km, node]] of ticks.entries()) {
      const px = X(km), last = k === ticks.length - 1;
      body += `<line x1="${px.toFixed(1)}" x2="${px.toFixed(1)}" y1="${top + plot}" y2="${top + plot + 4}" stroke="${COLORS.text_dim}" stroke-width="1"/>`;
      const name = nameOf(node), width = name.length * 5.6;
      const anchor = k === 0 ? "start" : last ? "end" : "middle", from = anchor === "start" ? px : anchor === "end" ? px - width : px - width / 2;
      if (from > room + 6 && (last || from + width < right - 60)) {
        body += `<text x="${px.toFixed(1)}" y="${top + plot + 16}" text-anchor="${anchor}" fill="${COLORS.text_dim}" style="${text}">${esc(name)}</text>`;
        room = from + width;
      }
    }
    body += `<line x1="${left}" x2="${right}" y1="${top + plot}" y2="${top + plot}" stroke="${COLORS.text_dim}" stroke-width="0.6"/>`;
    if (ahead.length > 1) body += `<path class="ahead" d="${line(ahead)}" fill="none" stroke="${COLORS[q0.color]}" stroke-width="1.4" stroke-dasharray="4 3"/>`;
    body += `<path class="now" d="${line(now.length > 1 ? now : [[now[0][0], 0], ...now])}" fill="none" stroke="${COLORS[q0.color]}" stroke-width="2"/>`;
    const [leadKm, leadConc] = ahead[0];
    body += `<circle cx="${X(leadKm).toFixed(1)}" cy="${Y(leadConc).toFixed(1)}" r="3" fill="${COLORS[q0.color]}" stroke="${COLORS.casing}" stroke-width="0.8"/>`;
    body += `<text x="${X(leadKm).toFixed(1)}" y="${(Y(leadConc) - 7).toFixed(1)}" text-anchor="${X(leadKm) > W / 2 ? "end" : "start"}" fill="${COLORS.text}" style="${text}">now ${esc(fmt(leadConc, q0.digits))} ${esc(q0.unit)}</text>`;
    body += `<text x="${right}" y="${H - 2}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(total, 0))} km</text>`;
    return h("div", { class: "box slug-profile" }, h("h2", null, `${q0.name} along the route`),
      svg(`0 0 ${W} ${H}`, body, "profile"),
      h("p", { class: "dim small" }, "Solid: the peak now. Dashed: expected ahead, diluted where other gas joins. An estimate from the gas speed and today's flows."));
  }
  // A pig's run: the next node, the receiver at the end of its route, and when.
  // A pig's run now: where it goes next, its receiver, the live ETA and its speed.
  function pigTrip(pig, time) {
    const r = pigRun(pig, pigRunIndex(pig, time)), place = pigPlace(pig, time);
    return {
      run: r.run, start: r.start, next: place ? place.next : r.receiver, nextAt: place ? place.exitAt : r.arrives,
      receiver: r.receiver, arrives: pigEta(pig, r, time), speed: place ? place.speed : pig.speed, r,
    };
  }
  function facts(id) {
    const d = assets[id];
    const lost = d.lost ? `${fmt(d.lost)} MSm³/d (${fmt(d.share * 100, 1)}%)` : "Nothing lost";
    const position = d.lat != null ? `${d.lat.toFixed(4)}°N, ${d.lon.toFixed(4)}°E` : null; // always N and E (Ray)
    const depth = d.lat != null ? depthAt(d.lon, d.lat) : null;
    const rows = d.kind === "node"
      ? [["Operator", d.operator], ["Capacity", d.capacity == null ? null : `${fmt(d.capacity)} MSm³/d`], ["If it trips", lost],
        ["Pressure window", C.pressure[d.type] ? `${C.pressure[d.type][0]}–${C.pressure[d.type][1]} bar` : null],
        ["Pressure limits", (C.pressure_limits || {})[d.type] ? (([ll, l, hi, hh, top]) => `low-low ${ll}, low ${l}, high ${hi}, high-high ${hh}, integrity ${top} bar`)(C.pressure_limits[d.type]) : null], ["Status", d.status],
        ["Position", h("a", { href: `https://www.google.com/maps?q=${d.lat},${d.lon}`, target: "_blank", rel: "noopener", title: "Open this exact location in Google Maps" }, position)],
        ["Water depth", depth != null ? `${fmt(depth)} m (EMODnet seabed model)` : null]]
      : [["Capacity", d.capacity == null ? "Not modelled" : `${fmt(d.capacity)} MSm³/d`], ["Length", `${fmt(d.km)} km`],
        ["Diameter", d.diameter == null ? null : `${fmt(d.diameter)} in`], ["In service since", d.commissioned], ["If it trips", lost], ["Status", d.status]];
    return h("dl", { class: "facts" }, rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  }
  /* Labels in the asset picture: regular weight and never outlined. Set inline, so no
     stylesheet rule (the global `svg` one strokes shapes) can smudge them into bold. */
  const TEXT = "stroke:none;font-weight:400;paint-order:normal";
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
    if (d.kind === "pipeline") {
      /* A pipeline: its two ends, the flow beside the line with an arrowhead for its
         direction, and the pigs and peaks in it now, each at its place with its value
         and ETA: what is in this line, at a glance. */
      const W = 420, H = 230, s = pipeStyle(id), x = W / 2, top = 52, bottom = H - 34;
      const v = f.flows[id], dir = v < 0 ? -1 : 1;
      let m = `<text x="${x}" y="40" text-anchor="middle" style="${TEXT}">${esc(nameOf(d.from))}</text><text x="${x}" y="${H - 14}" text-anchor="middle" style="${TEXT}">${esc(nameOf(d.to))}</text>`;
      m += `<line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${s.level ? COLORS.casing : "none"}" stroke-width="${s.width + 2.4}"/><line x1="${x}" y1="${top}" x2="${x}" y2="${bottom}" stroke="${s.level ? LEVEL_COLOR[s.level] : s.color}" stroke-width="${Math.max(1.2, s.width)}"/>`;
      if (v != null && Math.abs(v) >= 0.05) {
        const tip = dir > 0 ? bottom : top;
        m += `<path d="M${x - 5} ${tip - dir * 9}L${x} ${tip}L${x + 5} ${tip - dir * 9}" fill="none" stroke="${COLORS.text}" stroke-width="1.4" stroke-linejoin="round"/>`;
        m += `<text x="${x - 14}" y="${(top + bottom) / 2 + 4}" text-anchor="end" class="dimtext" style="${TEXT}">${esc(fmt(Math.abs(v), 1))} MSm³/d</text>`;
      }
      const lvl = levelOf(id);
      if (lvl) m += `<g transform="translate(${x - 30} ${(top + bottom) / 2 + 10})">${shapeMarkup(lvl)}</g>`;
      let below = -Infinity; // labels on the right, one row each
      for (const k of markers().filter((k) => k.id === id && !k.noDot).sort((a, b) => a.along - b.along)) {
        const y = top + Math.max(0, Math.min(1, k.along)) * (bottom - top);
        if (k.kind === "pig") m += `<path d="M${x - 4.5} ${y - dir * 4}L${x + 4.5} ${y - dir * 4}L${x} ${y + dir * 5}Z" fill="${COLORS.pig}" stroke="${COLORS.casing}" stroke-width="0.8"/>`;
        else m += `<circle cx="${x}" cy="${y}" r="4" fill="${k.kind === "quality" ? COLORS[QUALITY[k.gas].color] : COLORS.peak}" stroke="${COLORS.casing}" stroke-width="0.8"/>`;
        const what = k.kind === "pig" ? k.title || "Pig" : k.value;
        const ly = Math.max(y + 4, below + 15);
        below = ly;
        m += `<text x="${x + 14}" y="${ly}" style="${TEXT}">${esc(what.length > 30 ? `${what.slice(0, 29)}…` : what)}${k.eta ? `<tspan class="dimtext" dx="6">${esc(k.eta)}</tspan>` : ""}</text>`;
      }
      return svg(`0 0 ${W} ${H}`, m, "schematic");
    }
    /* A node: one row per line, gas in above the circle and gas out below it, so labels
       never meet however many lines there are. Names sit in a column on the left with
       the flow (MSm³/d) right-aligned beside them; each line fans from its row into the
       circle, and the node's name sits to the right of the circle, where no line runs. */
    const W = 420, ROW = 19, R = 22, CX = 300, END = 236, START = 246;
    const rows = [];
    let y = 4, m = "";
    const group = (list, title) => {
      if (!list.length) return;
      y += 14;
      m += `<text x="18" y="${y}" class="dimtext" style="${TEXT};font-size:10.5px">${title}</text>`;
      for (const pid of list) { y += ROW; rows.push({ pid, y }); }
    };
    group(inbound, "Gas in");
    const mid = y + R + 14;
    y = mid + R;
    group(outbound, "Gas out");
    const H = Math.max(mid + R, y) + 10;
    for (const { pid, y: ry } of rows) {
      const s = pipeStyle(pid), v = f.flows[pid];
      const color = s.level ? LEVEL_COLOR[s.level] : v == null || Math.abs(v) < 0.05 ? COLORS.inactive : COLORS.active;
      const ly = ry - 4; // the middle of the row's text
      if (s.level) m += `<line x1="${START}" y1="${ly}" x2="${CX}" y2="${mid}" stroke="${COLORS.casing}" stroke-width="${s.width + 2.4}"/>`;
      m += `<line x1="${START}" y1="${ly}" x2="${CX}" y2="${mid}" stroke="${color}" stroke-width="${Math.max(1.2, s.width)}"/>`;
      if (s.level) m += `<g transform="translate(${START - 10} ${ry - 12}) scale(0.9)">${shapeMarkup(s.level)}</g>`;
      const name = nameOf(pid);
      m += `<text x="18" y="${ry}" style="${TEXT}">${esc(name.length > 28 ? `${name.slice(0, 27)}…` : name)}</text>`;
      // A satellite's tie-back (map detail): its gas is in its host's figure, so no flow of its own.
      const tieBack = [assets[pid].from, assets[pid].to].some((n) => assets[n] && assets[n].min_zoom > 0);
      if (tieBack) m += `<text x="${END}" y="${ry}" text-anchor="end" class="dimtext" style="${TEXT}">tie-back</text>`;
      else if (v != null) m += `<text x="${END}" y="${ry}" text-anchor="end" class="dimtext" style="${TEXT}">${esc(fmt(Math.abs(v), 1))}</text>`;
    }
    // The node as a circle holding its flow, its pressure beside it (the Flow view draws squares).
    const st = nodeStyle(id), look = COLORS.card[st.inactive ? "inactive" : state.mode === "live" ? "active" : "normal"];
    const flow = throughput(id, f.flows), bar = metric("pressure_bar", id);
    m += `<circle cx="${CX}" cy="${mid}" r="${R}" fill="${look.fill}" stroke="${st.level ? LEVEL_COLOR[st.level] : look.edge}" stroke-width="${st.level ? 2.5 : 1}"/>`;
    if (flow != null) m += `<text x="${CX}" y="${mid + 4}" text-anchor="middle" fill="${look.ink}" style="${TEXT};font-weight:500">${esc(fmt(flow, flow < 10 ? 1 : 0))}</text>`;
    if (bar != null) m += `<text x="${CX + R + 8}" y="${mid + 20}" class="dimtext" style="${TEXT};font-size:11px">${esc(fmt(bar))} bar</text>`;
    const lvl = levelOf(id);
    if (lvl) m += `<g transform="translate(${CX + 12} ${mid - R - 10})">${shapeMarkup(lvl)}</g>`;
    m += `<text x="${CX + R + 8}" y="${mid + 4}" style="${TEXT};font-weight:500">${esc(d.name.length > 13 ? `${d.name.slice(0, 12)}…` : d.name)}</text>`;
    if (!rows.length) m += `<text x="${CX}" y="${mid + R + 18}" text-anchor="middle" class="dimtext" style="${TEXT}">No connected pipelines</text>`;
    return svg(`0 0 ${W} ${rows.length ? H : mid + R + 26}`, m, "schematic");
  }

  /* Level 4 trends (hub 3614): the exact history behind the values. One chart per
     reading the asset has, up to the playhead, with its limits (amber for a warning,
     red for an alarm, labelled at the right), outages shaded (planned ones dashed) and a
     crosshair with the exact numbers. 2 h / 12 h / 24 h / All, or drag across a chart to
     zoom; "Compare with" draws a second asset on the same axes; Export CSV writes the
     window shown. Inline SVG, no library. */
  const diagView = { asset: null, span: 0, from: null, to: null, cursor: null, compare: "", drag: null };
  const DIAG_SERIES = [
    { key: "flow", name: (d) => (d.kind === "pipeline" ? "Flow" : "Throughput"), unit: "MSm³/d", digits: 2 },
    { key: "pressure_bar", name: () => "Pressure", unit: "bar", digits: 1 },
    { key: "nomination_msm3d", name: () => "Nomination", unit: "MSm³/d", digits: 2 },
    { key: "booked_msm3d", name: () => "Booked", unit: "MSm³/d", digits: 2 },
    { key: "h2s_ppm", name: () => "H₂S", unit: "ppm", digits: 2 },
    { key: "co2_molpct", name: () => "CO₂", unit: "mol %", digits: 2 },
  ];
  function diagRead(series, id, f) {
    if (series.key !== "flow") return metric(series.key, id, f);
    const v = assets[id].kind === "pipeline" ? f.flows[id] : throughput(id, f.flows);
    return v == null ? null : v;
  }
  // Limits drawn on a chart: [label, value, level], level 1 a warning (amber), 2 or 3 an alarm (red).
  function diagLimits(series, id) {
    const d = assets[id];
    if (series.key === "pressure_bar") {
      const limits = (C.pressure_limits || {})[d.type];
      if (!limits) return [];
      const [ll, low, high, hh, top] = limits;
      return [["LL", ll, 2], ["L", low, 1], ["H", high, 1], ["HH", hh, 2], ["INT", top, 3]];
    }
    if (series.key === "flow" && d.kind === "pipeline" && d.capacity) return [["Capacity", d.capacity, 1], ["Over", d.capacity * T.load[2], 3]];
    if (C.quality && C.quality[series.key]) return [["Warning", C.quality[series.key][0], 1], ["Alarm", C.quality[series.key][2], 3]];
    return [];
  }
  // The frames shown: up to the playhead, within the chosen window.
  function diagFrames() {
    const upto = live.frames.slice(0, live.index + 1).filter(Boolean);
    if (!upto.length) return [];
    const end = diagView.to ?? upto[upto.length - 1].t;
    const start = diagView.from ?? (diagView.span ? end - diagView.span : upto[0].t);
    return upto.filter((f) => f.t >= start && f.t <= end);
  }
  function diagChart(series, id, other, frames) {
    // Drawn at the screen's own width, so the 11 px type stays 11 px.
    const W = Math.round(Math.max(320, Math.min(1600, (screens.diag.clientWidth || 720) - 96))), H = 132, left = 8, right = W - 8, top = 10, plot = 92;
    const mine = frames.map((f) => [f.t, diagRead(series, id, f)]).filter(([, v]) => v != null);
    const theirs = other ? frames.map((f) => [f.t, diagRead(series, other, f)]).filter(([, v]) => v != null) : [];
    if (!mine.length && !theirs.length) return null;
    const t0 = frames[0].t, t1 = frames[frames.length - 1].t, span = Math.max(1, t1 - t0);
    const values = [...mine, ...theirs].map(([, v]) => v);
    let lo = Math.min(...values), hi = Math.max(...values);
    // Limits within 15 % of the readings are drawn, so the chart shows how far away they are.
    const room = Math.max((hi - lo) * 0.5, Math.abs(hi) * 0.15, 0.5);
    const limits = diagLimits(series, id).filter(([, v]) => v >= lo - room && v <= hi + room);
    lo = Math.min(lo, ...limits.map(([, v]) => v));
    hi = Math.max(hi, ...limits.map(([, v]) => v));
    // A steady reading stays a steady line: never less than 4 % of its size top to bottom.
    const least = Math.max(Math.abs(hi + lo) * 0.02, 0.01);
    if (hi - lo < 2 * least) { const mid = (hi + lo) / 2; lo = mid - least; hi = mid + least; }
    const pad = (hi - lo) * 0.08;
    lo -= pad; hi += pad;
    const x = (t) => left + ((t - t0) / span) * (right - left);
    const y = (v) => top + plot - ((v - lo) / (hi - lo)) * plot;
    const path = (rows) => rows.map(([t, v], k) => `${k ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join("");
    // Labels carry a halo in the box's colour, so no limit line runs through a number.
    const text = `stroke:${COLORS.surface};stroke-width:3px;paint-order:stroke;font-weight:400;font-size:11px;font-family:Archivo,system-ui,sans-serif`;
    let body = "";
    const events = (live.stream && live.stream.events) || live.feedEvents || [];
    for (const e of events) {
      if (e.asset !== id || e.end < t0 || e.start > t1) continue;
      const a = x(Math.max(e.start, t0)), b = x(Math.min(e.end, t1));
      body += `<rect x="${a.toFixed(1)}" y="${top}" width="${Math.max(1, b - a).toFixed(1)}" height="${plot}" fill="${COLORS.band}" stroke="${COLORS.text_dim}" stroke-width="0.6"${e.planned ? ' stroke-dasharray="3 3"' : ""}><title>${esc(e.label)}${e.planned ? " (planned)" : ""}</title></rect>`;
    }
    for (const [label, v, lvl] of limits) {
      body += `<line x1="${left}" x2="${right}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${limitInk(lvl >= 2 ? 2 : 1)}" stroke-width="1" stroke-dasharray="2 3"/>`;
      body += `<text x="${right}" y="${(y(v) - 3).toFixed(1)}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${esc(label)} ${esc(fmt(v, series.digits > 1 ? 1 : 0))}</text>`;
    }
    body += `<text x="${left}" y="${top + 9}" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(hi, series.digits))}</text>`;
    body += `<text x="${left}" y="${top + plot - 2}" fill="${COLORS.text_dim}" style="${text}">${esc(fmt(lo, series.digits))}</text>`;
    if (theirs.length) body += `<path class="compare" d="${path(theirs)}" fill="none" stroke="${COLORS.text_dim}" stroke-width="1.4" stroke-dasharray="5 3"/>`;
    if (mine.length) body += `<path class="measured" d="${path(mine)}" fill="none" stroke="${COLORS.text}" stroke-width="1.6"/>`;
    if (diagView.cursor != null && diagView.cursor >= t0 && diagView.cursor <= t1) {
      body += `<line class="crosshair" x1="${x(diagView.cursor).toFixed(1)}" x2="${x(diagView.cursor).toFixed(1)}" y1="${top}" y2="${top + plot}" stroke="${COLORS.text}" stroke-width="0.8"/>`;
    }
    if (diagView.drag && diagView.drag.at != null) {
      const a = x(Math.min(diagView.drag.from, diagView.drag.at)), b = x(Math.max(diagView.drag.from, diagView.drag.at));
      body += `<rect x="${a.toFixed(1)}" y="${top}" width="${Math.max(1, b - a).toFixed(1)}" height="${plot}" fill="${COLORS.text_dim}" fill-opacity="0.15"/>`;
    }
    body += `<text x="${left}" y="${H - 4}" fill="${COLORS.text_dim}" style="${text}">${esc(shortTime(t0))}</text>`;
    body += `<text x="${right}" y="${H - 4}" text-anchor="end" fill="${COLORS.text_dim}" style="${text}">${esc(shortTime(t1))}</text>`;
    // Pointer: a press and a drag picks a window, a move sets the crosshair.
    const at = (e) => {
      const r = e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
      const share = r && r.width ? (e.clientX - r.left) / r.width : (e.offsetX ?? 0) / W;
      return t0 + Math.min(1, Math.max(0, (share * W - left) / (right - left))) * span;
    };
    const nearest = (t) => frames.reduce((best, f) => (Math.abs(f.t - t) < Math.abs(best.t - t) ? f : best), frames[0]).t;
    return h("div", { class: "diag-chart", "data-series": series.key,
      onpointerdown: (e) => { diagView.drag = { from: at(e), at: null }; },
      onpointermove: (e) => {
        const t = at(e);
        if (diagView.drag) diagView.drag.at = t;
        else diagView.cursor = nearest(t);
        renderDiag();
      },
      onpointerup: (e) => {
        const drag = diagView.drag, t = at(e);
        diagView.drag = null;
        if (drag && Math.abs(t - drag.from) > span / 40) {
          diagView.from = Math.min(drag.from, t);
          diagView.to = Math.max(drag.from, t);
          diagView.span = 0;
        } else diagView.cursor = nearest(t);
        renderDiag();
      },
      onpointerleave: () => { if (diagView.drag) { diagView.drag = null; renderDiag(); } } },
    h("div", { class: "diag-chart-title" }, `${series.name(assets[id])} · ${series.unit}`),
    svg(`0 0 ${W} ${H}`, body, "diag-trend"));
  }
  function diagCsv(id, other, series, frames) {
    const cols = [];
    for (const s of series) {
      cols.push([`${nameOf(id)} ${s.name(assets[id])} (${s.unit})`, (f) => diagRead(s, id, f)]);
      if (other) cols.push([`${nameOf(other)} ${s.name(assets[other])} (${s.unit})`, (f) => diagRead(s, other, f)]);
    }
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [["time_utc", ...cols.map(([name]) => name)].map(cell).join(",")];
    for (const f of frames) lines.push([new Date(f.t * 1000).toISOString(), ...cols.map(([, read]) => { const v = read(f); return v == null ? "" : v; })].map(cell).join(","));
    return `${lines.join("\n")}\n`;
  }
  function diagDownload(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function trendsBox(id) {
    if (diagView.asset !== id) Object.assign(diagView, { asset: id, span: 0, from: null, to: null, cursor: null, compare: "", drag: null });
    const d = assets[id], frames = diagFrames();
    if (frames.length < 2) return null;
    const other = diagView.compare && assets[diagView.compare] ? diagView.compare : null;
    const series = DIAG_SERIES.filter((s) => frames.some((f) => diagRead(s, id, f) != null));
    if (!series.length) return null;
    const preset = (label, seconds) => h("button", { type: "button", role: "tab", "data-key": `diag-span:${seconds}`,
      "aria-selected": String(!diagView.from && diagView.span === seconds),
      onclick: () => { Object.assign(diagView, { span: seconds, from: null, to: null }); renderDiag(); } }, label);
    const peers = (d.kind === "pipeline" ? pipeIds : nodeIds).filter((p) => p !== id).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const cursorFrame = diagView.cursor != null ? frames.find((f) => f.t === diagView.cursor) : null;
    const charts = series.map((s) => diagChart(s, id, other, frames)).filter(Boolean);
    return h("div", { class: "box wide diag-trends" },
      h("h2", null, "Trends"),
      h("div", { class: "diag-controls" },
        h("div", { class: "seg", role: "tablist", "aria-label": "Window" },
          preset("2 h", 2 * 3600), preset("12 h", 12 * 3600), preset("24 h", 24 * 3600), preset("All", 0)),
        h("select", { "aria-label": "Compare with", "data-key": "diag-compare", onchange: (e) => { diagView.compare = e.target.value; renderDiag(); } },
          h("option", { value: "", selected: other ? null : "" }, "Compare with…"),
          ...peers.map((p) => h("option", { value: p, selected: p === other ? "" : null }, nameOf(p)))),
        h("button", { type: "button", class: "text", "data-key": "diag-csv",
          onclick: () => diagDownload(`${id}${other ? `-vs-${other}` : ""}.csv`, diagCsv(id, other, series, frames)) }, "Export CSV")),
      h("p", { class: "dim small" }, `Drag across a chart to zoom. ${other ? `Dashed: ${nameOf(other)}. ` : ""}Shaded: outages on this asset, planned ones dashed.`),
      charts,
      cursorFrame ? h("table", { class: "data diag-cursor" },
        h("thead", null, h("tr", null, h("th", null, "At the crosshair"), ...series.map((s) => h("th", null, `${s.name(d)} (${s.unit})`)))),
        h("tbody", null,
          h("tr", null, h("td", null, formatTime(cursorFrame.t)), ...series.map((s) => h("td", null, fmt(diagRead(s, id, cursorFrame), s.digits)))),
          other ? h("tr", null, h("td", null, nameOf(other)), ...series.map((s) => h("td", null, fmt(diagRead(s, other, cursorFrame), s.digits)))) : null))
        : h("p", { class: "dim small" }, "Point at a chart for the exact values."));
  }
  /* The blending stations (nora.toml [blending], found by blending.py): one picture of the
     main lines through them, left to right (Ray, 27 Oct: "an image showing how the main
     pipelines go for the gas at those two blending stations, from left to right"). Gas in
     on the left, the stations in the order the gas runs between them now, gas out on the
     right. Every line is straight and opens its own page; colour only for an alarm, with
     its shape and word. Rebuilt every data step from a dozen lines, so it stays cheap. */
  const BLEND = NORA.blending || { stations: [], incoming: [], internal: [], outgoing: [] };
  const isBlendingStation = (id) => BLEND.stations.includes(id) && Boolean(assets[id]);
  let linesByNode = null; // node id -> the pipelines at it, built once
  function linesAt(node) {
    if (!linesByNode) {
      linesByNode = new Map();
      for (const pid of pipeIds) for (const end of [assets[pid].from, assets[pid].to]) {
        if (!linesByNode.has(end)) linesByNode.set(end, []);
        linesByNode.get(end).push(pid);
      }
    }
    return linesByNode.get(node) || [];
  }
  /* A gas reading mixed down to a node: its own reading, else the flow-weighted mix of
     the gas arriving now. `cover` is the share of that gas with a reading behind it. */
  function mixedReading(node, name, f, memo, seen = new Set()) {
    if (memo.has(node)) return memo.get(node);
    const own = metric(name, node, f);
    if (own != null) { memo.set(node, { value: own, cover: 1 }); return memo.get(node); }
    if (seen.has(node)) return { value: null, cover: 0 };
    seen.add(node);
    let flow = 0, known = 0, sum = 0;
    for (const pid of linesAt(node)) {
      const p = assets[pid], v = f.flows[pid];
      if (v == null || p.type === "onshore") continue;
      const into = p.to === node ? v : -v;
      if (into < 0.05) continue;
      flow += into;
      const up = mixedReading(p.to === node ? p.from : p.to, name, f, memo, seen);
      if (up.value != null && up.cover) { known += into * up.cover; sum += into * up.cover * up.value; }
    }
    seen.delete(node);
    const out = { value: known ? sum / known : null, cover: flow ? known / flow : 0 };
    memo.set(node, out);
    return out;
  }
  // The picture's content: stations in flow order, each line on the side its flow says.
  function blendingLayout(f = viewFrame()) {
    const stations = BLEND.stations.filter((s) => assets[s]);
    const moving = (v) => v != null && Math.abs(v) >= 0.05;
    // The stations in the order the gas runs between them now (the flow's sign, not the
    // CSV's from and to); stations the gas does not order keep nora.toml's order.
    const after = new Map(stations.map((s) => [s, []])), waiting = new Map(stations.map((s) => [s, 0]));
    const links = [];
    for (const pid of BLEND.internal) {
      const p = assets[pid];
      if (!p || !after.has(p.from) || !after.has(p.to)) continue;
      const v = f.flows[pid];
      const [a, b] = moving(v) && v < 0 ? [p.to, p.from] : [p.from, p.to];
      links.push({ pid, a, b, v: moving(v) ? Math.abs(v) : v == null ? null : 0 });
      if (moving(v)) { after.get(a).push(b); waiting.set(b, waiting.get(b) + 1); }
    }
    const rank = (s) => stations.indexOf(s), order = [], ready = stations.filter((s) => !waiting.get(s));
    while (ready.length) {
      const s = ready.shift();
      order.push(s);
      for (const t of after.get(s)) {
        waiting.set(t, waiting.get(t) - 1);
        if (!waiting.get(t)) { ready.push(t); ready.sort((x, y) => rank(x) - rank(y)); }
      }
    }
    for (const s of stations) if (!order.includes(s)) order.push(s); // a loop: nora.toml's order
    // Lines to and from the rest of the network: on the left when the gas runs toward the
    // station now (or, standing still, when pipelines.csv points it there).
    const left = new Map(order.map((s) => [s, []])), right = new Map(order.map((s) => [s, []]));
    for (const pid of [...BLEND.incoming, ...BLEND.outgoing]) {
      const p = assets[pid];
      if (!p) continue;
      const station = left.has(p.to) ? p.to : left.has(p.from) ? p.from : null;
      if (!station) continue;
      const v = f.flows[pid], csvIn = p.to === station;
      const inward = moving(v) ? csvIn === (v > 0) : csvIn;
      (inward ? left : right).get(station).push({ pid, far: csvIn ? p.from : p.to, v: v == null ? null : Math.abs(v) });
    }
    // Each station's share of its gas to each export, followed through the stations after
    // it (mixed evenly at each station).
    const shares = new Map();
    for (const s of [...order].reverse()) {
      const outs = [...right.get(s).filter((l) => moving(l.v)).map((l) => ({ v: l.v, export: l.pid })),
        ...links.filter((l) => l.a === s && l.v > 0).map((l) => ({ v: l.v, next: l.b }))];
      const total = outs.reduce((sum, o) => sum + o.v, 0), share = new Map();
      for (const o of outs) {
        if (o.export) share.set(o.export, (share.get(o.export) || 0) + o.v / total);
        else for (const [e, x] of shares.get(o.next) || []) share.set(e, (share.get(e) || 0) + (o.v / total) * x);
      }
      shares.set(s, [...share].filter(([, x]) => x >= 0.005).sort((a, b) => b[1] - a[1]));
    }
    // The blended H₂S and CO₂, only where readings stand behind most of the gas.
    const quality = new Map(order.map((s) => [s, []]));
    for (const name of Object.keys(QUALITY)) {
      if (!Object.keys((f.metrics || {})[name] || {}).length) continue;
      const memo = new Map();
      for (const s of order) {
        const r = mixedReading(s, name, f, memo);
        if (r.value != null && r.cover >= 0.5) quality.get(s).push({ name, value: r.value });
      }
    }
    return { order, links, left, right, shares, quality };
  }
  function blendingPicture(id, inSidebar = false) {
    const f = viewFrame(), L = blendingLayout(f);
    if (!L.order.length) return null;
    const halo = `stroke:${inSidebar ? COLORS.panel : COLORS.surface};stroke-width:3px;paint-order:stroke;stroke-linejoin:round`;
    const cut = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
    const ROW = 18, LINE = 14, BW = 150, DX = 80, GAP = 38;
    const NAME = 118, FLOW = 290, X0 = 316; // the left columns: where from, the line, its flow
    const RX = X0 + (L.order.length - 1) * DX + BW + 26, W = RX + 280;
    const lineLook = (pid, v) => {
      const lvl = whatifOn() ? 0 : levelOf(pid);
      // the width pipeStyle gives a flow in Live, whatever the mode
      const width = v == null ? 1 : 1 + 4 * Math.sqrt(v / live.maxAbs);
      const color = lvl ? LEVEL_COLOR[lvl] : v == null || v < 0.05 ? COLORS.inactive : COLORS.active;
      return { lvl, width: Math.max(1.2, width), color };
    };
    const link = (pid, label, inner) => `<g data-asset="${esc(pid)}" tabindex="0" role="link" aria-label="${esc(label)}" style="cursor:pointer">${inner}</g>`;
    const drawLine = (x1, y1, x2, y2, look) =>
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="12" pointer-events="stroke"/>`
      + (look.lvl ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.casing}" stroke-width="${look.width + 2.4}"/>` : "")
      + `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${look.color}" stroke-width="${look.width}"/>`;
    // An alarm on a line: its shape and number (none for a warning) and its word.
    const alarm = (lvl, x, y) => (lvl
      ? `${lvl > 1 ? `<g transform="translate(${x - 8} ${y - 8})">${shapeMarkup(lvl)}</g>` : ""}<text x="${x + (lvl > 1 ? 4 : -16)}" y="${y - 6}" style="${TEXT};${halo};font-size:10.5px">${esc(LEVEL[lvl])}</text>`
      : "");
    const flowText = (v) => (v == null ? "–" : fmt(v, 1));
    let m = "", y = 10;
    const boxes = new Map();
    L.order.forEach((s, i) => {
      const d = assets[s], x = X0 + i * DX, st = nodeStyle(s), lvl = whatifOn() ? 0 : levelOf(s);
      const flow = throughput(s, f.flows), bar = metric("pressure_bar", s, f);
      const rows = [[`<tspan style="font-weight:${s === id ? 700 : 500}">${esc(cut(d.name, 18))}</tspan>`, null]];
      rows.push([`${flowText(flow)} MSm³/d${bar != null ? ` · ${fmt(bar)} bar` : ""}`, null]);
      if (lvl) rows.push([`<tspan style="font-weight:600">${esc(LEVEL[lvl])}</tspan>`, null]);
      if (L.shares.get(s).length) {
        rows.push([`<tspan class="dimtext" style="font-size:10.5px">Share to exports</tspan>`, null]);
        for (const [e, x] of L.shares.get(s)) rows.push([esc(cut(nameOf(e), 17)), `${fmt(x * 100)} %`]);
      }
      if (L.quality.get(s).length) {
        rows.push([`<tspan class="dimtext" style="font-size:10.5px">Blend, estimate</tspan>`, null]);
        for (const q of L.quality.get(s)) rows.push([esc(qualityText(q.name, q.value)), null]);
      }
      const h = Math.max(rows.length * LINE + 12, L.left.get(s).length * ROW + 8, L.right.get(s).length * ROW + 8);
      boxes.set(s, { x, top: y, h });
      const look = COLORS.card[st.inactive ? "inactive" : "active"], here = s === id;
      let inner = `<rect x="${x}" y="${y}" width="${BW}" height="${h}" rx="6" fill="${look.fill}" stroke="${lvl ? LEVEL_COLOR[lvl] : here ? COLORS.text : look.edge}" stroke-width="${lvl ? 2.5 : here ? 2 : 1}"/>`;
      rows.forEach(([text, value], k) => {
        const ty = y + 16 + k * LINE;
        inner += `<text x="${x + 8}" y="${ty}" fill="${look.ink}" style="${TEXT}">${text}</text>`;
        if (value) inner += `<text x="${x + BW - 8}" y="${ty}" text-anchor="end" fill="${look.ink}" style="${TEXT}">${esc(value)}</text>`;
      });
      if (lvl > 1) inner += `<g transform="translate(${x + BW - 10} ${y - 6})">${shapeMarkup(lvl)}</g>`;
      m += link(s, `${d.name}, ${flowText(flow)} MSm³/d`, inner);
      // Gas in from the left and out to the right, one row each, level with the box.
      L.left.get(s).forEach((l, k) => {
        const ly = y + 12 + k * ROW, look = lineLook(l.pid, l.v);
        m += link(l.pid, `${nameOf(l.pid)} from ${nameOf(l.far)}, ${flowText(l.v)} MSm³/d`,
          drawLine(FLOW + 6, ly, x, ly, look)
          + `<text x="8" y="${ly + 4}" class="dimtext" style="${TEXT}">${esc(cut(nameOf(l.far), 17))}</text>`
          + `<text x="${NAME}" y="${ly + 4}" style="${TEXT}">${esc(cut(nameOf(l.pid), 25))}</text>`
          + `<text x="${FLOW}" y="${ly + 4}" text-anchor="end" style="${TEXT}">${flowText(l.v)}</text>`
          + alarm(look.lvl, (FLOW + 6 + x) / 2, ly));
      });
      L.right.get(s).forEach((l, k) => {
        const ly = y + 12 + k * ROW, look = lineLook(l.pid, l.v);
        m += link(l.pid, `${nameOf(l.pid)} to ${nameOf(l.far)}, ${flowText(l.v)} MSm³/d`,
          drawLine(x + BW, ly, RX, ly, look)
          + `<text x="${RX + 6}" y="${ly + 4}" style="${TEXT}">${flowText(l.v)}</text>`
          + `<text x="${RX + 40}" y="${ly + 4}" style="${TEXT}">${esc(cut(nameOf(l.pid), 25))}</text>`
          + `<text x="${RX + 196}" y="${ly + 4}" class="dimtext" style="${TEXT}">${esc(cut(nameOf(l.far), 15))}</text>`
          + alarm(look.lvl, (x + BW + RX) / 2, ly));
      });
      y += h + GAP;
    });
    // The lines between the stations: from one box to the next where the two overlap,
    // with an arrowhead for the way the gas runs now.
    for (const l of L.links) {
      const a = boxes.get(l.a), b = boxes.get(l.b), look = lineLook(l.pid, l.v);
      const down = a.top < b.top, [up, low] = down ? [a, b] : [b, a];
      const lx = Math.max(a.x, b.x) + (Math.min(a.x, b.x) + BW - Math.max(a.x, b.x)) / 2;
      const y1 = up.top + up.h, y2 = low.top, mid = (y1 + y2) / 2;
      let inner = drawLine(lx, y1, lx, y2, look);
      if (l.v > 0) {
        const tip = down ? y2 - 2 : y1 + 2, dir = down ? 1 : -1;
        inner += `<path d="M${lx - 4} ${tip - dir * 7}L${lx} ${tip}L${lx + 4} ${tip - dir * 7}" fill="none" stroke="${COLORS.text}" stroke-width="1.3" stroke-linejoin="round"/>`;
      }
      inner += `<text x="${lx + 10}" y="${mid + 4}" style="${TEXT};${halo}">${esc(cut(nameOf(l.pid), 24))}<tspan dx="6">${flowText(l.v)}</tspan></text>`;
      inner += alarm(look.lvl, lx - 30, mid + 10);
      m += link(l.pid, `${nameOf(l.pid)}, ${flowText(l.v)} MSm³/d`, inner);
    }
    const H = y - GAP + 10;
    const node = svg(`0 0 ${W} ${H}`, m, "schematic blending");
    node.setAttribute("width", W);
    node.setAttribute("height", H);
    node.removeAttribute("aria-hidden");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", "The blending stations: gas in on the left, out on the right");
    const open = (event) => {
      const g = event.target && event.target.closest && event.target.closest("[data-asset]");
      if (g && assets[g.getAttribute("data-asset")]) go({ screen: "asset", asset: g.getAttribute("data-asset") });
    };
    on(node, "click", open);
    on(node, "keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(event); } });
    return node;
  }
  // The box above "In context" on a blending station's page and in its sidebar. Its title
  // names the places from nodes.csv (Draupner S and E are one place).
  function blendingBox(id, inSidebar = false) {
    const picture = blendingPicture(id, inSidebar);
    if (!picture) return null;
    const places = [...new Set(BLEND.stations.filter((s) => assets[s]).map((s) => assets[s].name.split(" ")[0]))];
    const list = places.length > 1 ? `${places.slice(0, -1).join(", ")} and ${places[places.length - 1]}` : places[0];
    return h("div", { class: "box wide blending-box" },
      h("h2", null, `How gas runs through the ${list} blending stations`),
      h("div", { class: "blend-scroll" }, picture),
      h("p", { class: "dim small" }, "Gas enters on the left, is blended at the stations, and leaves on the right."));
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
    // In place, as the Overview: the charts keep the pointer and the select its focus while the data plays.
    keepFocus(screens.diag, () => patch(screens.diag, h("div", { class: "screen-body" },
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
        trendsBox(id),
        h("div", { class: "box wide" }, h("h2", null, "Readings, newest first (MSm³/d unless noted)"),
          h("table", { class: "data" },
            h("thead", null, h("tr", null, h("th", null, "Time"), h("th", null, d.kind === "pipeline" ? "Flow" : "Throughput"), ...here.map((m) => h("th", null, names[m])))),
            h("tbody", null, rows)))))));
  }

