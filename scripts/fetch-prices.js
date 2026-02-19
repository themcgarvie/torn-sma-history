/**
 * fetch-prices.js
 * Runs hourly via GitHub Actions. Fetches both market and bazaar prices
 * for all set items, appends a snapshot to data/history.json, and trims
 * to a rolling 720-entry window (30 days at hourly intervals).
 *
 * Per-item strategy (mirrors the userscript):
 *   Step 1: GET /v2/market/{id}?selections=itemmarket,bazaar
 *           → market price from itemmarket listings
 *           → list of bazaar shop owner IDs from bazaar.specialized
 *   Step 2: GET /v2/user/{shopId}?selections=bazaar
 *           → scan that shop's inventory for this item → bazaar price
 *
 * Requires: Node 18+ (built-in fetch), TORN_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname }                           from "path";
import { fileURLToPath }                           from "url";

const __dirname    = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(__dirname, "../data/history.json");
// ── Configuration ────────────────────────────────────────────────────────────
// How many hourly snapshots to keep. At 1 per hour:
//   720  = 30 days  (default)
//   2160 = 90 days  (3 months)
//   8760 = 365 days (1 year)
// history.json file size: roughly 2–3 KB per snapshot, so 2160 ≈ 5–6 MB.
const MAX_ENTRIES  = 720;
const DELAY_MS     = 700;

const API_KEY = process.env.TORN_API_KEY;
if (!API_KEY) { console.error("ERROR: TORN_API_KEY not set."); process.exit(1); }

const ITEMS = {
  "Quartz Point":      1504, "Chalcedony Point":  1503, "Basalt Point":      1502,
  "Quartzite Point":   1500, "Chert Point":       1501, "Obsidian Point":   1499,
  "Dahlia":            260, "Orchid":            264, "African Violet":    282,
  "Cherry Blossom":    277, "Peony":             276, "Ceibo Flower":      271,
  "Edelweiss":         272, "Crocus":            263, "Heather":           267,
  "Tribulus Omanense": 385, "Banana Orchid":     617,
  "Sheep Plushie":     186, "Teddy Bear Plushie":187, "Kitten Plushie":    215,
  "Jaguar Plushie":    258, "Wolverine Plushie": 261, "Nessie Plushie":    266,
  "Red Fox Plushie":   268, "Monkey Plushie":    269, "Chamois Plushie":   273,
  "Panda Plushie":     274, "Lion Plushie":      281, "Camel Plushie":     384,
  "Stingray Plushie":  618,
};

// ── Helpers (mirrors userscript extractListings + listingCost) ────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Handles: plain array, {listings:[]}, {items:[]}, keyed object of listings
function extractListings(sec) {
  if (!sec) return [];
  if (Array.isArray(sec)) return sec;
  if (typeof sec === "object") {
    if (Array.isArray(sec.listings)) return sec.listings;
    for (const k of ["items", "offers", "rows", "data", "results"]) {
      if (Array.isArray(sec[k])) return sec[k];
      if (sec[k] && Array.isArray(sec[k].listings)) return sec[k].listings;
    }
    // keyed object → values (only if entries look like listings)
    const vals = Object.values(sec).filter(v => v && typeof v === "object");
    if (vals.some(v => ("price" in v) || ("cost" in v) || ("amount" in v))) return vals;
  }
  return [];
}

function listingCost(l) {
  if (!l || typeof l !== "object") return null;
  for (const v of [l.price, l.cost, l.amount, l.value]) {
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

function cheapest(listings) {
  let min = Infinity;
  for (const l of listings) {
    const c = listingCost(l);
    if (c !== null && c < min) min = c;
  }
  return isFinite(min) ? min : null;
}

async function apiGet(path) {
  const url = `https://api.torn.com${path}&key=${API_KEY}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return res.json();
}

// ── Fetch one item: market + bazaar ───────────────────────────────────────────

async function fetchItemPrices(name, itemId) {
  let marketPrice = null;
  let shopIds     = [];

  try {
    const data = await apiGet(`/v2/market/${itemId}?selections=itemmarket,bazaar`);
    if (data.error) {
      console.warn(`  WARN [${name}] step1:`, JSON.stringify(data.error));
    } else {
      const mraw  = data.itemmarket;

      // Use Torn's server-side average_price as primary market price.
      const avg = mraw?.item?.average_price ?? 0;
      if (avg > 0) {
        marketPrice = avg;
      } else {
        const mlist = extractListings(mraw?.listings ?? mraw ?? []);
        marketPrice = cheapest(mlist);
      }
      const specialized = data.bazaar?.specialized ?? [];
      shopIds = specialized
        .filter(s => s && s.is_open !== false)
        .map(s => s.id)
        .filter(id => typeof id === "number" && id > 0);
    }
  } catch (err) {
    console.warn(`  WARN [${name}] step1 failed:`, err.message);
  }

  await sleep(DELAY_MS);

  let bazaarPrice = null;
  if (shopIds.length > 0) {
    try {
      const shopData = await apiGet(`/v2/user/${shopIds[0]}?selections=bazaar`);
      if (!shopData.error) {
        const inv = shopData.bazaar ?? shopData.items ?? shopData;
        const entries = Array.isArray(inv)
          ? inv
          : typeof inv === "object" && inv !== null
            ? Object.values(inv).filter(v => v && typeof v === "object")
            : [];
        for (const e of entries) {
          const eid = e.ID ?? e.id ?? e.item_id;
          if (Number(eid) !== Number(itemId)) continue;
          const p = listingCost(e);
          if (p !== null && (bazaarPrice === null || p < bazaarPrice)) bazaarPrice = p;
        }
      }
      await sleep(DELAY_MS);
    } catch (err) {
      console.warn(`  WARN [${name}] step2 failed:`, err.message);
    }
  }

  return { market: marketPrice, bazaar: bazaarPrice };
}

// ── Points price ──────────────────────────────────────────────────────────────

async function fetchPointsPrice() {
  try {
    const data = await apiGet("/v2/market/pointsmarket?selections=pointsmarket");
    if (data.error || !data.pointsmarket) return 0;
    const costs = Object.values(data.pointsmarket)
      .filter(l => l.quantity > 0).map(l => l.cost).sort((a, b) => a - b).slice(0, 5);
    return costs.length ? Math.round(costs.reduce((s, v) => s + v, 0) / costs.length) : 0;
  } catch { return 0; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[SMA] Starting fetch at ${new Date().toISOString()}`);

  let history = [];
  if (existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      if (!Array.isArray(history)) history = [];
    } catch { console.warn("[SMA] Bad history.json — starting fresh."); }
  }

  const market = {};
  const bazaar = {};
  const names  = Object.keys(ITEMS);

  for (let i = 0; i < names.length; i++) {
    const name   = names[i];
    const prices = await fetchItemPrices(name, ITEMS[name]);
    if (prices.market !== null) market[name] = prices.market;
    if (prices.bazaar !== null) bazaar[name] = prices.bazaar;
    console.log(`  [${i+1}/${names.length}] ${name}:  mkt(avg)=${prices.market !== null ? "$"+prices.market.toLocaleString() : "—"}  baz=${prices.bazaar !== null ? "$"+prices.bazaar.toLocaleString() : "—"}`);
  }

  const pp = await fetchPointsPrice();
  console.log(`  [points] $${pp.toLocaleString()}`);

  history.push({ ts: Date.now(), pp, market, bazaar, source: "github" });
  while (history.length > MAX_ENTRIES) history.shift();

  // Log set completeness so partial sets are visible in Actions output
  const GROUPS = {
    Prehistoric: ["Quartz Point","Chalcedony Point","Basalt Point","Quartzite Point","Chert Point","Obsidian Point"],
    Flowers:     ["Dahlia","Orchid","African Violet","Cherry Blossom","Peony","Ceibo Flower","Edelweiss","Crocus","Heather","Tribulus Omanense","Banana Orchid"],
    Plushies:    ["Sheep Plushie","Teddy Bear Plushie","Kitten Plushie","Jaguar Plushie","Wolverine Plushie","Nessie Plushie","Red Fox Plushie","Monkey Plushie","Chamois Plushie","Panda Plushie","Lion Plushie","Camel Plushie","Stingray Plushie"],
  };
  for (const [gName, keys] of Object.entries(GROUPS)) {
    const mComplete = keys.every(k => market[k] > 0);
    const bComplete = keys.every(k => bazaar[k] > 0);
    const mMissing  = keys.filter(k => !market[k]).join(", ") || "none";
    const bMissing  = keys.filter(k => !bazaar[k]).join(", ") || "none";
    const mTotal    = mComplete ? "$" + keys.reduce((s,k) => s + market[k], 0).toLocaleString() : "INCOMPLETE";
    const bTotal    = bComplete ? "$" + keys.reduce((s,k) => s + bazaar[k], 0).toLocaleString() : "INCOMPLETE";
    console.log(`  [${gName}] Market set: ${mTotal}${mComplete ? "" : "  missing: " + mMissing}`);
    console.log(`  [${gName}] Bazaar set: ${bTotal}${bComplete ? "" : "  missing: " + bMissing}`);
  }

  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
  console.log(`[SMA] Done. ${history.length} snapshots total.`);
}

main().catch(err => { console.error("[SMA] Fatal:", err); process.exit(1); });