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
import { calibratedSideProb } from '../../market/markov-calibration.js';
import { applyScoutOverlay } from '../scout-overlay.js';
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

      // Probability fallback chain (Phase 3, 2026-04-11):
      //   1. own-data base-rate calibrator — Wilson LB from our own resolved
      //      convergence.filtered_high_prob positions, bucketed by entry price.
      //   2. Markov empirical grid — Becker 72.1M-trade industry calibration.
      //      Critical for prod where own-data returns null almost every signal.
      //   3. naive `cp + (1 - cp) * 0.3` — last resort if both sources fail.
      const ownCalibrationFhp = baseRateCalibrator.getBaseRate(this.id, cp, 'filtered_high_prob');
      const markovCalibrationFhp = calibratedSideProb(cp, cs);
      const usingOwnFhp = ownCalibrationFhp !== null;
      const usingMarkovFhp = !usingOwnFhp && Number.isFinite(markovCalibrationFhp);
      const usingCalibrationFhp = usingOwnFhp || usingMarkovFhp;
      const fhpModelProb = Math.min(
        0.99,
        ownCalibrationFhp ??
          (Number.isFinite(markovCalibrationFhp) ? markovCalibrationFhp : cp + (1 - cp) * 0.3),
      );
      const fhpEdge = usingCalibrationFhp ? (fhpModelProb - cp) : ((1 - cp) * 0.5);

      if (
        this.isSubStrategyEnabled(ctx, 'filtered_high_prob') &&
        cp >= 0.65 && cp <= 0.96 &&
        hoursToResolve > 0 && hoursToResolve <= 24 &&
        (m.liquidity ?? 0) >= 10000
      ) {
        const key = `filtered_high_prob:${m.condition_id}`;
        if (!this.recent.has(key)) {
          const overlay = applyScoutOverlay(m.condition_id, cs);
          const sizedUsd = Math.max(1, 10 * overlay.multiplier);
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
            recommended_size_usd: sizedUsd,
            metadata: {
              question: m.question,
              sub_strategy: 'filtered_high_prob',
              hours_to_resolve: hoursToResolve,
              liquidity: m.liquidity,
              using_calibration: usingCalibrationFhp,
              using_own_calibration: usingOwnFhp,
              using_markov_calibration: usingMarkovFhp,
              scout_overlay_multiplier: overlay.multiplier,
              scout_overlay_reason: overlay.reason,
              scout_overlay_scout_id: overlay.scoutId,
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
        // Markov calibration anchored on Becker's empirical grid for the
        // 93-99¢ zone. Grid values in this range: 0.93→~0.928, 0.95→0.9549,
        // 0.97→0.9733, 0.99→0.9915. Slight systematic underpricing on deep
        // favorites per the study's findings. We use the grid for model_prob
        // and compute edge as grid - market_price.
        const ownCalibrationLtg = baseRateCalibrator.getBaseRate(this.id, cp, 'long_term_grind');
        const markovCalibrationLtg = calibratedSideProb(cp, cs);
        const usingOwnLtg = ownCalibrationLtg !== null;
        const usingMarkovLtg = !usingOwnLtg && Number.isFinite(markovCalibrationLtg);
        const ltgModelProb = Math.min(
          0.99,
          ownCalibrationLtg ??
            (Number.isFinite(markovCalibrationLtg) ? markovCalibrationLtg : cp + 0.005),
        );
        const ltgEdge = ltgModelProb - cp;
        const key = `long_term_grind:${m.condition_id}`;
        if (!this.recent.has(key)) {
          const ltgOverlay = applyScoutOverlay(m.condition_id, cs);
          const ltgSizedUsd = Math.max(1, 20 * ltgOverlay.multiplier);
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
            edge: ltgEdge,
            model_prob: ltgModelProb,
            market_price: cp,
            recommended_size_usd: ltgSizedUsd,
            metadata: {
              question: m.question,
              sub_strategy: 'long_term_grind',
              hours_to_resolve: hoursToResolve,
              profit: 1 - cp,
              using_own_calibration: usingOwnLtg,
              using_markov_calibration: usingMarkovLtg,
              scout_overlay_multiplier: ltgOverlay.multiplier,
              scout_overlay_reason: ltgOverlay.reason,
              scout_overlay_scout_id: ltgOverlay.scoutId,
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
