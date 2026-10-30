  // ------------------------------------------------------------------ P&ID
  /* A field's process as a P&ID, on its Level 3 page (Ray, 30 Oct: "should also be able to
     bring up a level 3 which could be an P&ID of the field that was clicked. make it
     intuitive and easy to navigate"). Left to right, the way the gas goes: its tie-backs
     and wells, the production manifold, the inlet separator, gas dehydration, export
     compression, fiscal metering with the gas chromatograph, the ESD valve and the export
     pipelines. A typical gas train for illustration: a platform's own P&ID is not public,
     and the page says so. The instruments carry the field's own readings from the data;
     one with no reading in the dataset shows its tag only, never a made-up number.
     Everything named is a way on: a tie-back or an export line opens its page, an
     instrument opens the field's trends (Level 4). */
  const PID_W = 1000, PID_H = 300, PID_MAIN = 128; // the main gas line's height
  function pidDiagram(id, f = frame()) {
    const d = assets[id];
    if (!d || d.kind !== "node") return null;
    const ink = COLORS.text, dim = COLORS.text_dim, paper = COLORS.paper, active = COLORS.active;
    const flow = throughput(id, f.flows), bar = metric("pressure_bar", id, f), mark = bar == null ? null : pressureMark(id, bar);
    const q = gasQuality(id, f), h2s = metric("h2s_ppm", id, f), co2 = metric("co2_molpct", id, f);
    const running = flow != null && flow >= 0.05;
    const inbound = pipeIds.filter((pid) => assets[pid].to === id && !pidHidden(pid)).slice(0, 6);
    const outbound = pipeIds.filter((pid) => assets[pid].from === id && !pidHidden(pid)).slice(0, 4);
    const y0 = PID_MAIN, text = (x, y, s, opts = "") => `<text x="${x}" y="${y}" ${opts} style="font:12px Archivo, sans-serif" fill="${ink}">${esc(s)}</text>`;
    const small = (x, y, s, opts = "") => `<text x="${x}" y="${y}" ${opts} style="font:10.5px Archivo, sans-serif" fill="${dim}">${esc(s)}</text>`;
    const pipe = (x1, y1, x2, y2, live = running, w = 2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${live ? active : dim}" stroke-width="${w}"/>`;
    const arrow = (x, y) => `<path d="M${x - 7} ${y - 4}L${x} ${y}L${x - 7} ${y + 4}" fill="none" stroke="${running ? active : dim}" stroke-width="1.5"/>`;
    // An instrument: a circle with its letters and loop number, its reading beside it,
    // and a hairline to the line it measures. Opens the field's trends.
    const instrument = (x, y, letters, loop, reading, title, level = 0, tapY = y0) => {
      const ring = level ? LEVEL_COLOR[level] : ink, lines = [].concat(reading).filter(Boolean); // a reading may take two lines
      const said = lines.join(", ");
      return `<g class="pid-link" data-diag="${esc(id)}" tabindex="0" role="button" aria-label="${esc(`${letters}-${loop}: ${title}${said ? `, ${said}` : ", no reading in the dataset"}. Opens the trends`)}">`
        + `<rect x="${x - 17}" y="${y - 17 - (lines.length > 1 ? 8 : 0)}" width="${36 + 7 * Math.max(0, ...lines.map((l) => l.length))}" height="${34 + (lines.length > 1 ? 16 : 0)}" fill="transparent" stroke="none"/>` // one place to click: the circle and its reading
        + `<line x1="${x}" y1="${y + (y < tapY ? 14 : -14)}" x2="${x}" y2="${tapY}" stroke="${dim}" stroke-width="1" stroke-dasharray="3 2"/>`
        + `<circle cx="${x}" cy="${y}" r="14" fill="${paper}" stroke="${ring}" stroke-width="${level ? 2 : 1.2}"/>`
        + `<line x1="${x - 14}" y1="${y}" x2="${x + 14}" y2="${y}" stroke="${ring}" stroke-width="0.8"/>`
        + `<text x="${x}" y="${y - 3}" text-anchor="middle" style="font:600 8.5px Archivo, sans-serif" fill="${ink}">${letters}</text>`
        + `<text x="${x}" y="${y + 9}" text-anchor="middle" style="font:8px Archivo, sans-serif" fill="${ink}">${loop}</text>`
        + lines.map((line, i) => `<text x="${x + 19}" y="${y + 4 + (i - (lines.length - 1) / 2) * 15}" style="font:600 11.5px Archivo, sans-serif" fill="${level ? limitInk(level) || ink : ink}">${esc(line)}</text>`).join("")
        + `<title>${esc(title)}</title></g>`;
    };
    const vessel = (x, y, w, hgt, tag, name) => `<rect x="${x - w / 2}" y="${y - hgt / 2}" width="${w}" height="${hgt}" rx="${Math.min(w, hgt) / 2}" fill="${COLORS.card.active.fill}" stroke="${ink}" stroke-width="1.2"/>`
      + small(x, y + hgt / 2 + 14, tag, 'text-anchor="middle"') + small(x, y + hgt / 2 + 27, name, 'text-anchor="middle"');
    let m = "";
    // 1. Tie-backs and wells, into the manifold.
    const mx = 205, rows = [...inbound.map((pid) => ({ pid })), { wells: true }];
    const step = Math.min(34, 210 / Math.max(1, rows.length)), top = y0 - ((rows.length - 1) * step) / 2;
    rows.forEach((row, i) => {
      const y = top + i * step;
      m += pipe(150, y, mx - 10, y, row.wells ? running : (f.flows[row.pid] || 0) >= 0.05 || running, 1.4) + `<line x1="${mx - 10}" y1="${y}" x2="${mx}" y2="${y0}" stroke="${dim}" stroke-width="1"/>`;
      if (row.wells) m += `<g><path d="M128 ${y - 9}v18M122 ${y - 9}h12M122 ${y + 9}h12" stroke="${ink}" stroke-width="1.2" fill="none"/>${text(116, y + 4, "Wells", 'text-anchor="end"')}</g>`;
      else {
        const other = assets[row.pid].from, tie = assets[other] && assets[other].min_zoom > 0;
        m += `<g class="pid-link" data-asset="${esc(other)}" tabindex="0" role="button" aria-label="${esc(`${nameOf(other)}, ${tie ? "tie-back" : "line in"}. Opens its page`)}">`
          + `<rect x="8" y="${y - 11}" width="134" height="22" fill="transparent" stroke="none"/>`
          + text(138, y + 4, nameOf(other).length > 17 ? `${nameOf(other).slice(0, 16)}…` : nameOf(other), 'text-anchor="end" text-decoration="underline"')
          + `<title>${esc(`${nameOf(row.pid)}${tie ? " (tie-back)" : ""}`)}</title></g>`;
      }
    });
    m += `<rect x="${mx}" y="${y0 - 40}" width="16" height="80" fill="${COLORS.card.active.fill}" stroke="${ink}" stroke-width="1.2"/>` + small(mx + 8, y0 + 54, "M-100", 'text-anchor="middle"') + small(mx + 8, y0 + 67, "Manifold", 'text-anchor="middle"');
    // 2. Inlet separator, 3. dehydration, 4. compression, along the main gas line.
    m += pipe(mx + 16, y0, 300, y0) + arrow(300, y0);
    m += vessel(350, y0, 100, 46, "V-100", "Inlet separator");
    m += pipe(400, y0, 470, y0) + arrow(470, y0);
    m += vessel(490, y0, 40, 110, "T-200", "TEG dehydration");
    m += pipe(510, y0, 580, y0) + arrow(580, y0);
    m += `<path d="M590 ${y0 - 26}L640 ${y0 - 14}V${y0 + 14}L590 ${y0 + 26}Z" fill="${COLORS.card.active.fill}" stroke="${ink}" stroke-width="1.2"/>` + small(615, y0 + 44, "K-300", 'text-anchor="middle"') + small(615, y0 + 57, "Export compressor", 'text-anchor="middle"');
    // Liquids off the separator: shown, not modelled.
    m += `<line x1="388" y1="${y0 + 18}" x2="388" y2="${PID_H - 34}" stroke="${dim}" stroke-width="1.4" stroke-dasharray="5 3"/>` + small(396, PID_H - 26, "Condensate and oil to storage and export (not modelled)");
    // 5. Metering with the gas chromatograph, 6. the ESD valve, 7. the export lines.
    m += pipe(640, y0, 870, y0) + arrow(730, y0);
    m += `<rect x="750" y="${y0 - 9}" width="40" height="18" fill="${paper}" stroke="${ink}" stroke-width="1.2"/>` + small(770, y0 + 104, "Fiscal metering", 'text-anchor="middle"'); // below the GC: the taps do not cross it
    const open = running;
    m += `<g><path d="M840 ${y0 - 9}L860 ${y0 + 9}V${y0 - 9}L840 ${y0 + 9}Z" fill="${open ? paper : ink}" stroke="${ink}" stroke-width="1.2"/>`
      + `<line x1="850" y1="${y0}" x2="850" y2="${y0 - 18}" stroke="${ink}" stroke-width="1.2"/><rect x="843" y="${y0 - 26}" width="14" height="8" fill="${paper}" stroke="${ink}" stroke-width="1"/>`
      + small(850, y0 + 30, "XV-501", 'text-anchor="middle"') + small(850, y0 + 43, `ESD ${open ? "open" : "closed"}`, 'text-anchor="middle"') + `<title>Emergency shutdown valve: ${open ? "open, gas flowing" : "no export flow in the data"}</title></g>`;
    // Instruments: pressure and temperature after the compressor, flow and quality at metering.
    m += instrument(652, y0 - 62, "PT", "301", bar == null ? "" : `${fmt(bar, 1)} bar${mark ? ` ${mark.code}` : ""}`, "Export pressure, after the compressor", mark ? mark.level : 0);
    m += instrument(770, y0 - 62, "FT", "401", flow == null ? "" : `${fmt(flow, 1)} MSm³/d`, "Export flow, fiscal metering");
    const quality = [[h2s != null ? `H₂S ${fmt(h2s, 1)} ppm` : "", co2 != null ? `CO₂ ${fmt(co2, 2)} %` : ""].filter(Boolean).join(" · "), q ? `GCV ${fmt(q.gcv, 1)} MJ/Sm³` : ""];
    m += instrument(770, y0 + 70, "AT", "402", quality, "Gas chromatograph: H₂S, CO₂ and the gas's calorific value");
    m += instrument(430, y0 - 62, "PT", "101", "", "Separator pressure");
    m += instrument(350, y0 - 62, "LT", "101", "", "Separator liquid level");
    // Export lines out, each a way on to its page.
    const outs = outbound.length ? outbound : [null];
    const ostep = Math.min(40, 200 / outs.length), otop = y0 - ((outs.length - 1) * ostep) / 2;
    outs.forEach((pid, i) => {
      const y = otop + i * ostep;
      m += `<line x1="870" y1="${y0}" x2="884" y2="${y}" stroke="${running ? active : dim}" stroke-width="2"/>` + pipe(884, y, 990, y) + arrow(990, y);
      if (pid) {
        const v = f.flows[pid];
        m += `<g class="pid-link" data-asset="${esc(pid)}" tabindex="0" role="button" aria-label="${esc(`${nameOf(pid)}${v != null ? `, ${fmt(Math.abs(v), 1)} MSm³/d` : ""}. Opens its page`)}">`
          + `<rect x="876" y="${y - 22}" width="118" height="26" fill="transparent" stroke="none"/>`
          + text(882, y - 6, nameOf(pid).length > 18 ? `${nameOf(pid).slice(0, 17)}…` : nameOf(pid), 'text-decoration="underline"')
          + (v != null ? small(882, y + 14, `${fmt(Math.abs(v), 1)} MSm³/d`) : "") + `<title>${esc(nameOf(pid))}</title></g>`;
      }
    });
    const node = svg(`0 0 ${PID_W} ${PID_H}`, m, "schematic pid");
    node.removeAttribute("aria-hidden");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", `${d.name}: process as a P&ID, from its wells and tie-backs on the left to its export lines on the right`);
    const follow = (event) => {
      const g = event.target && event.target.closest && event.target.closest("[data-asset], [data-diag]");
      if (!g) return;
      if (g.hasAttribute("data-asset") && assets[g.getAttribute("data-asset")]) go({ screen: "asset", asset: g.getAttribute("data-asset") });
      else if (g.hasAttribute("data-diag")) go({ screen: "diag", asset: g.getAttribute("data-diag") });
    };
    on(node, "click", follow);
    on(node, "keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); follow(event); } });
    return node;
  }
  const pidHidden = (pid) => pipeStyle(pid).hidden;
  // The P&ID box at the top of a field's page, full width.
  function pidBox(id) {
    const d = assets[id];
    if (!d || d.type !== "field") return null;
    const picture = pidDiagram(id);
    if (!picture) return null;
    return h("div", { class: "box wide pid-box", id: "pid" },
      h("h2", { title: "Click a tie-back or an export line for its page, an instrument for the trends" }, "Process (P&ID)"),
      picture,
      h("p", { class: "dim small" }, "A typical gas train for illustration, not the platform's own P&ID (that is not public). "
        + `The instruments show this field's readings${live.stream && live.stream.synthetic ? " (synthetic)" : ""}; one with no reading in the dataset shows its tag only. `
        + "Click a tie-back or an export line to open it, an instrument for its trends."));
  }
