/**
 * fetch-prices.js
 * Runs hourly via GitHub Actions. Calls the Torn API for market prices
 * on all set items, appends a snapshot to data/history.json, and trims
 * to a rolling 720-entry window (30 days at hourly intervals).
 *
 * Requires: Node 18+ (uses built-in fetch), TORN_API_KEY env var.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = join(__dirname, "../data/history.json");
const MAX_ENTRIES  = 720;   // 30 days at hourly intervals
const DELAY_MS     = 700;   // pause between API calls to avoid rate limiting

const API_KEY = process.env.TORN_API_KEY;
if (!API_KEY) {
  console.error("ERROR: TORN_API_KEY environment variable not set.");
  process.exit(1);
}

// ── Item list (mirrors GROUPS in the userscript) ──────────────────────────────
// Format: { [displayName]: itemId }
const ITEMS = {
  // Prehistoric
  "Quartz Point":      538,
  "Chalcedony Point":  539,
  "Basalt Point":      540,
  "Quartzite Point":   541,
  "Chert Point":       542,
  "Obsidian Point":    543,
  // Flowers
  "Dahlia":            260,
  "Orchid":            261,
  "African Violet":    262,
  "Cherry Blossom":    263,
  "Peony":             264,
  "Ceibo Flower":      265,
  "Edelweiss":         266,
  "Crocus":            267,
  "Heather":           268,
  "Tribulus Omanense": 269,
  "Banana Orchid":     532,
  // Plushies
  "Sheep Plushie":      186,
  "Teddy Bear Plushie": 187,
  "Kitten Plushie":     188,
  "Jaguar Plushie":     581,
  "Wolverine Plushie":  582,
  "Nessie Plushie":     583,
  "Red Fox Plushie":    584,
  "Monkey Plushie":     585,
  "Chamois Plushie":    586,
  "Panda Plushie":      587,
  "Lion Plushie":       588,
  "Camel Plushie":      589,
  "Stingray Plushie":   590,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function cheapestListing(listings) {
  if (!Array.isArray(listings) || listings.length === 0) return null;
  let min = Infinity;
  for (const l of listings) {
    const p = typeof l.price === "number" ? l.price
            : typeof l.cost  === "number" ? l.cost
            : null;
    if (p !== null && p > 0 && p < min) min = p;
  }
  return isFinite(min) ? min : null;
}

// ── Fetch market price for one item ──────────────────────────────────────────

async function fetchMarketPrice(name, itemId) {
  const url = `https://api.torn.com/v2/market/${itemId}?selections=itemmarket&key=${API_KEY}`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();

    if (data.error) {
      console.warn(`  WARN [${name}] API error:`, JSON.stringify(data.error));
      return null;
    }

    const mraw    = data.itemmarket;
    const listings = mraw?.listings ?? (Array.isArray(mraw) ? mraw : []);
    let price = cheapestListing(listings);

    // Fallback: Torn's own average price
    if (price === null) {
      const avg = mraw?.item?.average_price ?? 0;
      if (avg > 0) price = avg;
    }

    return price;
  } catch (err) {
    console.warn(`  WARN [${name}] fetch failed:`, err.message);
    return null;
  }
}

// ── Fetch points market price ─────────────────────────────────────────────────

async function fetchPointsPrice() {
  const url = `https://api.torn.com/v2/market/pointsmarket?key=${API_KEY}`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    if (data.error || !data.pointsmarket) return 0;

    const costs = Object.values(data.pointsmarket)
      .filter(l => l.quantity > 0)
      .map(l => l.cost)
      .sort((a, b) => a - b)
      .slice(0, 5);

    if (costs.length === 0) return 0;
    return Math.round(costs.reduce((s, v) => s + v, 0) / costs.length);
  } catch {
    return 0;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[SMA] Starting price fetch at ${new Date().toISOString()}`);

  // Load existing history
  let history = [];
  if (existsSync(HISTORY_PATH)) {
    try {
      history = JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
      if (!Array.isArray(history)) history = [];
    } catch {
      console.warn("[SMA] Could not parse existing history.json — starting fresh.");
      history = [];
    }
  }

  // Fetch all item prices
  const prices = {};
  const names  = Object.keys(ITEMS);

  for (let i = 0; i < names.length; i++) {
    const name   = names[i];
    const itemId = ITEMS[name];
    const price  = await fetchMarketPrice(name, itemId);
    if (price !== null) prices[name] = price;
    console.log(`  [${i + 1}/${names.length}] ${name}: ${price !== null ? "$" + price.toLocaleString() : "—"}`);
    if (i < names.length - 1) await sleep(DELAY_MS);
  }

  // Fetch points price
  const pointsPrice = await fetchPointsPrice();
  console.log(`  [points] $${pointsPrice.toLocaleString()}`);

  // Append snapshot
  const snapshot = {
    ts:     Date.now(),
    pp:     pointsPrice,
    prices,
    source: "github",   // lets the userscript distinguish GH vs local snapshots
  };
  history.push(snapshot);

  // Trim to rolling window
  while (history.length > MAX_ENTRIES) history.shift();

  // Write back
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf8");
  console.log(`[SMA] Done. History now has ${history.length} snapshots.`);
}

main().catch(err => {
  console.error("[SMA] Fatal error:", err);
  process.exit(1);
});
