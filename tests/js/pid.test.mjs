/* Ray, 30 Oct: "should also be able to bring up a level 3 which could be an P&ID of the
   field that was clicked. make it intuitive and easy to navigate". A field's page leads with
   its process as a P&ID: its tie-backs in on the left, the process train, its export lines
   out on the right, the field's own readings on the instruments. A tie-back or an export
   line opens its page, an instrument the field's trends. The sidebar and the right-click
   menu bring it up. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const find = (el, ok) => (el && ok(el) ? el : ((el && el.children) || []).map((c) => (typeof c === "object" ? find(c, ok) : null)).find(Boolean) || null);

function page(asset) {
  const loaded = loadApp();
  const { App, NORA, document } = loaded;
  document.getElementById("speed").options = [{ value: "600" }];
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  App.go({ screen: "asset", asset });
  return { ...loaded, box: find(document.getElementById("screen-asset"), (n) => n.getAttribute && n.getAttribute("id") === "pid") };
}

test("P&ID: a field's page leads with its process, tie-backs in, export lines out, its readings on the instruments", () => {
  const { App, NORA, box } = page("gjoa");
  assert.ok(box, "a P&ID box on Gjøa's page");
  const picture = find(box, (n) => /^svg$/i.test(n.tagName || "")), markup = picture._innerHTML;
  for (const sat of ["vega", "nova", "duva"]) assert.match(markup, new RegExp(`data-asset="${sat}"`), `${sat}, its tie-back, is a way to its page`);
  const out = App.pipeIds.find((pid) => NORA.assets[pid].from === "gjoa" && !NORA.assets[NORA.assets[pid].to].min_zoom);
  assert.match(markup, new RegExp(`data-asset="${out}"`), "the export line is a way to its page");
  for (const tag of ["V-100", "T-200", "K-300", "XV-501", "M-100"]) assert.ok(markup.includes(tag), `${tag} drawn`);
  const pressure = App.reading("gjoa").pressure;
  assert.ok(markup.includes(`${App.fmt(pressure, 1)} bar`), "PT-301 shows the field's pressure");
  assert.match(markup, /PT-101: Separator pressure, no reading in the dataset/, "an instrument with no data says so, with no number");
  assert.match(box.textContent, /not the platform's own P&ID/, "it says what it is");
});

test("P&ID: a click on a tie-back opens its page; on an instrument, the trends", () => {
  const { App, box } = page("gjoa");
  const picture = find(box, (n) => /^svg$/i.test(n.tagName || ""));
  const click = (attr, value) => picture._listeners.click[0]({ target: { closest: () => ({ hasAttribute: (a) => a === attr, getAttribute: () => value }) } });
  click("data-asset", "vega");
  assert.deepEqual([App.route.screen, App.route.asset], ["asset", "vega"]);
  App.go({ screen: "asset", asset: "gjoa" });
  click("data-diag", "gjoa");
  assert.deepEqual([App.route.screen, App.route.asset], ["diag", "gjoa"]);
});

test("P&ID: only fields have one; the sidebar and the right-click menu bring it up", () => {
  assert.equal(page("kollsnes").box, null, "a gas plant's page has none");
  const { App } = page("gjoa");
  const labels = App.menu.for("gjoa").filter((i) => i !== "-").map((i) => i.label);
  assert.ok(labels.includes("Open the P&ID"), "in the right-click menu");
  assert.ok(!App.menu.for("kollsnes").some((i) => i.label === "Open the P&ID"), "not for a plant");
});

/* Seen on the live Sleipner page, 30 Oct: seven lines fanned into one point on the
   manifold, the lowest cut through its "M-100 Manifold" tag, and a seventh (Zeepipe IIA
   from Kollsnes) was left out without a word. */
const svgOf = (box) => find(box, (n) => /^svg$/i.test(n.tagName || ""))._innerHTML;
const numbers = (tag, markup) => [...markup.matchAll(new RegExp(`<${tag} ([^>]*)/?>`, "g"))].map(([, attrs]) =>
  Object.fromEntries([...attrs.matchAll(/(\w[\w-]*)="([^"]*)"/g)].map(([, k, v]) => [k, Number.isNaN(Number(v)) ? v : Number(v)])));

test("P&ID: every line into Sleipner is drawn, the main lines first, each straight into the manifold", () => {
  const { NORA, box } = page("sleipner");
  const markup = svgOf(box);
  const into = Object.values(NORA.assets).filter((a) => a.kind === "pipeline" && a.to === "sleipner");
  for (const a of into) assert.match(markup, new RegExp(`data-asset="${a.from}"`), `${a.from} drawn`);
  assert.ok(markup.indexOf('data-asset="kollsnes"') < markup.indexOf('data-asset="gungne"'), "Zeepipe IIA from Kollsnes above the tie-backs");
  const manifold = numbers("rect", markup).find((r) => r.x === 205 && r.width === 16);
  const inlets = numbers("line", markup).filter((l) => l.x2 === 205);
  assert.equal(inlets.length, into.length + 1, "one line per pipeline in, and the wells");
  for (const l of inlets) {
    assert.equal(l.y1, l.y2, "straight in, not fanned across the tag below");
    assert.ok(l.y1 > manifold.y && l.y1 < manifold.y + manifold.height, "into the manifold's side");
  }
  const tag = [...markup.matchAll(/<text x="213" y="([\d.]+)"[^>]*>M-100</g)].map((m) => Number(m[1]))[0];
  assert.ok(tag > manifold.y + manifold.height, "its tag below it, clear of every line");
});

test("P&ID: with more than eight lines in, seven are drawn and the rest counted", () => {
  const { NORA, box } = page("asgard");
  const markup = svgOf(box);
  const into = Object.values(NORA.assets).filter((a) => a.kind === "pipeline" && a.to === "asgard");
  assert.ok(into.length > 8, "Åsgard has more than eight lines in");
  assert.equal((markup.match(/data-asset="/g) || []).length - (markup.match(/x="876"/g) || []).length, 7, "seven drawn");
  assert.match(markup, new RegExp(`\\+${into.length - 7} more`), "and a count of the rest, never a silent cut");
});
