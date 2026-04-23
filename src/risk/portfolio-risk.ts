// Portfolio-level risk tracking — category concentration, correlation, drawdown halt.
//
// R3b (2026-04-10). Per design-decisions §G + `agi-risk-management`: individual
// position caps (10% per market, $20 absolute) are necessary but insufficient.
// Without portfolio awareness, 40 "favorites" positions can all be on the same
// sports league and the fleet is effectively one giant correlated bet, not 40
// diversified ones.
//
// This module tracks:
//   1. Per-category exposure (sports, politics, crypto, weather, macro)
//   2. Per-strategy exposure
//   3. Fleet drawdown vs high-water mark
//   4. Consecutive-loss streaks for circuit breaker gates
//
// Used by the engine scan cycle: checkExposure() before opening any new position,
// updateOnFill() after every fill, updateOnResolution() on every close. Triggers
// kill-switch halts on breach (R1 PR#2 kill switch).

import { getAllOpenPositions } from '../storage/repositories/position-repo.js';
import { killSwitch } from '../core/kill-switch.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('portfolio-risk');

// Category keywords — if a market's question matches any keyword in a
// category, the position is tagged to that category for aggregation.
const CATEGORY_KEYWORDS: Record<string, readonly string[]> = {
  sports: ['nfl', 'nba', 'mlb', 'nhl', 'soccer', 'tennis', 'ufc', 'mma', 'f1', 'cup', 'championship', 'playoff', 'lakers', 'warriors', 'cowboys', 'yankees'],
  politics: ['election', 'president', 'senate', 'congress', 'governor', 'primary', 'vote', 'nominee', 'trump', 'biden', 'harris'],
  crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'ripple', 'xrp', 'dogecoin', 'crypto'],
  weather: ['temperature', 'hurricane', 'snowfall', 'rainfall', 'weather', 'storm', 'climate'],
  macro: ['fed', 'rate cut', 'rate hike', 'fomc', 'cpi', 'inflation', 'unemployment', 'gdp', 'recession'],
  entertainment: ['oscar', 'movie', 'grammy', 'billboard', 'emmy', 'netflix', 'box office'],
} as const;

export type Category = keyof typeof CATEGORY_KEYWORDS | 'other';

export interface ExposureCheckResult {
  approved: boolean;
  reason?: string;
  currentCategoryExposurePct?: number;
  currentCategoryUsd?: number;
  currentStrategyExposurePct?: number;
  currentStrategyUsd?: number;
}

export interface ExposureLimits {
  maxCategoryPct: number;       // max % of trading balance per category
  maxStrategyPct: number;       // max % per strategy
  maxDrawdownPct: number;       // halt if drawdown exceeds
  maxConsecutiveLosses: number; // halt after N consecutive losing resolutions
}

export const DEFAULT_EXPOSURE_LIMITS: ExposureLimits = {
  maxCategoryPct: 0.30,     // 30% per category (agi-risk-management)
  maxStrategyPct: 0.40,     // 40% per strategy
  maxDrawdownPct: 0.50,     // 2026-04-23: raised 20->50% for RmaxDrawdownPct: 0.20,     // -20% halt (moderate tier)D. Prod still effectively capped by daily_loss_lockout_usd=$10 (2.7% daily) + max_portfolio_exposure_pct=0.15.
  maxConsecutiveLosses: 7,
};

export class PortfolioRiskTracker {
  private highWaterMark = new Map<string, number>(); // entity_slug → peak equity
  private consecutiveLosses = new Map<string, number>(); // entity_slug → count
  private lossStreakLocked = new Set<string>(); // entities currently in cooling period

  constructor(private readonly limits: ExposureLimits = DEFAULT_EXPOSURE_LIMITS) {}

  /**
   * Pre-trade gate: check if opening a new position would breach category
   * or strategy concentration limits. Returns approved:false with a reason
   * if blocked — caller should log the block + emit a risk:violation event.
   */
  checkExposure(
    entitySlug: string,
    tradingBalance: number,
    proposedSizeUsd: number,
    category: Category,
    strategyId: string,
  ): ExposureCheckResult {
    if (tradingBalance <= 0) {
      return { approved: false, reason: 'zero trading balance' };
    }

    const positions = getAllOpenPositions().filter(p => p.entity_slug === entitySlug);

    let categoryUsd = 0;
    let strategyUsd = 0;
    for (const p of positions) {
      const posCategory = inferCategory(p.market_question ?? '');
      if (posCategory === category) categoryUsd += p.cost_basis;
      if (p.strategy_id === strategyId) strategyUsd += p.cost_basis;
    }

    const newCategoryUsd = categoryUsd + proposedSizeUsd;
    const newStrategyUsd = strategyUsd + proposedSizeUsd;
    const newCategoryPct = newCategoryUsd / tradingBalance;
    const newStrategyPct = newStrategyUsd / tradingBalance;

    if (newCategoryPct > this.limits.maxCategoryPct) {
      return {
        approved: false,
        reason: `category_exposure: ${category} at ${(newCategoryPct * 100).toFixed(1)}% > ${(this.limits.maxCategoryPct * 100).toFixed(0)}% cap`,
        currentCategoryExposurePct: categoryUsd / tradingBalance,
        currentCategoryUsd: categoryUsd,
      };
    }
    if (newStrategyPct > this.limits.maxStrategyPct) {
      return {
        approved: false,
        reason: `strategy_exposure: ${strategyId} at ${(newStrategyPct * 100).toFixed(1)}% > ${(this.limits.maxStrategyPct * 100).toFixed(0)}% cap`,
        currentStrategyExposurePct: strategyUsd / tradingBalance,
        currentStrategyUsd: strategyUsd,
      };
    }

    return {
      approved: true,
      currentCategoryExposurePct: categoryUsd / tradingBalance,
      currentCategoryUsd: categoryUsd,
      currentStrategyExposurePct: strategyUsd / tradingBalance,
      currentStrategyUsd: strategyUsd,
    };
  }

  /**
   * Update on every entity balance change (after fills, resolutions, transfers).
   * Computes drawdown vs high-water mark and halts the engine via kill switch
   * if the drawdown breaches `maxDrawdownPct`.
   */
  updateDrawdown(entitySlug: string, currentEquity: number): number {
    const prevHwm = this.highWaterMark.get(entitySlug) ?? currentEquity;
    const newHwm = Math.max(prevHwm, currentEquity);
    this.highWaterMark.set(entitySlug, newHwm);

    const drawdown = newHwm > 0 ? (newHwm - currentEquity) / newHwm : 0;
    if (drawdown > this.limits.maxDrawdownPct) {
      log.error({ entity: entitySlug, drawdown: (drawdown * 100).toFixed(1) + '%', hwm: newHwm, current: currentEquity }, 'Drawdown breach — activating kill switch');
      killSwitch.halt('daily_drawdown_breach', `${entitySlug}: drawdown ${(drawdown * 100).toFixed(1)}% > ${(this.limits.maxDrawdownPct * 100).toFixed(0)}%`);
    }
    return drawdown;
  }

  /**
   * Called on every resolution. Tracks consecutive losses per entity and
   * halts if the streak crosses `maxConsecutiveLosses`.
   */
  recordResolution(entitySlug: string, realizedPnl: number): void {
    if (realizedPnl > 0) {
      this.consecutiveLosses.set(entitySlug, 0);
      this.lossStreakLocked.delete(entitySlug);
      return;
    }

    const prev = this.consecutiveLosses.get(entitySlug) ?? 0;
    const streak = prev + 1;
    this.consecutiveLosses.set(entitySlug, streak);

    if (streak >= this.limits.maxConsecutiveLosses && !this.lossStreakLocked.has(entitySlug)) {
      log.error({ entity: entitySlug, streak }, 'Consecutive loss streak breach — activating kill switch');
      killSwitch.halt('consecutive_losses', `${entitySlug}: ${streak} consecutive losses`);
      this.lossStreakLocked.add(entitySlug);
    }
  }

  getDrawdown(entitySlug: string, currentEquity: number): number {
    const hwm = this.highWaterMark.get(entitySlug) ?? currentEquity;
    return hwm > 0 ? (hwm - currentEquity) / hwm : 0;
  }

  getConsecutiveLosses(entitySlug: string): number {
    return this.consecutiveLosses.get(entitySlug) ?? 0;
  }

  getHighWaterMark(entitySlug: string): number {
    return this.highWaterMark.get(entitySlug) ?? 0;
  }

  /**
   * Snapshot of all portfolio-level state for the dashboard.
   */
  snapshot(): Record<string, unknown> {
    return {
      high_water_marks: Object.fromEntries(this.highWaterMark),
      consecutive_losses: Object.fromEntries(this.consecutiveLosses),
      locked_entities: Array.from(this.lossStreakLocked),
      limits: this.limits,
    };
  }
}

/**
 * Infer a market's category from its question text. Used by checkExposure
 * and by dashboard aggregation.
 */
export function inferCategory(question: string): Category {
  const lowered = question.toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const kw of keywords) {
      if (lowered.includes(kw)) return category as Category;
    }
  }
  return 'other';
}
