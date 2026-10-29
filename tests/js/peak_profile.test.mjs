/* Hub 3607 (Ray, 27 Oct: "if i click on a peak i should be able to see the source of the
   peak and the profile of the H2S in the pipeline"). The peak panel draws the
   concentration along the route from the field: the slug now, and dashed what its
   strongest parcel is expected to become, diluted where other gas joins. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}
// The synthetic week at the first hour with a slug still on its way to an exit.
function openSlug() {
  const loaded = loadApp();
  const { App, NORA, document } = loaded;
  document.getElementById("speed").options = [{ value: "600" }];
  const week = NORA.streams.find((s) => s.synthetic);
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: week.name } });
  App.state.mode = "live";
  App.go({ screen: "unit", unit: "all" });
  const scrub = document.getElementById("scrub");
  for (let i = 0; i < week.times.length; i++) {
    scrub.value = String(i);
    scrub._listeners.input[0]();
    const slug = App.markers().find((m) => m.kind === "quality" && m.lead && App.live.quality.some((q) => q.slug === m.ref && !q.arrived && q.path.length > 1));
    if (slug) {
      App.selectMarker(slug.key);
      let profile = null;
      walk(document.getElementById("side-body"), (n) => { if (!profile && /slug-profile/.test(n.className || "")) profile = n; });
      let chart = null;
      walk(profile, (n) => { if (!chart && /^svg$/i.test(n.tagName)) chart = n; });
      return { ...loaded, slug, profile, markup: chart ? chart.innerHTML : "" };
    }
  }
  throw new Error("no slug under way in the synthetic week");
}

test("peak profile: the slug along its route, from the field to the exit, with the limits", () => {
  const { App, NORA, slug, profile, markup } = openSlug();
  assert.ok(profile, "the peak panel has a profile");
  assert.match(profile.textContent, /(H₂S|CO₂) along the route/);
  assert.match(markup, /class="now"/, "the slug as it is now");
  assert.match(markup, /class="ahead"[^>]*stroke-dasharray/, "what is expected ahead, dashed");
  assert.match(markup, />Warning [\d.]+</);
  assert.match(markup, />Alarm [\d.]+</);
  const origin = App.live.slugs.get(slug.ref).origin;
  assert.ok(markup.includes(`>${NORA.assets[origin].name}<`), "the route starts at the field it came from");
  assert.match(markup, />[\d,]+ km</, "the route's length");
});

test("peak profile: the dashed line ends at the concentration expected at the exit", () => {
  const { App, slug, markup } = openSlug();
  const lead = App.live.quality.filter((q) => q.slug === slug.ref).reduce((a, b) => (a.conc >= b.conc ? a : b));
  // The chart's scale from the alarm line: y = 120 - c / hi * 108
  const [, yAlarm] = markup.match(/<line x1="8" x2="332" y1="([\d.]+)"[^>]*\/><text[^>]*>Alarm/);
  const alarm = Number(markup.match(/>Alarm ([\d.]+)</)[1]);
  const hi = (alarm * 108) / (120 - Number(yAlarm));
  const ahead = markup.match(/class="ahead" d="([^"]+)"/)[1];
  const lastY = Number(ahead.trim().split(/[ML]/).filter(Boolean).pop().split(",")[1]);
  const atExit = ((120 - lastY) / 108) * hi;
  assert.ok(atExit > 0 && atExit <= lead.conc + 1e-9, `diluted on the way: ${lead.conc} in the peak now, ${atExit.toFixed(3)} at the exit`);
  const steps = ahead.split("L").map((p) => p.replace("M", "").split(",").map(Number));
  assert.ok(steps.some(([x, y], k) => k && x === steps[k - 1][0] && y > steps[k - 1][1]), "it steps down where other gas joins");
});
