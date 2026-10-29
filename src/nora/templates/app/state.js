  // ------------------------------------------------------------------ settings
  const DEFAULT_SETTINGS = {
    names: C.labels.names,
    lineValues: C.labels.line_values,
    pack: C.labels.pack,
    pressureChange: C.labels.pressure_change,
    temperature: C.labels.temperature,
    pigs: C.markers.pigs,
    gasQuality: C.markers.gas_quality,
    hide: C.assets.hide,
    gridEntries: C.assets.grid_entries,
    density: C.flow.density,
    animation: C.flow.animation,
    speed: C.screen.speed || 60,  // default playback: data seconds per real second
    display: C.screen.display || "auto", // auto, desk, wall or compact
    scale: "auto", // UI size: auto or a factor such as 1.25
  };
  function readSettings() {
    let saved = {}, shared = {};
    try { saved = JSON.parse(localStorage.getItem("nora-settings") || "{}"); } catch (error) { saved = {}; }
    try { if (params.get("s")) shared = JSON.parse(atob(params.get("s"))); } catch (error) { shared = {}; }
    const merged = { ...DEFAULT_SETTINGS, ...saved, ...shared };
    if (!Array.isArray(merged.hide)) merged.hide = [];
    return merged;
  }
  let settings = readSettings();
  function saveSettings() {
    try { localStorage.setItem("nora-settings", JSON.stringify(settings)); } catch (error) { /* private mode */ }
  }

  // ------------------------------------------------------------------ display
  /* Control-room display profiles (issue #59). The same page runs on a video wall read
     from metres away, at an operator desk and on a tablet. One UI scale drives the
     chrome (CSS zoom on the bars, player, sidebar, sheets and screens), and the views
     read App.uiScale() for whatever they draw in screen pixels. Auto picks the profile
     and the scale from the window; ?display= and ?scale=, or Settings, override them. */
  const PROFILES = ["desk", "wall", "compact"];
  const autoProfile = (width) => (width < 900 ? "compact" : width >= 3000 ? "wall" : "desk");
  // 1 up to 1920 px wide, rising to 1.5 at 3840 and 2.2 at 7680 (a 4×2 wall of 1080p cubes).
  function autoScale(width) {
    if (width <= 1920) return 1;
    if (width <= 3840) return 1 + (0.5 * (width - 1920)) / 1920;
    return Math.min(2.2, 1.5 + (0.7 * (width - 3840)) / 3840);
  }
  const display = { profile: null, scale: 1 };
  function chosenProfileFor(asked) { return PROFILES.includes(asked) ? asked : autoProfile(window.innerWidth); }
  const chosenProfile = () => chosenProfileFor(params.get("display") || settings.display);
  function chosenScale(profile) {
    let asked = Number(params.get("scale") || (settings.scale === "auto" ? NaN : settings.scale));
    if (asked > 4) asked /= 100; // ?scale=150 means 150 %
    return asked >= 0.75 && asked <= 4 ? asked : autoScaleFor(profile);
  }
  /* A wall is read from metres away (review #49802: desk × 1.5 read to about 1.5 m).
     Control-room practice (ISO 9241-303, ISA-101) wants capitals of about 20 arcmin at
     the reading distance; a browser cannot measure the screen, so nora.toml says how far
     it is read from and how wide its picture is. 13 px Archivo has capitals of ~9 px.
     A 4 m wide 3840 px wall read from 5 m comes to about 3. */
  function wallScale(width) {
    const distance = C.screen.wall_distance_m || 5, wide = C.screen.wall_width_m || 4;
    const capital = distance * 1000 * Math.tan((20 / 60) * (Math.PI / 180)); // mm
    const perPixel = (wide * 1000) / width; // mm per CSS pixel
    return Math.min(4, Math.max(1.5, capital / perPixel / 9));
  }
  const autoScaleFor = (profile) => (profile === "wall" ? wallScale(window.innerWidth) : autoScale(window.innerWidth));
  // Returns true when the profile or scale changed, so the views can re-fit.
  /* The bar is one row while it fits (Ray, 29 Oct: "everything here should be on one
     line"). The UI scale zooms it, so a 1440 px wall screen at 1.5 has 960 px of room:
     the fit is judged on that, which a media query cannot see. */
  function barLayout(scale) {
    const room = window.innerWidth / scale;
    document.documentElement.dataset.bar = room < 1060 ? "two" : room < 1240 ? "tight" : "one";
  }
  /* Two rows may still not hold the bar on a phone: measure what its rows need, so no
     control is cut off above the screen and the screens start below the bar. */
  function fitBar(scale) {
    const root = document.documentElement, bar = document.querySelector(".bar");
    if (!bar) return;
    root.style.removeProperty("--bar-h");
    if (root.dataset.bar !== "two") return;
    bar.style.height = "auto";
    const needed = Math.ceil(bar.getBoundingClientRect().height / scale) + 16;
    bar.style.height = "";
    if (needed > parseFloat(getComputedStyle(root).getPropertyValue("--bar-h"))) root.style.setProperty("--bar-h", `${needed}px`);
  }
  function applyDisplay() {
    const profile = chosenProfile(), scale = Math.round(chosenScale(profile) * 100) / 100;
    barLayout(scale);
    const changed = profile !== display.profile || scale !== display.scale;
    if (changed) {
      display.profile = profile;
      display.scale = scale;
      document.documentElement.dataset.display = profile;
      document.documentElement.style.setProperty("--ui-scale", String(scale));
    }
    fitBar(scale);
    return changed;
  }
  applyDisplay();
  // The web font changes how much room the bar's text takes: fit it again once loaded.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitBar(display.scale));
  // Control rooms are dim: a wall starts dark unless the link or the operator chose.
  if (display.profile === "wall" && !params.get("theme") && !storedTheme() && theme !== "dark") {
    theme = "dark";
    applyPalette();
  }
  // ------------------------------------------------------------------ indexes
  const nodeIds = Object.keys(assets).filter((id) => assets[id].kind === "node").sort();
  const pipeIds = Object.keys(assets).filter((id) => assets[id].kind === "pipeline").sort();
  const markets = new Set(nodeIds.filter((id) => assets[id].type === "market"));
  const exitPoints = nodeIds.filter((id) => assets[id].type === "terminal");
  const maxCapacity = Math.max(1, ...pipeIds.map((id) => assets[id].capacity || 0));
  const worst = NORA.worstOutage || 1;
  const unitOf = {};
  for (const unit of NORA.units) {
    for (const id of unit.nodes) unitOf[id] = unit.id;
    for (const id of unit.pipelines) unitOf[id] = unit.id;
  }
  const unitById = Object.fromEntries(NORA.units.map((u) => [u.id, u]));
  function visible(id) {
    const d = assets[id];
    if (!yearActive(id)) return false;
    if (d.kind === "node") return !settings.hide.includes(d.type);
    if (d.type === "onshore" && !settings.gridEntries) return false;
    return !settings.hide.includes(assets[d.from].type) && !settings.hide.includes(assets[d.to].type);
  }

  // ------------------------------------------------------------------ state
  const route = { screen: "overview", unit: "all", asset: null, focus: null };
  const state = { view: C.screen.network_view, mode: C.screen.network_mode, year: null };

  // ---------------------------------------------------------------- the year shown
  /* The network as it stands this year: planned assets appear from their startup year,
     decommissioned ones are gone from their shutdown year (a blank year: always there).
     Ray removed the year slider (29 Oct), so this is today's year, in the browser. */
  function yearActive(id) {
    const d = assets[id], year = state.year;
    if (year == null) return true;
    if (d.kind === "pipeline") return yearActive(d.from) && yearActive(d.to);
    return !(d.startup && year < d.startup) && !(d.shutdown && year >= d.shutdown);
  }
  const live = {
    stream: null, // recorded stream being replayed
    feed: null, // EventSource when connected to a live feed
    frames: [], // [{t, flows, metrics, plan}], recorded or received from the feed
    playhead: 0,
    index: -1,
    playing: false,
    speed: 3600,
    clock: 0,
    time: null,
    values: {}, // flows at the playhead, interpolated between frames
    maxAbs: 1,
    typical: {},
    down: {}, // pipelines whose flow has collapsed
    peaks: [], // flow changes travelling down pipelines
    quality: [], // parcels of H₂S or CO₂-rich gas travelling with the flow
    slugs: new Map(), // slug -> {origin, metric, first, last, volume, max}: what each slug is
    conditions: [], // active abnormal conditions, worst first (shelved ones left out)
    shelved: [], // active conditions an operator has shelved for a while
    levelOf: {}, // asset -> worst active level
    onset: new Map(), // `${kind}|${id}` -> when that alarm began ({t, before})
    jumped: true, // the playhead jumped (a seek, a new stream): onsets start over
  };
  const frame = () => live.frames[Math.max(0, live.index)] || { flows: {}, metrics: {}, plan: null };
  const metric = (name, id, f = frame()) => ((f.metrics || {})[name] || {})[id];

