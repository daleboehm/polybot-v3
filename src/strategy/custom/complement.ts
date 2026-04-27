// Complement (arbitrage) strategy — buy both YES and NO when combined < $0.96
// V1 logic: If YES + NO < $1.00 (minus fees), buying both guarantees profit on resolution.
// This is mathematical arbitrage — one side always pays $1, and you paid less than $1 total.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal, MarketData } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:complement');

const CONFIG = {
  // Threshold tightened 0.96→0.95 for V2 fee safety.
  // Fee drag: both YES + NO legs each pay feeRate×p×(1-p).
  // At p=0.5, fee = 2 × 0.02 × 0.25 = 1% on the combined purchase.
  // $0.95 combined → gross profit $0.05 → net profit after ~$0.01 fee = $0.04 = 4.2%.
  max_combined: 0.95,
  min_side_price: 0.01,    // Both sides must have meaningful price
  max_side_price: 0.99,    // Neither side near $1
  min_profit_pct: 0.02,    // Minimum 2% profit after fees (taker ~2% per leg)
  dedup_minutes: 240,      // Don't re-arb same market within 4 hours
};

export class ComplementStrategy extends BaseStrategy {
  readonly id = 'complement';
  readonly name = 'Complement Arbitrage';
  readonly description = 'Buy both YES and NO when combined price < $0.96 for guaranteed profit';
  readonly version = '3.2.0';

  private recentTrades = new Map<string, number>();

  override getSubStrategies(): string[] {
    return ['intra_market_arb'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    if (!this.isSubStrategyEnabled(ctx, 'intra_market_arb')) return signals;
    const markets = ctx.getActiveMarkets();
    const now = Date.now();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id)
    );

    for (const market of markets) {
      // Skip if we already have a position in this market
      if (existingPositions.has(market.condition_id)) continue;

      // Dedup
      const lastTrade = this.recentTrades.get(market.condition_id);
      if (lastTrade && (now - lastTrade) < CONFIG.dedup_minutes * 60 * 1000) continue;

      if (!market.active || market.closed) continue;

      // STRICT: Must have a valid end_date within 48 hours — no long-dated markets
      const endTime = market.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (isNaN(hoursToResolve) || hoursToResolve < 0 || hoursToResolve > 48) continue;

      const yesPrice = market.yes_price;
      const noPrice = market.no_price;

      if (!yesPrice || !noPrice) continue;
      if (yesPrice < CONFIG.min_side_price || noPrice < CONFIG.min_side_price) continue;
      if (yesPrice > CONFIG.max_side_price || noPrice > CONFIG.max_side_price) continue;

      const combined = yesPrice + noPrice;

      // The arb condition: combined < threshold
      if (combined >= CONFIG.max_combined || combined <= 0) continue;

      // Profit calculation: pay (combined), receive $1 on resolution
      // Net profit per $1 deployed = (1 - combined) / combined
      const profitPct = (1.0 - combined) / combined;

      // Must exceed fee drag (~2% taker each side = ~4% round trip, but we only buy)
      if (profitPct < CONFIG.min_profit_pct) continue;

      // YES leg — buy YES side of the arb
      const yesSignal: Signal = {
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'intra_market_arb',
        condition_id: market.condition_id,
        token_id: market.token_yes_id,
        side: 'BUY',
        outcome: 'YES',
        strength: Math.min(1, profitPct * 10),
        edge: profitPct,
        model_prob: 0.95,
        market_price: yesPrice,
        recommended_size_usd: 10,
        metadata: {
          question: market.question,
          market_slug: market.market_slug,
          yes_price: yesPrice,
          no_price: noPrice,
          combined: Math.round(combined * 10000) / 10000,
          profit_pct: Math.round(profitPct * 10000) / 10000,
          arb_type: 'complement',
          arb_leg: 'YES',
          pair_id: market.condition_id,          // links YES+NO of SAME condition (intentionally identical on both legs — not a cross-market link)
          submission_ts: now,                    // signal generation time (not fill time) — latency reference anchor only
          spread_at_submission: combined,        // for post-mortem fill analysis
        },
        created_at: new Date(),
      };

      // NO leg — mandatory second leg; without it this is directional, not arb
      const noSignal: Signal = {
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'intra_market_arb',
        condition_id: market.condition_id,
        token_id: market.token_no_id,
        side: 'BUY',
        outcome: 'NO',
        strength: Math.min(1, profitPct * 10),
        edge: profitPct,
        model_prob: 0.95,
        market_price: noPrice,
        recommended_size_usd: 10,
        metadata: {
          question: market.question,
          market_slug: market.market_slug,
          yes_price: yesPrice,
          no_price: noPrice,
          combined: Math.round(combined * 10000) / 10000,
          profit_pct: Math.round(profitPct * 10000) / 10000,
          arb_type: 'complement',
          arb_leg: 'NO',
          pair_id: market.condition_id,          // links YES+NO of SAME condition (intentionally identical on both legs — not a cross-market link)
          submission_ts: now,                    // signal generation time (not fill time) — latency reference anchor only
          spread_at_submission: combined,        // for post-mortem fill analysis
        },
        created_at: new Date(),
      };

      signals.push(yesSignal, noSignal);
      this.recentTrades.set(market.condition_id, now);

      log.info({
        market: market.question.substring(0, 50),
        yes: yesPrice,
        no: noPrice,
        combined: combined.toFixed(4),
        profit: (profitPct * 100).toFixed(2) + '%',
        legs: 2,
      }, 'Complement arb signal — both legs');
    }

    if (signals.length > 0) {
      log.info({ count: signals.length }, 'Complement signals generated');
    }

    return signals;
  }

  shouldRun(_ctx: StrategyContext): boolean {
    const cutoff = Date.now() - (8 * 60 * 60 * 1000);
    for (const [key, ts] of this.recentTrades) {
      if (ts < cutoff) this.recentTrades.delete(key);
    }
    return true;
  }
}
