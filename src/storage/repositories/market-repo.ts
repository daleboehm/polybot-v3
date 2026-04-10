// Market CRUD operations

import { getDatabase } from '../database.js';
import type { SamplingMarket } from '../../types/index.js';

export function upsertMarket(m: SamplingMarket): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO markets (
      condition_id, question_id, question, description, market_slug,
      end_date, active, closed, neg_risk, neg_risk_market_id,
      minimum_order_size, minimum_tick_size, maker_base_fee, taker_base_fee,
      tags, token_yes_id, token_no_id, last_yes_price, last_no_price
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(condition_id) DO UPDATE SET
      question = excluded.question,
      active = excluded.active,
      closed = excluded.closed,
      last_yes_price = excluded.last_yes_price,
      last_no_price = excluded.last_no_price,
      last_updated = datetime('now')
  `).run(
    m.condition_id, m.question_id, m.question, m.description, m.market_slug,
    m.end_date_iso, m.active ? 1 : 0, m.closed ? 1 : 0, m.neg_risk ? 1 : 0,
    m.neg_risk_market_id,
    m.minimum_order_size, m.minimum_tick_size, m.maker_base_fee, m.taker_base_fee,
    JSON.stringify(m.tags),
    m.tokens[0].token_id, m.tokens[1].token_id,
    m.tokens[0].price, m.tokens[1].price,
  );
}

export function getActiveMarkets(): MarketRow[] {
  const db = getDatabase();
  return db.prepare("SELECT * FROM markets WHERE active = 1 AND closed = 0 ORDER BY last_updated DESC").all() as MarketRow[];
}

export function getMarketByCondition(conditionId: string): MarketRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM markets WHERE condition_id = ?').get(conditionId) as MarketRow | undefined;
}

export function getMarketByTokenId(tokenId: string): MarketRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM markets WHERE token_yes_id = ? OR token_no_id = ?').get(tokenId, tokenId) as MarketRow | undefined;
}

export function markMarketClosed(conditionId: string): void {
  const db = getDatabase();
  db.prepare("UPDATE markets SET closed = 1, active = 0, last_updated = datetime('now') WHERE condition_id = ?").run(conditionId);
}

export function getMarketCount(): { active: number; closed: number; total: number } {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN active = 1 AND closed = 0 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN closed = 1 THEN 1 ELSE 0 END) as closed,
      COUNT(*) as total
    FROM markets
  `).get() as { active: number; closed: number; total: number };
  return row;
}

export interface MarketRow {
  id: number;
  condition_id: string;
  question_id: string | null;
  question: string;
  description: string | null;
  market_slug: string | null;
  end_date: string | null;
  active: number;
  closed: number;
  neg_risk: number;
  neg_risk_market_id: string | null;
  minimum_order_size: number | null;
  minimum_tick_size: number | null;
  maker_base_fee: number | null;
  taker_base_fee: number | null;
  tags: string | null;
  token_yes_id: string;
  token_no_id: string;
  last_yes_price: number | null;
  last_no_price: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  last_updated: string;
  first_seen: string;
}
