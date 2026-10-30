  // ------------------------------------------------------------------ navigation
  function hashFor(r) {
    return r.screen === "overview" ? "#/overview" : r.screen === "unit" ? `#/unit/${r.unit}` : `#/${r.screen}/${r.asset}`;
  }
  function go(next, push = true) {
    Object.assign(route, { focus: null }, next);
    if (route.screen === "unit" && !unitById[route.unit]) route.unit = "all";
    if (route.screen !== "unit") closeSidebar();
    const hash = hashFor(route);
    if (push && location.hash !== hash) history.pushState(null, "", `${location.pathname}${location.search}${hash}`);
    render();
  }
  function fromHash() {
    const [, screen, arg] = (location.hash || "").split("/");
    if (screen === "unit") return { screen: "unit", unit: unitById[arg] ? arg : "all" };
    if ((screen === "asset" || screen === "diag") && assets[arg]) return { screen, asset: arg };
    if (screen === "overview") return { screen: "overview" };
    return null;
  }
  // Where a fresh visit lands: nora.toml [screen] start (the whole network, or the overview).
  const startRoute = () => (C.screen.start === "network" ? { screen: "unit", unit: "all" } : { screen: "overview" });
  addEventListener("popstate", () => go(fromHash() || startRoute(), false));

  let splitShown = false;
  function render() {
    const s = route.screen;
    for (const [key, el] of Object.entries(screens)) el.hidden = key !== s;
    const shown = shownViews();
    splitShown = splitScreen();
    document.body.classList.toggle("split", s === "unit" && splitShown);
    for (const [key, el] of Object.entries(containers)) el.hidden = !(s === "unit" && shown.includes(views[key]));
    // The Map/Flow and mode tabs stay in the bar on every screen: one constant top bar.
    $("crumb-overview").setAttribute("aria-current", s === "overview" ? "page" : "false");
    const deep = s === "asset" || s === "diag";
    $("sep-asset").hidden = $("crumb-asset").hidden = !deep;
    $("sep-diag").hidden = $("crumb-diag").hidden = s !== "diag";
    if (deep) $("crumb-asset").replaceChildren(h("span", { class: "level" }, "3"), nameOf(route.asset));
    $("crumb-asset").setAttribute("aria-current", s === "asset" ? "page" : "false");
    $("crumb-diag").setAttribute("aria-current", s === "diag" ? "page" : "false");
    if (s === "unit") for (const view of shown) {
      const key = Object.keys(views).find((k) => views[k] === view), fresh = !view.mounted || view.shownUnit !== route.unit;
      if (!view.mounted) { view.mounted = true; view.mount(containers[key]); }
      else view.resize();
      if (view.ready) {
        // Back to a view, it is where you left it; another unit fits that unit (Ray, 29 Oct:
        // "the page should stay in the exact same location and not zoom out every time").
        if (fresh) view.setUnit(route.unit);
        view.shownUnit = route.unit;
        view.restyle();
        if (route.focus) { view.highlight(route.focus); view.focus(route.focus, true); }
      }
    }
    refreshScreens();
  }
  function refreshScreens() {
    if (route.screen === "overview") renderOverview();
    else if (route.screen === "asset") renderAsset();
    else if (route.screen === "diag") renderDiag();
    renderTop();
    announceAlarms();
    describeView();
  }
  /* For a screen reader (hub 3615). New alarms are announced, priority and text, at most
     once per hour of data so a busy hour is one message, not a stream. */
  const announced = new Set();
  let lastAnnounce = null;
  function announceAlarms() {
    const fresh = live.conditions.filter((c) => !announced.has(occurrence(c)));
    if (!fresh.length || live.time == null) return;
    if (lastAnnounce != null && live.time >= lastAnnounce && live.time - lastAnnounce < 3600) return;
    for (const c of fresh) announced.add(occurrence(c));
    lastAnnounce = live.time;
    const said = fresh.slice(0, 3).map((c) => `${LEVEL[c.level]}, priority ${4 - c.level}: ${c.text}`);
    $("announce").textContent = `${fresh.length} new alarm${fresh.length === 1 ? "" : "s"}. ${said.join(". ")}${fresh.length > 3 ? `. And ${fresh.length - 3} more in the alarm list` : ""}.`;
  }
  // The Map and the Flow draw on canvases; the same assets as a list, with their state.
  function describeView() {
    const list = $("view-list");
    if (!list) return;
    if (route.screen !== "unit") { if (list.dataset.signature !== "") replaceIfChanged(list, "", () => []); return; }
    const unit = unitById[route.unit], ids = unit ? unit.nodes : nodeIds;
    const worst = (id) => live.conditions.filter((c) => c.id === id);
    const signature = `${route.unit}|${ids.map((id) => `${id}:${worst(id).map((c) => c.level).join("")}`).join(",")}`;
    replaceIfChanged(list, signature, () => [h("h2", null, `${unit ? unit.name : "The network"}: ${ids.length} assets`),
      h("ul", null, ids.map((id) => {
        const conds = worst(id);
        return h("li", null, `${nameOf(id)}: ${conds.length ? conds.map((c) => `${LEVEL[c.level]}, ${c.text}`).join("; ") : "normal"}`);
      }))]);
  }
  function renderTop() {
    const counts = [3, 2, 1].map((l) => {
      const at = live.conditions.filter((c) => c.level === l);
      return [l, at.length, at.filter((c) => !c.acked).length];
    }).filter(([, n]) => n);
    // Both are live regions, refreshed with every data step: rebuilt only when they change.
    replaceIfChanged($("alarm-counts"), counts.map(([l, n, open]) => `${l}:${n}:${open}`).join(",") || "none",
      () => (counts.length ? counts.map(([l, n, open]) => h("span", { class: open ? null : "acked", title: `${n} ${LEVEL[l].toLowerCase()}, ${open ? `${open} unacknowledged` : "all acknowledged"}` },
        badge(l, l === 1 ? `${n} warning${n === 1 ? "" : "s"}` : String(n))))
        : [h("span", { class: "dim" }, "No alarms")]));
    buildAlarms();
    // No plan chip (Ray, 29 Oct: "remove this. it serves no purpose"): the plan's state
    // is on the Overview, and its shortfalls are alarms in the counts.
  }

  /* The alarm list (Ray, 29 Oct: "when clicking this, an alarm list should show. make it
     well made, minimalistic as a popup window that shows alarm categories by level,
     network, ID"; "integrity alarms needs its own category, with time first, then location,
     then note, then level, then network. Same for scada alarms but thats its own
     category"). Integrity: pressures at their limits and lines over capacity, what
     protects the pipelines; SCADA: everything else the readings raise. Newest first; a
     level and a network narrow it; a location opens the asset. */
  const INTEGRITY = new Set(["pressure", "load"]);
  const ALARM_TAG = { pressure: "PI", load: "FI", trip: "FT", quality: "QI", peak: "FS", nomination: "NOM", booking: "BKG" };
  const alarmFilter = { level: 0, unit: "all" };
  let shelving = null; // the alarm whose shelve form is open
  const alarmUnit = (id) => unitOf[id] || (assets[id] && assets[id].kind === "pipeline" ? unitOf[assets[id].from] : null);
  const alarmId = (c) => `${ALARM_TAG[c.kind] || c.kind.slice(0, 3).toUpperCase()}-${c.id.toUpperCase()}`;
  function alarmNote(c) {
    const name = nameOf(c.id), note = c.text.startsWith(name) ? c.text.slice(name.length).replace(/^[\s:,]+/, "") : c.text;
    return note.charAt(0).toUpperCase() + note.slice(1);
  }
  function buildAlarms() {
    const panel = $("alarms");
    if (!panel || panel.hidden) return;
    const all = live.conditions, shown = all.filter((c) => (!alarmFilter.level || c.level === alarmFilter.level)
      && (alarmFilter.unit === "all" || alarmUnit(c.id) === alarmFilter.unit));
    const sig = (c) => `${c.kind}:${c.id}:${c.level}:${c.text}:${c.since ? c.since.t : ""}:${c.acked ? 1 : 0}`;
    const key = `${alarmFilter.level}|${alarmFilter.unit}|${shelving}|${all.map(sig).join(";")}|${live.shelved.map((c) => `${sig(c)}:${c.shelf.until}`).join(";")}`;
    replaceIfChanged(panel, key, () => {
      const chip = (lvl, label) => h("button", { type: "button", role: "tab", "aria-selected": String(alarmFilter.level === lvl),
        onclick: () => { alarmFilter.level = lvl; buildAlarms(); } }, label);
      const count = (lvl) => all.filter((c) => c.level === lvl).length;
      const location = (c) => (assets[c.id] ? h("button", { type: "button", class: "link", "data-key": `alarm:${c.kind}|${c.id}`,
        onclick: () => { closePops(); if (route.screen === "unit") openSidebar(c.id); else go({ screen: "asset", asset: c.id }); } }, nameOf(c.id)) : c.id);
      const redo = () => { evaluate(); refreshScreens(); buildAlarms(); };
      const actions = (c) => h("td", { class: "alarm-do" }, h("span", { class: "alarm-actions" },
        c.acked ? h("span", { class: "dim" }, "Acked") : ackButton([c]),
        shelving === alarmKey(c) ? null : h("button", { type: "button", class: "ack", "data-key": `shelve:${alarmKey(c)}`, title: "Take it out of the counts for a while, with a reason",
          onclick: () => { shelving = alarmKey(c); buildAlarms(); } }, "Shelve")));
      // The shelve form opens on its own row under the alarm: why, and for how long.
      const shelveRow = (c) => {
        if (shelving !== alarmKey(c)) return null;
        const reason = h("select", { "aria-label": "Reason" }, ...SHELVE_REASONS.map((r) => h("option", { value: r }, r)));
        const hours = h("select", { "aria-label": "For" }, ...SHELVE_HOURS.map((n) => h("option", { value: String(n) }, n === 12 ? "12 h (a shift)" : `${n} h`)));
        return h("tr", { class: "shelving" }, h("td", { colspan: "7" }, h("span", { class: "alarm-actions" },
          h("span", { class: "dim" }, `Shelve ${nameOf(c.id)}:`), reason, hours,
          h("button", { type: "button", class: "ack", "data-key": `shelve-ok:${alarmKey(c)}`,
            onclick: () => { alarmHandling.shelve(c, reason.value, Number(hours.value)); shelving = null; redo(); } }, "Shelve"),
          h("button", { type: "button", class: "ack", onclick: () => { shelving = null; buildAlarms(); } }, "Cancel"))));
      };
      const table = (title, rows) => [
        h("h3", null, `${title} · ${rows.length}`),
        rows.length ? h("table", { class: "data alarm-table" },
          h("thead", null, h("tr", null, ...["Time", "Location", "Note", "Level", "Network", "ID", ""].map((t) => h("th", null, t)))),
          h("tbody", null, ...rows.flatMap((c) => [h("tr", { class: c.acked ? "acked" : null },
            h("td", null, sinceTime(c.since)),
            h("td", null, location(c)),
            h("td", { class: "note" }, alarmNote(c)),
            h("td", null, badge(c.level, LEVEL[c.level])),
            h("td", { class: "network" }, (unitById[alarmUnit(c.id)] || {}).name || "–"),
            h("td", { class: "dim id" }, alarmId(c)),
            actions(c)), shelveRow(c)].filter(Boolean))))
          : h("p", { class: "dim" }, "None"),
      ];
      const shelved = live.shelved.filter((c) => !alarmFilter.level || c.level === alarmFilter.level);
      const shelf = shelved.length ? [
        h("h3", null, `Shelved · ${shelved.length}`),
        h("table", { class: "data alarm-table" },
          h("thead", null, h("tr", null, ...["Location", "Note", "Level", "Reason", "Back at (your clock)", ""].map((t) => h("th", null, t)))),
          h("tbody", null, ...shelved.map((c) => h("tr", { class: "acked" },
            h("td", null, location(c)),
            h("td", { class: "note" }, alarmNote(c)),
            h("td", null, badge(c.level, LEVEL[c.level])),
            h("td", null, c.shelf.reason),
            h("td", null, h("time", { title: "Wall-clock time, this browser" }, new Date(c.shelf.until).toTimeString().slice(0, 5))),
            h("td", { class: "alarm-do" }, h("button", { type: "button", class: "ack", "data-key": `unshelve:${alarmKey(c)}`,
              onclick: () => { alarmHandling.unshelve(c); redo(); } }, "Unshelve")))))),
      ] : [];
      const newest = (a, b) => ((b.since && b.since.t) || 0) - ((a.since && a.since.t) || 0);
      return [
        h("div", { class: "alarm-filters" },
          h("div", { class: "seg", role: "tablist", "aria-label": "Level" }, chip(0, `All ${all.length}`),
            ...[3, 2, 1].map((l) => chip(l, `${4 - l} ${LEVEL[l]} ${count(l)}`))),
          ackButton(shown, "Acknowledge all"),
          h("select", { "aria-label": "Network", onchange: (e) => { alarmFilter.unit = e.target.value; buildAlarms(); } },
            h("option", { value: "all", selected: alarmFilter.unit === "all" ? "" : null }, "All networks"),
            ...Object.values(unitById).map((u) => h("option", { value: u.id, selected: alarmFilter.unit === u.id ? "" : null }, u.name)))),
        ...table("Integrity", shown.filter((c) => INTEGRITY.has(c.kind)).sort(newest)),
        ...table("SCADA", shown.filter((c) => !INTEGRITY.has(c.kind)).sort(newest)),
        ...shelf,
        h("p", { class: "dim small" }, "Acknowledgements and shelving are kept in this browser only."),
      ];
    });
  }

  // ------------------------------------------------------------------ key and settings
  function buildKey() {
    const sample = (color, w, dash = "") => svg("0 0 26 14", `<line x1="1" y1="7" x2="25" y2="7" stroke="${COLORS.text}" stroke-width="${w + 2}"${dash}/><line x1="1" y1="7" x2="25" y2="7" stroke="${color}" stroke-width="${w}"${dash}/>`);
    const item = (icon, text) => h("li", null, icon, h("span", null, text));
    const section = (title, wide, ...children) => h("section", { class: `key-section${wide ? " key-wide" : ""}` }, h("h3", null, title), ...children);
    const timeline = svg("0 0 280 58", `<path d="M9 9l7 5-7 5z" fill="${COLORS.text}"/><line x1="28" y1="28" x2="268" y2="28" stroke="${COLORS.text_dim}"/><line x1="148" y1="17" x2="148" y2="39" stroke="${COLORS.text}" stroke-width="2"/><circle cx="148" cy="28" r="4" fill="${COLORS.text}"/><g fill="${COLORS.text_dim}" font-size="11" font-family="Archivo, sans-serif"><text x="28" y="49">← History</text><text x="148" y="49" text-anchor="middle" fill="${COLORS.text}">Now</text><text x="268" y="49" text-anchor="end">Model →</text></g>`);
    const tag = (x, y) => `<rect x="${x}" y="${y}" width="40" height="15" rx="2" fill="${COLORS.card.active.fill}" stroke="${COLORS.card.active.edge}"/><text x="${x + 20}" y="${y + 11}" text-anchor="middle" fill="${COLORS.card.active.ink}" font-size="9.5" font-family="Archivo, sans-serif">82 bar</text>`;
    const flow = svg("0 0 280 96", `<line x1="6" y1="34" x2="54" y2="34" stroke="${COLORS.text_dim}"/><path d="M45 30l9 4-9 4z" fill="${COLORS.text_dim}"/>${tag(54, 27)}<rect x="94" y="0" width="72" height="72" rx="4" fill="${COLORS.card.active.fill}" stroke="${COLORS.card.active.edge}"/>${tag(166, 27)}<line x1="206" y1="34" x2="274" y2="34" stroke="${COLORS.text_dim}"/><path d="M265 30l9 4-9 4z" fill="${COLORS.text_dim}"/><polyline points="102,62 112,58 122,60 130,54 138,56" fill="none" stroke="${COLORS.card.active.ink}" stroke-width="1.2"/><polyline points="138,56 148,55 158,55" fill="none" stroke="${COLORS.card.active.ink}" stroke-width="1.2" stroke-dasharray="3 2"/><g font-size="10" font-family="Archivo, sans-serif"><text x="160" y="14" text-anchor="end" fill="${COLORS.card.active.dim}">▼ 0.4/h</text></g><g font-size="11" font-family="Archivo, sans-serif" text-anchor="middle"><text x="113" y="38" fill="${COLORS.card.active.dim}">34M</text><text x="147" y="38" fill="${COLORS.card.active.ink}">34M</text><text x="130" y="88" fill="${COLORS.text}">Asset</text></g>`);
    const exit = svg("0 0 280 30", `<line x1="65" y1="14" x2="215" y2="14" stroke="${COLORS.text_dim}"/><line x1="105" y1="7" x2="105" y2="21" stroke="${COLORS.text_dim}"/><line x1="175" y1="7" x2="175" y2="21" stroke="${COLORS.text_dim}"/><line x1="145" y1="4" x2="145" y2="24" stroke="${COLORS.text}" stroke-width="3"/><g fill="${COLORS.text_dim}" font-size="11" font-family="Archivo, sans-serif"><text x="65" y="28">min</text><text x="140" y="28" fill="${COLORS.text}">now</text><text x="202" y="28">max</text></g>`);
    $("key").replaceChildren(
      h("button", { type: "button", class: "text close", onclick: closeGuide }, "Close"),
      h("div", { class: "key-grid" },
        section("Controls", true, timeline,
          h("ul", { class: "key-notes" },
            item(h("span", null, "▶"), "Play / scrub"),
            item(h("span", null, "↗"), "Click for details"),
            item(h("span", null, "⌁"), "What-if: click offline"),
            item(h("span", null, "⋯"), "Edit: drag to move; right-click to add, connect or remove"))),
        section("Moving", false, h("ul", null,
          item(svg("0 0 26 14", `<path d="M17 7l-8-4.5v9z" fill="${COLORS.pig}" stroke="${COLORS.casing}"/>`), "Pig"),
          item(svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.h2s}" stroke="${COLORS.casing}"/>`), "H₂S · ppm"),
          item(svg("0 0 26 14", `<circle cx="13" cy="7" r="5" fill="${COLORS.co2}" stroke="${COLORS.casing}"/>`), "CO₂ · mol %"))),
        section("Status", false, h("ul", null,
          ...[3, 2, 1].map((l) => item(badge(l), ["", "Watch", "Medium", "Act now"][l])),
          item(sample(COLORS.active, 3), "Active"),
          item(sample(COLORS.normal, 3), "Normal"),
          item(sample(COLORS.inactive, 3), "Inactive"),
          item(sample(COLORS.inactive, 1.5, ' stroke-dasharray="3 3"'), "No data"))),
        section("Flow", true, flow, h("p", { class: "key-caption" }, "Flow in MSm³/d: incoming faint, outgoing full · line ends: pressure, ▲▼ bar per hour · mid-line: settle-out pressure (bar), and pack, its line pack change (MSm³/d)"), exit, h("p", { class: "key-caption" }, "Exit delivery")),
        section("Indicators", true, rangeBar({ min: 0, max: 10, value: 6, band: [3, 7], ticks: [{ at: 1.5, level: 3 }, { at: 8.5, level: 3 }], target: 5 }),
          h("p", { class: "key-caption" }, "Band: normal · ◇ target · pointer: now"),
          h("p", { class: "key-caption" }, "Solid: history · dashed: model"))));
  }
  function storedFlag(key) { try { return localStorage.getItem(key); } catch (error) { return "1"; } }
  function openGuide() {
    $("key").hidden = false;
    $("key-toggle").setAttribute("aria-expanded", "true");
    try { localStorage.setItem("nora-guide-seen", "1"); } catch (error) { /* private window */ }
  }
  function closeGuide() {
    $("key").hidden = true;
    $("key-toggle").setAttribute("aria-expanded", "false");
  }
  /* Settings (Ray, 29 Oct: "options need to be updated and improved"): what is in the
     network, what the squares and lines show, what moves along them, and the display.
     Only the asset types the network has, by their short names; defaults from nora.toml. */
  function buildSettings() {
    const check = (label, key) => h("label", null, h("input", { type: "checkbox", checked: settings[key] ? "" : null, onchange: (e) => update({ [key]: e.target.checked }) }), label);
    const choose = (label, key, options, act = (v) => update({ [key]: v }), value = settings[key]) => h("div", { class: "row" }, h("span", null, label),
      h("select", { "aria-label": label, onchange: (e) => act(e.target.value) }, options.map(([v, t]) => h("option", { value: v, selected: value === v ? "" : null }, t))));
    const path = ["field", "hub", "tee", "processing", "terminal", "market", "lng", "storage"]; // as the gas goes
    const present = [...new Set([...path, ...Object.keys(NORA.nodeTypes)])].filter((type) => nodeIds.some((id) => assets[id].type === type));
    $("settings").replaceChildren(
      h("h3", null, "Network"),
      ...present.map((type) => h("label", { title: NORA.nodeTypes[type] },
        h("input", { type: "checkbox", checked: settings.hide.includes(type) ? null : "",
          onchange: (e) => update({ hide: e.target.checked ? settings.hide.filter((t) => t !== type) : [...settings.hide, type] }) }),
        (NORA.plural || {})[type] || NORA.nodeTypes[type])),
      h("h3", null, "On the squares"),
      check("Names", "names"),
      check("Pressure change in the last hour", "pressureChange"),
      check("Outside temperature", "temperature"),
      h("h3", null, "On the lines"),
      choose("Values", "lineValues", [["auto", "Auto"], ["on", "Always"], ["off", "Never"]]),
      check("Line pack change", "pack"),
      check("Moving flow", "animation"),
      h("h3", null, "Moving markers"),
      check("Pigs", "pigs"),
      check("H₂S and CO₂ peaks", "gasQuality"),
      h("h3", null, "Display"),
      choose("Theme", "theme", [["light", "Light"], ["dark", "Dark"]], (v) => setTheme(v), theme),
      choose("Spacing", "density", [["compact", "Compact"], ["comfortable", "Comfortable"], ["spacious", "Spacious"]]),
      choose("Screen", "display", [["auto", `Auto (${autoProfile(window.innerWidth)})`], ["desk", "Operator desk"], ["wall", "Video wall"], ["compact", "Tablet or phone"]]),
      choose("Size", "scale", [["auto", `Auto (${Math.round(autoScaleFor(chosenProfile()) * 100)} %)`],
        ...["1", "1.25", "1.5", "1.75", "2"].map((v) => [v, `${Number(v) * 100} %`])]),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "text", onclick: copyLink }, "Copy link"),
        h("button", { type: "button", class: "text", title: "Open this screen in its own window, for another monitor", onclick: () => window.open(location.href, "_blank", "noopener") }, "New window"),
        h("button", { type: "button", class: "text", onclick: () => update({ ...DEFAULT_SETTINGS }) }, "Reset")),
      h("p", { class: "dim", style: "margin:8px 0 0" }, "Defaults come from nora.toml in the repository."));
  }
  function update(changes) {
    settings = { ...settings, ...changes };
    saveSettings();
    const resized = applyDisplay();
    buildSettings();
    for (const view of Object.values(views)) if (view.ready && view.applySettings) view.applySettings();
    if (resized) displayChanged();
    restyle();
  }
  // After the profile or scale changed: the stage has a new size, so re-fit and redraw.
  function displayChanged() {
    if (splitShown !== splitScreen()) { render(); drawSpark(); return; }
    for (const view of shownViews()) if (view.mounted) view.resize();
    drawSpark();
  }
  function copyLink() {
    const url = new URL(location.href);
    url.searchParams.set("s", btoa(JSON.stringify(settings)));
    if (navigator.clipboard) navigator.clipboard.writeText(url.toString());
  }
  // NORA: back to the map of the whole network (Ray, 29 Oct: "clicking on NORA should take
  // me back to map overview and not download file"; it linked to the folder).
  if ($("brand")) $("brand").addEventListener("click", (event) => {
    event.preventDefault();
    closePops();
    closeSidebar();
    state.view = "map";
    markTabs();
    go({ screen: "unit", unit: "all" });
    if (views.map && views.map.ready && views.map.fit) views.map.fit();
  });
  const POPS = [["key-toggle", "key"], ["settings-toggle", "settings"], ["alarm-counts", "alarms"]];
  function closePops() {
    for (const [button, panel] of POPS) { if ($(panel)) $(panel).hidden = true; if ($(button)) $(button).setAttribute("aria-expanded", "false"); }
  }
  $("skip-alarms").addEventListener("click", (event) => {
    event.preventDefault();
    if ($("alarms").hidden) $("alarm-counts").click();
    $("alarms").setAttribute("tabindex", "-1");
    $("alarms").focus();
  });
  for (const [button, panel] of POPS) {
    if (!$(button)) continue;
    $(button).addEventListener("click", (event) => {
      const open = $(panel).hidden;
      closePops();
      $(panel).hidden = !open;
      event.currentTarget.setAttribute("aria-expanded", String(open));
      if (open && panel === "alarms") { $(panel).dataset.signature = ""; buildAlarms(); }
    });
  }

