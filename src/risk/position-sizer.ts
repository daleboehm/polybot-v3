// Position sizing — fractional Kelly, performance weighting, then hard caps.
//
// AUDIT FIX (A-P0-6, 2026-04-10): The previous implementation applied per-position
// caps BEFORE the strategy weight multiplier, which meant a proven strategy with a
// 2.0x weight could double the intended cap. Corrected order is:
//
//    Kelly → weighter multiply → pct cap → absolute cap → dust floor
//
// Caps are LAST because they're hard limits that bind regardless of weighter output.
// The weighter's purpose is cash preservation (keep R&D buying across all sub-strategies
// for coverage), NOT alpha amplification — but even so, a winning sub-strategy that
// the weighter legitimately boosts to 2.0x must still respect the 10% / $20 caps
// the risk policy sets.

import type { Signal, RiskLimits, EntityState } from '../types/index.js';
import type { StrategyWeighter } from './strategy-weighter.js';
import type { MarketCache } from '../market/market-cache.js';
import { kellySize, roundTo } from '../utils/math.js';
import { computeLiquidityBound, logLiquidityEvent } from './liquidity-check.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('position-sizer');

export interface SizingResult {
  size_usd: number;
  size_shares: number;
  method: 'kelly' | 'cap' | 'minimum';
  capped_by?: string;
  strategy_weight?: number;
}

export function calculatePositionSize(
  signal: Signal,
  entity: EntityState,
  limits: RiskLimits,
  strategyWeighter?: StrategyWeighter,
  marketCache?: MarketCache,
): SizingResult {
  const tradingBalance = entity.trading_balance;
  if (tradingBalance <= 0) {
    return { size_usd: 0, size_shares: 0, method: 'minimum' };
  }

  // 1. Kelly-based sizing from the signal's edge
  let sizeUsd = kellySize(
    signal.model_prob,
    signal.market_price,
    limits.fractional_kelly,
    tradingBalance,
  );

  // 2. Apply the strategy weight multiplier FIRST (before caps).
  //    The weighter is a cash-preservation device: keep all sub-strategies trading
  //    for coverage, reduce bet size on bad ones, amplify up to 2.0x for proven ones.
  //    See `strategy-weighter.ts` file header for the full framing.
  //    Passes entity_slug per audit A-P1-2 fix (2026-04-10) — cross-entity contamination.
  let stratWeight = 1.0;
  if (strategyWeighter) {
    stratWeight = strategyWeighter.getWeight(
      signal.strategy_id,
      signal.sub_strategy_id,
      signal.entity_slug,
    );
    sizeUsd = sizeUsd * stratWeight;
  }

  // 3. Apply hard caps LAST — they're the binding constraint.
  let method: SizingResult['method'] = 'kelly';
  let cappedBy: string | undefined;

  // Cap: percentage of trading balance
  const pctCap = tradingBalance * limits.max_position_pct;
  if (sizeUsd > pctCap) {
    sizeUsd = pctCap;
    method = 'cap';
    cappedBy = `${limits.max_position_pct * 100}% of trading balance`;
  }

  // Cap: absolute USD limit (0 = no cap)
  if (limits.max_position_usd > 0 && sizeUsd > limits.max_position_usd) {
    sizeUsd = limits.max_position_usd;
    method = 'cap';
    cappedBy = `$${limits.max_position_usd} absolute cap`;
  }

  // 2026-04-11 Phase 1.3: liquidity-aware bound. Refuse to walk the book
  // more than ~2% on the avg fill. Pure defensive layer — we never INCREASE
  // size here, only shrink. Failing gracefully if the book is unavailable
  // (returns the requested size + logs a warning).
  if (marketCache) {
    const book = marketCache.getOrderbook(signal.token_id);
    const liq = computeLiquidityBound(sizeUsd, signal.market_price, book, {
      maxSlippagePct: 0.02,
    });
    logLiquidityEvent(liq, {
      strategy_id: signal.strategy_id,
      condition_id: signal.condition_id,
      token_id: signal.token_id,
    });
    if (liq.max_size_usd < sizeUsd) {
      sizeUsd = liq.max_size_usd;
      method = 'cap';
      cappedBy = `liquidity bound (avg fill ${liq.avg_fill_price.toFixed(3)} vs midpoint ${signal.market_price.toFixed(3)})`;
    }
  }

  // Floor: don't trade dust
  sizeUsd = roundTo(sizeUsd, 2);
  if (sizeUsd < 0.10) {
    return { size_usd: 0, size_shares: 0, method: 'minimum', strategy_weight: stratWeight };
  }

  const sizeShares = sizeUsd / signal.market_price;

  log.debug({
    entity: signal.entity_slug,
    strategy: signal.strategy_id,
    edge: roundTo(signal.edge, 4),
    kelly_raw: roundTo(kellySize(signal.model_prob, signal.market_price, 1, tradingBalance), 2),
    final_usd: sizeUsd,
    method,
    capped_by: cappedBy,
    strategy_weight: stratWeight,
  }, 'Position sized');

  return { size_usd: sizeUsd, size_shares: roundTo(sizeShares, 2), method, capped_by: cappedBy, strategy_weight: stratWeight };
}
