/* Browser smoke check: builds the site, serves it on a free port and opens network.html
   in headless Chromium. It catches what pytest and the Node vm tests cannot see: an
   exception on load, a screen that renders nothing, a theme toggle that does nothing,
   "[object Object]" in the page, unreadable text.

   Offline and repeatable: every request that leaves this machine is blocked (MapLibre,
   map tiles, Google fonts), and WebGL is off, so the Map view draws on its 2D canvas
   (map2d.js) with the coastline shipped inside the page. The page's clock is fixed and,
   after the first load, the data stays paused, so every run sees the same hour.

     node tests/browser/smoke.mjs                  # build with `nora`, then check
     NORA="python -m nora" node tests/browser/smoke.mjs
     node tests/browser/smoke.mjs --site site      # check an existing build

   Screenshots of Overview, Map and Flow in light and dark go to
   tests/browser/screenshots (or --shots DIR). Exit code 1 lists every failed check. */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..", "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const shots = resolve(option("--shots", join(here, "screenshots")));

// The routes to open: ids that must exist in data/nodes.csv and data/units.toml (checked
// below, so a renamed asset fails with a clear message instead of a blank screen).
const EXIT = "easington"; // a landing terminal: nominations, gas-day chart, pressures
const FIELD = "sleipner"; // a field: supply side
const UNIT = "hubs"; // an operating unit in data/units.toml
const MIN_CONTRAST = 4.5; // WCAG AA for body text
// The page's clock: synthetic data is re-timed to "now", so a fixed now gives the same
// hours, alarms and markers on every run.
const NOW = new Date("2026-10-28T10:00:00Z");

/* Contrast failures already on main, each with the board task that fixes it. Strict: a
   known failure that no longer happens fails the run too, so delete its entry in the
   same change as the fix and this list cannot go stale. */
const KNOWN = [
  { theme: "dark", within: ".units button", task: "hub task 3698", why: "unit status text on the raised button, 3.22:1" },
];

const failures = [];
const passes = [];
function check(ok, what, detail = "") {
  (ok ? passes : failures).push(detail && !ok ? `${what}: ${detail}` : what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail && !ok ? `\n     ${detail}` : ""}`);
}

// ------------------------------------------------------------------ build
function build() {
  const out = mkdtempSync(join(tmpdir(), "nora-smoke-"));
  const [cmd, ...pre] = (process.env.NORA || "nora").split(/\s+/).filter(Boolean);
  const run = spawnSync(cmd, [...pre, "build", "--out", out], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`nora build failed (${run.error ? run.error.message : `exit ${run.status}`})`);
    process.exit(1);
  }
  return out;
}

function assetIds() {
  const text = readFileSync(join(root, "data", "nodes.csv"), "utf8");
  return new Set(text.split(/\r?\n/).slice(1).map((line) => line.split(",")[0]).filter(Boolean));
}
function unitIds() {
  const text = readFileSync(join(root, "data", "units.toml"), "utf8");
  return new Set([...text.matchAll(/^\[units\.([\w-]+)\]/gm)].map((m) => m[1]));
}

// ------------------------------------------------------------------ serve
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".csv": "text/csv", ".toml": "text/plain", ".txt": "text/plain",
};
function serve(dir) {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    let file = join(dir, path);
    if (!file.startsWith(dir + sep) && file !== dir) { res.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// ------------------------------------------------------------------ page helpers
// `App` is a script-level const, not a window property: reach it through eval.
const app = (page, body) => page.evaluate(`(() => { const App = window.eval("App"); ${body} })()`);

async function visibleScreen(page) {
  return page.evaluate(() => [...document.querySelectorAll("main.stage > *")]
    .filter((el) => !el.hidden && el.getBoundingClientRect().height > 0).map((el) => el.id));
}

// Distinct colours on a canvas (sampled): a blank or one-colour canvas drew nothing.
async function canvasColours(page, selector) {
  return page.evaluate((sel) => {
    let best = 0;
    for (const canvas of document.querySelectorAll(sel)) {
      if (!canvas.width || !canvas.height) continue;
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, copy.width, copy.height).data, seen = new Set();
      for (let i = 0; i < data.length; i += 4 * 97) seen.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
      best = Math.max(best, seen.size);
    }
    return best;
  }, selector);
}

/* Does a view draw the network? A canvas of land and water alone has plenty of colours,
   so compare it with itself: every view takes its styles from App.nodeStyle and
   App.pipeStyle, so redraw once with every asset hidden and once as it is, with names,
   values and moving markers off both times. The share of pixels that differ is the lines
   and nodes on screen; a view that stopped drawing them has none. */
const BARE = { names: false, lineValues: "off", pack: false, pressureChange: false, temperature: false, pigs: false, gasQuality: false };
async function networkPixels(page, name, selector) {
  const redraw = (step) => app(page, `
    const view = App.views[${JSON.stringify(name)}], settings = App.settings();
    window.__saved = window.__saved || { node: App.nodeStyle, pipe: App.pipeStyle, settings: { ...settings } };
    const s = window.__saved;
    if (${JSON.stringify(step)} === "hidden") {
      Object.assign(settings, ${JSON.stringify(BARE)});
      App.nodeStyle = (...a) => ({ ...s.node(...a), hidden: true });
      App.pipeStyle = (...a) => ({ ...s.pipe(...a), hidden: true });
    } else {
      App.nodeStyle = s.node; App.pipeStyle = s.pipe;
      if (${JSON.stringify(step)} === "restore") { Object.assign(settings, s.settings); delete window.__saved; }
    }
    if (view.repaint) view.repaint(); else view.restyle();`);
  const pixels = () => page.evaluate((sel) => {
    const out = [];
    for (const canvas of document.querySelectorAll(sel)) {
      if (!canvas.width || !canvas.height) continue;
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
      for (let i = 0; i < data.length; i += 4 * 7) out.push(data[i] << 16 | data[i + 1] << 8 | data[i + 2]);
    }
    return out;
  }, selector);
  await redraw("hidden");
  await page.waitForTimeout(500);
  const without = await pixels();
  await redraw("shown");
  await page.waitForTimeout(500);
  const shown = await pixels();
  await redraw("restore");
  await page.waitForTimeout(300);
  const differ = shown.filter((v, i) => v !== without[i]).length;
  return shown.length ? differ / shown.length : 0;
}

/* Contrast of every visible piece of text on a screen against what is behind it. The
   colours are composited on a 1×1 canvas, so rgba, color-mix() and oklch() all resolve
   the way the browser paints them. Returns the failing pieces. */
async function lowContrast(page, selector, minimum, known) {
  return page.evaluate(([sel, min, knownWithin]) => {
    const pixel = document.createElement("canvas");
    pixel.width = pixel.height = 1;
    const ctx = pixel.getContext("2d", { willReadFrequently: true });
    const paint = (colour, alpha = 1) => {
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#000"; ctx.fillStyle = colour; // invalid colours keep black
      ctx.fillRect(0, 0, 1, 1);
      ctx.globalAlpha = 1;
    };
    const read = () => [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
    const luminance = (rgb) => {
      const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}`;
    const bad = [];
    const scope = document.querySelector(sel);
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const done = new Set();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el || done.has(el) || !node.textContent.trim()) continue;
      done.add(el);
      if (el.closest("svg")) continue; // chart labels are drawn shapes; checked by eye in the screenshots
      const box = el.getBoundingClientRect(), style = getComputedStyle(el);
      if (!box.width || !box.height || style.visibility !== "visible" || el.closest("[hidden]")) continue;
      if (el.closest(".sr-only")) continue;
      // Background: every ancestor's background painted from the page down.
      const chain = [];
      let opacity = 1;
      for (let at = el; at; at = at.parentElement) {
        chain.unshift(at);
        opacity *= Number(getComputedStyle(at).opacity);
      }
      paint(getComputedStyle(document.documentElement).colorScheme === "dark" ? "#000" : "#fff");
      let ground = "html";
      for (const at of chain) {
        const bg = getComputedStyle(at).backgroundColor;
        paint(bg);
        if (!/^rgba\(.*, 0\)$|^transparent$/.test(bg)) ground = describe(at);
      }
      const behind = read();
      paint(style.color, opacity);
      const ink = read();
      const value = ratio(ink, behind);
      if (value < min) {
        bad.push({ within: knownWithin.find((k) => el.closest(k)) || null,
          text: `${value.toFixed(2)}:1 "${node.textContent.trim().slice(0, 40)}" ${describe(el)} rgb(${ink}) on rgb(${behind}) of ${ground}` });
      }
    }
    return bad;
  }, [selector, minimum, known]);
}

// ------------------------------------------------------------------ the checks
async function main() {
  const ids = assetIds();
  for (const id of [EXIT, FIELD]) check(ids.has(id), `data/nodes.csv has "${id}"`, "rename the smoke check's route ids to match the data");
  check(unitIds().has(UNIT), `data/units.toml has "${UNIT}"`, "rename the smoke check's unit id to match the data");

  const site = args.includes("--site") ? resolve(option("--site")) : build();
  const built = !args.includes("--site");
  const server = await serve(site);
  const base = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(shots, { recursive: true });

  // WebGL off: the Map view falls back to its 2D canvas, which needs no tiles.
  const browser = await chromium.launch({ args: ["--disable-gpu", "--disable-webgl", "--disable-3d-apis"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, colorScheme: "light", reducedMotion: "reduce", timezoneId: "UTC", locale: "en-GB",
  });
  await context.clock.setFixedTime(NOW);
  // Only this server: MapLibre, tiles and fonts are blocked so the run is the same offline.
  await context.route((url) => !url.href.startsWith(base), (route) => route.abort("blockedbyclient"));
  const page = await context.newPage();

  const errors = [];
  page.on("pageerror", (error) => errors.push(`uncaught: ${error.stack || error.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const where = (msg.location() && msg.location().url) || "";
    // A blocked outside request (fonts, MapLibre) logs a load failure for that URL: expected.
    if (where && !where.startsWith(base) && /Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(msg.text())) return;
    errors.push(`console: ${msg.text()} (${where || "no location"})`);
  });

  try {
    // ---- load, playing the data as a visitor sees it
    await page.goto(`${base}/network.html#/overview`, { waitUntil: "load" });
    const started = await page.waitForFunction(() => {
      const o = document.getElementById("screen-overview");
      return o && !o.hidden && o.textContent.trim().length > 50;
    }, null, { timeout: 30000 }).then(() => true, () => false);
    check(started, "the app starts and the Overview renders");
    await page.waitForTimeout(2000); // a few data steps play
    check(!errors.length, "no console errors or uncaught exceptions on load", errors.join("\n     "));
    if (!started) throw new Error("the app did not start; later checks would only repeat this");

    // ---- the Guide opens on a first visit only (and would cover the screenshots)
    const guideOpen = () => page.evaluate(() => !document.getElementById("key").hidden);
    check(await guideOpen(), "the Guide opens on the first visit");
    // From here on the data stays paused at the fixed now, so every run sees the same hour.
    await page.goto(`${base}/network.html?autoplay=0#/overview`, { waitUntil: "load" });
    await page.waitForFunction(() => document.getElementById("screen-overview").textContent.trim().length > 50, null, { timeout: 30000 });
    check(!(await guideOpen()), "the Guide stays closed on the second visit");

    // ---- theme toggle
    const themeOf = () => page.evaluate(() => document.documentElement.dataset.theme);
    const paper = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
    const first = await themeOf(), firstPaper = await paper();
    await page.click("#theme-toggle");
    const second = await themeOf(), secondPaper = await paper();
    await page.click("#theme-toggle");
    const third = await themeOf();
    check(["light", "dark"].includes(first) && second !== first && third === first,
      "the theme toggle flips data-theme and back", `${first} → ${second} → ${third}`);
    check(firstPaper && secondPaper && firstPaper !== secondPaper, "the theme toggle changes the palette (--paper)", `${firstPaper} → ${secondPaper}`);

    const setTheme = async (want) => { if ((await themeOf()) !== want) await page.click("#theme-toggle"); };
    const go = async (hash) => {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(300);
    };
    const showView = async (name) => {
      await go("#/unit/all");
      await page.click(`#views [data-view="${name}"]`);
      await page.waitForFunction((n) => { const v = window.eval("App").views[n]; return v && v.ready; }, name, { timeout: 30000 });
      await page.waitForTimeout(800);
    };

    // ---- routes
    await go("#/overview");
    check((await visibleScreen(page)).includes("screen-overview"), "#/overview shows the Overview");

    await showView("map");
    const mapState = await app(page, "return { canvas: !!App.views.map.canvasMap, shown: !document.getElementById('view-map').hidden };");
    check(mapState.shown, "#/unit/all on the Map shows the Map view");
    check(mapState.canvas, "without WebGL the Map falls back to the 2D canvas map");
    const mapColours = await canvasColours(page, "#view-map canvas");
    check(mapColours >= 4, "the Map canvas is not blank", `${mapColours} distinct colours sampled`);
    const mapNetwork = await networkPixels(page, "map", "#view-map canvas");
    check(mapNetwork >= 0.002, `the Map draws the network (${(mapNetwork * 100).toFixed(1)}% of pixels)`,
      "hiding every asset changed almost nothing on the canvas");

    await showView("flow");
    const flowShown = await page.evaluate(() => !document.getElementById("view-flow").hidden);
    check(flowShown, "#/unit/all on Flow shows the Flow view");
    const flowColours = await canvasColours(page, "#view-flow canvas");
    check(flowColours >= 4, "the Flow canvas is not blank", `${flowColours} distinct colours sampled`);
    const flowNetwork = await networkPixels(page, "flow", "#view-flow canvas");
    check(flowNetwork >= 0.002, `the Flow view draws the network (${(flowNetwork * 100).toFixed(1)}% of pixels)`,
      "hiding every asset changed almost nothing on the canvas");

    await go(`#/unit/${UNIT}`);
    const unit = await app(page, "return { unit: App.route.unit, shown: !document.getElementById('view-flow').hidden && App.views.flow.shownUnit };");
    check(unit.unit === UNIT && unit.shown === UNIT, `#/unit/${UNIT} shows that unit`, JSON.stringify(unit));

    for (const id of [EXIT, FIELD]) {
      await go(`#/asset/${id}`);
      const asset = await page.evaluate(() => {
        const s = document.getElementById("screen-asset");
        const facts = [...s.querySelectorAll(".box")].find((b) => /^Facts/.test(b.textContent));
        return { shown: !s.hidden, title: (s.querySelector("h1") || {}).textContent || "", text: s.textContent, facts: facts ? facts.textContent : null };
      });
      const name = await app(page, `return App.nameOf(${JSON.stringify(id)});`);
      check(asset.shown && asset.title === name, `#/asset/${id} shows "${name}"`, `shown ${asset.shown}, title "${asset.title}"`);
      check(asset.facts != null && asset.facts.length > 10, `#/asset/${id} has a Facts list`);
      check(asset.facts != null && !asset.facts.includes("[object"), `#/asset/${id} Facts has no "[object"`, asset.facts || "");
      check(!asset.text.includes("[object") && !/\bundefined\b|\bNaN\b/.test(asset.text), `#/asset/${id} shows no "[object", undefined or NaN`,
        (asset.text.match(/.{0,40}(\[object|\bundefined\b|\bNaN\b).{0,40}/) || [""])[0]);
    }

    await go(`#/diag/${EXIT}`);
    const diag = await page.evaluate(() => {
      const s = document.getElementById("screen-diag");
      return { shown: !s.hidden, rows: s.querySelectorAll("tbody tr").length, text: s.textContent };
    });
    check(diag.shown && diag.rows > 0, `#/diag/${EXIT} shows readings`, `shown ${diag.shown}, ${diag.rows} rows`);
    check(!diag.text.includes("[object"), `#/diag/${EXIT} shows no "[object"`);

    // ---- moving markers somewhere in the synthetic stream
    const marks = await app(page, `
      const s = App.live.stream; if (!s) return { name: null, hours: 0, kinds: [] };
      const kinds = new Set(), back = App.live.playhead;
      for (let i = 0; i < s.times.length && kinds.size < 2; i++) { App.seek(i); for (const m of App.markers()) kinds.add(m.kind); }
      App.seek(back);
      return { name: s.name || null, hours: s.times.length, kinds: [...kinds] };`);
    check(marks.kinds.includes("pig"), "App.markers() returns a pig at some hour of the opening stream",
      `stream ${marks.name}, ${marks.hours} steps, marker kinds seen: ${marks.kinds.join(", ") || "none"}`);
    check(marks.kinds.includes("quality"), "App.markers() returns an H2S or CO2 peak at some hour of the opening stream",
      `stream ${marks.name}, ${marks.hours} steps, marker kinds seen: ${marks.kinds.join(", ") || "none"}`);

    // ---- screenshots and contrast, light and dark
    for (const theme of ["light", "dark"]) {
      await go("#/overview");
      await setTheme(theme);
      await page.waitForTimeout(400);
      check((await themeOf()) === theme, `the ${theme} theme can be chosen`);
      await page.screenshot({ path: join(shots, `overview-${theme}.png`) });
      const known = KNOWN.filter((k) => k.theme === theme);
      const bad = await lowContrast(page, "#screen-overview", MIN_CONTRAST, known.map((k) => k.within));
      const fresh = bad.filter((b) => !b.within);
      check(!fresh.length, `Overview text contrast is at least ${MIN_CONTRAST}:1 in ${theme}`, fresh.slice(0, 12).map((b) => b.text).join("\n     "));
      for (const k of known) {
        const hits = bad.filter((b) => b.within === k.within);
        if (hits.length) console.log(`known ${theme}: ${hits.length} below ${MIN_CONTRAST}:1 in ${k.within} (${k.why}; ${k.task})`);
        check(hits.length > 0, `known failure in ${k.within} (${theme}) still happens`,
          `it is fixed: delete its entry from KNOWN in tests/browser/smoke.mjs (${k.task})`);
      }
      for (const view of ["map", "flow"]) {
        await showView(view);
        await page.screenshot({ path: join(shots, `${view}-${theme}.png`) });
      }
    }
    await setTheme(first);

    check(!errors.length, "no console errors or uncaught exceptions while using the app", errors.join("\n     "));
  } catch (error) {
    check(false, "the smoke run finished", error.stack || String(error));
  } finally {
    await browser.close();
    server.close();
    if (built) rmSync(site, { recursive: true, force: true });
  }

  console.log(`\n${passes.length} passed, ${failures.length} failed. Screenshots in ${shots}`);
  if (failures.length) {
    console.log(`\nFailed:\n${failures.map((f) => `  - ${f.split("\n")[0]}`).join("\n")}`);
    process.exit(1);
  }
}

main();
