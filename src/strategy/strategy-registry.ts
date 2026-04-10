// Strategy registry — loads, lists, and enables/disables strategies

import type { BaseStrategy } from './strategy-interface.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('strategy-registry');

export class StrategyRegistry {
  private strategies = new Map<string, BaseStrategy>();

  register(strategy: BaseStrategy): void {
    if (this.strategies.has(strategy.id)) {
      log.warn({ id: strategy.id }, 'Strategy already registered, overwriting');
    }
    this.strategies.set(strategy.id, strategy);
    log.info({ id: strategy.id, name: strategy.name, version: strategy.version }, 'Strategy registered');
  }

  unregister(strategyId: string): void {
    this.strategies.delete(strategyId);
    log.info({ id: strategyId }, 'Strategy unregistered');
  }

  get(strategyId: string): BaseStrategy | undefined {
    return this.strategies.get(strategyId);
  }

  getAll(): BaseStrategy[] {
    return Array.from(this.strategies.values());
  }

  getAllIds(): string[] {
    return Array.from(this.strategies.keys());
  }

  /**
   * Returns all registered (strategy_id, sub_strategy_id) pairs.
   * Strategies with no sub-strategies return [{strategy_id, sub_strategy_id: undefined}].
   * Strategies with sub-strategies return one entry per sub.
   */
  getAllSubStrategyKeys(): Array<{ strategy_id: string; sub_strategy_id: string | undefined }> {
    const result: Array<{ strategy_id: string; sub_strategy_id: string | undefined }> = [];
    for (const strategy of this.strategies.values()) {
      const subs = strategy.getSubStrategies();
      if (subs.length === 0) {
        result.push({ strategy_id: strategy.id, sub_strategy_id: undefined });
      } else {
        for (const sub of subs) {
          result.push({ strategy_id: strategy.id, sub_strategy_id: sub });
        }
      }
    }
    return result;
  }

  getForEntity(enabledStrategies: string[]): BaseStrategy[] {
    return enabledStrategies
      .map(id => this.strategies.get(id))
      .filter((s): s is BaseStrategy => s !== undefined);
  }

  has(strategyId: string): boolean {
    return this.strategies.has(strategyId);
  }

  get size(): number {
    return this.strategies.size;
  }

  async initializeAll(): Promise<void> {
    for (const strategy of this.strategies.values()) {
      try {
        await strategy.initialize();
        log.info({ id: strategy.id }, 'Strategy initialized');
      } catch (err) {
        log.error({ id: strategy.id, err }, 'Strategy initialization failed');
      }
    }
  }

  async teardownAll(): Promise<void> {
    for (const strategy of this.strategies.values()) {
      try {
        await strategy.teardown();
      } catch (err) {
        log.error({ id: strategy.id, err }, 'Strategy teardown failed');
      }
    }
  }
}
