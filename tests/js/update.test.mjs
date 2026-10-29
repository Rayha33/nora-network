/* Ray, 29 Oct: his open tab showed bugs fixed hours before (it never reloaded). A tab
   compares its build with the site's version.json; a newer one reloads it when nobody is
   at it, or the bar offers "New version · Reload". */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";
import { makeDom } from "./stub.mjs";

function withBuild(published) {
  const document = makeDom(), find = document.querySelector.bind(document);
  document.querySelector = (sel) => (String(sel).includes("nora-build") ? { content: "aaaaaaaaaaaa" } : find(sel));
  const reloads = [];
  const location = { search: "", hash: "", href: "http://localhost/network.html", pathname: "/network.html", reload: () => reloads.push(1) };
  const fetch = async (url) => ({ ok: true, json: async () => ({ build: published, url }) });
  const loaded = loadApp({ globals: { document, fetch, location } });
  return { ...loaded, document, reloads };
}

test("update: the same build stays; a newer one reloads an idle tab", async () => {
  const same = withBuild("aaaaaaaaaaaa");
  assert.equal(same.App.build(), "aaaaaaaaaaaa", "the page knows its build");
  assert.equal(await same.App.checkBuild(Date.now() + 120000), "current");
  const newer = withBuild("bbbbbbbbbbbb");
  assert.equal(await newer.App.checkBuild(Date.now() + 120000), "reloaded", "nobody at it for two minutes");
  assert.equal(newer.reloads.length, 1);
});

test("update: someone at it, or What-if values, get a Reload button instead", async () => {
  const { App, document, reloads } = withBuild("bbbbbbbbbbbb");
  assert.equal(await App.checkBuild(Date.now()), "offered", "touched just now");
  assert.equal(document.getElementById("update").hidden, false, "the button shows");
  App.whatif.set("supply", "troll", 50);
  assert.equal(await App.checkBuild(Date.now() + 120000), "offered", "a reload would clear your values");
  assert.equal(reloads.length, 0);
});
