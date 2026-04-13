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

// 2026-04-10: targeted metadata update used by the long-tail backfill job.
// upsertMarket()'s ON CONFLICT intentionally leaves end_date alone (it trusts the
// sampling poller's view), so long-tail positions outside the sampling horizon
// never get their end_date refreshed by the normal poll cycle. This function
// bypasses that by writing fields surgically — only the ones the caller provides.
export function updateMarketMetadata(
  conditionId: string,
  fields: {
    end_date?: string;
    question?: string;
    market_slug?: string;
    active?: number;
    closed?: number;
    uma_resolution_status?: string;
  },
): void {
  const db = getDatabase();
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (fields.end_date !== undefined && fields.end_date !== '') {
    sets.push('end_date = ?');
    values.push(fields.end_date);
  }
  if (fields.question !== undefined && fields.question !== '') {
    sets.push('question = ?');
    values.push(fields.question);
  }
  if (fields.market_slug !== undefined && fields.market_slug !== '') {
    sets.push('market_slug = ?');
    values.push(fields.market_slug);
  }
  if (fields.active !== undefined) {
    sets.push('active = ?');
    values.push(fields.active);
  }
  if (fields.closed !== undefined) {
    sets.push('closed = ?');
    values.push(fields.closed);
  }
  if (fields.uma_resolution_status !== undefined) {
    sets.push('uma_resolution_status = ?');
    values.push(fields.uma_resolution_status);
  }
  if (sets.length === 0) return;
  sets.push("last_updated = datetime('now')");
  values.push(conditionId);
  db.prepare(`UPDATE markets SET ${sets.join(', ')} WHERE condition_id = ?`).run(...values);
}

// 2026-04-10: minimal insert used by the long-tail backfill when a position
// references a condition_id that has no row in `markets` at all (because the
// sampling poller never returned it). We only know what Gamma tells us — enough
// to satisfy the NOT NULL constraints and let the dashboard compute overdue state.
export function insertMinimalMarket(fields: {
  condition_id: string;
  question: string;
  market_slug: string;
  end_date: string;
  active: number;
  closed: number;
  neg_risk: number;
  neg_risk_market_id: string | null;
  token_yes_id: string;
  token_no_id: string;
}): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO markets (
      condition_id, question, market_slug, end_date,
      active, closed, neg_risk, neg_risk_market_id,
      token_yes_id, token_no_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fields.condition_id,
    fields.question,
    fields.market_slug,
    fields.end_date,
    fields.active,
    fields.closed,
    fields.neg_risk,
    fields.neg_risk_market_id,
    fields.token_yes_id,
    fields.token_no_id,
  );
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
