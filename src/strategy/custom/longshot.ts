// Longshot strategy — FADE low-probability outcomes (research shows longshots resolve 14% vs 10% implied).
// We BUY the opposite high-prob side, not the cheap tail.
//
// Sub-strategies:
//   - systematic_fade: blanket fade any <20¢ tail (buy the 80%+ side)
//   - bucketed_fade: only fade 5-20¢ range (peak prospect-theory bias)
//   - news_overreaction_fade: fade recent hype-driven extreme tails

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { baseRateCalibrator } from '../../validation/base-rate-calibrator.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:longshot');
const DEDUP_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — prevents re-entry on same market

export class LongshotStrategy extends BaseStrategy {
  readonly id = 'longshot';
  readonly name = 'Longshot';
  readonly description = 'Fade low-probability outcomes — buy the high-prob side instead';
  readonly version = '3.0.0';

  private recent = new Map<string, number>(); // `${subId}:${conditionId}` -> timestamp

  override getSubStrategies(): string[] {
    return ['systematic_fade', 'bucketed_fade', 'news_overreaction_fade'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();

    const signals: Signal[] = [];
    // 2026-04-10 contamination fix: check the DB for positions already open
    // on each market's condition_id BEFORE generating a fresh signal. Without
    // this, longshot would fire on markets where favorites (or any other
    // strategy) already held a position, and the subsequent fill's upsertPosition
    // would overwrite the original strategy_id/sub_strategy_id. favorites.ts
    // and convergence.ts already have this check; longshot was the odd one out.
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    // Per-market precedence set — audit A-P1-10 fix (2026-04-10). Prevents the
    // same market from firing 3 longshot subs in the same cycle (which would
    // consume 3x the position cap for one opportunity). Priority order:
    // news_overreaction_fade > bucketed_fade > systematic_fade.
    const firedThisCycle = new Set<string>();

    for (const m of ctx.getActiveMarkets()) {
      if (existingPositions.has(m.condition_id)) continue;
      if (!m.active || m.closed || !m.yes_price || !m.no_price) continue;

      // Find the longshot (tail) side and the high-prob (fade) side
      // Tail = the cheap side; we want to BUY the expensive/high-prob side
      const tailIsYes = m.yes_price < m.no_price;
      const tailPrice = tailIsYes ? m.yes_price : m.no_price;
      const fadePrice = tailIsYes ? m.no_price : m.yes_price;
      const fadeSide: 'YES' | 'NO' = tailIsYes ? 'NO' : 'YES';
      const fadeTokenId = tailIsYes ? m.token_no_id : m.token_yes_id;

      // Skip if tail is not actually cheap (not a longshot market)
      if (tailPrice >= 0.20 || tailPrice < 0.02) continue;
      // Skip if fade side is too expensive (not enough room for profit)
      if (fadePrice > 0.98) continue;

      // R2 PR#1 base-rate calibration: prefer empirical Wilson LB from resolved
      // fade positions in this fade-price bucket. Falls back to the old
      // `impliedProb + 0.04` heuristic when insufficient history.
      const calibratedProb = baseRateCalibrator.getBaseRate(this.id, fadePrice);
      const usingCalibration = calibratedProb !== null;
      const expectedEdge = 0.04; // ~4% statistical edge from fading longshot bias (fallback)
      const impliedProb = fadePrice;
      const modelProb = calibratedProb ?? Math.min(0.99, impliedProb + expectedEdge);

      // Precedence check: if any higher-priority sub already fired on this market
      // this cycle, skip the lower-priority subs. Priority (highest first):
      //   news_overreaction_fade > bucketed_fade > systematic_fade
      //
      // news_overreaction_fade — tails between 10-20¢ (assumed news-driven hype)
      if (
        tailPrice >= 0.10 && tailPrice <= 0.20 &&
        this.isSubStrategyEnabled(ctx, 'news_overreaction_fade') &&
        !firedThisCycle.has(m.condition_id)
      ) {
        const key = `news_overreaction_fade:${m.condition_id}`;
        if (!this.recent.has(key)) {
          signals.push(
            this.buildFadeSignal(ctx, m, 'news_overreaction_fade', fadeSide, fadeTokenId, fadePrice, tailPrice, modelProb, expectedEdge, 0.6, usingCalibration),
          );
          this.recent.set(key, Date.now());
          firedThisCycle.add(m.condition_id);
        }
      }

      // bucketed_fade — only tails in 5-20¢ range (peak bias zone per prospect theory)
      if (
        tailPrice >= 0.05 && tailPrice <= 0.20 &&
        this.isSubStrategyEnabled(ctx, 'bucketed_fade') &&
        !firedThisCycle.has(m.condition_id)
      ) {
        const key = `bucketed_fade:${m.condition_id}`;
        if (!this.recent.has(key)) {
          const bucketedModelProb = calibratedProb ?? Math.min(0.99, impliedProb + expectedEdge * 1.5);
          signals.push(
            this.buildFadeSignal(ctx, m, 'bucketed_fade', fadeSide, fadeTokenId, fadePrice, tailPrice, bucketedModelProb, expectedEdge * 1.5, 0.7, usingCalibration),
          );
          this.recent.set(key, Date.now());
          firedThisCycle.add(m.condition_id);
        }
      }

      // systematic_fade — any tail <20¢ (lowest priority)
      if (
        this.isSubStrategyEnabled(ctx, 'systematic_fade') &&
        !firedThisCycle.has(m.condition_id)
      ) {
        const key = `systematic_fade:${m.condition_id}`;
        if (!this.recent.has(key)) {
          signals.push(
            this.buildFadeSignal(ctx, m, 'systematic_fade', fadeSide, fadeTokenId, fadePrice, tailPrice, modelProb, expectedEdge, 0.5, usingCalibration),
          );
          this.recent.set(key, Date.now());
          firedThisCycle.add(m.condition_id);
        }
      }
    }

    if (signals.length > 0) {
      const bySub = signals.reduce((acc, s) => {
        acc[s.sub_strategy_id ?? 'unknown'] = (acc[s.sub_strategy_id ?? 'unknown'] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      log.info({ count: signals.length, by_sub: bySub }, 'Longshot fade signals generated');
    }

    return signals;
  }

  private buildFadeSignal(
    ctx: StrategyContext,
    m: { condition_id: string; question: string; yes_price: number; no_price: number; token_yes_id: string; token_no_id: string },
    subStrategyId: string,
    fadeSide: 'YES' | 'NO',
    fadeTokenId: string,
    fadePrice: number,
    tailPrice: number,
    modelProb: number,
    fallbackEdge: number,
    strength: number,
    usingCalibration: boolean,
  ): Signal {
    const clampedModelProb = Math.min(0.99, modelProb);
    // Real edge = calibrated prob - market price. Fallback uses the heuristic
    // edge constant when calibration has insufficient data.
    const edge = usingCalibration ? (clampedModelProb - fadePrice) : fallbackEdge;
    return {
      signal_id: nanoid(),
      entity_slug: ctx.entity.config.slug,
      strategy_id: this.id,
      sub_strategy_id: subStrategyId,
      condition_id: m.condition_id,
      token_id: fadeTokenId,
      side: 'BUY',
      outcome: fadeSide,
      strength,
      edge,
      model_prob: clampedModelProb,
      market_price: fadePrice,
      recommended_size_usd: 5,
      metadata: {
        question: m.question,
        tail_price: tailPrice,
        sub_strategy: subStrategyId,
        using_calibration: usingCalibration,
      },
      created_at: new Date(),
    };
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, ts] of this.recent.entries()) {
      if (now - ts > DEDUP_TTL_MS) {
        this.recent.delete(key);
      }
    }
  }
}
