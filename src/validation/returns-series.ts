// Returns-series adapter — Phase B (2026-04-11).
//
// DSR, PSR, MinTRL, and Brier all need a per-trade returns series, not
// the win/loss counts Wilson LB uses. This module converts the raw
// `resolutions` rows (which our existing advisor reads via v_strategy_performance)
// into a list of per-trade returns `r_i = realized_pnl_i / cost_basis_i`.
//
// Why returns, not P&L:
//   - Sharpe ratio is (mean / stddev) of returns, dimensionless
//   - A $10 win on a $5 cost basis and a $20 win on a $10 cost basis
//     are both +100% returns and should contribute identically to Sharpe
//   - Using raw P&L instead biases Sharpe toward whichever trades happen
//     to be bigger, which doesn't tell us about strategy quality
//
// This module reads from the R&D database directly (same connection
// pattern as the advisor). It's read-only and file-must-exist.

import Database from 'better-sqlite3';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('returns-series');

export interface TradeReturn {
  /** Dimensionless return: realized_pnl / cost_basis */
  return_pct: number;
  /** Binary outcome: 1 if win (payout > cost), 0 if loss */
  outcome: 0 | 1;
  /** Original realized P&L in USD (for logging) */
  realized_pnl: number;
  /** Cost basis in USD (for logging) */
  cost_basis: number;
  /** Market price at entry (needed for Brier) */
  entry_price: number | null;
  /** Unix ms of resolution */
  resolved_at_ms: number;
}

/**
 * Load all resolved trades for a given (strategy_id, sub_strategy_id)
 * from the R&D database, converted to per-trade returns + binary outcome.
 *
 * Joins the `resolutions` table to `positions` to get the entry price
 * (which resolutions alone doesn't store). Drops rows where cost_basis
 * is zero or missing — a zero-cost trade is either paper-sim noise or
 * a data bug; either way it can't contribute to a meaningful returns series.
 *
 * @param rdDatabasePath Path to the read-only R&D database
 * @param strategyId Parent strategy
 * @param subStrategyId Sub-strategy — empty string for parent-only
 * @param daysBack Optional; if set, only return resolutions within this window
 */
export function loadReturnsSeries(
  rdDatabasePath: string,
  strategyId: string,
  subStrategyId: string,
  daysBack?: number,
): TradeReturn[] {
  const db = new Database(rdDatabasePath, { readonly: true, fileMustExist: true });
  try {
    const params: (string | number)[] = [strategyId];
    let subClause: string;
    if (subStrategyId === '') {
      subClause = `AND (r.sub_strategy_id IS NULL OR r.sub_strategy_id = '')`;
    } else {
      subClause = `AND r.sub_strategy_id = ?`;
      params.push(subStrategyId);
    }

    let dateClause = '';
    if (daysBack !== undefined && daysBack > 0) {
      dateClause = `AND r.resolved_at >= datetime('now', ?)`;
      params.push(`-${daysBack} days`);
    }

    const sql = `
      SELECT
        r.realized_pnl AS realized_pnl,
        r.cost_basis_usdc AS cost_basis,
        r.payout_usdc AS payout,
        r.resolved_at AS resolved_at,
        p.avg_entry_price AS entry_price
      FROM resolutions r
      LEFT JOIN positions p
        ON p.entity_slug = r.entity_slug
       AND p.condition_id = r.condition_id
       AND p.token_id = r.token_id
      WHERE r.strategy_id = ?
        ${subClause}
        AND r.cost_basis_usdc > 0
        ${dateClause}
      ORDER BY r.resolved_at ASC
    `;

    const rows = db.prepare(sql).all(...params) as Array<{
      realized_pnl: number;
      cost_basis: number;
      payout: number;
      resolved_at: string;
      entry_price: number | null;
    }>;

    const out: TradeReturn[] = [];
    for (const row of rows) {
      if (!row.cost_basis || row.cost_basis <= 0) continue;
      const returnPct = row.realized_pnl / row.cost_basis;
      if (!Number.isFinite(returnPct)) continue;
      const outcome: 0 | 1 = row.payout > row.cost_basis ? 1 : 0;
      let resolvedMs: number;
      try {
        resolvedMs = new Date(row.resolved_at).getTime();
      } catch {
        resolvedMs = 0;
      }
      out.push({
        return_pct: returnPct,
        outcome,
        realized_pnl: row.realized_pnl,
        cost_basis: row.cost_basis,
        entry_price: row.entry_price,
        resolved_at_ms: resolvedMs,
      });
    }

    log.debug(
      {
        strategy: strategyId,
        sub: subStrategyId,
        rows_returned: rows.length,
        rows_kept: out.length,
        days_back: daysBack ?? 'all',
      },
      'Returns series loaded',
    );
    return out;
  } finally {
    db.close();
  }
}

/**
 * Summary stats over a returns series — used for logging + debugging.
 */
export function returnsSeriesSummary(returns: TradeReturn[]): {
  n: number;
  wins: number;
  losses: number;
  mean_return_pct: number;
  total_pnl: number;
} {
  let wins = 0;
  let losses = 0;
  let sumReturn = 0;
  let sumPnl = 0;
  for (const r of returns) {
    if (r.outcome === 1) wins++;
    else losses++;
    sumReturn += r.return_pct;
    sumPnl += r.realized_pnl;
  }
  return {
    n: returns.length,
    wins,
    losses,
    mean_return_pct: returns.length > 0 ? sumReturn / returns.length : 0,
    total_pnl: sumPnl,
  };
}
