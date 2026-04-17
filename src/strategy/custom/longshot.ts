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
import { calibratedSideProb, longshotBiasMultiplier, preferredExecutionModeForTail } from '../../market/markov-calibration.js';
import { applyScoutOverlay } from '../scout-overlay.js';
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

  /**
   * G3 (2026-04-15): longshot is the strategy family that blew up prod on
   * 2026-04-13 (43.8% daily drawdown). R&D on identical code is flat-to-up
   * on the same market set, so there's a paper-to-live divergence we have
   * not isolated yet. Until we do, longshot must NOT run on live entities.
   *
   * Gate logic:
   *   - Paper entities: always allowed (R&D needs to keep collecting data
   *     so we can identify the divergence).
   *   - Live entities: only runs when env LONGSHOT_LIVE_ENABLED === 'true'.
   *     Default is unset → blocked. Requires deliberate operator action
   *     (set env var + restart) to re-arm on live, in addition to whatever
   *     SIGUSR2 release and portfolio-cap work unblocks the rest of the
   *     recap-day gate list.
   *
   * This is belt-and-suspenders on top of the yaml strategy list. Even if
   * an operator adds 'longshot' to a live entity's strategies array by
   * mistake, shouldRun returns false and evaluate never runs.
   */
  override shouldRun(ctx: StrategyContext): boolean {
    if (ctx.entity.config.mode === 'paper') return true;
    return process.env.LONGSHOT_LIVE_ENABLED === 'true';
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

      // R2 PR#1 + Phase 3 (2026-04-11) base-rate calibration:
      // Order of precedence:
      //   1. Wilson LB from our own resolved fade positions (best — calibrated
      //      to OUR strategy performance)
      //   2. Markov empirical lookup from Becker's 72.1M-trade study (better
      //      than a blanket 4% heuristic — captures the real longshot bias
      //      curve at different price levels)
      //   3. Naive `impliedProb + 0.04` (last resort, kept for safety)
      const ownCalibration = baseRateCalibrator.getBaseRate(this.id, fadePrice);
      // Symmetry audit fix (2026-04-15): we want the probability of the FADE
      // side (expensive) resolving IN ITS OWN FAVOR — not the YES rate at this
      // price. When fadeSide === 'NO', calibratedYesProb(fadePrice) asks the
      // wrong question ("YES rate at no_price") and only agrees with the right
      // answer because the Becker grid is near-symmetric. calibratedSideProb
      // routes to the correct lookup branch. Numerical delta is <0.4% at
      // tested prices, but the intent is now explicit. See
      // docs/symmetry-audit-2026-04-15.md §longshot.ts.
      const markovCalibration = calibratedSideProb(fadePrice, fadeSide);
      const usingCalibration = ownCalibration !== null;
      const expectedEdge = 0.04; // legacy heuristic fallback if Markov also unavailable
      const impliedProb = fadePrice;
      const modelProb = ownCalibration ?? markovCalibration ?? Math.min(0.99, impliedProb + expectedEdge);

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
          // bucketed_fade uses a wider fallback edge because 5-20¢ is peak
          // bias territory. Fallback chain mirrors the top block.
          const bucketedModelProb = ownCalibration ?? markovCalibration ?? Math.min(0.99, impliedProb + expectedEdge * 1.5);
          signals.push(
            this.buildFadeSignal(ctx, m, 'bucketed_fade', fadeSide, fadeTokenId, fadePrice, tailPrice, bucketedModelProb, expectedEdge * 1.5, 0.7, usingCalibration),
          );
          this.recent.set(key, Date.now());
          firedThisCycle.add(m.condition_id);
        }
      }

      // systematic_fade — any tail <20¢ (lowest priority)
      //
      // 2026-04-16 Kelly-boundary fix: the broad 0.80-0.98 fade range pools
      // profitable 0.80-0.90 trades with unprofitable 0.90-0.98 trades where
      // breakeven WR exceeds achievable WR. Two surgical gates:
      //   1. Edge floor: require model edge ≥ 3¢ (filters dead-band entries
      //      where calibrated edge is already small).
      //   2. Size scaling: fadeKellyScale = (1 - fadePrice) / 0.20, clamped
      //      to [0,1]. Scales sizing from full at 0.80 fade → zero at 1.00.
      //      Absolute skip when scale is 0 (fadePrice ≥ 1.0 — not reachable
      //      in practice but defensive).
      // Applied to systematic_fade ONLY. bucketed_fade (5-20¢ tails) and
      // news_overreaction_fade (10-20¢ tails) already have narrower
      // implicit ranges and stay on the original sizing curve.
      if (
        this.isSubStrategyEnabled(ctx, 'systematic_fade') &&
        !firedThisCycle.has(m.condition_id)
      ) {
        const edgeForFilter = usingCalibration ? (Math.min(0.99, modelProb) - fadePrice) : expectedEdge;
        const fadeKellyScale = Math.max(0, Math.min(1, (1 - fadePrice) / 0.20));
        if (edgeForFilter >= 0.03 && fadeKellyScale > 0) {
          const key = `systematic_fade:${m.condition_id}`;
          if (!this.recent.has(key)) {
            signals.push(
              this.buildFadeSignal(ctx, m, 'systematic_fade', fadeSide, fadeTokenId, fadePrice, tailPrice, modelProb, expectedEdge, 0.5, usingCalibration, fadeKellyScale),
            );
            this.recent.set(key, Date.now());
            firedThisCycle.add(m.condition_id);
          }
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
    // 2026-04-16 Kelly-boundary fix: optional size multiplier for
    // systematic_fade (1.0 = full size, 0.0 = skip). Other subs call without
    // this parameter and stay on the original sizing curve.
    kellyScale: number = 1,
  ): Signal {
    const clampedModelProb = Math.min(0.99, modelProb);
    // Real edge = calibrated prob - market price. Fallback uses the heuristic
    // edge constant when calibration has insufficient data.
    const edge = usingCalibration ? (clampedModelProb - fadePrice) : fallbackEdge;
    // Phase 3 (2026-04-11): apply the Markov/Becker longshot-bias multiplier
    // to the base size. Shrinks YES exposure on deep tails, grows NO exposure.
    // For fade strategies we're buying the FADE side (the expensive side), so
    // the multiplier is evaluated at fadePrice with fadeSide.
    const biasMultiplier = longshotBiasMultiplier(fadePrice, fadeSide);
    // Phase 3 (2026-04-11): scout overlay. Layered on TOP of the Markov
    // longshot bias multiplier. The bias multiplier is Becker's industry
    // statistical adjustment; the overlay is the scout's qualitative view.
    // Both compose linearly — so a 1.2x Markov boost × 1.25x scout boost
    // gives a final multiplier of 1.5x, bounded by the risk engine's caps.
    const overlay = applyScoutOverlay(m.condition_id, fadeSide);
    const baseSize = 5;
    // 2026-04-16 Kelly-boundary fix: kellyScale ∈ [0,1] throttles size at
    // the fade-price boundary where breakeven WR is unreachable. systematic_fade
    // passes (1 - fadePrice) / 0.20; other subs default to 1.0.
    const combinedMultiplier = biasMultiplier * overlay.multiplier * kellyScale;
    const biasedSize = Math.max(1, Math.round(baseSize * combinedMultiplier * 100) / 100);
    // Phase A1 (2026-04-11): in the deep-tail dead-band zone (fadePrice > 0.95),
    // single-sided makers collect no reward score and eat concentrated adverse
    // selection. The empirical longshot edge from Becker's grid dominates the
    // -1.12% taker cost in this zone, so we switch execution mode to taker.
    // The order-builder reads signal.metadata.preferred_execution_mode and
    // overrides its default entry-maker policy when this is set.
    const preferredExecMode = preferredExecutionModeForTail(fadePrice);
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
      recommended_size_usd: biasedSize,
      metadata: {
        question: m.question,
        tail_price: tailPrice,
        sub_strategy: subStrategyId,
        using_calibration: usingCalibration,
        bias_multiplier: biasMultiplier,
        scout_overlay_multiplier: overlay.multiplier,
        scout_overlay_reason: overlay.reason,
        scout_overlay_scout_id: overlay.scoutId,
        preferred_execution_mode: preferredExecMode,
        in_dead_band: fadePrice > 0.90,
        kelly_scale: kellyScale,
        // 2026-04-16 Fix 1: per-signal probability uncertainty. Position
        // sizer shrinks model_prob by this amount before running Kelly
        // (see utils/math.ts α-boundary correction + position-sizer.ts).
        // systematic_fade runs at extreme fade prices (0.80-0.98) where
        // the 86.7%/-$33 paradox means observed WR is ~2-8 points BELOW
        // market-implied — so model_prob is systematically overstated.
        // Shrinking the Kelly input by 0.03 prevents the formula from
        // sizing into negative-EV territory on the strategy's own error.
        // bucketed_fade and news_overreaction_fade are already
        // constrained to tail-price 0.05-0.20 (fade price 0.80-0.95) and
        // don't need the extra shrinkage.
        prob_uncertainty: subStrategyId === 'systematic_fade' ? 0.03 : 0,
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
