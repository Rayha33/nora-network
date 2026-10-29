  // ------------------------------------------------------------------ editing the network
  /* The edits themselves are at the top (applyEdit): here are the right-click actions,
     the forms for a new node or line, and the bar that lists the changes with Undo,
     Save and Discard. An edit reloads the page with the view kept, so every index is
     rebuilt from the edited NORA. */
  const slug = (text) => text.toLowerCase().replace(/ø/g, "o").replace(/æ/g, "ae").normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
  function uniqueId(name) {
    const base = slug(name);
    let id = base;
    for (let n = 2; assets[id]; n++) id = `${base}_${n}`;
    return id;
  }
  function reloadKeepingView() {
    try {
      const flow = views.flow && views.flow.ready && views.flow.viewport ? views.flow.viewport() : null;
      sessionStorage.setItem("nora-restore", JSON.stringify({ view: state.view, mode: state.mode, flow }));
    } catch (error) { /* a plain reload then */ }
    if (location.reload) location.reload();
  }
  function takeRestore() {
    try {
      const restore = JSON.parse(sessionStorage.getItem("nora-restore") || "null");
      sessionStorage.removeItem("nora-restore");
      return restore;
    } catch (error) { return null; }
  }
  let restored = null; // read once at start; the Flow view takes its viewport
  function commitEdit(step) {
    edits.push(step);
    if (!storeEdits(edits)) { edits.pop(); editNote("This browser does not keep edits: its storage is blocked."); return; }
    reloadKeepingView();
  }
  /* A node dragged in the Flow view: its new place, kept like any edit but without a
     reload (only the drawing moves). Dragging the same node again updates that step. */
  function commitMove(id, grid) {
    const last = edits[edits.length - 1], step = { op: "moveNode", id, grid };
    if (last && last.op === "moveNode" && last.id === id) edits[edits.length - 1] = step;
    else edits.push(step);
    NORA.grid[id] = grid;
    storeEdits(edits);
    confirmDiscard = false;
    renderEditsBar();
  }
  function undoEdit() { edits.pop(); storeEdits(edits); reloadKeepingView(); }
  function discardEdits() { edits.length = 0; storeEdits(edits); reloadKeepingView(); }

  function openForm(title, sub, form) {
    side.id = null;
    side.marker = null;
    side.form = true;
    $("side-title").textContent = title;
    $("side-sub").textContent = sub;
    $("side-body").replaceChildren(form);
    $("asset-side").classList.add("open");
    $("asset-side").setAttribute("aria-hidden", "false");
    const first = form.querySelector && form.querySelector("input");
    if (first && first.focus) first.focus();
  }
  const field = (label, input, hint) => h("label", { class: "field" }, h("span", null, label), input, hint ? h("small", null, hint) : null);
  const formActions = (submit) => h("div", { class: "actions" },
    h("button", { type: "submit", class: "primary" }, submit),
    h("button", { type: "button", onclick: closeSidebar }, "Cancel"));
  /* A new node where the Flow view was right-clicked (`grid`: its stage and rank). The
     nearest node lends its unit, country and position as a start: the Map needs real
     coordinates, so they are asked for. */
  function openNodeForm({ grid, near }) {
    const anchor = near && assets[near];
    const name = h("input", { name: "name", autocomplete: "off", placeholder: "e.g. Snorre" });
    const type = h("select", { name: "type" }, ...Object.entries(NORA.nodeTypes).map(([key, label]) => h("option", { value: key }, label)));
    const unit = h("select", { name: "unit" }, ...NORA.units.map((u) => h("option", { value: u.id }, u.name)));
    if (anchor) unit.value = unitOf[near] || NORA.units[0].id;
    const lat = h("input", { name: "lat", type: "number", step: "0.001" });
    const lon = h("input", { name: "lon", type: "number", step: "0.001" });
    const country = h("input", { name: "country", maxlength: "2" });
    lat.value = anchor ? anchor.lat.toFixed(3) : "";
    lon.value = anchor ? anchor.lon.toFixed(3) : "";
    country.value = anchor ? anchor.country : "NO";
    const capacity = h("input", { name: "capacity", type: "number", step: "0.1", min: "0", placeholder: "MSm³/d" });
    const note = h("p", { class: "form-note", role: "alert" });
    const form = h("form", {
      class: "edit-form",
      onsubmit: (event) => {
        event.preventDefault();
        const node = {
          name: name.value.trim(), type: type.value, unit: unit.value, country: country.value.trim().toUpperCase(),
          lat: Number(lat.value), lon: Number(lon.value), capacity: capacity.value === "" ? null : Number(capacity.value), grid,
        };
        const problem = !node.name ? "Give the node a name."
          : lat.value === "" || !(node.lat >= -90 && node.lat <= 90) ? "Latitude is in °N, from -90 to 90."
          : lon.value === "" || !(node.lon >= -180 && node.lon <= 180) ? "Longitude is in °E (west is negative), from -180 to 180."
          : !/^[A-Z]{2}$/.test(node.country) ? "The country is two letters, such as NO or GB."
          : NORA.supplyTypes.includes(node.type) && !(node.capacity > 0) ? `${NORA.nodeTypes[node.type]}: give its capacity in MSm³/d.`
          : null;
        if (problem) { note.textContent = problem; return; }
        commitEdit({ op: "addNode", node: { id: uniqueId(node.name), ...node } });
      },
    },
    field("Name", name), field("Type", type), field("Unit", unit),
    h("div", { class: "field-pair" }, field("Latitude °N", lat), field("Longitude °E", lon, "West is negative")),
    h("div", { class: "field-pair" }, field("Country", country), field("Capacity MSm³/d", capacity, "Needed for fields")),
    note, formActions("Add node"));
    openForm("New node", anchor ? `Placed near ${anchor.name}; connect it with a right-click` : "Connect it with a right-click", form);
  }
  // A new line between two nodes (from the Flow view's "Connect to another node…").
  function openLineForm(from, to) {
    const name = h("input", { name: "name", autocomplete: "off" });
    name.value = `${nameOf(from)} – ${nameOf(to)}`;
    const type = h("select", { name: "type" }, ...Object.entries(NORA.pipelineTypes).map(([key, label]) => h("option", { value: key }, label)));
    type.value = "feeder";
    const capacity = h("input", { name: "capacity", type: "number", step: "0.1", min: "0", placeholder: "MSm³/d" });
    const twoWay = h("input", { name: "bidirectional", type: "checkbox" });
    const note = h("p", { class: "form-note", role: "alert" });
    const existing = pipeIds.find((pid) => [assets[pid].from, assets[pid].to].sort().join() === [from, to].sort().join());
    if (existing) note.textContent = `${nameOf(existing)} already joins these two.`;
    const form = h("form", {
      class: "edit-form",
      onsubmit: (event) => {
        event.preventDefault();
        const line = { name: name.value.trim(), from, to, type: type.value, capacity: capacity.value === "" ? null : Number(capacity.value), bidirectional: twoWay.checked };
        if (!line.name) { note.textContent = "Give the line a name."; return; }
        if (from === to) { note.textContent = "A line joins two different nodes."; return; }
        commitEdit({ op: "addLine", line: { id: uniqueId(line.name), ...line } });
      },
    },
    field("Name", name), field("Type", type), field("Capacity MSm³/d", capacity, "Leave empty if unknown"),
    h("label", { class: "field check" }, twoWay, h("span", null, "Gas can flow both ways")),
    note, formActions("Add line"));
    openForm("New line", `${nameOf(from)} to ${nameOf(to)}`, form);
  }

  /* The data files with the edits in: the rows nobody touched stay exactly as they are
     (NORA.sources is the files as built), removed rows go, new rows are appended. */
  const csvField = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  function editedCsv(name, kind, row) {
    const source = NORA.sources[name] || "";
    const lines = source.split(/\r?\n/), header = lines[0].split(",");
    const kept = lines.slice(1).filter((line) => line.trim() && assets[line.split(",")[0]] && assets[line.split(",")[0]].kind === kind);
    const added = Object.keys(assets).filter((id) => assets[id].kind === kind && assets[id].edited)
      .map((id) => header.map((column) => csvField(row(id)[column])).join(","));
    return [lines[0], ...kept, ...added].join("\n") + "\n";
  }
  const nodeRow = (id) => {
    const d = assets[id];
    return { id, name: d.name, type: d.type, country: d.country, lat: d.lat, lon: d.lon, operator: "", capacity_msm3d: d.capacity,
      status: "operating", startup: null, shutdown: null, source: "", notes: "Added in the NORA editor" };
  };
  const lineRow = (id) => {
    const d = assets[id];
    return { id, name: d.name, from: d.from, to: d.to, type: d.type, length_km: null, diameter_in: null, capacity_msm3d: d.capacity,
      bidirectional: d.bidirectional ? "true" : "false", commissioned: null, status: "operating", operator: "", source: "", notes: "Added in the NORA editor" };
  };
  function editedUnits() {
    const source = NORA.sources["units.toml"] || "", start = source.indexOf("[units.");
    const head = start >= 0 ? source.slice(0, start) : "";
    const list = (ids) => { // one line when it fits, else wrapped as the file is (edit.py)
      const items = ids.map((n) => JSON.stringify(n)), line = `nodes = [${items.join(", ")}]`;
      if (line.length <= 100) return line;
      const rows = [];
      let row = "   ";
      for (const item of items) {
        if (row.length + item.length + 2 > 92) { rows.push(row.trimEnd()); row = "   "; }
        row += ` ${item},`;
      }
      rows.push(row.trimEnd());
      return `nodes = [\n${rows.join("\n")}\n]`;
    };
    return head + NORA.units.map((u) => `[units.${u.id}]\nname = ${JSON.stringify(u.name)}\n${list(u.nodes)}\n`).join("\n");
  }
  /* flow_layout.toml: the lines of moved and added nodes rewritten (or added), those of
     removed nodes dropped, everything else as it was (edit.edit_layout does the same). */
  function editedLayout() {
    let text = NORA.sources["flow_layout.toml"] || "[positions]\n";
    const at = (id) => `${id} = [${NORA.grid[id][1]}, ${NORA.grid[id][0]}]`;
    const line = (id) => new RegExp(`^${id} = \\[[^\\]]*\\][^\\n]*\\n?`, "m");
    for (const step of edits) {
      const id = step.op === "moveNode" ? step.id : step.op === "addNode" ? step.node.id : null;
      if (step.op === "removeNode") text = text.replace(line(step.id), "");
      else if (id && assets[id]) text = line(id).test(text) ? text.replace(line(id), `${at(id)}\n`) : `${text.replace(/\n*$/, "\n")}${at(id)}\n`;
    }
    return text;
  }
  const editedFiles = () => ({
    "nodes.csv": editedCsv("nodes.csv", "node", nodeRow), "pipelines.csv": editedCsv("pipelines.csv", "pipeline", lineRow),
    "units.toml": editedUnits(), "flow_layout.toml": editedLayout(),
  });
  // The full network for `nora serve --edit` (POST api/save): its rows, with the edits.
  function editedNetwork(current) {
    let nodeRows = current.nodes.slice(), lineRows = current.pipelines.slice();
    const units = {};
    for (const step of edits) {
      if (step.op === "removeNode") {
        nodeRows = nodeRows.filter((n) => n.id !== step.id);
        lineRows = lineRows.filter((p) => p.from !== step.id && p.to !== step.id);
      } else if (step.op === "removeLine") lineRows = lineRows.filter((p) => p.id !== step.id);
      else if (step.op === "addNode" && assets[step.node.id]) { nodeRows.push(nodeRow(step.node.id)); units[step.node.id] = unitOf[step.node.id]; }
      else if (step.op === "addLine" && assets[step.line.id]) lineRows.push(lineRow(step.line.id));
    }
    for (const id of Object.keys(units)) if (!nodeRows.some((n) => n.id === id)) delete units[id];
    const layout = {}; // [across, down] of every node added or moved
    for (const step of edits) {
      const id = step.op === "moveNode" ? step.id : step.op === "addNode" ? step.node.id : null;
      if (id && NORA.grid[id] && nodeRows.some((n) => n.id === id)) layout[id] = [NORA.grid[id][1], NORA.grid[id][0]];
    }
    return { revision: current.revision, nodes: nodeRows, pipelines: lineRows, units, layout };
  }
  /* Save: served by `nora serve --edit` (make edit), the edits go straight into data/
     and the site rebuilds; anywhere else (a file, the hosted site) the three files download,
     ready to put in data/ and commit. */
  async function saveEdits() {
    editNote("Saving…");
    let current = null;
    try {
      const response = await fetch("api/network", { cache: "no-store" });
      if (response.ok) current = await response.json();
    } catch (error) { current = null; }
    if (!current) { downloadEdits(); return; }
    // Hosted (NORA_EDIT_TOKEN on the server), a save carries the edit key: asked for once
    // and kept in this browser (Ray: "i will later host this solution").
    const send = (key) => fetch("api/save", {
      method: "POST", body: JSON.stringify(editedNetwork(current)),
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    try {
      let key = null;
      try { key = localStorage.getItem("nora-edit-key"); } catch (error) { key = null; }
      let response = await send(key);
      if (response.status === 401 && typeof window.prompt === "function") {
        key = window.prompt("This NORA server needs its edit key to save:") || "";
        if (key) { try { localStorage.setItem("nora-edit-key", key); } catch (error) { /* asked again next time */ } response = await send(key); }
      }
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.saved) { edits.length = 0; storeEdits(edits); reloadKeepingView(); return; }
      if (response.status === 401) { try { localStorage.removeItem("nora-edit-key"); } catch (error) { /* nothing kept */ } }
      editNote(`Not saved: ${(result.problems || [result.error || response.statusText]).join("; ")}`);
    } catch (error) { editNote(`Not saved: ${error.message}`); }
  }
  function downloadEdits() {
    for (const [name, text] of Object.entries(editedFiles())) {
      const link = h("a", { href: URL.createObjectURL(new Blob([text], { type: "text/plain" })), download: name });
      document.body.append(link);
      link.click();
      link.remove();
    }
    editNote("Downloaded nodes.csv, pipelines.csv, units.toml and flow_layout.toml for data/. `make edit` saves straight to data/ and also clears removed assets from the streams.");
  }
  let editsBar = null, editMessage = "", confirmDiscard = false;
  function editNote(text) { editMessage = text; renderEditsBar(); }
  /* The edits bar shows only in Edit (Ray, 29 Oct, of "13 changes to the network kept in
     this browser until saved": "what is the purpose of this? maybe remove it?"). Edits are
     made in Edit, where the bar lists them with Undo, Save and Discard. */
  function renderEditsBar() {
    if (!edits.length || state.mode !== "edit") { if (editsBar) { editsBar.remove(); editsBar = null; } return; }
    if (!editsBar) {
      editsBar = h("div", { class: "edits-bar", role: "status", "aria-live": "polite" });
      document.body.append(editsBar);
    }
    const button = (label, act, cls) => h("button", { type: "button", class: cls, onclick: act }, label);
    editsBar.replaceChildren(
      h("span", { class: "count" }, `${edits.length} ${edits.length === 1 ? "change" : "changes"} to the network`),
      h("span", { class: "dim" }, editMessage || "kept in this browser until saved"),
      button("Undo", undoEdit),
      button("Save", saveEdits, "primary"),
      confirmDiscard ? button("Discard all?", discardEdits, "danger") : button("Discard", () => { confirmDiscard = true; renderEditsBar(); }),
    );
  }

  // A mode tab: what the lines show (and Edit, where the network can be changed).
  function setMode(mode) {
    state.mode = mode;
    markTabs();
    restyle();
    renderWhatif();
    renderEditsBar();
    renderSidebar();
    if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
  }
  function markTabs() {
    for (const tab of document.querySelectorAll("[data-view]")) tab.setAttribute("aria-selected", String(tab.dataset.view === state.view));
    for (const tab of document.querySelectorAll("[data-mode]")) tab.setAttribute("aria-selected", String(tab.dataset.mode === state.mode));
  }

  function start() {
    $("update").addEventListener("click", () => location.reload());
    if (BUILD) setInterval(checkBuild, 5 * 60 * 1000);
    $("crumb-overview").addEventListener("click", () => go({ screen: "overview" }));
    $("crumb-asset").addEventListener("click", () => go({ screen: "asset", asset: route.asset }));
    $("theme-toggle").addEventListener("click", () => setTheme(theme === "light" ? "dark" : "light"));
    $("side-close").addEventListener("click", closeSidebar);
    addEventListener("keydown", (e) => { if (e.key === "Escape" && (side.id || side.marker || side.form)) closeSidebar(); });
    addEventListener("click", closeMenu);
    addEventListener("resize", closeMenu);
    addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); closePops(); } });
    for (const tab of document.querySelectorAll("[data-view]")) {
      tab.addEventListener("click", () => {
        state.view = tab.dataset.view;
        markTabs();
        // The bar is identical on every page: a view tab from another screen opens it.
        if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
        else render();
      });
    }
    for (const tab of document.querySelectorAll("[data-mode]")) tab.addEventListener("click", () => setMode(tab.dataset.mode));
    addEventListener("resize", () => {
      if (applyDisplay()) { // a window dragged to another screen may change profile or scale
        buildSettings();
        for (const view of Object.values(views)) if (view.ready && view.applySettings) view.applySettings();
      }
      displayChanged();
    });
    if (embed) document.body.classList.add("embed");
    if (views[params.get("view")]) state.view = params.get("view");
    if (["live", "load", "risk", "whatif", "plain", "edit"].includes(params.get("mode"))) state.mode = params.get("mode");
    state.year = new Date().getFullYear();
    restored = takeRestore(); // after an edit: the same view and mode as before the reload
    if (restored) {
      if (views[restored.view]) state.view = restored.view;
      if (["live", "load", "risk", "whatif", "plain", "edit"].includes(restored.mode)) state.mode = restored.mode;
    }
    renderEditsBar();
    markTabs();
    renderWhatif();
    buildKey();
    buildSettings();
    if (!embed && !storedFlag("nora-guide-seen")) openGuide();
    const feed = params.has("live") ? liveFeedUrl(params.get("live")) : null;
    if (params.has("live") && !feed) console.warn(`NORA: live feed ${params.get("live")} refused: only this site or this computer can feed the page`);
    if (NORA.streams.length || feed) {
      document.body.classList.add("has-player");
      $("player").hidden = false;
    }
    if (feed) connectFeed(feed);
    else if (NORA.streams.length) {
      const select = $("stream-select");
      select.replaceChildren(...NORA.streams.map((s) => h("option", { value: s.name }, `${s.title}${s.synthetic ? " (synthetic)" : ""}`)));
      select.disabled = NORA.streams.length < 2;
      const wanted = NORA.streams.find((s) => s.name === params.get("stream")) || NORA.streams[0];
      select.value = wanted.name;
      setStream(wanted);
    }
    go(fromHash() || (C.screen.start === "network" ? { screen: "unit", unit: "all" } : { screen: "overview" }), false);
    // Reduced motion: nothing starts moving by itself; ▶ plays.
    if (params.get("autoplay") === "1" || (C.screen.autoplay && params.get("autoplay") !== "0" && !feed && !reduceMotion)) play();
    kiosk();
    requestAnimationFrame(tick);
  }
  /* Wall behaviour: the pointer hides after a few idle seconds, and ?rotate=SECONDS
     (any profile) cycles Overview, Map and Flow for a screen nobody stands at. */
  function kiosk() {
    let idle = 0;
    const wake = () => {
      document.body.classList.remove("idle");
      clearTimeout(idle);
      if (display.profile === "wall") idle = setTimeout(() => document.body.classList.add("idle"), 4000);
    };
    for (const type of ["pointermove", "pointerdown", "keydown"]) addEventListener(type, wake);
    wake();
    const every = Number(params.get("rotate"));
    if (!(every >= 10)) return;
    const stops = [() => go({ screen: "overview" }), () => showView("map"), () => showView("flow")];
    let at = 0;
    setInterval(() => { at = (at + 1) % stops.length; stops[at](); }, every * 1000);
  }
  function showView(name) {
    state.view = name;
    markTabs();
    if (route.screen !== "unit") go({ screen: "unit", unit: route.unit || "all" });
    else render();
  }

  return {
    state, live, route, views, settings: () => settings, embed, reduceMotion, nodeIds, pipeIds,
    whatif: {
      result: whatifResult, // the most the network can deliver with assets offline (the analysis' max flow)
      state: whatifState, // the steady state: flows, pressures, line pack, balance
      set: setWhatif, // ("supply" | "offtake" | "pressure" | "pack", id, value or null)
      scenario: (key) => { if (key) { whatif.scenario = key; whatifChanged(); } return whatif.scenario; },
      reset: resetWhatif,
      toggle: toggleOffline,
      clear: () => { whatif.offline.clear(); whatif.cache = null; whatif.version++; },
      offline: () => [...whatif.offline],
      card: whatifCard,
    },
    routes: { nextOut, pigPlace, peakPlace, seeded },
    pigs: { pigSpeed, pigMessages, pigAlarm, pigRun, pigEta, pigStatus, pigConditions },
    colors: COLORS, levelColor: LEVEL_COLOR, shapeMarkup, drawBadge, drawMarker, drawBand, markerSize, markerTip, levelOf, alarmHandling, buildAlarms, fmt, esc, nameOf, unitOf, units: unitById,
    linepack, packRate, pressureRate, inventory, settleOut, // the line-pack model (PMS-style estimates)
    pressureMark, flowMark, limitInk, drawFlowDirection, gasDayChart, gasQuality, pressureOutlook, pressureChart,
    airTemp: (id) => metric("air_temp_c", id),
    rampAhead, // the next 6 hours of nominations at an exit point
    reachAhead, // and whether its pressure holds for them with the input as now
    blending: { layout: blendingLayout, picture: blendingPicture, box: blendingBox, routes: BLEND },
    pipeStyle, pipeMapName, pipeDetail, detailZoom: DETAIL_ZOOM, visibleRange, bandStops, nodeStyle, markers, window4h, nominationWindow, nominationHistogram, flowRate, thresholds: T,
    // Where the playhead stands against the wall clock ({ahead, model}), or null.
    timeState, timelineWindow, seek,
    // The display profile (desk, wall or compact) and the one UI scale (1 = 100 %).
    display: () => display.profile,
    uiScale: () => display.scale,
    mix, onPinch, checkBuild, // for tests
    // Seconds between repaints of what moves while the data plays: about 20 a second, every
    // third frame at 60 (Ray, 29 Oct: "fix performance, it is lagging"); a pan, a zoom or
    // new data still draws at once. Under 0.05 so frame jitter never skips a fourth.
    movingStep: 0.045,
    build: () => BUILD,
    notes: {
      list: () => notes.list, add: addNote, remove: removeNote, snap: snapToRoute, layer: noteLayer,
      version: () => notes.version, onChange: (fn) => notes.listeners.add(fn),
    },
    // Flow through a node now (MSm³/d) and its pressure (bar), for the views to show.
    reading: (id) => cached("reading", id, () => { const f = viewFrame(); return { flow: throughput(id, f.flows), pressure: metric("pressure_bar", id, f) }; }),
    lineFlow, stateShown: () => state.mode === "live" || state.mode === "whatif",
    frame: frameApi, cached,
    dayDelivery, register, restyle, go, start, setMode, theme: () => theme, buildSettings,
    // `at`: where the click was (client px), for What-if's window on the view.
    select: (id, at = null) => {
      if (!id || !assets[id]) { if (route.screen === "unit" && state.mode !== "whatif") closeSidebar(); return; }
      if (state.mode === "whatif" && at) { openWhatifEditor(id, at); return; } // your numbers, right there
      if (state.mode === "whatif") { openSidebar(id); return; } // its what-if card: your values
      // On the unit screen the details slide in from the right instead of taking over the page.
      if (route.screen === "unit") { openSidebar(id); return; }
      go({ screen: "asset", asset: id });
    },
    sidebar: { open: (id) => openSidebar(id), close: closeSidebar, id: () => side.id, marker: () => side.marker },
    depth: { at: depthAt, ready: () => depthGrid.ready }, // water depth (m) under a position
    positionText,
    selectMarker: openMarker, // a click on a pig or a peak, from any view
    feed: { frame: receiveFrame, trouble: feedTrouble, meta: receiveMeta, glide: glideFeed }, // the live feed's handlers, for tests
    menu: { open: openMenu, close: closeMenu, for: menuFor },
    // The editor: the Flow view's right-click on empty paper, its connect step, the
    // edited data files and network, and the viewport to restore after an edit.
    edit: {
      canvasMenu: (ctx) => (embed || state.mode !== "edit" ? [] : [{ label: "Add a node here", act: () => openNodeForm(ctx) }]),
      lineForm: openLineForm,
      move: commitMove,
      list: () => edits.slice(),
      files: editedFiles,
      network: editedNetwork,
      save: saveEdits,
      viewport: () => (restored && restored.flow) || null,
    },
  };
})();
