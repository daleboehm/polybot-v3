// Convergence strategy — buy outcomes drifting toward fair value as resolution nears
//
// Sub-strategies:
//   - filtered_high_prob: 65-96% prob, ≥$10k liquidity, <24h to resolution (93% WR per research)
//   - curve_spread: time-decay exploitation on same-event contracts (deferred — needs multi-date lookup)
//   - partition: force sum-to-1 on multi-outcome markets (deferred — needs multi-outcome support)
//   - long_term_grind: enter high-prob markets early, ride drift to fair value

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { baseRateCalibrator } from '../../validation/base-rate-calibrator.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:convergence');
const DEDUP_TTL_MS = 4 * 60 * 60 * 1000;

export class ConvergenceStrategy extends BaseStrategy {
  readonly id = 'convergence';
  readonly name = 'Convergence';
  readonly description = 'Buy outcomes converging to fair value — filtered and long-term variants';
  readonly version = '3.0.0';

  private recent = new Map<string, number>();

  override getSubStrategies(): string[] {
    return ['filtered_high_prob', 'long_term_grind'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();

    const signals: Signal[] = [];
    const now = Date.now();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id)
    );

    // Two separate market lists because the two subs inherently need
    // different time horizons:
    //   - filtered_high_prob: 0-24h (near-resolution drift capture)
    //   - long_term_grind:    2-720h (up to 30 days — bypasses the global 1-48h
    //                         R&D window so long-drift markets aren't filtered out)
    const nearMarkets = ctx.getActiveMarketsInWindow(0, 24);
    const longMarkets = ctx.getActiveMarketsInWindow(2, 30 * 24);

    // ─── sub: filtered_high_prob (93% WR in research) ───
    // 65-96% prob, <24h to resolution, sufficient liquidity
    for (const m of nearMarkets) {
      if (existingPositions.has(m.condition_id)) continue;
      if (!m.active || m.closed || !m.yes_price || !m.no_price) continue;

      const endTime = m.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (hoursToResolve < 0) continue;

      // Find the high-prob side
      let cp: number, cs: 'YES' | 'NO', ct: string;
      if (m.yes_price >= m.no_price) {
        cp = m.yes_price; cs = 'YES'; ct = m.token_yes_id;
      } else {
        cp = m.no_price; cs = 'NO'; ct = m.token_no_id;
      }

      // R2 PR#1: calibrate model_prob from resolved convergence positions in this
      // bucket (2026-04-10 base-rate-calibrator). Fallback to the old heuristic
      // when insufficient data, but log that the signal is using fallback so the
      // advisor can de-rate it vs calibrated signals.
      const calibratedProbFhp = baseRateCalibrator.getBaseRate(this.id, cp, 'filtered_high_prob');
      const usingCalibrationFhp = calibratedProbFhp !== null;
      const fhpModelProb = calibratedProbFhp ?? Math.min(0.99, cp + (1 - cp) * 0.3);
      const fhpEdge = usingCalibrationFhp ? (fhpModelProb - cp) : ((1 - cp) * 0.5);

      if (
        this.isSubStrategyEnabled(ctx, 'filtered_high_prob') &&
        cp >= 0.65 && cp <= 0.96 &&
        hoursToResolve > 0 && hoursToResolve <= 24 &&
        (m.liquidity ?? 0) >= 10000
      ) {
        const key = `filtered_high_prob:${m.condition_id}`;
        if (!this.recent.has(key)) {
          signals.push({
            signal_id: nanoid(),
            entity_slug: ctx.entity.config.slug,
            strategy_id: this.id,
            sub_strategy_id: 'filtered_high_prob',
            condition_id: m.condition_id,
            token_id: ct,
            side: 'BUY',
            outcome: cs,
            strength: 0.9,
            edge: fhpEdge,
            model_prob: fhpModelProb,
            market_price: cp,
            recommended_size_usd: 10,
            metadata: {
              question: m.question,
              sub_strategy: 'filtered_high_prob',
              hours_to_resolve: hoursToResolve,
              liquidity: m.liquidity,
              using_calibration: usingCalibrationFhp,
            },
            created_at: new Date(),
          });
          this.recent.set(key, now);
        }
      }
    }

    // ─── sub: long_term_grind (enter 93-99¢ early, ride to fair value) ───
    // Uses the expanded 2h-30d window so we can actually find long-drift markets.
    for (const m of longMarkets) {
      if (existingPositions.has(m.condition_id)) continue;
      if (!m.active || m.closed || !m.yes_price || !m.no_price) continue;

      const endTime = m.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (hoursToResolve < 0) continue;

      let cp: number, cs: 'YES' | 'NO', ct: string;
      if (m.yes_price >= m.no_price) {
        cp = m.yes_price; cs = 'YES'; ct = m.token_yes_id;
      } else {
        cp = m.no_price; cs = 'NO'; ct = m.token_no_id;
      }

      if (
        this.isSubStrategyEnabled(ctx, 'long_term_grind') &&
        cp >= 0.93 && cp <= 0.99 &&
        hoursToResolve > 2 && hoursToResolve <= 30 * 24
      ) {
        const key = `long_term_grind:${m.condition_id}`;
        if (!this.recent.has(key)) {
          signals.push({
            signal_id: nanoid(),
            entity_slug: ctx.entity.config.slug,
            strategy_id: this.id,
            sub_strategy_id: 'long_term_grind',
            condition_id: m.condition_id,
            token_id: ct,
            side: 'BUY',
            outcome: cs,
            strength: cp,
            edge: 1 - cp,
            model_prob: Math.min(0.99, cp + 0.005),
            market_price: cp,
            recommended_size_usd: 20,
            metadata: {
              question: m.question,
              sub_strategy: 'long_term_grind',
              hours_to_resolve: hoursToResolve,
              profit: 1 - cp,
            },
            created_at: new Date(),
          });
          this.recent.set(key, now);
        }
      }
    }

    if (signals.length > 0) {
      const bySub = signals.reduce((acc, s) => {
        acc[s.sub_strategy_id ?? 'unknown'] = (acc[s.sub_strategy_id ?? 'unknown'] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      log.info({ count: signals.length, by_sub: bySub }, 'Convergence signals');
    }
    return signals;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, ts] of this.recent.entries()) {
      if (now - ts > DEDUP_TTL_MS) this.recent.delete(key);
    }
  }
}
