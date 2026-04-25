#!/usr/bin/env node
// polybot-marks.mjs — print live mark prices for all open Prod positions
// (queries Gamma directly; doesn t trust DB current_price which goes stale
// when engine is halted).

import Database from "better-sqlite3";
const PROD = new Database("/opt/polybot-v3/data/polybot.db", { readonly: true });

const positions = PROD.prepare(`
  SELECT condition_id, token_id, side, size, avg_entry_price, cost_basis, market_slug, strategy_id, opened_at
  FROM positions
  WHERE entity_slug = 'polybot' AND status = 'open'
  ORDER BY opened_at DESC
`).all();

let totalCost = 0, totalMtm = 0;
console.log("cid       slug                                            tok ent_px live_px sz       cost   mtm    upnl    h_rem strat");
console.log("-".repeat(135));

for (const p of positions) {
  const url = "https://gamma-api.polymarket.com/markets/keyset?condition_ids=" + p.condition_id;
  const m = await fetch(url).then(r => r.json()).then(d => d.markets?.[0]).catch(() => null);
  let livePx = NaN; let endIso = ""; let slug = p.market_slug || "?";
  if (m) {
    const ids = JSON.parse(m.clobTokenIds || "[]");
    const op = JSON.parse(m.outcomePrices || "[]");
    const idx = ids.findIndex(t => t === p.token_id);
    if (idx >= 0 && op[idx] != null) livePx = parseFloat(op[idx]);
    endIso = m.endDate || "";
    slug = m.slug || slug;
  }
  const mtm = isFinite(livePx) ? p.size * livePx : p.cost_basis;
  const upnl = mtm - p.cost_basis;
  totalCost += p.cost_basis;
  totalMtm  += mtm;
  const hRem = endIso ? ((Date.parse(endIso) - Date.now()) / 3600000).toFixed(1) : "?";
  console.log(
    p.condition_id.substring(0,10).padEnd(10) + " " +
    slug.substring(0,46).padEnd(48) + " " +
    p.side.padEnd(3) + " " +
    p.avg_entry_price.toFixed(3).padStart(6) + " " +
    (isFinite(livePx)?livePx.toFixed(3):"?".padStart(5)).padStart(7) + " " +
    p.size.toFixed(2).padStart(8) + " " +
    p.cost_basis.toFixed(2).padStart(6) + " " +
    mtm.toFixed(2).padStart(6) + " " +
    (upnl>=0?"+":"") + upnl.toFixed(2).padStart(6) + " " +
    String(hRem).padStart(5) + " " +
    (p.strategy_id || "?").padEnd(20)
  );
}

console.log("-".repeat(135));
console.log("TOTAL  cost=" + totalCost.toFixed(2) + "  mtm=" + totalMtm.toFixed(2) + "  upnl=" + (totalMtm - totalCost >= 0 ? "+" : "") + (totalMtm - totalCost).toFixed(2));
