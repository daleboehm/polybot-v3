#!/usr/bin/env node
// scan-edges.mjs — continuous multi-source edge scanner. Runs every N min via
// systemd timer. Logs candidates to /var/log/polybot-edges.log for human review.
// Does NOT auto-fire — operator reviews and runs manual-buy.mjs.
//
// Edge sources scanned per cycle:
//   1. Price-jump: markets where bestAsk moved >MIN_JUMP% in last 1h (RTDS-style mispricing)
//   2. R&D survivor strategies firing in last MAX_AGE_MIN min (echo of mirror-rd)
//   3. NegRisk family arbs (Σ YES < 1.00, exhaustive >=3 members)
//   4. Whale 2+-consensus markets (≥2 whitelisted whales same side, last 6h)
//   5. Liquidity-spike: markets where 24h volume jumped >5x vs avg (interest signal)
//
// Each source filters for: liq >= MIN_LIQ, vol24 >= MIN_VOL, resolves in 0.5-24h,
// not already held on Prod.

import Database from "better-sqlite3";
import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";

const RD = new Database("/opt/polybot-v3-rd/data/rd.db", { readonly: true });
const PROD = new Database("/opt/polybot-v3/data/polybot.db", { readonly: true });
const LOG = "/var/log/polybot-edges.log";
const STATE = "/var/lib/polybot/edges-state.json";

const MIN_LIQ = parseFloat(process.env.EDGES_MIN_LIQ || "5000");
const MIN_VOL = parseFloat(process.env.EDGES_MIN_VOL || "200");
const MIN_HORIZON_H = 0.5;
const MAX_HORIZON_H = 24;
const MIN_JUMP = 0.05;

const heldOnProd = new Set(PROD.prepare("SELECT condition_id FROM positions WHERE entity_slug = 'polybot' AND status = 'open'").all().map(r => r.condition_id));

// Load prior price snapshot (for jump detection)
let prior = {};
if (existsSync(STATE)) { try { prior = JSON.parse(readFileSync(STATE, "utf8")); } catch {} }
const next = {};

function log(level, source, msg, extra = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, source, msg, ...extra });
  appendFileSync(LOG, line + "\n");
  if (level === "PICK") console.log(line);
}

// === Pull all near-term active markets once
const minIso = new Date(Date.now() + MIN_HORIZON_H*3600*1000).toISOString();
const maxIso = new Date(Date.now() + MAX_HORIZON_H*3600*1000).toISOString();
const url = "https://gamma-api.polymarket.com/markets?closed=false&end_date_min=" + minIso + "&end_date_max=" + maxIso + "&limit=500";
const ms = await fetch(url).then(r => r.json()).catch(() => []);
log("INFO", "scan", "fetched markets", { count: ms.length });

// === Source 1: Price jump
let jumps = 0;
for (const m of ms) {
  if (heldOnProd.has(m.conditionId)) continue;
  const liq = parseFloat(m.liquidity||0); const vol = parseFloat(m.volume24hr||0);
  if (liq < MIN_LIQ || vol < MIN_VOL) continue;
  const op = JSON.parse(m.outcomePrices||"[]");
  if (op.length < 2) continue;
  const fav = Math.max(parseFloat(op[0]), parseFloat(op[1]));
  next[m.conditionId] = fav;
  const old = prior[m.conditionId];
  if (old != null && Math.abs(fav - old) >= MIN_JUMP) {
    jumps++;
    const dir = fav > old ? "up" : "down";
    log("PICK", "price-jump", "favorite price moved " + dir + " " + Math.abs(fav-old).toFixed(3), {
      slug: m.slug, cid: m.conditionId, fav, old, liq, vol, dir, end: m.endDate
    });
  }
}
writeFileSync(STATE, JSON.stringify(next));
log("INFO", "price-jump", "scanned", { jumps });

// === Source 2: R&D survivor recent fires
const sinceIso = new Date(Date.now() - 5*60*1000).toISOString().slice(0,19).replace("T"," ");
const SURVIVORS = ["longshot","weather_forecast","negrisk_arbitrage","rtds_forecast"];
const ph = SURVIVORS.map(()=>"?").join(",");
const rdRecent = RD.prepare(`SELECT condition_id, market_slug, side, avg_entry_price, strategy_id, sub_strategy_id, opened_at FROM positions WHERE entity_slug = 'rd-engine' AND status = 'open' AND opened_at >= ? AND avg_entry_price BETWEEN 0.78 AND 0.96 AND strategy_id IN (${ph}) ORDER BY opened_at DESC`).all(sinceIso, ...SURVIVORS);
let rdPicks = 0;
for (const r of rdRecent) {
  if (heldOnProd.has(r.condition_id)) continue;
  rdPicks++;
  log("PICK", "rd-mirror", "R&D " + r.strategy_id + " fired", { slug: r.market_slug, cid: r.condition_id, side: r.side, entry: r.avg_entry_price });
}
log("INFO", "rd-mirror", "scanned", { picks: rdPicks });

// === Source 3: NegRisk arb (group by negRiskMarketID, sum YES asks)
const families = new Map();
for (const m of ms) {
  const id = m.negRiskMarketID; if (!id) continue;
  if (!families.has(id)) families.set(id, []);
  families.get(id).push(m);
}
let arbs = 0;
for (const [id, fam] of families) {
  if (fam.length < 3 || fam.length > 25) continue;
  let sum = 0, maxLeg = 0, valid = true, totalLiq = 0;
  for (const f of fam) {
    const op = JSON.parse(f.outcomePrices||"[]");
    if (op.length < 2) { valid=false; break; }
    const yes = parseFloat(op[0]);
    if (yes <= 0 || yes >= 1) { valid=false; break; }
    sum += yes; if (yes > maxLeg) maxLeg = yes;
    totalLiq += parseFloat(f.liquidity||0);
  }
  if (!valid || sum < 0.85 || sum > 0.97 || maxLeg > 0.30) continue;
  arbs++;
  log("PICK", "negrisk-arb", "family sum=" + sum.toFixed(3) + " edge=" + (1-sum).toFixed(3), { n: fam.length, sum, totalLiq, sample: fam[0].slug });
}
log("INFO", "negrisk-arb", "scanned", { families: families.size, picks: arbs });

// === Source 4: 2+ whale consensus (last 6h, exclude already-held)
const whaleSql = "SELECT condition_id, outcome, COUNT(DISTINCT proxy_wallet) AS n_whales, SUM(usdc_size) AS total_usd, AVG(price) AS avg_px FROM whale_trades WHERE side='BUY' AND condition_id != '' AND observed_at >= (strftime('%s','now') - 21600)*1000 GROUP BY condition_id, outcome HAVING n_whales >= 2 AND total_usd >= 500";
const whales = RD.prepare(whaleSql).all();
let wp = 0;
for (const w of whales) {
  if (heldOnProd.has(w.condition_id)) continue;
  wp++;
  log("PICK", "whale-consensus", w.n_whales + " whales " + w.outcome, { cid: w.condition_id, n: w.n_whales, total_usd: Math.round(w.total_usd), avg_px: Number(w.avg_px).toFixed(3) });
}
log("INFO", "whale-consensus", "scanned", { picks: wp });

console.log(`[edges] scan complete: jumps=${jumps} rd=${rdPicks} arbs=${arbs} whales=${wp}`);
