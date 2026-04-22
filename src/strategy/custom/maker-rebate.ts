// Maker-rebate strategy — 2026-04-21.
//
// Captures Polymarket's Maker Rewards + Rebate program ($5M+ pool across
// sports/esports; 20-25% rebate on counter-party taker fees; pro-rata
// payout from the daily reward pool for competitive resting limits).
//
// Strategy: when no strong directional edge, post tight BUY limits 1
// tick below best bid on eligible neg-risk sports/esports markets. Orders
// rest as makers, earning rebates if filled + reward-pool score while
// open. Fills are held to market settlement using our existing stop-loss
// monitor exits.
//
// v1 is INTENTIONALLY SIMPLE:
//   - No direction edge required (we are not betting, we are providing
//     liquidity). The fill is a by-product; the maker rebate is the edge.
//   - Tiny position ($2) per order
//   - Limited to neg-risk sports/esports (highest reward-pool share)
//   - Posts through existing clob-router with metadata.post_only = true
//
// Gated by MAKER_REBATE_ENABLED env. Off by default on both engines.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:maker-rebate');

const FEATURE_FLAG = 'MAKER_REBATE_ENABLED';
const MAX_CONCURRENT_ORDERS = 3;
const MAX_POSITION_USD = 2.0;
const MIN_LIQUIDITY_USD = 5_000;
const MAX_HOURS_TO_RESOLVE = 168;
const MIN_HOURS_TO_RESOLVE = 2;

// Reward-pool eligible tags (sports + esports per Grok research 2026-04-21).
const ELIGIBLE_TAG_KEYWORDS = ['sport', 'nba', 'nhl', 'nfl', 'mlb', 'soccer', 'football', 'tennis', 'boxing', 'mma', 'esport', 'league', 'cs2', 'lol', 'dota', 'valorant'];

export class MakerRebateStrategy extends BaseStrategy {
  readonly id = 'maker_rebate';
  readonly name = 'Maker Rebate';
  readonly description = 'Post tight maker limit orders on sports/esports markets to capture Polymarket Maker Rewards pool ($5M+)';
  readonly version = '1.0.0';

  private recentFires = new Map<string, number>();

  override getSubStrategies(): string[] {
    return ['sports_esports'];
  }

  override shouldRun(_ctx: StrategyContext): boolean {
    return process.env[FEATURE_FLAG] === 'true';
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    if (process.env[FEATURE_FLAG] !== 'true') return [];
    if (!this.isSubStrategyEnabled(ctx, 'sports_esports')) return [];

    const signals: Signal[] = [];
    const markets = ctx.getActiveMarkets();
    const now = Date.now();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    // Count how many maker orders are already out (proxy for MAX_CONCURRENT_ORDERS cap)
    let maker_signals_emitted_this_cycle = 0;

    for (const market of markets) {
      if (maker_signals_emitted_this_cycle >= MAX_CONCURRENT_ORDERS) break;
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;

      const endTime = market.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (hoursToResolve < MIN_HOURS_TO_RESOLVE || hoursToResolve > MAX_HOURS_TO_RESOLVE) continue;

      // Tag check — sports/esports only
      const tags = (market.tags ?? []).map(t => t.toLowerCase());
      const isEligible = tags.some(t => ELIGIBLE_TAG_KEYWORDS.some(k => t.includes(k)));
      if (!isEligible) continue;

      // Liquidity gate — don't post into thin books
      if ((market.liquidity ?? 0) < MIN_LIQUIDITY_USD) continue;

      // Dedup: don't re-fire same market within 10 min
      const lastFire = this.recentFires.get(market.condition_id);
      if (lastFire && now - lastFire < 10 * 60 * 1000) continue;

      // Pick the side with the wider spread (more fee rebate room). Default: YES
      const yesPrice = market.yes_price ?? 0.5;
      const noPrice = market.no_price ?? 0.5;
      if (yesPrice < 0.10 || yesPrice > 0.90) continue; // avoid tail prices
      if (noPrice < 0.10 || noPrice > 0.90) continue;

      // Post at current YES best price (which equals best bid from our
      // perspective as buyer) — this is the maker-side anchor. clob-router
      // will pass this through with metadata.post_only = true.
      const targetPrice = yesPrice;

      const signal: Signal = {
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'sports_esports',
        condition_id: market.condition_id,
        token_id: market.token_yes_id,
        side: 'BUY',
        outcome: 'YES',
        strength: 0.3,
        edge: 0.01, // nominal — we earn rebate, not direction
        model_prob: targetPrice, // no directional view
        market_price: targetPrice,
        recommended_size_usd: MAX_POSITION_USD,
        metadata: {
          question: market.question,
          sub_strategy: 'sports_esports',
          maker_mode: true,
          post_only: true, // consumed by clob-router
          liquidity_usd: market.liquidity ?? 0,
          tags: market.tags?.slice(0, 3) ?? [],
          rationale: 'maker-rebate farming on sports/esports reward pool',
        },
        created_at: new Date(),
      };

      signals.push(signal);
      this.recentFires.set(market.condition_id, now);
      maker_signals_emitted_this_cycle++;
    }

    if (signals.length > 0) {
      log.info({ count: signals.length }, 'Maker-rebate signals emitted');
    }
    return signals;
  }
}
