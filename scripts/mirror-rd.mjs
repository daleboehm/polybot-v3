#!/usr/bin/env node
// mirror-rd.mjs — read R&D auto-engine new BUYs and (optionally) mirror them
// onto Prod via manual-buy.mjs. The engine on R&D is doing the high-throughput
// scouting; this script harvests its filtered output for Prod.
//
// Usage:
//   node scripts/mirror-rd.mjs              # dry-run, prints what would fire
//   node scripts/mirror-rd.mjs --fire       # actually places trades on Prod
//   node scripts/mirror-rd.mjs --fire --max=4 --size=25
//
// Filter rules (tunable via env or flags):
//   - R&D position opened in last MIRROR_MAX_AGE_MIN min (default 3)
//   - entry price between MIRROR_MIN_PRICE and MIRROR_MAX_PRICE (0.85 - 0.96)
//   - on-chain liquidity ≥ MIRROR_MIN_LIQ ($5000)
//   - strategy_id IN survivor list
//   - Not already held on Prod (no duplicate)
//   - Resolves within MIRROR_HORIZON_HOURS (default 24)

import { execSync } from "node:child_process";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const FIRE = args.includes("--fire");
const MAX = parseInt(args.find(a => a.startsWith("--max="))?.split("=")[1] || "5");
const SIZE_USDC = parseFloat(args.find(a => a.startsWith("--size="))?.split("=")[1] || "25");
const MAX_AGE_MIN = parseInt(process.env.MIRROR_MAX_AGE_MIN || "5");
const MIN_PRICE = parseFloat(process.env.MIRROR_MIN_PRICE || "0.85");
const MAX_PRICE = parseFloat(process.env.MIRROR_MAX_PRICE || "0.96");
const MIN_LIQ = parseFloat(process.env.MIRROR_MIN_LIQ || "5000");
const HORIZON_H = parseFloat(process.env.MIRROR_HORIZON_HOURS || "24");
const SURVIVORS = ["longshot", "weather_forecast", "negrisk_arbitrage", "rtds_forecast", "favorites"];

const rd = new Database("/opt/polybot-v3-rd/data/rd.db", { readonly: true });
const prod = new Database("/opt/polybot-v3/data/polybot.db", { readonly: true });

// 1. R&D candidates: recent new positions that match survivor strategies + price range
const sinceIso = new Date(Date.now() - MAX_AGE_MIN*60*1000).toISOString().slice(0,19).replace("T"," ");
const placeholders = SURVIVORS.map(() => "?").join(",");
const rdRows = rd.prepare(`SELECT condition_id, token_id, side, avg_entry_price AS entry, market_slug, strategy_id, sub_strategy_id, opened_at, (julianday('now') - julianday(opened_at)) * 1440 AS age_min FROM positions WHERE entity_slug = 'rd-engine' AND status = 'open' AND opened_at >= ? AND avg_entry_price BETWEEN ? AND ? AND strategy_id IN (${placeholders}) ORDER BY opened_at DESC`).all(sinceIso, MIN_PRICE, MAX_PRICE, ...SURVIVORS);

// 2. Already-held on Prod
const heldOnProd = new Set(
  prod.prepare(`SELECT condition_id FROM positions WHERE entity_slug = 'polybot' AND status = 'open'`).all()
    .map(r => r.condition_id)
);

console.log(`[mirror-rd] candidates from R&D last ${MAX_AGE_MIN}min: ${rdRows.length}`);
console.log(`[mirror-rd] already held on Prod: ${heldOnProd.size}`);

const fired = [];
for (const r of rdRows) {
  if (fired.length >= MAX) break;
  if (heldOnProd.has(r.condition_id)) { console.log(`SKIP held: ${r.market_slug?.slice(0,40)}`); continue; }

  // 3. Pull fresh market state from Gamma to verify liquidity + endDate + price
  let m;
  try {
    const url = "https://gamma-api.polymarket.com/markets/keyset?condition_ids=" + r.condition_id;
    m = await fetch(url).then(x => x.json()).then(d => d.markets?.[0]);
  } catch (e) { console.log(`SKIP fetch fail: ${r.market_slug}`); continue; }
  if (!m) { console.log(`SKIP not in gamma: ${r.market_slug}`); continue; }

  const liq = parseFloat(m.liquidity || 0);
  const endTs = m.endDate ? Date.parse(m.endDate) : 0;
  const hoursToEnd = endTs ? (endTs - Date.now()) / 3600000 : 999;

  if (liq < MIN_LIQ) { console.log(`SKIP liq=${liq.toFixed(0)} < ${MIN_LIQ}: ${r.market_slug?.slice(0,40)}`); continue; }
  if (hoursToEnd > HORIZON_H) { console.log(`SKIP h=${hoursToEnd.toFixed(1)} > ${HORIZON_H}: ${r.market_slug?.slice(0,40)}`); continue; }
  if (hoursToEnd < 0.5) { console.log(`SKIP h=${hoursToEnd.toFixed(1)} too soon: ${r.market_slug?.slice(0,40)}`); continue; }

  // 4. Determine the side label that manual-buy.mjs needs (YES = tokenIds[0], NO = tokenIds[1])
  const tokenIds = JSON.parse(m.clobTokenIds || "[]");
  const sideArg = (r.token_id === tokenIds[0]) ? "YES" : "NO";
  // current ask we can take: outcomePrices for our side  
  const op = JSON.parse(m.outcomePrices);
  const idx = sideArg === "YES" ? 0 : 1;
  const curPrice = parseFloat(op[idx]);

  if (curPrice < MIN_PRICE || curPrice > MAX_PRICE) {
    console.log(`SKIP price drifted: cur=${curPrice} ${r.market_slug?.slice(0,40)}`);
    continue;
  }

  const buyPrice = Math.min(curPrice + 0.005, MAX_PRICE).toFixed(2); // small cushion to take

  console.log(`PICK: ${r.market_slug?.slice(0,42)} ${sideArg}@${buyPrice} liq=${liq.toFixed(0)} h=${hoursToEnd.toFixed(1)} strat=${r.strategy_id}/${r.sub_strategy_id || "?"} age=${r.age_min.toFixed(1)}m`);

  if (FIRE) {
    try {
      const out = execSync(`node /opt/polybot-v3/scripts/manual-buy.mjs ${r.condition_id} ${sideArg} ${buyPrice} ${SIZE_USDC}`, { encoding: "utf8", timeout: 30000 });
      const last = out.trim().split("\n").pop();
      console.log(`  FIRED: ${last.slice(0, 200)}`);
      fired.push({ slug: r.market_slug, side: sideArg, price: buyPrice });
    } catch (e) {
      console.log(`  FAIL: ${e.message.slice(0, 200)}`);
    }
  }
}

console.log(`[mirror-rd] ${FIRE ? "fired" : "would-fire"} ${fired.length} trades`);
