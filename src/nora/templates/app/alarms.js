  // ------------------------------------------------------------------ alarm levels
  // 0 normal, 1 warning (amber, priority 3), 2 medium (orange, 2), 3 critical (red, 1).
  const LEVEL = ["Normal", "Warning", "Medium", "Critical"];
  const LEVEL_COLOR = [null, null, null, null];
  function mix(a, b, t) {
    const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [x, y] = [rgb(a), rgb(b)];
    return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
  }
  /* Surfaces for panels, controls and cards. In light mode the state greys are the
     surfaces. In dark mode they would glare, so surfaces stay dark and the state shows
     as a lighter tint and edge: lighter still means open and active. */
  function applyPalette() {
    Object.assign(COLORS, PALETTES[theme]);
    const c = COLORS;
    // `soft`: a second ink for numbers that matter less (incoming flows), still easy to read
    // on the card (Ray, 29 Oct: "the numbers are sometimes difficult to see").
    const card = (fill, ink, dim, edge) => ({ fill, ink, dim, edge, soft: mix(ink, fill, 0.15) });
    Object.assign(COLORS, theme === "dark" ? {
      surface: c.panel, raised: mix(c.panel, c.active, 0.14), band: mix(c.panel, c.active, 0.22),
      casing: mix(c.paper, "#000000", 0.55),
      rule: "rgba(225, 228, 230, 0.14)",
      card: {
        active: card(mix(c.panel, c.active, 0.2), c.text, c.text_dim, c.active),
        normal: card(c.panel, c.text, c.text_dim, c.normal),
        inactive: card(mix(c.paper, "#000000", 0.3), c.text, c.text, c.inactive),
      },
    } : {
      surface: c.normal, raised: c.active, band: c.active, rule: "rgba(34, 39, 43, 0.16)", casing: c.text,
      card: {
        active: card(c.active, c.text, c.text_dim, c.text_dim),
        normal: card(c.normal, c.text, c.text_dim, c.text_dim),
        inactive: card(c.inactive, c.active, c.normal, c.text),
      },
    });
    LEVEL_COLOR[1] = COLORS.warning;
    LEVEL_COLOR[2] = COLORS.medium;
    LEVEL_COLOR[3] = COLORS.critical;
    for (const [key, value] of Object.entries(COLORS)) {
      if (typeof value === "string") document.documentElement.style.setProperty(`--${key.replace("_", "-")}`, value);
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    NORA.icons = NORA.iconSets[theme];
  }
  applyPalette();
  function level(value, thresholds, rising = true) {
    if (value == null || Number.isNaN(value)) return 0;
    return rising ? thresholds.filter((t) => value >= t).length : thresholds.filter((t) => value <= t).length;
  }
  /* A pressure at an upper limit (nora.toml [pressure_limits]): Ray, 29 Oct, "pressure
     number inside rectangles should change color when meeting a limit, high = yellow,
     high high = red, integrity = dark red"; "only the number itself should turn yellow
     ... not the whole square"; "we want to use strong colors sparingly". The number
     (and, zoomed in, its H, HH or INT) takes the colour, in a shade that reads on the
     tag; the alarm list says which limit in words. */

  // Strong enough to see at a glance (Ray, 29 Oct: "its a bit difficult to see the yellow
  // color of the low or high warning numbers, maybe it can be a bit stronger for those and
  // the red color as well"): a vivid golden yellow and the full alarm red on the light tag.
  function limitInk(lvl) {
    return theme === "dark"
      ? [null, COLORS.warning, COLORS.critical, mix(COLORS.integrity, COLORS.critical, 0.55)][lvl] // on the dark tag
      : [null, mix(COLORS.warning, "#000000", 0.25), COLORS.critical, COLORS.integrity][lvl];
  }
  // Its limits are [low-low, low, high, high-high, integrity]: L and H yellow, LL and HH
  // red, INT dark red (`level` 1, 2, 3 for the colour).
  // The state the views draw: the data now, or the what-if's (its own flows and pressures).
  const whatifOn = () => state.mode === "whatif";
  const viewFrame = () => (whatifOn() ? whatifState().frame : frame());
  const lineFlow = (pid) => (whatifOn() ? whatifState().frame.flows[pid] : live.values[pid]);
  function pressureMark(id, p = metric("pressure_bar", id, viewFrame())) {
    const limits = (C.pressure_limits || {})[(assets[id] || {}).type];
    if (!limits || p == null) return null;
    const [ll, low, high, hh, top] = limits;
    const at = p >= top ? ["INT", "integrity", top, 3] : p >= hh ? ["HH", "high-high", hh, 2] : p >= high ? ["H", "high", high, 1]
      : p <= ll ? ["LL", "low-low", ll, 2] : p <= low ? ["L", "low", low, 1] : null;
    if (!at) return null;
    const [code, name, limit, lvl] = at;
    return { level: lvl, code, name, limit, ink: limitInk(lvl) };
  }
  // A line's flow against its capacity (nora.toml thresholds.load): its number yellow
  // over the warning level, red past the critical one, like a pressure's.
  function flowMark(pid, v = lineFlow(pid)) {
    const d = assets[pid];
    if (!d || !d.capacity || v == null) return null;
    const lvl = level(Math.abs(v) / d.capacity, T.load);
    return lvl ? { level: lvl === 3 ? 2 : 1, ink: limitInk(lvl === 3 ? 2 : 1) } : null;
  }
  /* Each priority has its own shape and number as well as its colour; a warning (3) has
     none (Ray, 29 Oct: "remove all warning triangles") and reads as words only. */
  function shapeMarkup(lvl, x = 8, y = 8, s = 7) {
    if (lvl < 2) return "";
    const fill = LEVEL_COLOR[lvl], ink = COLORS.text;
    const outline = `fill="${fill}" stroke="${ink}" stroke-width="1.3" stroke-linejoin="round"`;
    const shape = lvl === 3 ? `<rect x="${x - s}" y="${y - s}" width="${2 * s}" height="${2 * s}" rx="1" ${outline}/>`
      : `<path d="M${x} ${y - s - 1}L${x + s + 1} ${y}L${x} ${y + s + 1}L${x - s - 1} ${y}Z" ${outline}/>`;
    const number = `<text x="${x}" y="${y + 3.6}" text-anchor="middle" font-size="${s * 1.35}" font-weight="600" font-family="Archivo, sans-serif" fill="${ink}">${4 - lvl}</text>`;
    return shape + number;
  }
  function badge(lvl, text) {
    if (!lvl) return h("span", { class: "badge text-only dim" }, text ?? LEVEL[0]);
    if (lvl === 1) return h("span", { class: "badge text-only", title: LEVEL[1] }, text ?? LEVEL[1]);
    return h("span", { class: "badge", title: LEVEL[lvl] }, svg("0 0 16 16", shapeMarkup(lvl)), text ?? LEVEL[lvl]);
  }
  // The same badge on a canvas (the views): shape, colour, dark outline and number.
  function drawBadge(ctx, lvl, x, y, size = 8) {
    if (lvl < 2) return; // a warning: no triangle
    ctx.save();
    ctx.beginPath();
    if (lvl === 3) ctx.rect(x - size, y - size, 2 * size, 2 * size);
    else { ctx.moveTo(x, y - size - 1); ctx.lineTo(x + size + 1, y); ctx.lineTo(x, y + size + 1); ctx.lineTo(x - size - 1, y); ctx.closePath(); }
    ctx.fillStyle = LEVEL_COLOR[lvl];
    ctx.fill();
    ctx.lineWidth = Math.max(1, size / 6);
    ctx.strokeStyle = COLORS.text;
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = `600 ${size * 1.3}px Archivo, sans-serif`; // nothing heavier than semibold
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(4 - lvl), x, y + size * 0.08);
    ctx.restore();
  }
  /* A pig (a dot-sized solid triangle pointing downstream) or a peak (a calm circle)
     at x, y, turned along the line by `angle`. Each kind has its own shape AND its
     own calm colour, so nothing reads as an alarm badge (triangle/diamond/square in
     amber/orange/red). */
  /* `closeness` (0 to 1) is how far the view is zoomed in: a marker grows to twice its
     size, or pigs read as specks beside the squares (Ray, 29 Oct: "when i zoom into a
     pipeline the pigs become extremely small and difficult to see"). */
  function markerSize(kind, closeness = 0) {
    const base = kind === "pig" ? 13 : 6.5; // visible in a dense view, not dominant (Ray, 29 Oct: "a bit smaller")
    return base * (1 + Math.max(0, Math.min(1, closeness)));
  }
  function drawMarker(ctx, marker, x, y, angle, size = 7, detail = 1, taken = null) {
    size *= display.scale; // markers are drawn in screen pixels in every view
    if (marker.kind === "quality") { drawParcel(ctx, marker, x, y, size, detail, taken, angle); return; }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    if (marker.kind === "pig") {
      const s = Math.max(2.5, size * 0.5);
      ctx.moveTo(s, 0); ctx.lineTo(-s * 0.8, -s * 0.7); ctx.lineTo(-s * 0.8, s * 0.7); ctx.closePath();
    } else {
      ctx.arc(0, 0, Math.max(2, size * 0.4), 0, Math.PI * 2);
    }
    ctx.fillStyle = marker.kind === "pig" ? COLORS.pig : COLORS.peak;
    ctx.fill();
    ctx.lineWidth = 0.8 * display.scale;
    ctx.strokeStyle = COLORS.casing;
    ctx.stroke();
    ctx.restore();
    markerLabel(ctx, marker, x, y, size, detail, taken, angle);
  }

