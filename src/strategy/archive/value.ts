// Value strategy — positive EV when model prob > market implied prob
//
// Sub-strategies:
//   - statistical_model: legacy heuristic (20-50¢ with payoff > 1)
//   - positive_ev_grind: same range but tighter edge requirement
//   - brier_calibrated: placeholder (requires historical calibration data)

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:value');
const DEDUP_TTL_MS = 4 * 60 * 60 * 1000;

export class ValueStrategy extends BaseStrategy {
  readonly id = 'value';
  readonly name = 'Value';
  readonly description = 'Positive EV trades — multiple sub-strategies for different edge regimes';
  readonly version = '3.0.0';

  private recent = new Map<string, number>();

  override getSubStrategies(): string[] {
    return ['statistical_model', 'positive_ev_grind'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();

    const signals: Signal[] = [];
    const now = Date.now();

    for (const m of ctx.getActiveMarkets()) {
      if (!m.active || m.closed || !m.yes_price || !m.no_price) continue;

      const endTime = m.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (hoursToResolve < 0 || hoursToResolve > 48) continue;

      for (const [price, side, tid] of [
        [m.yes_price, 'YES', m.token_yes_id],
        [m.no_price, 'NO', m.token_no_id],
      ] as const) {
        if (price < 0.20 || price > 0.50) continue;
        const payoff = (1 - price) / price;
        if (payoff < 1) continue;

        // ─── sub: statistical_model (legacy) ───
        if (this.isSubStrategyEnabled(ctx, 'statistical_model')) {
          const key = `statistical_model:${m.condition_id}:${side}`;
          if (!this.recent.has(key)) {
            signals.push({
              signal_id: nanoid(),
              entity_slug: ctx.entity.config.slug,
              strategy_id: this.id,
              sub_strategy_id: 'statistical_model',
              condition_id: m.condition_id,
              token_id: tid,
              side: 'BUY',
              outcome: side as 'YES' | 'NO',
              strength: Math.min(1, payoff / 4),
              edge: payoff * 0.1,
              model_prob: price + 0.05,
              market_price: price,
              recommended_size_usd: 10,
              metadata: { question: m.question, payoff, sub_strategy: 'statistical_model' },
              created_at: new Date(),
            });
            this.recent.set(key, now);
          }
        }

        // ─── sub: positive_ev_grind (stricter edge) ───
        if (this.isSubStrategyEnabled(ctx, 'positive_ev_grind') && payoff >= 2) {
          const key = `positive_ev_grind:${m.condition_id}:${side}`;
          if (!this.recent.has(key)) {
            signals.push({
              signal_id: nanoid(),
              entity_slug: ctx.entity.config.slug,
              strategy_id: this.id,
              sub_strategy_id: 'positive_ev_grind',
              condition_id: m.condition_id,
              token_id: tid,
              side: 'BUY',
              outcome: side as 'YES' | 'NO',
              strength: Math.min(1, payoff / 3),
              edge: payoff * 0.15,
              model_prob: price + 0.08,
              market_price: price,
              recommended_size_usd: 10,
              metadata: { question: m.question, payoff, sub_strategy: 'positive_ev_grind' },
              created_at: new Date(),
            });
            this.recent.set(key, now);
          }
        }

        break;
      }
    }

    if (signals.length > 0) {
      const bySub = signals.reduce((acc, s) => {
        acc[s.sub_strategy_id ?? 'unknown'] = (acc[s.sub_strategy_id ?? 'unknown'] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      log.info({ count: signals.length, by_sub: bySub }, 'Value signals');
    }
    return signals;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [k, ts] of this.recent.entries()) {
      if (now - ts > DEDUP_TTL_MS) this.recent.delete(k);
    }
  }
}
