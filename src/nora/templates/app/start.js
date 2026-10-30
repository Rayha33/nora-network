  // ------------------------------------------------------------------ start
  const byName = {};
  for (const id of [...nodeIds, ...pipeIds]) byName[nameOf(id).toLowerCase()] = id;
  $("asset-names").replaceChildren(...Object.keys(byName).sort().map((n) => h("option", { value: nameOf(byName[n]) })));
  $("search").addEventListener("change", (e) => {
    const id = byName[e.target.value.trim().toLowerCase()];
    if (id) { e.target.value = ""; go({ screen: "asset", asset: id }); }
  });
  function setTheme(next) {
    theme = next;
    try { localStorage.setItem("nora-theme", theme); } catch (error) { /* private mode */ }
    applyPalette();
    buildKey();
    buildSettings();
    for (const view of Object.values(views)) if (view.mounted && view.theme) view.theme(theme);
    refreshScreens();
    drawSpark();
  }
  /* A tab left open keeps the build it was opened with, and then shows bugs fixed since as
     if they were still there (Ray, 29 Oct). Every 5 minutes the page asks the site which
     build it serves (version.json beside it). A newer one: the page reloads itself once
     nobody has touched it for a minute, or the bar offers "New version · Reload" while
     someone is at it or has What-if values that a reload would clear. Edits and notes are
     kept in the browser and survive a reload. */
  const BUILD = ((document.querySelector && document.querySelector('meta[name="nora-build"]')) || {}).content || "";
  let lastInput = Date.now();
  for (const type of ["pointerdown", "keydown", "wheel"]) addEventListener(type, () => { lastInput = Date.now(); }, { capture: true, passive: true });
  async function checkBuild(now = Date.now()) {
    if (!BUILD) return null; // opened from a file or a dev build: nothing to compare
    let published = null;
    try {
      const response = await fetch(`version.json?at=${now}`, { cache: "no-store" });
      published = response.ok ? (await response.json()).build : null;
    } catch (error) { return null; } // offline, or the site has no version.json: keep this build
    if (!published || published === BUILD) return "current";
    const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName || "");
    if (now - lastInput >= 60000 && !typing && !whatifChanges()) { location.reload(); return "reloaded"; }
    $("update").hidden = false;
    return "offered";
  }
  /* Right-click menu: the same actions everywhere, on the Map and in the Flow.
     openMenu places it inside the viewport; any click, Esc or resize closes it. */
  const menu = { el: null };
  function closeMenu() { if (menu.el) { menu.el.remove(); menu.el = null; } }
  function openMenu(x, y, items) {
    closeMenu();
    if (!items.length) return;
    const el = h("div", { class: "ctx-menu", role: "menu" },
      ...items.map((it) => it === "-"
        ? h("div", { class: "rule" })
        : h("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); it.act(); } }, it.label)));
    // The menu is zoomed by the UI scale, so its position is in zoomed pixels.
    const k = display.scale;
    el.style.left = Math.max(8, Math.min(x, innerWidth - 240 * k)) / k + "px"; // min-width 220 + padding
    el.style.top = Math.max(8, Math.min(y, innerHeight - (10 + items.length * 32) * k)) / k + "px";
    document.body.append(el);
    menu.el = el;
  }
  /* One builder for the actions on an asset, so both views offer the same menu. */
  function menuFor(id, ctx = {}) {
    if (!id || !assets[id]) return [];
    const d = assets[id], items = [];
    items.push({ label: "Open details", act: () => { if (route.screen === "unit") openSidebar(id); else go({ screen: "asset", asset: id }); } });
    if (ctx.center) items.push({ label: "Centre here", act: ctx.center });
    if (ctx.coords) items.push({ label: `Copy position (${ctx.coords})`, act: () => { if (navigator.clipboard) navigator.clipboard.writeText(ctx.coords); } });
    if (ctx.note) items.push({ label: "Add a note here", act: ctx.note });
    items.push("-");
    if (d.kind === "node") items.push({
      label: whatif.offline.has(id) ? "Restore in the what-if" : "Take offline in the what-if",
      act: () => { if (state.mode !== "whatif") { state.mode = "whatif"; markTabs(); restyle(); } toggleOffline(id); renderSidebar(); renderWhatif(); },
    });
    items.push({ label: "Open the full page", act: () => go({ screen: "asset", asset: id }) });
    if (d.kind === "node") items.push({ label: "Diagnostics", act: () => go({ screen: "diag", asset: id }) });
    if (!embed && state.mode === "edit") { // changing the network only in Edit
      items.push("-");
      items.push({ label: d.kind === "node" ? "Change this node…" : "Change this line…", act: () => App.edit.open(id) });
      if (d.kind === "node" && ctx.connect) items.push({ label: "Connect to another node…", act: ctx.connect });
      items.push(d.kind === "node"
        ? { label: "Remove from the network", act: () => commitEdit({ op: "removeNode", id }) }
        : { label: "Remove this line", act: () => commitEdit({ op: "removeLine", id }) });
    }
    return items;
  }

  /* Safari pinches with gesture events, where other browsers send Ctrl + wheel: the
     same zoom either way (Ray, 29 Oct: "zooming in and out should be seamless ...
     regardless of browser"). `zoom(factor, at)`, `at` in the element's pixels. */
  function onPinch(el, zoom) {
    let last = 1;
    el.addEventListener("gesturestart", (e) => { e.preventDefault(); last = 1; });
    el.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.scale > 0) zoom(e.scale / last, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      last = e.scale || last;
    });
    el.addEventListener("gestureend", (e) => e.preventDefault());
  }

