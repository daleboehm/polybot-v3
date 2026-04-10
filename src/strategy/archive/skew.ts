// Skew strategy — fade extreme consensus (buy underdog when market >85% skewed)
//
// Sub-strategies:
//   - probability_skew: legacy logic (underdog 3-15¢ when favorite >85%)
//   - orderbook_liquidity_skew: deferred — requires orderbook depth data

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:skew');
const DEDUP_TTL_MS = 4 * 60 * 60 * 1000;

export class SkewStrategy extends BaseStrategy {
  readonly id = 'skew';
  readonly name = 'Skew';
  readonly description = 'Fade extreme consensus — buy underdog when market >85% skewed';
  readonly version = '3.0.0';

  private recent = new Map<string, number>();

  override getSubStrategies(): string[] {
    return ['probability_skew'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();

    const signals: Signal[] = [];
    const now = Date.now();

    if (!this.isSubStrategyEnabled(ctx, 'probability_skew')) return signals;

    for (const m of ctx.getActiveMarkets()) {
      const key = `probability_skew:${m.condition_id}`;
      if (this.recent.has(key)) continue;
      if (!m.active || m.closed || !m.yes_price || !m.no_price) continue;

      let up: number, us: 'YES' | 'NO', ut: string;
      if (m.yes_price > 0.85 && m.no_price >= 0.03 && m.no_price <= 0.15) {
        up = m.no_price; us = 'NO'; ut = m.token_no_id;
      } else if (m.no_price > 0.85 && m.yes_price >= 0.03 && m.yes_price <= 0.15) {
        up = m.yes_price; us = 'YES'; ut = m.token_yes_id;
      } else continue;

      signals.push({
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'probability_skew',
        condition_id: m.condition_id,
        token_id: ut,
        side: 'BUY',
        outcome: us,
        strength: Math.min(1, (1 - up) / up / 15),
        edge: up * 0.5,
        model_prob: up * 1.5,
        market_price: up,
        recommended_size_usd: 10,
        metadata: {
          question: m.question,
          skew: Math.max(m.yes_price, m.no_price),
          sub_strategy: 'probability_skew',
        },
        created_at: new Date(),
      });
      this.recent.set(key, now);
    }
    if (signals.length > 0) log.info({ count: signals.length }, 'Skew signals');
    return signals;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [k, ts] of this.recent.entries()) {
      if (now - ts > DEDUP_TTL_MS) this.recent.delete(k);
    }
  }
}
