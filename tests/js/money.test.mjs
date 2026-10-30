/* Ray, 30 Oct: "show real flow of money in NOK and USD (toggle between them) based on flows
   after the gas day started at 06:00 am. it then resets, it should check current gas
   prices". The player values the gas delivered where it leaves the system since the gas day
   began at today's TTF (data/prices.json), in NOK or USD. */
import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./harness.mjs";

const PRICES = { ttf_eur_per_mwh: 100, ttf_at: 1793354736, ttf_source: "TTF front-month future, via Yahoo Finance (TTF=F)", nok_per_eur: 10, nok_per_usd: 8, fx_date: "2026-10-29", fx_source: "Norges Bank", fetched_at: 1793363497 };

async function counter(prices = PRICES) {
  const fetch = async (url) => (url === "data/prices.json" && prices ? { ok: true, json: async () => prices } : { ok: false, json: async () => ({}) });
  const loaded = loadApp({ globals: { fetch } });
  const { App, NORA, document } = loaded;
  document.getElementById("speed").options = [{ value: "600" }];
  document.getElementById("player").hidden = false;
  document.getElementById("stream-select")._listeners.change[0]({ target: { value: NORA.streams[0].name } });
  await App.money.load();
  return loaded;
}
// What the counter should say, worked out here from the frames.
function expected(App, NORA) {
  const live = App.live, start = NORA.config.thresholds.gas_day_start_utc, now = live.time;
  const dayStart = Math.floor((now - start * 3600) / 86400) * 86400 + start * 3600;
  const sold = Object.keys(NORA.assets).filter((id) => ["terminal", "lng", "market"].includes(NORA.assets[id].type));
  let msm3 = 0;
  for (let i = 0; i <= live.index; i++) {
    const f = live.frames[i], next = i < live.index ? live.frames[i + 1].t : now;
    const from = Math.max(f.t, dayStart), to = Math.min(next, now);
    if (to > from) for (const id of sold) { const v = App.money.throughput(id, f.flows); if (v > 0) msm3 += (v * (to - from)) / 86400; }
  }
  return msm3 * 1e6 * 11 / 1000 * 100 * 10; // MWh x EUR/MWh x NOK/EUR
}

test("money: the gas sold since the gas day began, at TTF, in NOK; the button switches to USD", async () => {
  const { App, NORA, document } = await counter();
  App.seek(App.live.index + 0.5);
  App.money.draw();
  const m = App.money.today();
  assert.ok(m && m.nok > 0, "a value once prices and flows are in");
  assert.ok(Math.abs(m.nok - expected(App, NORA)) < 1, `${m.nok} NOK as worked out by hand`);
  assert.equal(m.usd, m.nok / 8);
  assert.equal(document.getElementById("money").hidden, false);
  assert.match(document.getElementById("money-value").textContent, /^NOK [\d,.]+ (bn|M)$/);
  const title = document.getElementById("money").title;
  assert.match(title, /^An estimate: [\d.]+ MSm³ delivered where gas leaves the system since the gas day began at 06:00/);
  assert.match(title, /\(synthetic flows\)/, "synthetic flows say so");
  assert.match(title, /at 11 kWh\/Sm³ and TTF 100\.00 EUR\/MWh/);
  assert.match(title, /Norges Bank's rates of 2026-10-29: 1 EUR = 10 NOK, 1 USD = 8 NOK/);
  const button = document.getElementById("money-currency");
  assert.equal(button.textContent, "USD", "the button offers the other currency");
  button._listeners.click[0]();
  assert.match(document.getElementById("money-value").textContent, /^USD /);
  assert.equal(button.textContent, "NOK");
});

test("money: it starts again at the next gas day (06:00 Norwegian time)", async () => {
  const { App, NORA } = await counter();
  const start = NORA.config.thresholds.gas_day_start_utc, s = App.live.stream;
  const at = (t) => { App.seek((t - s.times[0]) / s.step); return App.money.today(); };
  const day = Math.floor((s.times[0] + 86400 * 2 - start * 3600) / 86400) * 86400 + start * 3600; // a gas day well inside the week
  const late = at(day - 3600), early = at(day + 1800);
  assert.ok(late.nok > early.nok * 10, `late in one gas day ${late.nok}, early in the next ${early.nok}`);
  assert.equal(early.dayStart, day);
});

test("money: with no prices (a local build) the counter stays hidden", async () => {
  const { App, document } = await counter(null);
  App.money.draw();
  assert.equal(App.money.today(), null);
  assert.equal(document.getElementById("money").hidden, true);
});
