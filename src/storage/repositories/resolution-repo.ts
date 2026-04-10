// Resolution CRUD operations

import { getDatabase } from '../database.js';
import type { Resolution } from '../../types/index.js';

export function insertResolution(r: Resolution): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO resolutions (
      entity_slug, condition_id, token_id, winning_outcome, position_side,
      size, payout_usdc, cost_basis_usdc, sell_proceeds_usdc, realized_pnl,
      is_paper, strategy_id, sub_strategy_id, market_question, market_slug, tx_hash, resolved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    r.entity_slug, r.condition_id, r.token_id, r.winning_outcome, r.position_side,
    r.size, r.payout_usdc, r.cost_basis_usdc, r.sell_proceeds_usdc, r.realized_pnl,
    r.is_paper ? 1 : 0, r.strategy_id, r.sub_strategy_id ?? null, r.market_question, r.market_slug,
    r.tx_hash, r.resolved_at.toISOString(),
  );
}

export function getResolutionsByEntity(entitySlug: string, limit = 100): ResolutionRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM resolutions WHERE entity_slug = ? ORDER BY resolved_at DESC LIMIT ?',
  ).all(entitySlug, limit) as ResolutionRow[];
}

export function getResolutionsByStrategy(strategyId: string): ResolutionRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM resolutions WHERE strategy_id = ? ORDER BY resolved_at DESC',
  ).all(strategyId) as ResolutionRow[];
}

export function getTotalRealizedPnl(entitySlug: string): number {
  const db = getDatabase();
  const row = db.prepare(
    'SELECT COALESCE(SUM(realized_pnl), 0) as total FROM resolutions WHERE entity_slug = ?',
  ).get(entitySlug) as { total: number };
  return row.total;
}

export function getWeeklyTax(entitySlug?: string): WeeklyTaxRow[] {
  const db = getDatabase();
  if (entitySlug) {
    return db.prepare('SELECT * FROM v_weekly_tax WHERE entity_slug = ?').all(entitySlug) as WeeklyTaxRow[];
  }
  return db.prepare('SELECT * FROM v_weekly_tax').all() as WeeklyTaxRow[];
}

export function getStrategyPerformance(): StrategyPerfRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM v_strategy_performance').all() as StrategyPerfRow[];
}

export interface ResolutionRow {
  id: number;
  entity_slug: string;
  condition_id: string;
  token_id: string;
  winning_outcome: string;
  position_side: string;
  size: number;
  payout_usdc: number;
  cost_basis_usdc: number;
  sell_proceeds_usdc: number;
  realized_pnl: number;
  is_paper: number;
  strategy_id: string | null;
  sub_strategy_id: string | null;
  market_question: string | null;
  market_slug: string | null;
  tx_hash: string | null;
  resolved_at: string;
  created_at: string;
}

export interface WeeklyTaxRow {
  entity_slug: string;
  tax_week: string;
  taxable_gains: number;
  deductible_losses: number;
  net_pnl: number;
  num_resolutions: number;
}

export interface StrategyPerfRow {
  strategy_id: string;
  sub_strategy_id: string;
  entity_slug: string;
  total_resolutions: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl_per_trade: number;
  best_trade: number;
  worst_trade: number;
  open_positions: number;
  open_cost_basis: number;
  open_upside: number;
  total_trades: number;
  total_volume: number;
}
