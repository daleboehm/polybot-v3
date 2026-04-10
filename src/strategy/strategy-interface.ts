// Abstract base class for all trading strategies — implement evaluate() to create a strategy

import type { Signal, MarketData, EntityState, RiskLimits, Position } from '../types/index.js';

export interface StrategyContext {
  entity: EntityState;
  risk_limits: RiskLimits;
  /** Allow-list of enabled sub-strategies for this entity.
   *  - undefined: run all sub-strategies
   *  - []: run all sub-strategies (treated same as undefined)
   *  - ['near_snipe', 'compounding']: only run these sub-strategies
   */
  enabled_sub_strategies?: string[];
  getMarketData(conditionId: string): MarketData | undefined;
  getAllMarkets(): MarketData[];
  getActiveMarkets(): MarketData[];
  /**
   * Per-strategy time window override — returns active markets whose time-to-resolve
   * falls in `[minHours, maxHours]`, bypassing the global `risk.min_hours_to_resolve`
   * / `max_hours_to_resolve` filter used by `getActiveMarkets()`.
   *
   * Used by strategies that inherently need a wider horizon than the 1-48h default
   * (e.g. convergence.long_term_grind accumulates over multi-day drifts) OR narrower
   * (e.g. weather_forecast.same_day_snipe wants <6h). Use sparingly — Dale's default
   * keeps capital velocity high for a reason.
   */
  getActiveMarketsInWindow(minHours: number, maxHours: number): MarketData[];
  getOpenPositions(entitySlug: string): Position[];
  getRecentSignals(strategyId: string, limit: number): Signal[];
}

export abstract class BaseStrategy {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly version: string;

  /**
   * List of sub-strategy IDs this strategy implements.
   * Override in strategies that have multiple sub-strategies.
   * Empty array (default) means strategy has no sub-strategies — signals have sub_strategy_id = undefined.
   */
  getSubStrategies(): string[] {
    return [];
  }

  /**
   * Helper: check if a sub-strategy is enabled for this entity.
   * Returns true if enabled_sub_strategies is undefined/empty (run all) or if the sub is in the allow-list.
   */
  protected isSubStrategyEnabled(ctx: StrategyContext, subStrategyId: string): boolean {
    if (!ctx.enabled_sub_strategies || ctx.enabled_sub_strategies.length === 0) return true;
    return ctx.enabled_sub_strategies.includes(subStrategyId);
  }

  /**
   * Evaluate markets and return zero or more signals.
   * Called by the engine on each scan cycle for each assigned entity.
   */
  abstract evaluate(ctx: StrategyContext): Promise<Signal[]>;

  /**
   * Whether this strategy should run on the current cycle.
   * Override for strategies that only run at specific times or conditions.
   */
  shouldRun(_ctx: StrategyContext): boolean {
    return true;
  }

  /**
   * Called once when the strategy is loaded into the registry.
   * Use for one-time initialization (loading models, caching data).
   */
  async initialize(): Promise<void> {}

  /**
   * Called on engine shutdown for cleanup.
   */
  async teardown(): Promise<void> {}
}
