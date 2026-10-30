  // ------------------------------------------------------------------ line pack
  /* The gas held in a pipeline: its volume and the mean pressure along it, from the
     pressures at its two ends (2/3 (p1 + p2 - p1 p2 / (p1 + p2)), absolute), at 5 °C on
     the seabed and a compressibility of 0.85. A model estimate, as a pipeline modelling
     system (PMS) gives, for every line with a known length and diameter. Ray, 29 Oct:
     the pack rate "normally we want to stay close to 0"; the rate of change of
     pressure matters "especially in and out of SLR, DRP S and DRP E"; and "a trend
     showing total inventory in the whole system". */
  const PACK = { pStd: 1.01325, tStd: 288.15, tSea: 278.15, z: 0.85 };
  const lineVolume = {}; // m³
  for (const pid of pipeIds) {
    const d = assets[pid];
    if (d.length && d.diameter) lineVolume[pid] = (Math.PI / 4) * (d.diameter * 0.0254) ** 2 * d.length * 1000;
  }
  /* Settle-out pressure (bar g): what a line settles to, shut in at both ends, with the
     gas it holds now: the mean of its end pressures for compressible flow. Operators
     read it on the lines (the old Area D screen's "sop"). */
  function settleOut(pid, f = frame()) {
    if (!f || !assets[pid]) return null;
    const a = metric("pressure_bar", assets[pid].from, f), b = metric("pressure_bar", assets[pid].to, f);
    if (a == null && b == null) return null;
    const p1 = (a ?? b) + PACK.pStd, p2 = (b ?? a) + PACK.pStd;
    return (2 / 3) * (p1 + p2 - (p1 * p2) / (p1 + p2)) - PACK.pStd;
  }
  function linepack(pid, f) { // MSm³
    const sop = lineVolume[pid] ? settleOut(pid, f) : null;
    if (sop == null) return null;
    return ((lineVolume[pid] * (sop + PACK.pStd)) / PACK.pStd) * (PACK.tStd / PACK.tSea) / PACK.z / 1e6;
  }
  const frameNo = (i) => live.frames[Math.max(0, Math.min(live.frames.length - 1, i))];
  // The frame an hour before now, and now: rates are over the last hour.
  function hourPair() {
    const step = (live.stream && live.stream.step) || 3600, now = frameNo(live.index);
    const before = frameNo(live.index - Math.max(1, Math.round(3600 / step)));
    return now && before && now !== before && now.t > before.t ? [before, now] : null;
  }
  function packRate(pid) { // MSm³/d
    const pair = hourPair(), a = pair && linepack(pid, pair[0]), b = pair && linepack(pid, pair[1]);
    return a == null || b == null ? null : ((b - a) * 86400) / (pair[1].t - pair[0].t);
  }
  function pressureRate(id) { // bar/h (a what-if is a steady state: none)
    if (whatifOn()) return null;
    const pair = hourPair(), a = pair && metric("pressure_bar", id, pair[0]), b = pair && metric("pressure_bar", id, pair[1]);
    return a == null || b == null ? null : ((b - a) * 3600) / (pair[1].t - pair[0].t);
  }
  const inventories = new WeakMap(); // frame -> MSm³ (a stream's frames do not change)
  function inventory(f) {
    if (!f) return null;
    if (!inventories.has(f)) {
      let total = 0, any = false;
      for (const pid of Object.keys(lineVolume)) {
        const lp = linepack(pid, f);
        if (lp != null) { total += lp; any = true; }
      }
      inventories.set(f, any ? total : null);
    }
    return inventories.get(f);
  }

  /* Gas through a node (or the node's own reading), from a frame's flows: what arrives,
     or for fields and storage what they send out (storage may also take gas in). */
  function throughput(id, flows) {
    if (flows[id] !== undefined) return Math.abs(flows[id]);
    let into = 0, out = 0, seen = false;
    for (const pid of pipeIds) {
      const v = flows[pid];
      if (v === undefined) continue;
      const p = assets[pid];
      if (p.type === "onshore" && !markets.has(id)) continue;
      if (p.to === id) { seen = true; if (v > 0) into += v; else out -= v; }
      else if (p.from === id) { seen = true; if (v > 0) out += v; else into -= v; }
    }
    if (!seen) return null;
    return assets[id] && assets[id].supply ? Math.max(out, into) : into;
  }
  // The trends in the indicator banks: the last TREND_STEPS data steps (12 h of hourly
  // or half-hourly data, 12 gas days of daily data), and their column says so.
  const TREND_STEPS = 12;
  function series(fn, n = hourly(TREND_STEPS) + 1) {
    const out = [];
    for (let i = Math.max(0, live.index - n + 1); i <= live.index; i++) out.push(live.frames[i] ? fn(live.frames[i]) : null);
    return out;
  }
  function stepHours() {
    if (live.stream) return live.stream.step / 3600;
    const n = live.frames.length;
    return n > 1 ? (live.frames[n - 1].t - live.frames[n - 2].t) / 3600 || 1 : 1;
  }
  // n data steps, or n hours of data finer than hourly: half-hourly data keeps the hourly
  // views (twelve hours of trend, the ruler's ten days) instead of halving them.
  const hourly = (n) => (stepHours() < 1 ? Math.round(n / stepHours()) : n);
  // Change per hour over the last three readings.
  function rate(values) {
    const known = values.filter((v) => v != null);
    if (known.length < 2) return null;
    const recent = known.slice(-3);
    return (recent[recent.length - 1] - recent[0]) / ((recent.length - 1) * stepHours());
  }

  /* Within-day delivery at an exit point: the gas delivered so far this gas day against
     what was nominated for the same hours, as a share (0 = on plan, -0.05 = 5 % short).
     The gas day starts at thresholds.gas_day_start_utc. */
  const dayDelivery = (id) => cached("day", id, () => (whatifOn() ? whatifDay(id) : dayDeliveryNow(id)));
  // In a what-if: its delivery against the nomination it starts from (now's, or the next gas day's).
  function whatifDay(id) {
    const w = whatifState(), nom = w.nominations[id], got = w.delivered[id];
    if (!(nom > 0) || got == null) return null;
    const share = (got - nom) / nom;
    return { share, level: level(Math.abs(share), T.nomination), trail: [] };
  }
  /* The gas day so far at an exit: delivered against nominated, and how that stood after
     each hour of the day (`trail`, oldest first; Ray, 29 Oct: "the end of day target to
     exit points changes over time and this need to be illustrated as well"). `hours`
     keeps each hour's MSm³ for the panel's chart. */
  function dayDeliveryNow(id) {
    const start = T.gas_day_start_utc == null ? 5 : T.gas_day_start_utc, now = frame();
    if (now.t == null || metric("nomination_msm3d", id, now) == null) return null;
    const dayStart = Math.floor((now.t - start * 3600) / 86400) * 86400 + start * 3600;
    let first = live.index;
    while (first > 0 && live.frames[first - 1] && live.frames[first - 1].t >= dayStart) first--;
    let actual = 0, nominated = 0;
    const trail = [], hours = [];
    for (let i = first; i <= live.index; i++) {
      const f = live.frames[i], nom = metric("nomination_msm3d", id, f), got = throughput(id, f.flows);
      if (nom == null || got == null) continue;
      actual += got;
      nominated += nom;
      hours.push({ t: f.t, nominated: nom, delivered: got });
      if (nominated > 0) trail.push((actual - nominated) / nominated);
    }
    if (nominated <= 0) return null;
    const share = (actual - nominated) / nominated;
    return { share, level: level(Math.abs(share), T.nomination), trail: trail.slice(0, -1), hours, dayStart };
  }
  // How fast gas through a node is changing, MSm³/d per hour, over the last 2 hours.
  const flowRate = (id) => (whatifOn() ? null : rate(window4h(id).past));
  /* The 4-hour window shown in each flow-view card: the last 2 hours of actual flow,
     and the next 2 hours of what shippers have nominated (from the recorded data, or
     the `ahead` block of a live-feed frame). */
  function window4h(id) { return whatifOn() ? { past: [], future: null, tol: 0 } : cached("w4h", id, () => window4hNow(id)); }
  function window4hNow(id) {
    const n = Math.max(1, Math.round(2 / stepHours()));
    const past = [];
    for (let i = live.index - n; i <= live.index; i++) past.push(live.frames[i] ? throughput(id, live.frames[i].flows) : null);
    let future = null;
    const nomNow = metric("nomination_msm3d", id);
    if (nomNow != null) {
      future = [nomNow];
      for (let k = 1; k <= n; k++) {
        const ahead = live.feed ? (((frame().ahead || {}).nomination_msm3d || {})[id] || [])[k - 1] : metric("nomination_msm3d", id, live.frames[live.index + k] || {});
        future.push(ahead ?? null);
      }
    }
    return { past, future, tol: T.nomination[0] };
  }

  // Six hourly nominations beginning at the displayed hour. Live frames carry their
  // forecast in `ahead`; recorded streams use their frames on the following hours (each
  // frame of hourly data, every other one of half-hourly data).
  function nominationWindow(id) {
    return cached("nom6", id, () => {
      const current = frame(), out = [];
      const gap = live.frames.length > 1 ? live.frames[1].t - live.frames[0].t : 3600;
      const per = !live.feed && gap > 0 && gap < 3600 ? Math.round(3600 / gap) : 1;
      const base = live.index - (per > 1 ? Math.round((current.t % 3600) / gap) : 0);
      const t0 = (live.frames[base] || current).t;
      // Each hour's nomination and booking (a live feed's `ahead` block, or the
      // recorded data's following hours).
      const hourOf = (name, k, future) => (k === 0 && base === live.index ? metric(name, id, current)
        : live.feed ? (((current.ahead || {})[name] || {})[id] || [])[k - 1]
        : metric(name, id, future || {}));
      for (let k = 0; k < 6; k++) {
        const future = live.frames[base + k * per];
        const value = hourOf("nomination_msm3d", k, future), booked = hourOf("booked_msm3d", k, future);
        out.push({ t: future && future.t != null ? future.t : t0 + k * 3600, value: value ?? null, booked: booked ?? null });
      }
      return out;
    });
  }

