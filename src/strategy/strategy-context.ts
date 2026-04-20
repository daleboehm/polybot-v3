// Context object passed to strategies during evaluation

import type { StrategyContext } from './strategy-interface.js';
import type { Signal, MarketData, EntityState, RiskLimits, Position } from '../types/index.js';
import type { MarketCache } from '../market/market-cache.js';
import { getOpenPositions as getOpenPositionsRepo } from '../storage/repositories/position-repo.js';
import { getSignalsByStrategy } from '../storage/repositories/signal-repo.js';

export function createStrategyContext(
  entity: EntityState,
  riskLimits: RiskLimits,
  marketCache: MarketCache,
  enabledSubStrategies?: string[],
): StrategyContext {
  return {
    entity,
    risk_limits: riskLimits,
    enabled_sub_strategies: enabledSubStrategies,

    getMarketData(conditionId: string): MarketData | undefined {
      return marketCache.get(conditionId);
    },

    getAllMarkets(): MarketData[] {
      return marketCache.getAll();
    },

    getActiveMarkets(): MarketData[] {
      // Dale 2026-04-10: global 1-48h time-horizon filter. Strategies should
      // NOT consider any market that resolves outside this window. Keeps capital
      // velocity high — "keep the wheels spinning, no long term positions."
      const minHours = riskLimits.min_hours_to_resolve ?? 1;
      const maxHours = riskLimits.max_hours_to_resolve ?? 48;
      const now = Date.now();
      const minMs = minHours * 60 * 60 * 1000;
      const maxMs = maxHours * 60 * 60 * 1000;
      return marketCache.getActive().filter(m => {
        if (!m.end_date) return false;
        const deltaMs = m.end_date.getTime() - now;
        return deltaMs >= minMs && deltaMs <= maxMs;
      });
    },

    getActiveMarketsInWindow(minHours: number, maxHours: number): MarketData[] {
      // Per-strategy time window override. Bypasses the global default 1-48h filter.
      // Used by strategies that inherently need a wider or narrower horizon, e.g.
      // convergence.long_term_grind (up to 30 days) or weather.same_day_snipe (<6h).
      const now = Date.now();
      const minMs = minHours * 60 * 60 * 1000;
      const maxMs = maxHours * 60 * 60 * 1000;
      return marketCache.getActive().filter(m => {
        if (!m.end_date) return false;
        const deltaMs = m.end_date.getTime() - now;
        return deltaMs >= minMs && deltaMs <= maxMs;
      });
    },

    getOpenPositions(entitySlug: string): Position[] {
      const rows = getOpenPositionsRepo(entitySlug);
      return rows.map(r => ({
        entity_slug: r.entity_slug,
        condition_id: r.condition_id,
        token_id: r.token_id,
        side: r.side as 'YES' | 'NO',
        size: r.size,
        avg_entry_price: r.avg_entry_price,
        cost_basis: r.cost_basis,
        current_price: r.current_price,
        unrealized_pnl: r.unrealized_pnl,
        market_question: r.market_question ?? '',
        strategy_id: r.strategy_id ?? '',
        is_paper: r.is_paper === 1,
        status: r.status as 'open' | 'closed' | 'resolved',
        opened_at: new Date(r.opened_at),
        closed_at: r.closed_at ? new Date(r.closed_at) : undefined,
      }));
    },

    getRecentSignals(strategyId: string, limit: number): Signal[] {
      const rows = getSignalsByStrategy(strategyId, limit);
      return rows.map(r => ({
        signal_id: r.signal_id,
        entity_slug: r.entity_slug,
        strategy_id: r.strategy_id,
        sub_strategy_id: r.sub_strategy_id ?? undefined,
        condition_id: r.condition_id,
        token_id: r.token_id,
        side: r.side as 'BUY' | 'SELL',
        outcome: r.outcome as 'YES' | 'NO',
        strength: r.strength,
        edge: r.edge,
        model_prob: r.model_prob,
        market_price: r.market_price,
        recommended_size_usd: r.recommended_size_usd,
        metadata: r.metadata ? JSON.parse(r.metadata) : {},
        created_at: new Date(r.created_at),
      }));
    },
  };
}


// 2026-04-20 Action 6 (04-19 report): lifecycle timing filter per SSRN
// 5910522 (Reichenbach & Walther, 124M trades) — pricing inaccuracies
// cluster at contract inception (< 6h) and near resolution (> 85% elapsed).
// Strategies opt in by wrapping candidate selection with isLifecycleEdgeMarket().
export function isLifecycleEdgeMarket(market: { end_date?: Date; created_at?: Date }): boolean {
  const now = Date.now();
  const created = market.created_at?.getTime();
  const end = market.end_date?.getTime();
  if (!end) return false;
  if (created && (now - created) < 6 * 3600 * 1000) return true;
  if (created) {
    const totalLife = end - created;
    const elapsed = now - created;
    if (totalLife > 0 && elapsed / totalLife > 0.85) return true;
  } else {
    const hoursLeft = (end - now) / 3600 / 1000;
    if (hoursLeft < 2) return true;
  }
  return false;
}
