// PriorityScanner — attention router for scout-flagged markets.
//
// Phase 2 (2026-04-11). The normal scan cycle runs every 5 min on prod
// (2 min on R&D), which is too slow to grab a fast-moving opportunity.
// Scouts watch for volume spikes, price jumps, news catalysts, and flag
// specific markets as high-priority via the market_priorities table.
// This scanner polls that table every 30 seconds and fires strategies
// on JUST those markets out-of-cycle. Any signals generated flow through
// the normal risk engine + order router pipeline — nothing about the
// execution path is bypassed.
//
// The PriorityScanner is NOT a replacement for the normal scan cycle.
// It's a fast-lane parallel path for markets the scouts flagged. The
// normal cycle still runs at its full cadence and picks up markets the
// scouts missed.
//
// Contract with strategies:
//   - Strategies call ctx.getActiveMarkets() / getActiveMarketsInWindow()
//     to get their candidate set.
//   - In a priority scan, those methods return ONLY markets in the
//     priority set (intersected with the strategy's time-window filter).
//   - The strategy itself is unchanged — its own dedup logic handles the
//     case where a priority market was just evaluated by a normal cycle.

import type { EntityManager } from '../entity/entity-manager.js';
import type { StrategyRegistry } from '../strategy/strategy-registry.js';
import type { MarketCache } from '../market/market-cache.js';
import type { RiskEngine } from '../risk/risk-engine.js';
import type { ClobRouter } from '../execution/clob-router.js';
import type { RiskLimits, Signal, MarketData, EntityState, Position } from '../types/index.js';
import type { StrategyContext } from '../strategy/strategy-interface.js';
import { getActivePriorities, markScanned, purgeExpired as purgeExpiredPriorities } from '../storage/repositories/market-priority-repo.js';
import { purgeExpired as purgeExpiredIntel } from '../storage/repositories/scout-intel-repo.js';
import { getOpenPositions as getOpenPositionsRepo } from '../storage/repositories/position-repo.js';
import { getSignalsByStrategy } from '../storage/repositories/signal-repo.js';
import { buildOrder } from '../execution/order-builder.js';
import { createChildLogger } from './logger.js';
import { eventBus } from './event-bus.js';

const log = createChildLogger('priority-scanner');

export interface PriorityScannerDeps {
  entityManager: EntityManager;
  strategyRegistry: StrategyRegistry;
  marketCache: MarketCache;
  riskEngine: RiskEngine;
  clobRouter: ClobRouter;
  riskLimits: RiskLimits;
  executionConfig: {
    slippage_bps: number;
    bid_premium_pct: number;
  };
}

export interface PriorityScannerConfig {
  enabled: boolean;
  /** How often the scanner runs, in ms. Default 30 seconds. */
  interval_ms: number;
  /** Max priority rows evaluated per run. */
  max_priorities_per_run: number;
  /** Minimum gap between re-scans of the same priority row, in ms. */
  min_scan_gap_ms: number;
  /** Run a garbage collection sweep every N runs. */
  gc_every_n_runs: number;
}

export const DEFAULT_PRIORITY_SCANNER_CONFIG: PriorityScannerConfig = {
  enabled: true,
  interval_ms: 30_000,
  max_priorities_per_run: 25,
  min_scan_gap_ms: 60_000,
  gc_every_n_runs: 60, // every ~30 minutes at 30s cadence
};

export class PriorityScanner {
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private runCount = 0;

  constructor(
    private deps: PriorityScannerDeps,
    private config: PriorityScannerConfig = DEFAULT_PRIORITY_SCANNER_CONFIG,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      log.info('PriorityScanner disabled via config — not starting');
      return;
    }
    if (this.interval) {
      log.warn('PriorityScanner already running');
      return;
    }
    this.interval = setInterval(() => {
      if (this.running) {
        log.debug('Previous priority scan still in progress, skipping');
        return;
      }
      this.runOnce().catch(err => {
        log.error({ err }, 'Priority scan run failed');
      });
    }, this.config.interval_ms);
    log.info({ interval_ms: this.config.interval_ms }, 'PriorityScanner started');
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.info('PriorityScanner stopped');
    }
  }

  async runOnce(): Promise<void> {
    this.running = true;
    try {
      this.runCount++;
      // Periodic GC — delete expired priority + intel rows so the tables
      // don't grow unbounded.
      if (this.runCount % this.config.gc_every_n_runs === 0) {
        try {
          const removedP = purgeExpiredPriorities();
          const removedI = purgeExpiredIntel();
          if (removedP > 0 || removedI > 0) {
            log.info({ removed_priorities: removedP, removed_intel: removedI }, 'GC swept expired rows');
          }
        } catch (err) {
          log.warn({ err }, 'GC sweep failed');
        }
      }

      const priorities = getActivePriorities(
        this.config.max_priorities_per_run,
        this.config.min_scan_gap_ms,
      );
      if (priorities.length === 0) return;

      // Resolve priorities to MarketData. Skip any that aren't in the cache
      // (market may have been delisted or never pulled by sampling-poller).
      const prioritySet = new Set<string>();
      const resolved: MarketData[] = [];
      for (const p of priorities) {
        const m = this.deps.marketCache.get(p.condition_id);
        if (m) {
          resolved.push(m);
          prioritySet.add(p.condition_id);
        }
      }

      if (resolved.length === 0) {
        // All priority markets missing from cache — still mark them scanned
        // so we don't poll the same invalid rows every 30 seconds.
        for (const p of priorities) markScanned(p.id);
        log.debug({ count: priorities.length }, 'Priority scan — no cached markets to evaluate');
        return;
      }

      log.debug({ count: resolved.length }, 'Priority scan firing');

      // Iterate every entity (same shape as the normal scan cycle).
      const entities = this.deps.entityManager.getAllEntities();
      let totalSignals = 0;
      let totalOrders = 0;

      for (const entity of entities) {
        if (entity.config.status !== 'active') continue;

        const rawStrategies = entity.config.strategies ?? [];
        const strategyConfigs: Array<{ strategy_id: string; sub_strategy_ids: string[] | undefined }> =
          rawStrategies.map((s: string | { strategy_id: string; sub_strategy_ids?: string[] }) =>
            typeof s === 'string' ? { strategy_id: s, sub_strategy_ids: undefined } : { strategy_id: s.strategy_id, sub_strategy_ids: s.sub_strategy_ids },
          );
        if (strategyConfigs.length === 0) continue;

        // Scoped ctx — getActiveMarkets returns ONLY the priority set
        // (intersected with the risk-limit time window), so strategies
        // evaluate a small universe.
        const allSignals: Signal[] = [];
        for (const stratCfg of strategyConfigs) {
          const strategy = this.deps.strategyRegistry.get(stratCfg.strategy_id);
          if (!strategy) continue;

          const ctx = this.createPriorityContext(
            entity,
            resolved,
            stratCfg.sub_strategy_ids,
          );

          if (!strategy.shouldRun(ctx)) continue;

          try {
            const signals = await strategy.evaluate(ctx);
            totalSignals += signals.length;
            for (const s of signals) {
              // Only accept signals where the target market is actually in
              // the priority set. Some strategies may emit off-target
              // signals (e.g. fan_fade on a market not in priorities).
              if (prioritySet.has(s.condition_id)) allSignals.push(s);
            }
          } catch (err) {
            log.error({ strategy: strategy.id, entity: entity.config.slug, err }, 'Priority strategy eval failed');
          }
        }

        // Same shuffle + dedup + risk-engine + router pipeline as normal scan
        for (let i = allSignals.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = allSignals[i]!;
          allSignals[i] = allSignals[j]!;
          allSignals[j] = tmp;
        }

        const openedThisCycle = new Set<string>();
        for (const signal of allSignals) {
          eventBus.emit('signal:generated', { signal });
          const cycleKey = `${signal.condition_id}|${signal.token_id}`;
          if (openedThisCycle.has(cycleKey)) continue;

          const decision = this.deps.riskEngine.evaluate(signal, entity);
          if (decision.risk_approved && decision.order_request) {
            const tokenBook = this.deps.marketCache.getOrderbook(signal.token_id);
            const order = buildOrder(
              decision,
              entity,
              this.deps.executionConfig.slippage_bps,
              this.deps.executionConfig.bid_premium_pct,
              tokenBook,
            );
            if (order) {
              try {
                const fill = await this.deps.clobRouter.routeOrder(order, entity);
                if (fill) {
                  totalOrders++;
                  openedThisCycle.add(cycleKey);
                  // Balance + position updates handled elsewhere on
                  // fill processing — priority scanner does not duplicate
                  // that logic here. The clob router emits the trade
                  // event; the engine's existing event handlers apply
                  // the balance delta. (See engine.ts processPosition).
                }
              } catch (err) {
                log.error({ entity: entity.config.slug, err }, 'Priority order routing failed');
              }
            }
          }
        }
      }

      // Mark priorities as scanned so we don't hammer them.
      for (const p of priorities) markScanned(p.id);

      if (totalSignals > 0 || totalOrders > 0) {
        log.info(
          {
            priorities: priorities.length,
            cached: resolved.length,
            signals: totalSignals,
            orders: totalOrders,
          },
          'Priority scan complete',
        );
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Build a StrategyContext where getActiveMarkets / getActiveMarketsInWindow
   * return only the priority set (still respecting the strategy's own
   * time-window filter). Everything else — getOpenPositions, getRecentSignals,
   * getMarketData — mirrors the normal context.
   */
  private createPriorityContext(
    entity: EntityState,
    priorityMarkets: MarketData[],
    enabledSubStrategies: string[] | undefined,
  ): StrategyContext {
    const riskLimits = this.deps.riskLimits;
    const marketCache = this.deps.marketCache;
    const priorityIds = new Set(priorityMarkets.map(m => m.condition_id));

    return {
      entity,
      risk_limits: riskLimits,
      enabled_sub_strategies: enabledSubStrategies,

      getMarketData(conditionId: string): MarketData | undefined {
        return marketCache.get(conditionId);
      },

      getAllMarkets(): MarketData[] {
        return priorityMarkets;
      },

      getActiveMarkets(): MarketData[] {
        // Still apply the global time-horizon filter so a priority market
        // that's >48h out doesn't get traded.
        const minHours = riskLimits.min_hours_to_resolve ?? 1;
        const maxHours = riskLimits.max_hours_to_resolve ?? 48;
        const now = Date.now();
        const minMs = minHours * 60 * 60 * 1000;
        const maxMs = maxHours * 60 * 60 * 1000;
        return priorityMarkets.filter(m => {
          if (!m.end_date) return false;
          const deltaMs = m.end_date.getTime() - now;
          return deltaMs >= minMs && deltaMs <= maxMs;
        });
      },

      getActiveMarketsInWindow(minHours: number, maxHours: number): MarketData[] {
        const now = Date.now();
        const minMs = minHours * 60 * 60 * 1000;
        const maxMs = maxHours * 60 * 60 * 1000;
        return priorityMarkets.filter(m => {
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

      getOpenPositionsAcrossFleet(): Position[] {
        // Single-entity context — fleet dedup handled by main engine-tick path.
        return getOpenPositionsRepo(entity.config.slug).map(r => ({
          entity_slug: r.entity_slug, condition_id: r.condition_id, token_id: r.token_id,
          side: r.side as 'YES' | 'NO', size: r.size, avg_entry_price: r.avg_entry_price,
          cost_basis: r.cost_basis, current_price: r.current_price, unrealized_pnl: r.unrealized_pnl,
          market_question: r.market_question ?? '', strategy_id: r.strategy_id ?? '',
          is_paper: r.is_paper === 1, status: r.status as 'open' | 'closed' | 'resolved',
          opened_at: new Date(r.opened_at), closed_at: r.closed_at ? new Date(r.closed_at) : undefined,
        }));
      },

      getRecentSignals(strategyId: string, limit: number): Signal[] {
        // Use getSignalsByStrategy to keep the same dedup behavior
        // strategies expect from the normal context.
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
}
