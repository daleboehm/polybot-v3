// Trade (fill) CRUD operations

import { getDatabase } from '../database.js';
import type { OrderFill } from '../../types/index.js';

export function insertTrade(fill: OrderFill): number {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT OR IGNORE INTO trades (
      trade_id, order_id, entity_slug, condition_id, token_id, tx_hash,
      side, size, price, usdc_size, fee_usdc, net_usdc,
      is_paper, strategy_id, sub_strategy_id, outcome, market_question, market_slug,
      timestamp, timestamp_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fill.trade_id, fill.order_id, fill.entity_slug, fill.condition_id, fill.token_id,
    fill.tx_hash, fill.side, fill.size, fill.price, fill.usdc_size, fill.fee_usdc,
    fill.net_usdc, fill.is_paper ? 1 : 0, fill.strategy_id, fill.sub_strategy_id ?? null, fill.outcome,
    fill.market_question, fill.market_slug,
    fill.timestamp, new Date(fill.timestamp * 1000).toISOString(),
  );
  return result.changes;
}

export function getTradesByEntity(entitySlug: string, limit = 100): TradeRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM trades WHERE entity_slug = ? ORDER BY timestamp DESC LIMIT ?',
  ).all(entitySlug, limit) as TradeRow[];
}

export function getTradesByCondition(conditionId: string, entitySlug?: string): TradeRow[] {
  const db = getDatabase();
  if (entitySlug) {
    return db.prepare(
      'SELECT * FROM trades WHERE condition_id = ? AND entity_slug = ? ORDER BY timestamp ASC',
    ).all(conditionId, entitySlug) as TradeRow[];
  }
  return db.prepare(
    'SELECT * FROM trades WHERE condition_id = ? ORDER BY timestamp ASC',
  ).all(conditionId) as TradeRow[];
}

export function getTradesByStrategy(strategyId: string, limit = 100): TradeRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM trades WHERE strategy_id = ? ORDER BY timestamp DESC LIMIT ?',
  ).all(strategyId, limit) as TradeRow[];
}

export function getTradeCount(entitySlug?: string): number {
  const db = getDatabase();
  if (entitySlug) {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE entity_slug = ?').get(entitySlug) as { cnt: number };
    return row.cnt;
  }
  const row = db.prepare('SELECT COUNT(*) as cnt FROM trades').get() as { cnt: number };
  return row.cnt;
}

export function getDailyVolume(entitySlug?: string, days = 30): DailyVolumeRow[] {
  const db = getDatabase();
  if (entitySlug) {
    return db.prepare(
      'SELECT * FROM v_daily_volume WHERE entity_slug = ? LIMIT ?',
    ).all(entitySlug, days) as DailyVolumeRow[];
  }
  return db.prepare('SELECT * FROM v_daily_volume LIMIT ?').all(days * 16) as DailyVolumeRow[];
}

export interface TradeRow {
  id: number;
  trade_id: string | null;
  order_id: string | null;
  entity_slug: string;
  condition_id: string;
  token_id: string;
  tx_hash: string | null;
  side: string;
  size: number;
  price: number;
  usdc_size: number;
  fee_usdc: number;
  net_usdc: number;
  is_paper: number;
  strategy_id: string | null;
  sub_strategy_id: string | null;
  outcome: string | null;
  market_question: string | null;
  market_slug: string | null;
  timestamp: number;
  timestamp_utc: string;
  created_at: string;
}

export interface DailyVolumeRow {
  entity_slug: string;
  trade_date: string;
  num_trades: number;
  volume_usdc: number;
  fees_usdc: number;
}
