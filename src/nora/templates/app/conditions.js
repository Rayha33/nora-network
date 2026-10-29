  // ------------------------------------------------------------------ alarm handling
  /* Acknowledge and shelve (ISA-18.2 style; hub 3612). An alarm is raised unacknowledged.
     Acknowledging one occurrence dims its badge; it stays listed until it clears, and if
     it comes back it is a new occurrence, unacknowledged again (an acknowledgement is
     kept per kind, asset and onset). Shelving takes an alarm out of the counts and the
     views for 1, 8 or 12 hours, with a reason; it returns by itself at the expiry and
     stays listed under Shelved meanwhile. Operator actions run on the wall clock and are
     kept in this browser only (localStorage), not shared with anyone else. */
  const ALARM_STATE = "nora-alarm-handling";
  const SHELVE_REASONS = ["Known cause", "Maintenance", "Nuisance"];
  const SHELVE_HOURS = [1, 8, 12];
  const alarmKey = (c) => `${c.kind}|${c.id}`;
  const occurrence = (c) => `${alarmKey(c)}|${c.since && c.since.t != null ? c.since.t : ""}`;
  const alarmHandling = (() => {
    const state = { acked: {}, shelved: {} };
    try { Object.assign(state, JSON.parse(localStorage.getItem(ALARM_STATE) || "{}")); } catch (error) { /* start empty */ }
    const save = () => {
      const acked = Object.entries(state.acked).sort((a, b) => b[1] - a[1]).slice(0, 500); // the newest 500 are plenty
      state.acked = Object.fromEntries(acked);
      try { localStorage.setItem(ALARM_STATE, JSON.stringify(state)); } catch (error) { /* kept for this page only */ }
    };
    return {
      acked: (c) => state.acked[occurrence(c)] != null,
      ack(conditions, now = Date.now()) {
        for (const c of conditions) state.acked[occurrence(c)] ??= now;
        save();
      },
      shelf: (c, now = Date.now()) => { const s = state.shelved[alarmKey(c)]; return s && s.until > now ? s : null; },
      shelve(c, reason, hours, now = Date.now()) {
        state.shelved[alarmKey(c)] = { reason, since: now, until: now + hours * 3600e3 };
        save();
      },
      unshelve(c) { delete state.shelved[alarmKey(c)]; save(); },
      expire(now = Date.now()) {
        const gone = Object.keys(state.shelved).filter((k) => state.shelved[k].until <= now);
        for (const k of gone) delete state.shelved[k];
        if (gone.length) save();
      },
    };
  })();

  // ------------------------------------------------------------------ conditions
  /* Everything abnormal right now, as {level, id, kind, text, since}. The views, the
     alarm counts, the overview and the asset screens all read this one list. `since`
     is when the alarm began, in data time: {t, before} with `before` set when it was
     already active as the playhead arrived (a seek), so it may have begun earlier. */
  function evaluate() {
    const f = frame(), out = [];
    const add = (lvl, id, kind, text, since = null) => { if (lvl > 0) out.push({ level: lvl, id, kind, text, since }); };
    for (const id of pipeIds) {
      const v = f.flows[id], d = assets[id];
      if (v === undefined) continue;
      if (d.capacity) add(level(Math.abs(v) / d.capacity, T.load), id, "load", `${nameOf(id)} at ${fmt((Math.abs(v) / d.capacity) * 100)}% of capacity`);
      if (live.down[id]) add(2, id, "trip", `${nameOf(id)}: flow collapsed to ${fmt(Math.abs(v), 1)} MSm³/d`);
    }
    for (const id of exitPoints) {
      const nom = metric("nomination_msm3d", id, f), booked = metric("booked_msm3d", id, f);
      const actual = throughput(id, f.flows);
      if (nom > 1 && actual != null) {
        const dev = (actual - nom) / nom;
        add(level(Math.abs(dev), T.nomination), id, "nomination", `${nameOf(id)} ${signed(dev * 100, 0)}% against nomination`);
      }
      if (nom > 0 && booked > 0) add(level(nom / booked, T.booking), id, "booking", `${nameOf(id)} nominated ${fmt((nom / booked) * 100)}% of booked capacity`);
    }
    for (const id of nodeIds) {
      const p = metric("pressure_bar", id, f), window = C.pressure[assets[id].type];
      if (p == null || !window) continue;
      const [low, high] = window, span = high - low, mark = pressureMark(id, p);
      if (mark) { // at a limit: low and high a warning; low-low, high-high and integrity critical
        add(mark.level === 1 ? 1 : 3, id, "pressure", `${nameOf(id)} ${fmt(p, 1)} bar, at its ${mark.name} limit (${fmt(mark.limit)} bar)`);
        continue;
      }
      if ((C.pressure_limits || {})[assets[id].type]) continue; // inside its limits
      // A type with no limits warns as the pressure nears its window's edges.
      const margin = Math.min(p - low, high - p) / span;
      add(level(margin, T.pressure_margin, false), id, "pressure",
        `${nameOf(id)} ${fmt(p, 1)} bar, near the ${p - low < high - p ? "minimum" : "maximum"} (${fmt(low)}–${fmt(high)} bar)`);
    }
    for (const peak of live.peaks) {
      add(peak.level, peak.id, "peak", `${nameOf(peak.id)}: flow ${peak.delta > 0 ? "rose" : "fell"} ${fmt(Math.abs(peak.delta), 1)} MSm³/d in one step`);
    }
    for (const s of slugs()) {
      if (s.exit && s.exitLevel) {
        add(slugAlarm(s), s.exit.node, "quality", `${qualityText(s.q.metric, s.exit.conc)} expected at ${nameOf(s.exit.node)} ${etaText(s.exit.t)}; limit ${C.quality[s.q.metric][2]} ${QUALITY[s.q.metric].unit}`);
      } else if (s.level) {
        add(slugAlarm(s), s.q.origin, "quality", `${qualityText(s.q.metric, s.q.conc)} from ${nameOf(s.q.origin)}${s.exit ? `, diluted to ${fmt(s.exit.conc, QUALITY[s.q.metric].digits)} by ${nameOf(s.exit.node)}` : ""}`);
      }
    }
    // A pig's ETA drifting from the last update its receiver had, or a missed update.
    for (const c of pigConditions(live.time)) add(c.level, c.id, "pig", c.text);
    const events = (live.stream && live.stream.events) || live.feedEvents || [];
    for (const event of events) {
      if (live.time >= event.start && live.time < event.end && !event.planned) add(2, event.asset, "event", event.label, { t: event.start, before: false });
    }
    if (f.plan && f.plan.now[0]) add(f.plan.now[0], f.plan.now[2] || "plan", "plan", `Plan: ${f.plan.now[1]}`, planSince());
    if (live.stale) add(2, "feed", "feed", `Live feed stale, values from ${live.time ? formatTime(live.time) : "before"}: ${live.stale.text}`, { t: live.stale.since / 1000, before: false });
    out.sort((a, b) => b.level - a.level || a.text.localeCompare(b.text));
    // The rest began when first seen; an alarm active as the playhead arrives may be older.
    const onset = new Map();
    for (const c of out) {
      const key = `${c.kind}|${c.id}`;
      c.since = c.since || live.onset.get(key) || onset.get(key) || { t: live.time, before: live.jumped };
      if (!onset.has(key)) onset.set(key, c.since);
    }
    live.onset = onset;
    live.jumped = false;
    // Shelved alarms leave the counts, the views and the lists; they are listed apart.
    alarmHandling.expire();
    for (const c of out) { c.acked = alarmHandling.acked(c); c.shelf = alarmHandling.shelf(c); }
    live.conditions = out.filter((c) => !c.shelf);
    live.shelved = out.filter((c) => c.shelf);
    live.levelOf = {};
    for (const c of live.conditions) live.levelOf[c.id] = Math.max(live.levelOf[c.id] || 0, c.level);
  }
  // When the plan began to fall short: the first of the frames in a row that do.
  function planSince() {
    let i = Math.max(0, live.index);
    while (i > 0 && live.frames[i - 1] && live.frames[i - 1].plan && live.frames[i - 1].plan.now[0]) i--;
    return { t: live.frames[i].t, before: i === 0 };
  }
  const levelOf = (id) => live.levelOf[id] || 0;
  const levelFor = (id, kinds) => Math.max(0, ...live.conditions.filter((c) => c.id === id && kinds.includes(c.kind)).map((c) => c.level));

  // A pipeline's flow collapsing to a tenth of its usual level is a trip.
  function trackTrips(f) {
    const floor = Math.max(1, 0.05 * live.maxAbs);
    for (const [id, raw] of Object.entries(f.flows)) {
      // Trips are a transport matter: trunks, export lines and interconnectors. A field
      // feeder going quiet (curtailment, shut-in) and balancing links swinging are not.
      if (!assets[id] || !["trunk", "export", "interconnector"].includes(assets[id].type)) continue;
      const v = Math.abs(raw), typical = live.typical[id] || 0;
      if (typical > floor && v < 0.1 * typical) live.down[id] = true;
      else if (live.down[id] && v > 0.3 * typical) delete live.down[id];
    }
  }
  // A large change in flow travels down the pipeline with the gas: a "peak".
  function spawnPeaks(previous, current) {
    if (!previous) return;
    for (const id of pipeIds) {
      const a = previous.flows[id], b = current.flows[id], d = assets[id];
      if (a === undefined || b === undefined || !d.capacity) continue;
      const share = Math.abs(b - a) / d.capacity;
      if (share >= C.pipelines.step_min) {
        live.peaks.push({ id, t0: current.t, delta: b - a, level: level(share, T.step), forward: b >= 0 });
      }
    }
  }
  function prunePeaks() {
    const places = new Map();
    live.peaks = live.peaks.filter((p) => {
      const place = live.time >= p.t0 ? peakPlace(p) : null;
      if (place) places.set(p, place);
      return place;
    });
    // Keep the play calm: at most `peak_max` peaks on screen at once. When a big
    // event changes many lines in the same hour, only the strongest changes travel.
    const max = C.pipelines.peak_max || live.peaks.length;
    if (live.peaks.length > max) {
      const strength = new Map(live.peaks.map((p) => {
        const place = places.get(p);
        return [p, Math.abs(place.delta) / (assets[place.pid].capacity || 1)];
      }));
      live.peaks.sort((a, b) => strength.get(b) - strength.get(a));
      live.peaks.length = max;
    }
  }
  // A small deterministic PRNG from a string seed: same seed, same route, always.
  function seeded(seed) {
    let h = 2166136261;
    for (const c of String(seed)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return () => {
      h = (h + 0x6D2B79F5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /* The frame in force at data time `t`: the last one at or before it (the first one
     before the data starts). Routes are chosen with the flows of the moment a marker
     reaches each node, never the flows on screen, so a choice made in the past stays
     made: no marker re-routes or jumps when the hour changes or the user seeks. */
  function frameAt(t) {
    const frames = live.frames;
    if (!frames.length) return frame();
    let lo = 0, hi = frames.length - 1;
    if (t < frames[0].t) return frames[0];
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return frames[lo];
  }
  // The lines carrying gas away from `node`, each with the flow it carries.
  function linesOut(node, flows) {
    const out = [];
    for (const pid of pipeIds) {
      const v = flows[pid], p = assets[pid];
      if (v === undefined || p.type === "onshore") continue;
      const o = p.from === node ? v : p.to === node ? -v : 0;
      if (o > 0.05) out.push({ pid, forward: p.from === node, w: o });
    }
    return out;
  }
  // Pick the next line out of a node: random, weighted by the flow it carries, and
  // deterministic for the same seed - so a pig or a peak always takes the same way.
  function nextOut(node, flows, seed) {
    return pickOut(linesOut(node, flows), seed);
  }
  function pickOut(out, seed) {
    if (!out.length) return null;
    if (out.length === 1) return out[0];
    const rand = seeded(seed);
    let pick = rand() * out.reduce((s, o) => s + o.w, 0);
    for (const o of out) { pick -= o.w; if (pick <= 0) return o; }
    return out[out.length - 1];
  }
  const lineMetres = (pid) => Math.max(1, assets[pid].km || 1) * 1000;
  const farEnd = (seg) => (seg.forward ? assets[seg.pid].to : assets[seg.pid].from);

  /* ------------------------------------------------------------------ pigs
     A pig moves with the gas (Ray, 27 Oct): its set speed times its line's flow now
     against the line's typical (median) flow, bounded 0.3 to 1.5 times. The rules
     mirror stream.py (pig_speed, pig_messages, pig_alarm); tests/data/pig_messages.json
     holds cases both must pass. */
  const PIG = { slowest: 0.3, fastest: 1.5, notice: 2 * 3600, drift: 30 * 60, driftAlarm: 2 * 3600, response: 15 * 60, grace: 15 * 60, look: 15 * 60 };
  function pigSpeed(speed, flow, typical) {
    if (flow == null || !(typical > 0)) return speed;
    return speed * Math.min(PIG.fastest, Math.max(PIG.slowest, Math.abs(flow) / typical));
  }
  const lineSpeed = (pig, pid, f) => pigSpeed(pig.speed, f.flows[pid], live.typical[pid]);
  // When the data next changes after t; Infinity past the last frame.
  function nextFrameTime(t) {
    const frames = live.frames;
    let lo = 0, hi = frames.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].t <= t) lo = mid + 1; else hi = mid; }
    return lo < frames.length ? frames[lo].t : Infinity;
  }
  // Hops from every node to a receiving station, along any line.
  const hopsTo = new Map();
  function hopsToStation(station) {
    if (hopsTo.has(station)) return hopsTo.get(station);
    const hops = new Map([[station, 0]]), queue = [station];
    while (queue.length) {
      const node = queue.shift();
      for (const pid of pipeIds) {
        const p = assets[pid], other = p.from === node ? p.to : p.to === node ? p.from : null;
        if (other != null && !hops.has(other)) { hops.set(other, hops.get(node) + 1); queue.push(other); }
      }
    }
    hopsTo.set(station, hops);
    return hops;
  }
  /* The line a pig takes out of a node, with the gas: toward its receiver when it has
     one, else at random weighted by the flow; null where it is received. */
  function pigHop(pig, node, flows, seed) {
    if (pig.receiver) {
      if (node === pig.receiver) return null;
      const hops = hopsToStation(pig.receiver), here = hops.has(node) ? hops.get(node) : Infinity;
      const closer = linesOut(node, flows).filter((o) => {
        const far = o.forward ? assets[o.pid].to : assets[o.pid].from;
        return hops.has(far) && hops.get(far) < here;
      });
      if (closer.length) return pickOut(closer, seed);
    }
    return isExit(node) ? null : nextOut(node, flows, seed);
  }
  /* One run of a pig (a relaunch is a new run), worked out once from the data: it starts
     down its line the way the gas flows at launch and takes each further line with the
     flows of the moment it reaches that node; between data steps it keeps the speed of
     that step. `knots` are (time, metres) where the speed changes, so the place at any
     time is one search: replay and seek agree. */
  const pigRuns = new Map();
  function pigRun(pig, run) {
    const key = `${pig.label}|${pig.launch}|${run}`;
    if (pigRuns.has(key)) return pigRuns.get(key);
    const start = pig.launch + run * (pig.every > 0 ? pig.every : 0);
    const v0 = frameAt(start).flows[pig.pipeline];
    const route = [{ pid: pig.pipeline, forward: !(v0 < 0), m: 0, t: start }], knots = [{ t: start, d: 0 }];
    let t = start, d = 0, arrives = null;
    for (let guard = 0; guard < 20000; guard++) {
      const seg = route[route.length - 1], end = seg.m + lineMetres(seg.pid);
      const reach = t + (end - d) / lineSpeed(pig, seg.pid, frameAt(t)), next = nextFrameTime(t);
      if (reach > next) { d += (end - d) * (next - t) / (reach - t); t = next; knots.push({ t, d }); continue; }
      t = reach; d = end; seg.out = t; knots.push({ t, d });
      const hop = route.length >= 40 ? null : pigHop(pig, farEnd(seg), frameAt(t).flows, `${key}|${route.length}`);
      if (!hop) { arrives = t; break; } // received (or the network's edge): off screen
      route.push({ pid: hop.pid, forward: hop.forward, m: end, t });
    }
    const last = route[route.length - 1];
    const r = { key, run, start, route, knots, arrives, total: last.m + lineMetres(last.pid), receiver: farEnd(last) };
    pigRuns.set(key, r);
    return r;
  }
  // Metres travelled at `time`.
  function pigDistance(r, time) {
    const k = r.knots;
    if (time <= k[0].t) return 0;
    if (time >= k[k.length - 1].t) return k[k.length - 1].d;
    let lo = 0, hi = k.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (k[mid].t <= time) lo = mid; else hi = mid; }
    return k[lo].d + (k[hi].d - k[lo].d) * (time - k[lo].t) / (k[hi].t - k[lo].t);
  }
  // The run on screen at `time`: the latest launched (null before the first launch).
  const pigRunIndex = (pig, time) => (time < pig.launch ? null : pig.every > 0 ? Math.floor((time - pig.launch) / pig.every) : 0);
  // Where a pig is now: on one line at a time, handing over at the nodes, never jumping.
  function pigPlace(pig, time) {
    if (time == null || time < pig.launch) return null;
    const r = pigRun(pig, pigRunIndex(pig, time));
    if (r.arrives != null && time >= r.arrives) return null; // received, waiting for a relaunch
    const d = pigDistance(r, time);
    const seg = r.route.find((s) => d < s.m + lineMetres(s.pid)) || r.route[r.route.length - 1];
    const along = (d - seg.m) / lineMetres(seg.pid);
    return { pid: seg.pid, along: seg.forward ? along : 1 - along, exitAt: seg.out, next: farEnd(seg), speed: lineSpeed(pig, seg.pid, frameAt(time)) };
  }
  /* The live ETA at the receiver: the stretch still ahead on each line at the speed of
     that line's flow over the last 24 hours (a gas day, so the daily swing in the flows
     does not move an ETA days away; a lasting change does). Before the launch, the
     whole route from the launch. */
  const ETA_WINDOW = 24 * 3600;
  /* Running sums of each line's |flow| over the frames, so the mean over any window is
     two lookups (the message log looks at the ETA every 15 minutes of every run). */
  let flowSums = null;
  function lineSums(pid) {
    const frames = live.frames, first = frames.length ? frames[0].t : null;
    if (!flowSums || flowSums.frames !== frames || flowSums.n !== frames.length || flowSums.first !== first) {
      flowSums = { frames, n: frames.length, first, byLine: new Map() };
    }
    let sums = flowSums.byLine.get(pid);
    if (!sums) {
      const total = [0], count = [0];
      for (const f of frames) {
        const v = f.flows[pid];
        total.push(total[total.length - 1] + (v == null ? 0 : Math.abs(v)));
        count.push(count[count.length - 1] + (v == null ? 0 : 1));
      }
      flowSums.byLine.set(pid, sums = { total, count });
    }
    return sums;
  }
  const framesUpTo = (time) => { // how many frames are at or before `time`
    const frames = live.frames;
    let lo = 0, hi = frames.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].t <= time) lo = mid + 1; else hi = mid; }
    return lo;
  };
  // A line's mean |flow| over the 24 hours to `time`; its flow then when there is none.
  function dayFlow(pid, time) {
    const { total, count } = lineSums(pid), hi = framesUpTo(time), lo = framesUpTo(time - ETA_WINDOW);
    const n = count[hi] - count[lo];
    return n ? (total[hi] - total[lo]) / n : frameAt(time).flows[pid];
  }
  function pigEta(pig, r, time) {
    if (r.arrives != null && time >= r.arrives) return r.arrives;
    const d = pigDistance(r, time);
    let eta = Math.max(time, r.start);
    for (const seg of r.route) {
      const end = seg.m + lineMetres(seg.pid);
      if (end > d) eta += (end - Math.max(d, seg.m)) / pigSpeed(pig.speed, dayFlow(seg.pid, time), live.typical[seg.pid]);
    }
    return eta;
  }
  /* The messages to the receiving station over a run (synthetic: NORA writes them as a
     dispatcher would). A launch notice 2 h before the launch; an ETA update every
     `notify` after it; one more, 15 min later, whenever the live ETA, looked at at each
     of `checks`, has moved more than 30 min from the last one sent; the arrival
     confirmation. As stream.pig_messages. */
  function pigMessages(launch, arrival, notify, checks, eta, to) {
    const first = launch - PIG.notice, end = arrival == null ? Infinity : arrival;
    const out = [{ t: first, kind: "launch", eta: eta(first), to }];
    let scheduled = [];
    for (let k = 1; launch + k * notify < end && (arrival != null || k <= 1000); k++) scheduled.push(launch + k * notify);
    if (arrival == null) scheduled = scheduled.filter((t) => !checks.length || t <= checks[checks.length - 1]);
    const planned = new Set(scheduled);
    const times = [...new Set([...scheduled, ...checks])].filter((t) => t > first && t < end).sort((a, b) => a - b);
    const send = (t, reason) => out.push({ t, kind: "update", eta: eta(t), to, reason });
    let due = null;
    for (const t of times) {
      if (due != null && due <= t) {
        if (!(due === t && planned.has(t))) send(due, "drift"); // else the scheduled one goes instead
        due = null;
      }
      if (planned.has(t)) { send(t, "scheduled"); due = null; }
      else if (due == null && Math.abs(eta(t) - out[out.length - 1].eta) > PIG.drift) due = t + PIG.response;
    }
    if (due != null && due < end) send(due, "drift");
    if (arrival != null) out.push({ t: arrival, kind: "arrival", eta: arrival, to });
    return out;
  }
  /* A run's state at `now`: 1 when the live ETA is more than 30 min from the last one
     sent, 3 past 2 h or when a scheduled update is 15 min late. As stream.pig_alarm. */
  function pigAlarm(now, launch, arrival, notify, messages, etaNow) {
    if (now < launch - PIG.notice || (arrival != null && now >= arrival)) return { level: 0, what: "", drift: 0 };
    const sent = messages.filter((m) => m.t <= now);
    if (!sent.length) return { level: 0, what: "", drift: 0 };
    const drift = etaNow - sent[sent.length - 1].eta, k = Math.floor((now - PIG.grace - launch) / notify);
    if (k >= 1 && sent[sent.length - 1].t < launch + k * notify) return { level: 3, what: "missed", drift };
    if (Math.abs(drift) > PIG.driftAlarm) return { level: 3, what: "drift", drift };
    if (Math.abs(drift) > PIG.drift) return { level: 1, what: "drift", drift };
    return { level: 0, what: "", drift };
  }
  const pigNotify = (pig) => (pig.notify > 0 ? pig.notify : 6 * 3600);
  const pigTag = (pig) => pig.tag || pig.label;
  /* The run's messages, worked out once. The dispatcher looks at the live ETA every
     15 minutes from the launch notice to the arrival (to the end of the data while the
     pig is still under way). */
  function pigLog(pig, r) {
    if (r.messages) return r.messages;
    const first = r.start - PIG.notice, last = live.frames.length ? live.frames[live.frames.length - 1].t : r.start;
    const end = r.arrives == null ? Math.max(last, r.start) : r.arrives, checks = [];
    for (let t = Math.floor(first / PIG.look) * PIG.look + PIG.look; t < end; t += PIG.look) checks.push(t);
    r.messages = pigMessages(r.start, r.arrives, pigNotify(pig), checks, (t) => pigEta(pig, r, t), r.receiver);
    return r.messages;
  }
  /* What the receiving station has been told by `time`, against the live ETA. For the
     run on screen, and for the next one once its launch notice has gone. */
  function pigStatus(pig, r, time) {
    const log = pigLog(pig, r), sent = log.filter((m) => m.t <= time), eta = pigEta(pig, r, time);
    const updates = sent.filter((m) => m.kind === "update");
    return {
      run: r, eta, sent, log,
      launch: sent.find((m) => m.kind === "launch") || null,
      last: updates.length ? updates[updates.length - 1] : null,
      lastEta: sent.length ? sent[sent.length - 1].eta : null,
      arrival: sent.find((m) => m.kind === "arrival") || null,
      nextUpdate: log.find((m) => m.t > time && m.kind === "update" && m.reason === "scheduled") || null,
      alarm: pigAlarm(time, r.start, r.arrives, pigNotify(pig), log, eta),
    };
  }
  function pigRunsAt(pig, time) {
    const runs = [], now = pigRunIndex(pig, time);
    if (now != null) runs.push(pigRun(pig, now));
    const next = now == null ? 0 : pig.every > 0 ? now + 1 : null;
    if (next != null && time >= pig.launch + next * (pig.every || 0) - PIG.notice) runs.push(pigRun(pig, next));
    return runs;
  }
  const allPigs = () => (live.stream && live.stream.pigs) || live.feedPigs || [];
  const minutes = (s) => (Math.abs(s) < 5400 ? `${Math.round(Math.abs(s) / 60)} min` : `${fmt(Math.abs(s) / 3600, 1)} h`);
  // The pig alarms for evaluate(): an ETA that moved since the last update, or a missed one.
  function pigConditions(time) {
    const out = [];
    for (const pig of allPigs()) {
      for (const r of pigRunsAt(pig, time)) {
        const s = pigStatus(pig, r, time), a = s.alarm;
        if (!a.level) continue;
        const text = a.what === "missed"
          ? `Pig ${pigTag(pig)}: scheduled ETA update to ${nameOf(r.receiver)} not sent`
          : `Pig ${pigTag(pig)}: ETA moved ${minutes(a.drift)} ${a.drift > 0 ? "later" : "earlier"} since the last update to ${nameOf(r.receiver)}`;
        out.push({ level: a.level, id: pig.pipeline, text });
      }
    }
    return out;
  }
  /* Where a peak is now: it keeps travelling downstream, attenuated by its share of
     the gas at each node, and disappears at an exit or when it fades below step_min.
     Each hop is worked out once, with the flows when the peak reaches that node, and
     kept on the peak, so the place costs a few steps per frame. */
  function peakPlace(peak, time = live.time) {
    const v = C.pipelines.gas_velocity_mps;
    if (!peak.hops) peak.hops = [{ pid: peak.id, forward: peak.forward, delta: peak.delta, t: peak.t0 }];
    for (let k = 0; time >= peak.hops[k].t; k++) {
      const hop = peak.hops[k], exitAt = hop.t + lineMetres(hop.pid) / v;
      if (time < exitAt) {
        const along = ((time - hop.t) * v) / lineMetres(hop.pid);
        return { pid: hop.pid, forward: hop.forward, delta: hop.delta, along: hop.forward ? along : 1 - along, exitAt };
      }
      if (k + 1 < peak.hops.length) continue;
      if (hop.end || k >= 40) return null;
      const node = hop.forward ? assets[hop.pid].to : assets[hop.pid].from, f = frameAt(exitAt);
      let delta = hop.delta;
      const inflow = throughput(node, f.flows), mine = Math.abs(f.flows[hop.pid] || 0);
      if (inflow > 0 && mine < inflow) delta *= mine / inflow;  // diluted where gas joins
      const next = isExit(node) || Math.abs(delta) < C.pipelines.step_min * (assets[hop.pid].capacity || 1)
        ? null : nextOut(node, f.flows, `${peak.id}|${peak.t0}|${k}`);
      if (!next) { hop.end = true; return null; }  // left the network, or faded out
      peak.hops.push({ pid: next.pid, forward: next.forward, delta, t: exitAt });
    }
    return null;
  }
  /* Markers moving along the lines, with their position (0..1 from the pipeline's
     `from` end): pigs at their own speed, peaks with the gas. Both follow ROUTES:
     chains of pipelines in the downstream direction (the way the gas flows, top to
     bottom in the Flow view), chosen at random weighted by the flow each line carries,
     from a seed, so replay and seek give the same route. Pigs hand over line to line
     at the nodes; peaks continue attenuated by their share of the gas at each node
     and die when that share or the exit ends them. */
  function markers() {
    const out = [];
    if (live.time == null) return out;
    const pigs = settings.pigs ? (live.stream && live.stream.pigs) || live.feedPigs || [] : [];
    for (const pig of pigs) {
      const place = pigPlace(pig, live.time);
      if (!place) continue;
      const trip = pigTrip(pig, live.time);
      out.push({ kind: "pig", id: place.pid, along: place.along, label: "", level: 0, title: pig.label,
        eta: clock(place.exitAt), to: nameOf(place.next), key: `pig:${pig.label}|${pig.launch}`, ref: pig,
        pigId: pig.id != null ? pig.id + trip.run : null, arrives: trip.arrives, speed: place.speed });
    }
    // No marker for a change in flow (Ray, 29 Oct: "mainly stick to illustrating H2S, CO2
    // and pigs"); a large one is still an alarm.
    if (!settings.gasQuality) return out; // Settings: H₂S and CO₂ peaks off
    advanceQuality(); // the clock moves every frame, the parcels with it
    const leads = new Map(slugs().map((s) => [s.q.slug, s])), bySlug = new Map();
    for (const q of live.quality) bySlug.set(q.slug, [...(bySlug.get(q.slug) || []), q]);
    for (const [slug, parcels] of bySlug) {
      parcels.sort((a, b) => a.born - b.born);
      // Each parcel's share of the slug: the gas sent from its birth until the next
      // parcel's, or until now while the field still sends it.
      const windows = parcels.map((q, k) => [q.born, Math.min(q.born + q.len, k + 1 < parcels.length ? parcels[k + 1].born : Infinity, live.time)]);
      const bands = new Map();
      parcels.forEach((q, k) => {
        for (const piece of gasStretch(q, windows[k][0], windows[k][1])) {
          const band = bands.get(piece.pid);
          if (band) { band.tail = Math.min(band.tail, piece.tail); band.head = Math.max(band.head, piece.head); }
          else bands.set(piece.pid, { ...piece });
        }
      });
      if (!bands.size) continue;
      // The dot: the gas sent midway between the head still in the network and the tail.
      const inside = parcels.map((q, k) => [Math.max(windows[k][0], live.time - pathSeconds(q)), windows[k][1]]);
      const front = inside.find(([a, b]) => b >= a), back = windows[windows.length - 1][1];
      const mid = ((front ? front[0] : back) + back) / 2;
      const k = Math.max(0, windows.findIndex(([, b], i) => mid <= b || i === windows.length - 1));
      const dot = gasPlace(parcels[k], mid), s = leads.get(slug), q0 = parcels[0];
      for (const band of bands.values()) {
        const flip = (x) => (band.forward ? x : 1 - x), extent = [flip(band.tail), flip(band.head)];
        const base = { kind: "quality", gas: q0.metric, id: band.pid, extent, key: `quality:${slug}`, ref: slug };
        if (!s || !dot || dot.pid !== band.pid) { out.push({ ...base, along: (extent[0] + extent[1]) / 2, lead: false, noDot: true, level: 0, value: "" }); continue; }
        const along = Math.max(band.tail, Math.min(band.head, dot.at));
        out.push({ ...base, along: flip(along), lead: true, level: slugAlarm(s),
          value: `${QUALITY[q0.metric].name} ${fmt(s.q.conc, QUALITY[q0.metric].digits)}`, amount: fmt(s.q.conc, QUALITY[q0.metric].digits),
          eta: s.q.arrived ? "" : clock(s.next.t), to: nameOf(s.q.arrived ? s.q.arrived.node : s.next.node) });
      }
    }
    return out.sort((a, b) => Number(Boolean(a.lead)) - Number(Boolean(b.lead)));
  }

