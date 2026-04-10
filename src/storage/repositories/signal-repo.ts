// Signal CRUD operations

import { getDatabase } from '../database.js';
import type { Signal, StrategyDecision } from '../../types/index.js';

export function insertSignal(signal: Signal, decision?: StrategyDecision): void {
  const db = getDatabase();
  db.prepare(`
    INSERT OR IGNORE INTO signals (
      signal_id, entity_slug, strategy_id, sub_strategy_id, condition_id, token_id,
      side, outcome, strength, edge, model_prob, market_price,
      recommended_size_usd, approved, rejection_reason, final_size_usd, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    signal.signal_id, signal.entity_slug, signal.strategy_id, signal.sub_strategy_id ?? null,
    signal.condition_id, signal.token_id, signal.side, signal.outcome,
    signal.strength, signal.edge, signal.model_prob, signal.market_price,
    signal.recommended_size_usd,
    decision?.risk_approved ? 1 : 0,
    decision?.risk_rejection ?? null,
    decision?.final_size_usd ?? null,
    JSON.stringify(signal.metadata),
  );
}

export function getSignalsByStrategy(strategyId: string, limit = 100): SignalRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM signals WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?',
  ).all(strategyId, limit) as SignalRow[];
}

export function getSignalsByEntity(entitySlug: string, limit = 100): SignalRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM signals WHERE entity_slug = ? ORDER BY created_at DESC LIMIT ?',
  ).all(entitySlug, limit) as SignalRow[];
}

export function getApprovalRate(strategyId: string): { total: number; approved: number; rate: number } {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT COUNT(*) as total, SUM(approved) as approved FROM signals WHERE strategy_id = ?
  `).get(strategyId) as { total: number; approved: number };
  return {
    total: row.total,
    approved: row.approved ?? 0,
    rate: row.total > 0 ? (row.approved ?? 0) / row.total : 0,
  };
}

export interface SignalRow {
  id: number;
  signal_id: string;
  entity_slug: string;
  strategy_id: string;
  sub_strategy_id: string | null;
  condition_id: string;
  token_id: string;
  side: string;
  outcome: string;
  strength: number;
  edge: number;
  model_prob: number;
  market_price: number;
  recommended_size_usd: number;
  approved: number;
  rejection_reason: string | null;
  final_size_usd: number | null;
  metadata: string | null;
  created_at: string;
}
