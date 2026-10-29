  // ------------------------------------------------------------------ player
  function prepare(stream) {
    const columns = stream.assets.map(() => []);
    let maxAbs = 0;
    const metricNames = Object.keys(stream.metrics || {});
    stream.frames = stream.times.map((t, i) => {
      const flows = {};
      stream.assets.forEach((id, j) => {
        const v = stream.values[i][j];
        if (v == null) return;
        flows[id] = v;
        columns[j].push(Math.abs(v));
        maxAbs = Math.max(maxAbs, Math.abs(v));
      });
      const metrics = {};
      for (const name of metricNames) {
        const block = stream.metrics[name], values = {};
        block.assets.forEach((id, j) => { const v = block.values[i][j]; if (v != null) values[id] = v; });
        metrics[name] = values;
      }
      return { t, flows, metrics, plan: stream.plan ? stream.plan[i] : null };
    });
    stream.typical = {};
    stream.assets.forEach((id, j) => {
      const sorted = columns[j].sort((a, b) => a - b);
      stream.typical[id] = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    });
    stream.maxAbs = maxAbs || 1;
    stream.step = stream.times.length > 1 ? stream.times[1] - stream.times[0] : 3600;
    return stream;
  }
  const scrub = $("scrub"), spark = $("spark");
  // Redraw the ruler whenever its own box changes size, not only with the window: the
  // player settles its layout after the first draw, and paused nothing else redraws it,
  // so the bitmap was squeezed into a smaller box (tiny day names on a wall).
  if (typeof ResizeObserver === "function") new ResizeObserver(() => drawSpark()).observe(spark);
  /* "Now" in the middle of the timeline (Ray: "the middle of the timeline bar should be
     real time, while dragging to the right means looking into the future and modelled
     pressures and flows"). A synthetic stream is re-timed once when it loads, by whole
     days so its hours of the day and gas days stay true, to put the wall-clock now as
     near its middle as whole days allow. Left of now is history, right of it the model
     looking ahead, and the player says which. Recorded real data keeps its own dates:
     all of it is history. The built page holds no wall-clock time; this runs in the
     browser. [screen] now_in_middle = false plays synthetic data at its own dates. */
  const DAY = 86400, NOW_SLACK = 300; // within 5 minutes of the wall clock reads as now
  const wallClock = () => Date.now() / 1000;
  function retime(stream) {
    if (stream.offset != null || !stream.synthetic || C.screen.now_in_middle === false || stream.times.length < 2) return;
    const middle = (stream.times[0] + stream.times[stream.times.length - 1]) / 2;
    const offset = Math.round((wallClock() - middle) / DAY) * DAY;
    stream.offset = offset;
    stream.times = stream.times.map((t) => t + offset);
    for (const event of stream.events || []) { event.start += offset; event.end += offset; }
    for (const pig of stream.pigs || []) pig.launch += offset;
  }
  // Where the wall clock falls in a re-timed stream, as a playhead position; else null.
  function nowPosition(s = live.stream) {
    if (!s || live.feed || s.offset == null) return null;
    return (wallClock() - s.times[0]) / s.step;
  }
  /* The playhead against the wall clock: seconds ahead of now, and whether what is
     shown is the model's. Null for recorded data and live feeds. */
  function timeState() {
    if (nowPosition() == null || live.time == null) return null;
    const ahead = live.time - wallClock();
    return { ahead, model: ahead > NOW_SLACK };
  }
  const spanText = (seconds) => {
    const s = Math.abs(seconds);
    return s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.round(s / 3600)} h`;
  };
  function timeText(ts) {
    if (!ts) return "";
    if (Math.abs(ts.ahead) <= NOW_SLACK) return "Now";
    return ts.model ? `Model · in ${spanText(ts.ahead)}` : `${spanText(ts.ahead)} ago`;
  }
  // The chip beside the clock, and a page-wide class so model numbers read as such.
  function showTime() {
    const ts = timeState(), when = $("when");
    if (live.frames.length) rulerLabels(timelineWindow());
    if (live.feed) {
      when.hidden = !live.stale;
      when.textContent = live.stale ? "Stale" : "";
      when.title = live.stale ? live.stale.text : "";
      when.classList.toggle("model", Boolean(live.stale));
      return;
    }
    when.hidden = !ts;
    when.textContent = timeText(ts);
    const away = Boolean(ts && Math.abs(ts.ahead) > NOW_SLACK);
    when.classList.toggle("away", away);
    when.setAttribute("tabindex", away ? "0" : "-1");
    when.setAttribute("role", away ? "button" : "status");
    when.title = away ? "Back to now" : "";
    // The centre of the timeline is the playhead: "Real time" only while it is now.
    if (ts) $("tl-now").textContent = Math.abs(ts.ahead) <= NOW_SLACK ? "Real time · UTC" : ts.model ? "Model · UTC" : "History · UTC";
    when.classList.toggle("model", Boolean(ts && ts.model));
    document.body.classList.toggle("model-time", Boolean(ts && ts.model));
  }
  function setStream(stream) {
    retime(stream);
    live.stream = prepare(stream);
    live.frames = stream.frames;
    live.typical = stream.typical;
    live.maxAbs = stream.maxAbs;
    const speeds = [...$("speed").options].map((o) => Number(o.value));
    live.speed = speeds.includes(Number(settings.speed))
      ? Number(settings.speed)
      : speeds.includes(C.screen.speed) ? C.screen.speed : speeds[0];
    // A daily or monthly dataset at 10 min/s would take minutes per step: play it at the
    // slowest speed that shows a step about every two seconds (the menu still changes it).
    if (stream.step / live.speed > 30) live.speed = speeds.find((v) => stream.step / v <= 2) || Math.max(...speeds);
    /* Data re-timed to now opens at now and, unless someone picked a speed, plays at
       nora.toml's now_speed: 10 min/s (Ray, 29 Oct: "10 min / s should be the default view
       when opening the page"). */
    if (stream.offset != null && !settings.speedChosen && speeds.includes(C.screen.now_speed)) live.speed = C.screen.now_speed;
    $("speed").value = String(live.speed);
    const half = timelineHalf(), retimed = stream.offset != null;
    scrub.min = String(-half);
    scrub.max = String(half);
    scrub.step = String(Math.max(3600, stream.step));
    scrub.value = "0";
    // Only re-timed synthetic data has the wall clock on it; a recording has the time chosen.
    $("tl-now").textContent = retimed ? "Real time · UTC" : "Selected time · UTC";
    const centre = retimed ? "Real time" : "The selected time", oneStep = spanLabel(Math.max(3600, stream.step));
    scrub.setAttribute("aria-label", `Move around ${retimed ? "real time" : "the selected time"}: ${spanLabel(half)} back or ahead`);
    if (scrub.parentElement) scrub.parentElement.title = `${centre} stays in the centre. Drag right for later values or left for earlier ones. Arrow keys move ${oneStep.replace(/^1 /, "one ")}.`;
    seek(retimed ? nowPosition() : 0); // synthetic data opens at now; recordings keep their start
  }
  function seek(position) {
    const s = live.stream;
    live.playhead = Math.max(0, Math.min(s.times.length - 1, position));
    live.index = Math.floor(live.playhead);
    live.down = {};
    live.peaks = [];
    live.onset = new Map();
    live.jumped = true;
    pigRuns.clear();
    replayQuality(live.index);
    trackTrips(frame());
    step();
  }
  function valuesAt(position) {
    const s = live.stream, i = Math.floor(position), f = position - i;
    const a = s.frames[i].flows, b = s.frames[Math.min(i + 1, s.frames.length - 1)].flows;
    if (!f) return a;
    const out = {};
    for (const [id, v] of Object.entries(a)) out[id] = b[id] === undefined ? v : v + (b[id] - v) * f;
    return out;
  }
  // Whenever the playhead moves: values, conditions, then every screen.
  function step() {
    if (live.stream && !live.feed) {
      live.values = valuesAt(live.playhead);
      live.time = live.stream.times[live.index] + (reduceMotion ? 0 : (live.playhead - live.index) * live.stream.step);
      scrub.value = "0"; // the selected real time remains at the centre of the window
    }
    prunePeaks();
    advanceQuality();
    evaluate();
    if (live.time != null) $("clock").textContent = formatTime(live.time);
    showTime();
    restyle();
    refreshScreens();
    if ((side.id || side.marker) && route.screen === "unit") renderSidebar();
    renderWhatifEditor(); // its numbers follow the hour the timeline shows
    drawSpark();
    drawInventory();
  }
  /* Total inventory (Ray, 29 Oct: "a trend showing total inventory in the whole system
     would be nice to see as well. it should be minimalistic"): the number now and a
     hairline over the last 24 hours, the model's next 4 hours dashed. */
  function drawInventory() {
    const box = $("inventory");
    if (!box || $("player").hidden) return;
    const now = inventory(frameNo(live.index));
    box.hidden = now == null;
    if (now == null) return;
    $("inventory-value").textContent = `${fmt(now)} MSm³`;
    const step = (live.stream && live.stream.step) || 3600, back = Math.round((24 * 3600) / step), ahead = Math.round((4 * 3600) / step);
    const points = [];
    for (let i = live.index - back; i <= live.index + ahead; i++) {
      if (i < 0 || i >= live.frames.length) continue;
      const v = inventory(live.frames[i]);
      if (v != null) points.push([i - live.index, v]);
    }
    if (points.length < 2) { $("inventory-spark").innerHTML = ""; return; }
    const values = points.map(([, v]) => v), lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1;
    const x = (k) => (((k + back) / (back + ahead)) * 96).toFixed(1), y = (v) => (19 - ((v - lo) / span) * 16).toFixed(1);
    const line = (part) => part.map(([k, v]) => `${x(k)},${y(v)}`).join(" ");
    const past = points.filter(([k]) => k <= 0), future = points.filter(([k]) => k >= 0);
    $("inventory-spark").innerHTML = `<polyline points="${line(past)}" fill="none" stroke="${COLORS.text}" stroke-width="1.2"/>`
      + (future.length > 1 ? `<polyline points="${line(future)}" fill="none" stroke="${COLORS.text_dim}" stroke-width="1.2" stroke-dasharray="3 2"/>` : "")
      + `<line x1="${x(0)}" y1="1" x2="${x(0)}" y2="21" stroke="${COLORS.text_dim}" stroke-width="1"/>`; // built from numbers and palette colours only
  }
  /* The selected time is the centre of the timeline: four data steps of history on the
     left and four ahead on the right, never less than four hours. Hourly data shows four
     hours either way, a daily dataset four days, a monthly one four months. */
  const timelineHalf = () => Math.max(4 * 3600, 4 * ((live.stream && live.stream.step) || 3600));
  const spanLabel = (seconds) => (seconds < 2 * 86400 ? `${Math.round(seconds / 3600)} h`
    : seconds < 60 * 86400 ? `${Math.round(seconds / 86400)} d` : `${Math.round(seconds / (30 * 86400))} mo`);
  /* The timeline (Ray, 29 Oct: "im not happy with how the timeline works and functions at
     the bottom and the feel and look of it. make up your own version and improve it"). A
     ruler over the whole dataset, or the 240 steps around the playhead of a longer one,
     that stays put while the data plays: history solid, the model's hours ahead dashed, a
     line at now and the playhead to drag or click to any time. Along it, the gas days and
     what is coming: alarms on the plan, pressures at their limits, outages and when each
     H₂S or CO₂ peak reaches its exit. The keys still step one data step at a time. */
  const RULER_STEPS = 240;
  function timelineWindow() {
    const frames = live.frames, n = frames.length;
    if (!n) { const now = live.time == null ? 0 : live.time; return { start: now - 1, now, end: now + 1 }; }
    let first = 0, last = n - 1;
    if (n > RULER_STEPS + 1) { // a page of the data around the playhead, moved a quarter at a time
      const quarter = RULER_STEPS / 4, at = live.feed ? n - 1 : live.playhead;
      first = Math.max(0, Math.min(n - 1 - RULER_STEPS, Math.floor((at - RULER_STEPS / 2) / quarter) * quarter));
      last = first + RULER_STEPS;
    }
    return { start: frames[first].t, now: live.time, end: Math.max(frames[last].t, frames[first].t + 1) };
  }
  const gasDayStart = (t) => timeFormat(t, { timeZone: "Europe/Oslo", hour: "2-digit", hourCycle: "h23" }) === "06";
  // The worst pressure limit each frame passes, kept per dataset (a frame's pressures do not change).
  const limitLevels = new WeakMap();
  function frameLimitLevel(f) {
    if (limitLevels.has(f)) return limitLevels.get(f);
    let worst = 0;
    for (const [id, p] of Object.entries((f.metrics || {}).pressure_bar || {})) {
      const mark = p == null || !assets[id] ? null : pressureMark(id, p);
      if (mark) worst = Math.max(worst, mark.level);
    }
    limitLevels.set(f, worst);
    return worst;
  }
  // The ruler's ends, said for screen readers (the ruler draws its days).
  function rulerLabels(win) {
    const day = (t) => timeFormat(t, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    $("tl-past").textContent = day(win.start);
    $("tl-future").textContent = day(win.end);
  }
  function drawSpark() {
    if ($("player").hidden) return;
    // The player is zoomed by the UI scale: draw at that resolution, or the track blurs.
    const ratio = (window.devicePixelRatio || 1) * display.scale, width = spark.clientWidth, height = spark.clientHeight;
    if (!width) return;
    spark.width = width * ratio;
    spark.height = height * ratio;
    const ctx = spark.getContext("2d");
    ctx.scale(ratio, ratio);
    const frames = live.frames, n = frames.length;
    if (n < 2) return;
    const win = timelineWindow(), span = win.end - win.start, x = (t) => ((t - win.start) / span) * width;
    const step = (live.stream && live.stream.step) || 3600, stepW = Math.max(1.5, (step / span) * width);
    const bar = 17, lane = 24; // the track's middle, and the row of what is coming
    // Days: a tick where each gas day starts (06:00 Norwegian time) and its name over it.
    ctx.font = "10px Archivo, system-ui, sans-serif";
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    const days = [];
    if (step < 86400) {
      for (let t = Math.ceil(win.start / 3600) * 3600; t <= win.end; t += 3600) if (gasDayStart(t)) days.push(t);
    }
    ctx.strokeStyle = COLORS.text_dim;
    ctx.lineWidth = 1;
    days.forEach((t, i) => {
      const left = x(t), right = i + 1 < days.length ? x(days[i + 1]) : x(t + 86400);
      ctx.beginPath(); ctx.moveTo(Math.round(left) + 0.5, 11); ctx.lineTo(Math.round(left) + 0.5, height); ctx.stroke();
      const label = timeFormat(t, { timeZone: "Europe/Oslo", weekday: "short", day: "numeric" }), mid = (Math.max(0, left) + Math.min(width, right)) / 2;
      if (Math.min(width, right) - Math.max(0, left) > ctx.measureText(label).width + 8) { ctx.fillStyle = COLORS.text_dim; ctx.fillText(label, mid, 0); }
    });
    // The track: history solid, the model's hours ahead dashed (what the model expects).
    const nowAt = timeState() ? wallClock() : null, nowX = nowAt == null ? width : Math.max(0, Math.min(width, x(nowAt)));
    ctx.fillStyle = COLORS.dots;
    ctx.fillRect(0, bar - 2, nowX, 4);
    if (nowX < width) {
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = COLORS.text_dim;
      ctx.strokeRect(nowX, bar - 2, width - nowX, 4);
      ctx.setLineDash([]);
    }
    // What is coming, under the track: the plan's alarms, pressures at their limits, outages.
    for (const f of frames) {
      if (f.t < win.start || f.t > win.end) continue;
      const lvl = Math.max(f.plan ? f.plan.now[0] : 0, frameLimitLevel(f) >= 2 ? 3 : frameLimitLevel(f) ? 1 : 0);
      if (!lvl) continue;
      ctx.globalAlpha = 0.8; // a thin row: strong colours sparingly (Ray, 29 Oct)
      ctx.fillStyle = LEVEL_COLOR[lvl];
      ctx.fillRect(x(f.t), lane + 1, stepW, 2.5);
      ctx.globalAlpha = 1;
    }
    for (const event of (live.stream && live.stream.events) || []) {
      if (event.end < win.start || event.start > win.end) continue;
      const left = Math.max(0, x(event.start)), right = Math.min(width, x(event.end));
      ctx.strokeStyle = COLORS.text;
      ctx.setLineDash(event.planned ? [3, 2] : []);
      ctx.strokeRect(left, lane - 1.5, Math.max(2, right - left), 7);
    }
    ctx.setLineDash([]);
    // When each H₂S or CO₂ peak reaches its exit: a dot in its gas's colour, ringed when it
    // arrives over a limit.
    for (const s of slugs()) {
      const at = s.exit ? s.exit.t : null;
      if (at == null || at < win.start || at > win.end) continue;
      ctx.beginPath();
      ctx.arc(x(at), lane + 2, 3, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[QUALITY[s.q.metric].color];
      ctx.fill();
      if (s.exitLevel) { ctx.strokeStyle = LEVEL_COLOR[s.exitLevel]; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1; }
    }
    // Now, and the playhead on top.
    if (nowAt != null && nowX > 0 && nowX < width) {
      ctx.fillStyle = COLORS.text_dim;
      ctx.fillRect(Math.round(nowX), 11, 1, height - 11);
    }
    if (live.time != null && live.time >= win.start && live.time <= win.end) {
      const px = x(live.time);
      ctx.fillStyle = COLORS.text;
      ctx.fillRect(px - 1, 11, 2, height - 11);
      ctx.beginPath();
      ctx.arc(px, bar, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLORS.panel || COLORS.paper;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  function play() {
    if (!live.stream && !live.feed) return;
    live.playing = true;
    document.body.classList.add("playing");
    $("play").setAttribute("aria-label", "Pause");
  }
  function pause() {
    live.playing = false;
    document.body.classList.remove("playing");
    $("play").setAttribute("aria-label", "Play");
  }
  $("play").addEventListener("click", () => (live.playing ? pause() : play()));
  scrub.addEventListener("input", () => {
    if (!live.stream || live.feed) return;
    const offset = Number(scrub.value); // seconds left/right of the real-time centre
    scrub.value = "0";
    if (offset) seek(live.playhead + offset / live.stream.step);
  });
  /* The ruler under the pointer: a click or a drag puts the playhead at that time (once a
     frame however fast the pointer moves), and the time under the pointer shows above it. */
  const track = spark.parentElement, rulerTip = h("div", { class: "ruler-tip", "aria-hidden": "true" });
  rulerTip.hidden = true;
  if (track) track.append(rulerTip);
  let dragging = false, wanted = null;
  const rulerTime = (clientX) => {
    const r = spark.getBoundingClientRect(), win = timelineWindow();
    return win.start + Math.max(0, Math.min(1, (clientX - r.left) / (r.width || 1))) * (win.end - win.start);
  };
  function showTip(clientX) {
    if (!live.frames.length || !track) return;
    const t = rulerTime(clientX), r = spark.getBoundingClientRect(), ahead = timeState() ? t - wallClock() : null;
    rulerTip.textContent = `${timeFormat(t, { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}${ahead != null && ahead > NOW_SLACK ? " · model" : ""}`;
    rulerTip.style.left = `${(((clientX - r.left) / (r.width || 1)) * 100).toFixed(2)}%`;
    rulerTip.hidden = false;
  }
  function seekTime(t, now = false) {
    const s = live.stream;
    if (!s || live.feed) return;
    if (now) { wanted = null; seek((t - s.times[0]) / s.step); return; }
    if (wanted == null) requestAnimationFrame(() => { const at = wanted; wanted = null; if (at != null) seek((at - s.times[0]) / s.step); });
    wanted = t;
  }
  if (track) {
    track.addEventListener("pointerdown", (e) => {
      if (!live.stream || live.feed || e.button > 0) return;
      dragging = true;
      if (track.setPointerCapture) track.setPointerCapture(e.pointerId);
      seekTime(rulerTime(e.clientX), true);
      showTip(e.clientX);
    });
    track.addEventListener("pointermove", (e) => { if (dragging) seekTime(rulerTime(e.clientX)); showTip(e.clientX); });
    const release = () => { dragging = false; };
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", release);
    track.addEventListener("pointerleave", () => { if (!dragging) rulerTip.hidden = true; });
  }
  // "Model · in 6 h" or "3 h ago" beside the clock is also the way back to now.
  const backToNow = () => { const at = nowPosition(); if (at != null && live.stream) seek(at); };
  $("when").addEventListener("click", backToNow);
  $("when").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); backToNow(); } });
  $("speed").addEventListener("change", (e) => {
    live.speed = Number(e.target.value);
    settings.speed = live.speed;  // remembered with the other settings, and in ?s= links
    settings.speedChosen = true;  // a chosen speed also holds for data re-timed to now
    saveSettings();
  });
  $("stream-select").addEventListener("change", (e) => setStream(NORA.streams.find((s) => s.name === e.target.value)));

  let lastTick = 0, lastStep = 0;
  function tick(now) {
    frameApi.end(); // a draw that threw must not leave the cache on
    const dt = lastTick ? Math.min(0.25, (now - lastTick) / 1000) : 0;
    lastTick = now;
    if (live.playing) {
      live.clock += dt;
      if (live.stream && !live.feed) {
        const s = live.stream;
        live.playhead += (dt * live.speed) / s.step;
        if (live.playhead >= s.times.length - 1) seek(0);
        const i = Math.floor(live.playhead);
        if (i !== live.index) {
          const previous = live.frames[live.index];
          for (let k = live.index + 1; k <= i; k++) spawnQuality(live.frames[k - 1], live.frames[k]);
          live.index = i;
          trackTrips(frame());
          spawnPeaks(previous, frame());
        }
        // With reduced motion, markers move in the data's own steps, not in between.
        live.time = s.times[live.index] + (reduceMotion ? 0 : (live.playhead - live.index) * s.step);
        if (now - lastStep > 250) { lastStep = now; step(); }
      } else if (live.feed && glideFeed(dt) && now - lastStep > 250) { lastStep = now; step(); }
    } else if (now - lastStep > 30000) {
      // Paused, the wall clock still moves: keep "Now" / "3 h ago" and the now tick true.
      lastStep = now;
      showTime();
      drawSpark();
    }
    // A feed that goes quiet without an error is stale too: three missed frames, at least a minute.
    if (live.feed && !live.stale && live.frameGap && Date.now() - live.lastFrameWall > Math.max(60000, 3 * live.frameGap)) {
      feedTrouble(`No new data for ${spanText((Date.now() - live.lastFrameWall) / 1000)}`);
    }
    if (route.screen === "unit") for (const view of shownViews()) if (view.ready) view.draw();
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ live feed
  /* The feeds ?live= may connect to: this site (`nora live` serves the page and its
     feed together) or this computer. Any other site is refused, so a link to the public
     page cannot show someone else's numbers and alarms as NORA's live data. */
  const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
  function liveFeedUrl(value) {
    let url;
    try { url = new URL(value, location.href); } catch (error) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    const here = new URL(location.href);
    return url.origin === here.origin || LOCAL_HOSTS.includes(url.hostname) ? url.href : null;
  }
  function connectFeed(url) {
    live.feed = new EventSource(url);
    live.stream = null;
    document.body.classList.add("feed-mode");
    const select = $("stream-select");
    select.replaceChildren(h("option", null, "Connecting to the live feed"));
    select.disabled = true;
    $("speed").parentElement.hidden = true;
    $("tl-past").textContent = "Live feed";
    $("tl-future").textContent = "UTC";
    live.feed.addEventListener("meta", (message) => {
      const meta = JSON.parse(message.data);
      receiveMeta(meta);
      select.replaceChildren(h("option", null, `${meta.title || "Live feed"} (live)`));
    });
    live.feed.addEventListener("frame", (message) => receiveFrame(JSON.parse(message.data)));
    /* `error` is both the server's own event (it could not read its source: the data
       says why) and the browser's (the connection dropped; it reconnects by itself). */
    live.feed.addEventListener("error", (event) => {
      let text = "Connection to the live feed lost; reconnecting";
      if (event && typeof event.data === "string") {
        try { const d = JSON.parse(event.data); text = `${d.source || "Live source"}: ${d.error || "no data"}`; } catch (error) { /* keep the general text */ }
      }
      feedTrouble(text);
    });
  }
  /* One frame from the live feed. Frames must rise in time: routes, the gas day's
     delivery and peaks all assume it. A frame older than the last one means the feed
     started over (a replay looped, or the server restarted and the browser
     reconnected), so a new timeline begins; one with the same time replaces it. */
  function receiveMeta(meta) {
    live.feedEvents = meta.events || [];
    live.feedPigs = meta.pigs || [];
    // A feed re-timed to the wall clock (`nora live --now`) says how fast its clock runs.
    live.feedSpeed = meta.retimed && meta.retimed.speed > 0 ? meta.retimed.speed : null;
  }
  /* Between a re-timed feed's frames the clock runs on at the feed's speed, so pigs and
     peaks glide instead of jumping once an hour; never past one step beyond the last
     frame, where the next one is due. The values stay the last frame's. */
  function glideFeed(dt) {
    const n = live.frames.length;
    if (!live.feedSpeed || !n || live.stale) return false;
    const last = live.frames[n - 1], gap = n > 1 ? last.t - live.frames[n - 2].t : 3600;
    const next = Math.min(last.t + gap, Math.max(live.time ?? last.t, last.t) + dt * live.feedSpeed);
    if (next === live.time) return false;
    live.time = next;
    return true;
  }
  function receiveFrame(f) {
    const last = live.frames[live.frames.length - 1], entry = { t: f.t, flows: f.values, metrics: f.metrics || {}, plan: f.plan || null };
    if (last && f.t < last.t) {
      live.frames = []; live.peaks = []; live.quality = []; live.slugs = new Map(); live.down = {};
      live.onset = new Map(); live.jumped = true;
      pigRuns.clear();
    }
    for (const [id, v] of Object.entries(f.values)) {
      live.typical[id] = Math.max((live.typical[id] || 0) * 0.995, Math.abs(v));
      live.maxAbs = Math.max(live.maxAbs, Math.abs(v));
    }
    const wall = Date.now();
    if (live.lastFrameWall) live.frameGap = wall - live.lastFrameWall;
    live.lastFrameWall = wall;
    live.stale = null; // fresh data
    const same = last && live.frames.length && f.t === last.t;
    const previous = same ? null : live.frames[live.frames.length - 1];
    if (same) live.frames[live.frames.length - 1] = entry;
    else live.frames.push(entry);
    if (live.frames.length > 240) live.frames.shift();
    pigRuns.clear(); // the runs are worked out again with this step; what is past stays as it was
    live.index = live.frames.length - 1;
    live.values = f.values;
    live.time = f.t;
    trackTrips(frame());
    if (previous) { spawnPeaks(previous, frame()); spawnQuality(previous, frame()); }
    if (!live.playing) play();
    step();
  }
  /* The feed is in trouble: the last frame stays on screen, marked stale and raised
     as an alarm, never passed off as live data. */
  function feedTrouble(text) {
    if (live.stale && live.stale.text === text) return;
    live.stale = { text, since: live.lastFrameWall || Date.now() };
    step();
  }

