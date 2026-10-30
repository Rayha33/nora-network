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
    storeRedo([]); // a new step: what was undone stays undone
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
  /* Undo takes the last step back and Redo puts it back. The undone steps are kept for
     this tab only (sessionStorage), across the reload each step makes; a new edit
     clears them. */
  const REDO_KEY = "nora-redo";
  function redoList() {
    try { const list = JSON.parse(sessionStorage.getItem(REDO_KEY) || "[]"); return Array.isArray(list) ? list : []; } catch (error) { return []; }
  }
  function storeRedo(list) {
    try { if (list.length) sessionStorage.setItem(REDO_KEY, JSON.stringify(list)); else sessionStorage.removeItem(REDO_KEY); } catch (error) { /* no redo then */ }
  }
  function undoEdit() {
    if (!edits.length) return;
    storeRedo([...redoList(), edits.pop()]);
    storeEdits(edits);
    reloadKeepingView();
  }
  function redoEdit() {
    const list = redoList();
    if (!list.length) return;
    edits.push(list.pop());
    storeRedo(list);
    storeEdits(edits);
    reloadKeepingView();
  }
  function discardEdits() { edits.length = 0; storeEdits(edits); storeRedo([]); reloadKeepingView(); }

  function openForm(title, sub, form, editing = null) {
    side.id = null;
    side.marker = null;
    side.form = true;
    side.editing = editing; // the node or line the form changes: Delete removes it
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
  const option = (value, label) => h("option", { value }, label);
  const numberText = (value) => (value == null || value === "" ? "" : String(value));
  const numberOrNull = (input) => (input.value.trim() === "" ? null : Number(input.value));
  /* A node's fields, for a new node and for changing one: `d` holds their values. The
     Map needs real coordinates, so they are asked for. */
  function nodeFields(d) {
    const inputs = {
      name: h("input", { name: "name", autocomplete: "off", placeholder: "e.g. Snorre" }),
      type: h("select", { name: "type" }, ...Object.entries(NORA.nodeTypes).map(([key, label]) => option(key, label))),
      unit: h("select", { name: "unit" }, ...NORA.units.map((u) => option(u.id, u.name))),
      lat: h("input", { name: "lat", type: "number", step: "0.001" }),
      lon: h("input", { name: "lon", type: "number", step: "0.001" }),
      country: h("input", { name: "country", maxlength: "2" }),
      capacity: h("input", { name: "capacity", type: "number", step: "0.1", min: "0", placeholder: "MSm³/d" }),
      status: h("select", { name: "status" }, ...NORA.statuses.map((key) => option(key, key[0].toUpperCase() + key.slice(1)))),
      operator: h("input", { name: "operator", autocomplete: "off" }),
      notes: h("input", { name: "notes", autocomplete: "off" }),
    };
    inputs.name.value = d.name || "";
    inputs.type.value = d.type || "field";
    inputs.unit.value = d.unit || NORA.units[0].id;
    inputs.lat.value = d.lat == null ? "" : Number(d.lat).toFixed(3);
    inputs.lon.value = d.lon == null ? "" : Number(d.lon).toFixed(3);
    inputs.country.value = d.country || "NO";
    inputs.capacity.value = numberText(d.capacity);
    inputs.status.value = d.status || "operating";
    inputs.operator.value = d.operator || "";
    inputs.notes.value = d.notes || "";
    const rows = [
      field("Name", inputs.name), field("Type", inputs.type), field("Unit", inputs.unit),
      h("div", { class: "field-pair" }, field("Latitude °N", inputs.lat), field("Longitude °E", inputs.lon, "West is negative")),
      h("div", { class: "field-pair" }, field("Country", inputs.country), field("Capacity MSm³/d", inputs.capacity, "Needed for fields")),
      h("div", { class: "field-pair" }, field("Status", inputs.status), field("Operator", inputs.operator)),
      field("Notes", inputs.notes),
    ];
    return { inputs, rows };
  }
  // The values the node fields hold, or the first problem with them.
  function readNode(inputs) {
    const v = {
      name: inputs.name.value.trim(), type: inputs.type.value, unit: inputs.unit.value, country: inputs.country.value.trim().toUpperCase(),
      lat: Number(inputs.lat.value), lon: Number(inputs.lon.value), capacity: numberOrNull(inputs.capacity),
      status: inputs.status.value, operator: inputs.operator.value.trim(), notes: inputs.notes.value.trim(),
    };
    const problem = !v.name ? "Give the node a name."
      : inputs.lat.value === "" || !(v.lat >= -90 && v.lat <= 90) ? "Latitude is in °N, from -90 to 90."
      : inputs.lon.value === "" || !(v.lon >= -180 && v.lon <= 180) ? "Longitude is in °E (west is negative), from -180 to 180."
      : !/^[A-Z]{2}$/.test(v.country) ? "The country is two letters, such as NO or GB."
      : v.capacity != null && !(v.capacity >= 0) ? "Capacity is a number of MSm³/d, 0 or more."
      : NORA.supplyTypes.includes(v.type) && v.status === "operating" && !(v.capacity > 0) ? `${NORA.nodeTypes[v.type]}: give its capacity in MSm³/d.`
      : null;
    return { values: v, problem };
  }
  /* A new node where the Flow view was right-clicked or Add node placed it (`grid`: its
     stage and rank). The nearest node lends its unit, country and position as a start. */
  function openNodeForm({ grid, near }) {
    const anchor = near && assets[near];
    const { inputs, rows } = nodeFields(anchor
      ? { lat: anchor.lat, lon: anchor.lon, country: anchor.country, unit: unitOf[near] }
      : { lat: null, lon: null });
    const note = h("p", { class: "form-note", role: "alert" });
    const form = h("form", {
      class: "edit-form",
      onsubmit: (event) => {
        event.preventDefault();
        const { values, problem } = readNode(inputs);
        if (problem) { note.textContent = problem; return; }
        commitEdit({ op: "addNode", node: { id: uniqueId(values.name), ...values, grid } });
      },
    }, ...rows, note, formActions("Add node"));
    openForm("New node", anchor ? `Placed near ${anchor.name}; connect it with a right-click` : "Connect it with a right-click", form);
  }
  /* A node as it is, to change: its name, type, unit, place on the map, capacity, status,
     operator and notes (Ray, 30 Oct: "a fully fledged editing program where new nodes can
     be added or removed, named, etc"). Only what changed is kept as the step. */
  function openNodeEditor(id) {
    const d = assets[id], { inputs, rows } = nodeFields({ ...d, unit: unitOf[id] });
    const note = h("p", { class: "form-note", role: "alert" });
    const was = readNode(inputs).values;
    const flow = views.flow && views.flow.ready && state.view === "flow" && views.flow.connect;
    const form = h("form", {
      class: "edit-form",
      onsubmit: (event) => {
        event.preventDefault();
        const { values, problem } = readNode(inputs);
        if (problem) { note.textContent = problem; return; }
        const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== was[key]));
        if (!Object.keys(changes).length) { closeSidebar(); return; }
        commitEdit({ op: "editNode", id, changes });
      },
    }, ...rows, note,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "primary" }, "Save changes"),
      flow ? h("button", { type: "button", onclick: () => { closeSidebar(); views.flow.connect(id); } }, "Connect…") : null,
      h("button", { type: "button", class: "danger", onclick: () => commitEdit({ op: "removeNode", id }) }, "Remove node"),
      h("button", { type: "button", onclick: closeSidebar }, "Cancel")));
    openForm(d.name, `${NORA.nodeTypes[d.type] || d.type} · ${id}`, form, id);
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

  // A line as it is, to change: name, type, capacity, size, status, both ways, direction.
  function openLineEditor(pid) {
    const d = assets[pid];
    const inputs = {
      name: h("input", { name: "name", autocomplete: "off" }),
      type: h("select", { name: "type" }, ...Object.entries(NORA.pipelineTypes).map(([key, label]) => option(key, label))),
      capacity: h("input", { name: "capacity", type: "number", step: "0.1", min: "0", placeholder: "MSm³/d" }),
      length: h("input", { name: "length", type: "number", step: "1", min: "0", placeholder: "km" }),
      diameter: h("input", { name: "diameter", type: "number", step: "1", min: "0", placeholder: "inches" }),
      status: h("select", { name: "status" }, ...NORA.statuses.map((key) => option(key, key[0].toUpperCase() + key.slice(1)))),
      operator: h("input", { name: "operator", autocomplete: "off" }),
      notes: h("input", { name: "notes", autocomplete: "off" }),
      bidirectional: h("input", { name: "bidirectional", type: "checkbox" }),
      reverse: h("input", { name: "reverse", type: "checkbox" }),
    };
    inputs.name.value = d.name;
    inputs.type.value = d.type;
    inputs.capacity.value = numberText(d.capacity);
    inputs.length.value = numberText(d.length);
    inputs.diameter.value = numberText(d.diameter);
    inputs.status.value = d.status || "operating";
    inputs.operator.value = d.operator || "";
    inputs.notes.value = d.notes || "";
    inputs.bidirectional.checked = Boolean(d.bidirectional);
    const read = () => ({
      name: inputs.name.value.trim(), type: inputs.type.value, capacity: numberOrNull(inputs.capacity),
      length: numberOrNull(inputs.length), diameter: numberOrNull(inputs.diameter), status: inputs.status.value,
      operator: inputs.operator.value.trim(), notes: inputs.notes.value.trim(), bidirectional: inputs.bidirectional.checked,
    });
    const was = read(), note = h("p", { class: "form-note", role: "alert" });
    const form = h("form", {
      class: "edit-form",
      onsubmit: (event) => {
        event.preventDefault();
        const values = read();
        if (!values.name) { note.textContent = "Give the line a name."; return; }
        for (const [key, label] of [["capacity", "Capacity"], ["length", "Length"], ["diameter", "Diameter"]]) {
          if (values[key] != null && !(values[key] >= 0)) { note.textContent = `${label} is a number, 0 or more.`; return; }
        }
        const changes = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== was[key]));
        if (inputs.reverse.checked) changes.reverse = true;
        if (!Object.keys(changes).length) { closeSidebar(); return; }
        commitEdit({ op: "editLine", id: pid, changes });
      },
    },
    field("Name", inputs.name), field("Type", inputs.type),
    h("div", { class: "field-pair" }, field("Capacity MSm³/d", inputs.capacity), field("Status", inputs.status)),
    h("div", { class: "field-pair" }, field("Length km", inputs.length), field("Diameter in", inputs.diameter)),
    field("Operator", inputs.operator), field("Notes", inputs.notes),
    h("label", { class: "field check" }, inputs.bidirectional, h("span", null, "Gas can flow both ways")),
    h("label", { class: "field check" }, inputs.reverse, h("span", null, `Reverse: from ${nameOf(d.to)} to ${nameOf(d.from)}`)),
    note,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "primary" }, "Save changes"),
      h("button", { type: "button", class: "danger", onclick: () => commitEdit({ op: "removeLine", id: pid }) }, "Remove line"),
      h("button", { type: "button", onclick: closeSidebar }, "Cancel")));
    openForm(d.name, `${nameOf(d.from)} to ${nameOf(d.to)} · ${pid}`, form, pid);
  }
  const openEditor = (id) => (assets[id].kind === "node" ? openNodeEditor(id) : openLineEditor(id));

  /* The data files with the edits in: the rows nobody touched stay exactly as they are
     (NORA.sources is the files as built), removed rows go, new rows are appended. */
  const csvField = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  // One CSV line into its fields (quoted fields may hold commas and doubled quotes).
  function csvFields(line) {
    const out = [];
    let field = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { out.push(field); field = ""; } else field += c;
    }
    out.push(field);
    return out;
  }
  // A changed asset's row: its own fields as they were, the edited ones replaced.
  const nodeColumns = (d) => ({ name: d.name, type: d.type, country: d.country, lat: d.lat, lon: d.lon, operator: d.operator, capacity_msm3d: d.capacity, status: d.status, notes: d.notes });
  const lineColumns = (d) => ({ name: d.name, from: d.from, to: d.to, type: d.type, length_km: d.length, diameter_in: d.diameter, capacity_msm3d: d.capacity,
    bidirectional: d.bidirectional ? "true" : "false", status: d.status, operator: d.operator, notes: d.notes });
  function changedLine(line, header, d) {
    const fields = csvFields(line), columns = d.kind === "node" ? nodeColumns(d) : lineColumns(d);
    return header.map((column, i) => csvField(column in columns ? columns[column] : fields[i])).join(",");
  }
  function editedCsv(name, kind, row) {
    const source = NORA.sources[name] || "";
    const lines = source.split(/\r?\n/), header = lines[0].split(",");
    const kept = lines.slice(1).filter((line) => line.trim() && assets[line.split(",")[0]] && assets[line.split(",")[0]].kind === kind)
      .map((line) => { const d = assets[line.split(",")[0]]; return d.changed ? changedLine(line, header, d) : line; });
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
      else if (step.op === "editNode" && assets[step.id]) {
        nodeRows = nodeRows.map((n) => (n.id === step.id ? { ...n, ...nodeColumns(assets[step.id]) } : n));
        if (step.changes.unit) units[step.id] = unitOf[step.id];
      } else if (step.op === "editLine" && assets[step.id]) lineRows = lineRows.map((p) => (p.id === step.id ? { ...p, ...lineColumns(assets[step.id]) } : p));
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
  /* In Edit the bar is the editor's toolbar: Add node, Undo, Redo, Save, Discard, and
     how many changes there are. Click a node or a line to change or remove it;
     right-click for the same and Connect. Keys: Delete removes what the form shows,
     Cmd/Ctrl+Z undoes, Shift+Cmd/Ctrl+Z (or Ctrl+Y) redoes. */
  function addNodeTool() {
    if (state.view !== "flow") showView("flow");
    if (views.flow && views.flow.placeNode) views.flow.placeNode();
    editNote("Click on the drawing where the new node goes (Esc to stop)");
  }
  function renderEditsBar() {
    if (state.mode !== "edit" || embed) { if (editsBar) { editsBar.remove(); editsBar = null; } return; }
    if (!editsBar) {
      editsBar = h("div", { class: "edits-bar", role: "toolbar", "aria-label": "Edit the network" });
      document.body.append(editsBar);
    }
    const button = (label, act, cls, disabled = false, title = "") => h("button", { type: "button", class: cls, onclick: act, disabled: disabled ? "" : null, title: title || null }, label);
    const redo = redoList().length;
    editsBar.replaceChildren(...[ // a null would show as the text "null"
      button("Add node", addNodeTool),
      button("Undo", undoEdit, null, !edits.length, "Cmd/Ctrl+Z"),
      button("Redo", redoEdit, null, !redo, "Shift+Cmd/Ctrl+Z"),
      h("span", { class: "count", role: "status", "aria-live": "polite" }, edits.length ? `${edits.length} ${edits.length === 1 ? "change" : "changes"}` : "No changes"),
      h("span", { class: "dim" }, editMessage),
      button("Save", saveEdits, "primary", !edits.length),
      !edits.length ? null
        : confirmDiscard ? button("Discard all?", discardEdits, "danger") : button("Discard", () => { confirmDiscard = true; renderEditsBar(); }),
    ].filter(Boolean));
  }
  // The editor's keys, in Edit only and never while typing in a field.
  addEventListener("keydown", (e) => {
    if (state.mode !== "edit" || embed) return;
    const target = e.target || {}, typing = ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable;
    if (typing) return;
    const mod = e.metaKey || e.ctrlKey, key = String(e.key || "").toLowerCase();
    if (mod && key === "z") { e.preventDefault(); if (e.shiftKey) redoEdit(); else undoEdit(); return; }
    if (mod && key === "y") { e.preventDefault(); redoEdit(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && side.editing && assets[side.editing]) {
      e.preventDefault();
      commitEdit(assets[side.editing].kind === "node" ? { op: "removeNode", id: side.editing } : { op: "removeLine", id: side.editing });
    }
  });

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
    go(fromHash() || startRoute(), false);
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
    colors: COLORS, levelColor: LEVEL_COLOR, shapeMarkup, drawBadge, drawMarker, drawBand, markerSize, markerTip, levelOf, alarmHandling, buildAlarms, fmt, signed, esc, nameOf, unitOf, units: unitById,
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
      if (state.mode === "edit" && !embed) { openEditor(id); return; } // Edit: change it right there
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
      addAt: (ctx) => { editNote(""); openNodeForm(ctx); }, // Add node, then a click on the drawing
      open: openEditor,
      note: editNote,
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
