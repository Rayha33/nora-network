  // ------------------------------------------------------------------ map notes
  /* A note on a pipeline (Ray, 29 Oct: "on the map i should be able to add a note to that
     spesific location on the pipeline with arrow pointing to it and then write inside a
     minimalsistic note window"). Right-click a line on the Map, "Add a note here": a
     small window opens beside that point of the laid route with a hairline arrow to it,
     ready to type in. Drag the window by its frame; × or leaving it empty removes it.
     Kept in this browser, like a peak's Notified and Origo reference. */
  const NOTES = "nora-map-notes";
  const notes = { list: readNotes(), listeners: new Set(), version: 0 };
  function readNotes() {
    try {
      const all = JSON.parse(localStorage.getItem(NOTES) || "[]");
      return (Array.isArray(all) ? all : []).filter((n) => n && assets[n.pid] && Number.isFinite(n.lon) && Number.isFinite(n.lat))
        .map((n) => ({ id: String(n.id), pid: n.pid, lon: n.lon, lat: n.lat, text: String(n.text || ""), dx: Number(n.dx) || 28, dy: Number(n.dy) || -64 }));
    } catch (error) { return []; }
  }
  function notesChanged(save = true) {
    notes.version++;
    if (save) {
      const kept = notes.list.map(({ id, pid, lon, lat, text, dx, dy }) => ({ id, pid, lon, lat, text, dx, dy }));
      try { localStorage.setItem(NOTES, JSON.stringify(kept)); } catch (error) { /* kept for this view only */ }
    }
    for (const fn of notes.listeners) fn();
  }
  function addNote(pid, lon, lat) {
    const note = { id: `n${Date.now().toString(36)}${notes.list.length}`, pid, lon, lat, text: "", dx: 28, dy: -64, fresh: true };
    notes.list.push(note);
    notesChanged();
    return note;
  }
  function removeNote(id) {
    if (!notes.list.some((n) => n.id === id)) return;
    notes.list = notes.list.filter((n) => n.id !== id);
    notesChanged();
  }
  // The point of a laid route ([lon, lat] points) nearest a point on screen.
  function snapToRoute(line, toScreen, sx, sy) {
    let best = null;
    for (let i = 1; i < line.length; i++) {
      const a = toScreen(line[i - 1]), b = toScreen(line[i]), dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((sx - a.x) * dx + (sy - a.y) * dy) / len2)), d = Math.hypot(a.x + t * dx - sx, a.y + t * dy - sy);
      if (!best || d < best.d) best = { d, at: [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t] };
    }
    return best ? best.at : line[0];
  }
  /* The notes over one map: a window per note in `container`, placed at every draw
     from `toScreen` ([lon, lat] to pixels in the container), its arrow drawn on `ctx`.
     A note whose line is hidden, or that is off screen, hides its window. Returns where
     each window went. */
  function noteLayer(container) {
    const layer = h("div", { class: "map-notes" }), cards = new Map();
    container.append(layer);
    function card(note) {
      const text = h("textarea", { rows: "1", maxlength: "500", placeholder: "Note", "aria-label": `Note on ${nameOf(note.pid)}` });
      text.value = note.text;
      const fit = () => { text.style.height = "auto"; text.style.height = `${text.scrollHeight}px`; };
      text.addEventListener("input", () => { note.text = text.value; fit(); notesChanged(); });
      text.addEventListener("blur", () => { if (!note.text.trim()) removeNote(note.id); });
      text.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") text.blur(); });
      const close = h("button", { type: "button", class: "close", title: "Remove the note", "aria-label": "Remove the note", onclick: () => removeNote(note.id) }, "×");
      const el = h("div", { class: "map-note-card" }, text, close);
      // The map's own gestures stay off the window; its frame drags it.
      for (const type of ["wheel", "mousedown", "click", "dblclick", "contextmenu"]) el.addEventListener(type, (e) => e.stopPropagation());
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        if (e.target !== el) return;
        e.preventDefault();
        const from = { x: e.clientX, y: e.clientY, dx: note.dx, dy: note.dy }, k = display.scale || 1;
        const move = (m) => { note.dx = from.dx + (m.clientX - from.x) / k; note.dy = from.dy + (m.clientY - from.y) / k; notesChanged(false); };
        const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); notesChanged(); };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
      });
      layer.append(el);
      const made = { el, text, fit };
      cards.set(note.id, made);
      if (note.fresh) { delete note.fresh; setTimeout(() => { fit(); text.focus(); }, 0); } else setTimeout(fit, 0);
      return made;
    }
    function draw(ctx, toScreen, visible = () => true) {
      const k = display.scale || 1, w = container.clientWidth, hgt = container.clientHeight, seen = new Set(), placed = [];
      ctx.save();
      ctx.strokeStyle = COLORS.text;
      ctx.fillStyle = COLORS.text;
      ctx.lineWidth = 1;
      for (const note of notes.list) {
        const c = cards.get(note.id) || card(note), p = toScreen([note.lon, note.lat]);
        seen.add(note.id);
        const shown = visible(note.pid) && p.x > -20 && p.y > -20 && p.x < w + 20 && p.y < hgt + 20;
        c.el.hidden = !shown;
        if (!shown) { placed.push({ id: note.id, hidden: true }); continue; }
        const x = p.x + note.dx * k, y = p.y + note.dy * k, cw = c.el.offsetWidth || 120 * k, ch = c.el.offsetHeight || 28 * k;
        c.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        placed.push({ id: note.id, x: Math.round(x), y: Math.round(y), hidden: false });
        // The arrow: from the nearest point of the window's edge to the point on the line.
        const sx = Math.max(x, Math.min(x + cw, p.x)), sy = Math.max(y, Math.min(y + ch, p.y)), len = Math.hypot(p.x - sx, p.y - sy);
        if (len < 6 * k) continue;
        const ux = (p.x - sx) / len, uy = (p.y - sy) / len, head = 6 * k;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(p.x - ux * head * 0.6, p.y - uy * head * 0.6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - ux * head - uy * head * 0.45, p.y - uy * head + ux * head * 0.45);
        ctx.lineTo(p.x - ux * head + uy * head * 0.45, p.y - uy * head - ux * head * 0.45);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
      return placed;
    }
    return { draw, element: layer };
  }

