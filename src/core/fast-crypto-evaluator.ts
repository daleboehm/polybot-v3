// Fast crypto evaluator — Tier 1 infrastructure (2026-04-13).
//
// Subscribes to Polymarket's CLOB orderbook WebSocket for BTC markets.
// When a book update arrives (every ~100-500ms on active markets),
// triggers an immediate crypto_price strategy evaluation on JUST that
// market, bypassing the 5-minute scan cycle.
//
// The normal scan cycle still runs and catches anything this evaluator
// misses (markets we're not subscribed to, non-BTC markets, etc.).
// This is a FAST LANE, not a replacement.
//
// Architecture:
//   OrderbookWebSocket (existing) → emits 'orderbook:snapshot' events
//   FastCryptoEvaluator (this module) → listens for BTC-market snapshots
//     → creates a one-market StrategyContext
//     → runs CryptoPriceStrategy.evaluate()
//     → signals → RiskEngine → OrderBuilder (with book quality check) → ClobRouter
//
// Rate limiting:
//   - Orderbook updates can arrive many times per second
//   - We only re-evaluate if MIN_EVAL_INTERVAL_MS has passed since the
//     last evaluation on the same market (default 10 seconds)
//   - This means our effective reaction time is 10 seconds after a
//     significant book change, not 5 minutes
//
// Why 10 seconds and not 100ms:
//   - Our crypto_price strategy uses CoinGecko/Binance spot prices
//     which update every 1-5 seconds, not every book tick
//   - Evaluating faster than our price feed refreshes = no new info
//   - 10-second cadence is 30x faster than the 5-min cycle while
//     staying within our data freshness window
//   - When we upgrade to the Tier 2 (colocated + direct Binance WS),
//     we can lower this to 1-2 seconds

import type { EntityManager } from '../entity/entity-manager.js';
import type { StrategyRegistry } from '../strategy/strategy-registry.js';
import type { MarketCache } from '../market/market-cache.js';
import type { RiskEngine } from '../risk/risk-engine.js';
import type { ClobRouter } from '../execution/clob-router.js';
import type { RiskLimits, Signal, MarketData, Position } from '../types/index.js';
import type { StrategyContext } from '../strategy/strategy-interface.js';
import type { OrderBookSnapshot } from '../types/index.js';
import { buildOrder } from '../execution/order-builder.js';
import { getOpenPositions as getOpenPositionsRepo } from '../storage/repositories/position-repo.js';
import { getSignalsByStrategy } from '../storage/repositories/signal-repo.js';
import { eventBus } from './event-bus.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('fast-crypto-evaluator');

const MIN_EVAL_INTERVAL_MS = 10_000; // 10 seconds between re-evaluations per market
const BTC_KEYWORDS = ['bitcoin', 'btc', 'up or down'];

export interface FastCryptoEvaluatorDeps {
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

export class FastCryptoEvaluator {
  private lastEvalAt = new Map<string, number>(); // token_id → timestamp
  private running = false;
  private evalCount = 0;
  private signalCount = 0;
  private orderCount = 0;

  constructor(private deps: FastCryptoEvaluatorDeps) {}

  /**
   * Start listening for orderbook:snapshot events. The existing
   * OrderbookWebSocket already subscribes to BTC markets and emits
   * these events — we just hook into the event bus.
   */
  start(): void {
    eventBus.on('orderbook:snapshot', (payload) => {
      // Only process BTC markets
      const market = this.findMarketByToken(payload.token_id);
      if (!market) return;
      if (!this.isBtcMarket(market)) return;

      // Rate limit: don't re-evaluate the same market more than once per interval
      const now = Date.now();
      const lastEval = this.lastEvalAt.get(payload.token_id) ?? 0;
      if (now - lastEval < MIN_EVAL_INTERVAL_MS) return;

      this.lastEvalAt.set(payload.token_id, now);
      this.evaluateMarket(market, payload.book).catch(err => {
        log.debug(
          { err: err instanceof Error ? err.message : String(err), market: market.condition_id.substring(0, 14) },
          'Fast crypto eval failed',
        );
      });
    });

    log.info({ min_eval_interval_ms: MIN_EVAL_INTERVAL_MS }, 'Fast crypto evaluator started — listening for BTC orderbook events');
  }

  private findMarketByToken(tokenId: string): MarketData | null {
    // Check both YES and NO token IDs across the market cache
    for (const market of this.deps.marketCache.getAll()) {
      if (market.token_yes_id === tokenId || market.token_no_id === tokenId) {
        return market;
      }
    }
    return null;
  }

  private isBtcMarket(market: MarketData): boolean {
    const q = (market.question ?? '').toLowerCase();
    return BTC_KEYWORDS.some(kw => q.includes(kw));
  }

  private async evaluateMarket(market: MarketData, book: OrderBookSnapshot): Promise<void> {
    if (this.running) return; // prevent re-entrant evaluation
    this.running = true;
    try {
      this.evalCount++;
      const cryptoStrategy = this.deps.strategyRegistry.get('crypto_price');
      if (!cryptoStrategy) return;

      // Run for each active entity that has crypto_price in its strategy list
      for (const entity of this.deps.entityManager.getActiveEntities()) {
        if (entity.is_locked_out) continue;
        const strategyConfigs = (entity.config.strategies ?? []).map(s =>
          typeof s === 'string' ? { strategy_id: s, sub_strategy_ids: undefined } : { strategy_id: s.strategy_id, sub_strategy_ids: s.sub_strategy_ids },
        );
        const hasCrypto = strategyConfigs.some(c => c.strategy_id === 'crypto_price');
        if (!hasCrypto) continue;

        // Build a single-market context
        const ctx = this.buildSingleMarketContext(entity, market);
        if (!cryptoStrategy.shouldRun(ctx)) continue;

        const signals = await cryptoStrategy.evaluate(ctx);
        if (signals.length === 0) continue;

        this.signalCount += signals.length;

        // Process signals through risk engine + order builder
        for (const signal of signals) {
          eventBus.emit('signal:generated', { signal });
          const decision = this.deps.riskEngine.evaluate(signal, entity);
          if (decision.risk_approved && decision.order_request) {
            const order = buildOrder(
              decision,
              entity,
              this.deps.executionConfig.slippage_bps,
              this.deps.executionConfig.bid_premium_pct,
              book, // pass the live book for quality check
            );
            if (order) {
              try {
                const fill = await this.deps.clobRouter.routeOrder(order, entity);
                if (fill) {
                  this.orderCount++;
                  log.info(
                    {
                      entity: entity.config.slug,
                      condition: market.condition_id.substring(0, 14),
                      side: fill.side,
                      price: fill.price,
                      size: fill.size,
                      eval_count: this.evalCount,
                      latency_ms: Date.now() - (this.lastEvalAt.get(market.token_yes_id) ?? Date.now()),
                    },
                    'Fast crypto fill',
                  );
                }
              } catch (err) {
                log.debug(
                  { err: err instanceof Error ? err.message : String(err) },
                  'Fast crypto order routing failed',
                );
              }
            }
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private buildSingleMarketContext(
    entity: import('../types/index.js').EntityState,
    market: MarketData,
  ): StrategyContext {
    const riskLimits = this.deps.riskLimits;
    const marketCache = this.deps.marketCache;

    return {
      entity,
      risk_limits: riskLimits,
      enabled_sub_strategies: undefined,

      getMarketData(conditionId: string): MarketData | undefined {
        return marketCache.get(conditionId);
      },
      getAllMarkets(): MarketData[] {
        return [market];
      },
      getActiveMarkets(): MarketData[] {
        if (!market.active || market.closed) return [];
        if (!market.end_date) return [];
        const now = Date.now();
        const delta = market.end_date.getTime() - now;
        const minMs = (riskLimits.min_hours_to_resolve ?? 0.05) * 60 * 60 * 1000;
        const maxMs = (riskLimits.max_hours_to_resolve ?? 48) * 60 * 60 * 1000;
        if (delta < minMs || delta > maxMs) return [];
        return [market];
      },
      getActiveMarketsInWindow(minHours: number, maxHours: number): MarketData[] {
        if (!market.active || market.closed) return [];
        if (!market.end_date) return [];
        const now = Date.now();
        const delta = market.end_date.getTime() - now;
        if (delta < minHours * 3600000 || delta > maxHours * 3600000) return [];
        return [market];
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

  getStats(): { eval_count: number; signal_count: number; order_count: number } {
    return { eval_count: this.evalCount, signal_count: this.signalCount, order_count: this.orderCount };
  }
}
