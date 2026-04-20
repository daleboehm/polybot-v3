// Favorites strategy — buy consensus favorites in binary markets
//
// Sub-strategies:
//   - compounding: original logic — any favorite $0.50-$0.92 with 2-48h to resolve
//   - near_snipe: markets <1h from resolution with prob 92-98% (93% WR in research)
//   - stratified_bias: only "mid-favorites" in 40-60% range (peak behavioral distortion)
//   - fan_fade: CONTRARIAN — sell the favorite when crowd pushes hype markets >85%

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { baseRateCalibrator } from '../../validation/base-rate-calibrator.js';
import { calibratedSideProb, preferredExecutionModeForTail } from '../../market/markov-calibration.js';
import { applyScoutOverlay } from '../scout-overlay.js';
import { scoreCasualness } from '../../market/sophistication-score.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';
import { isLifecycleEdgeMarket } from '../strategy-context.js';

const log = createChildLogger('strategy:favorites');

const DEDUP_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours per (sub, condition_id)

export class FavoritesStrategy extends BaseStrategy {
  readonly id = 'favorites';
  readonly name = 'Favorites';
  readonly description = 'Buy consensus favorites — 4 sub-strategies for different probability regimes';
  readonly version = '3.0.0';

  private recentTrades = new Map<string, number>(); // `${sub}:${condition_id}` -> timestamp

  override getSubStrategies(): string[] {
    return ['compounding', 'near_snipe', 'stratified_bias', 'fan_fade'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();

    const signals: Signal[] = [];
    const markets = ctx.getActiveMarkets();
    const now = Date.now();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id)
    );

    // 2026-04-20 Action 6: lifecycle timing filter (opt-in via env).
    // When LIFECYCLE_EDGE_ONLY=true, skip markets in mid-lifecycle where
    // pricing is most efficient. Paper-test on R&D first.
    const lifecycleOnly = process.env.LIFECYCLE_EDGE_ONLY === 'true';

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;
      if (!market.yes_price || !market.no_price) continue;
      if (lifecycleOnly && !isLifecycleEdgeMarket(market)) continue;

      const endTime = market.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (isNaN(hoursToResolve) || hoursToResolve < 0) continue;

      // Identify favorite (highest-priced side)
      const yesPrice = market.yes_price;
      const noPrice = market.no_price;
      const favoritePrice = Math.max(yesPrice, noPrice);
      const favoriteSide: 'YES' | 'NO' = yesPrice >= noPrice ? 'YES' : 'NO';
      const favoriteTokenId = yesPrice >= noPrice ? market.token_yes_id : market.token_no_id;
      const payoff = (1.0 - favoritePrice) / favoritePrice;

      // Probability fallback chain (Phase 3, 2026-04-11):
      //   1. own-data base-rate calibrator — Wilson LB from our own resolved
      //      favorites positions bucketed by entry price. Best signal when
      //      available but prod has ~0 resolutions so it usually returns null.
      //   2. Markov empirical grid — Becker 72.1M-trade industry-wide
      //      calibration. Always has a value, grounded in real resolved
      //      Polymarket/Kalshi data across all strategy categories. This is
      //      the prod-critical step: without it, prod flies on the naive
      //      heuristic almost every signal.
      //   3. naive `favoritePrice + payoff * 0.5` — last resort, retained
      //      only as a defensive fallback in case the Markov helper
      //      ever returns NaN.
      const ownCalibration = baseRateCalibrator.getBaseRate(this.id, favoritePrice);
      const markovCalibration = calibratedSideProb(favoritePrice, favoriteSide);
      const usingOwnCalibration = ownCalibration !== null;
      const usingMarkovCalibration = !usingOwnCalibration && Number.isFinite(markovCalibration);
      const usingCalibration = usingOwnCalibration || usingMarkovCalibration;
      const modelProb =
        ownCalibration ??
        (Number.isFinite(markovCalibration) ? markovCalibration : (favoritePrice + payoff * 0.5));

      // Phase A1 (2026-04-11): when the favorite side we're buying is in the
      // deep-tail dead-band zone (>0.95), buildSignal() will set
      // metadata.preferred_execution_mode='taker' so the order-builder
      // switches from maker to taker. Captured via preferredExecutionModeForTail().

      // ─── sub: compounding (2026-04-20: floor raised 0.50 -> 0.70 after
      // R&D data showed the 0.60-0.70 entry-price bucket was -$45.30 on n=173
      // (62.4% WR, -$0.26/trade) while 0.70+ was +$78.65 on n=213. The dead
      // zone is moderate favorites where calibration can't add enough edge
      // to clear fees. Upper bound unchanged. See session 2026-04-20.) ───
      // Previously 0.50-0.92 which overlapped with fan_fade (0.85-0.92), causing
      // both subs to fire on the same markets with opposite sides. Compounding
      // now stops at 0.85 exclusive; fan_fade owns the 0.85-0.92 band.
      if (
        this.isSubStrategyEnabled(ctx, 'compounding') &&
        favoritePrice >= 0.70 && favoritePrice < 0.85 &&
        hoursToResolve >= 2 && hoursToResolve <= 48 &&
        payoff >= 0.03
      ) {
        const key = `compounding:${market.condition_id}`;
        if (!this.recentTrades.has(key)) {
          signals.push(this.buildSignal(ctx, market, 'compounding', favoriteSide, favoriteTokenId, favoritePrice, payoff, modelProb, hoursToResolve, 0.7, usingCalibration, usingOwnCalibration, usingMarkovCalibration));
          this.recentTrades.set(key, now);
        }
      }

      // ─── sub: near_snipe (93% WR per research) ───
      if (
        this.isSubStrategyEnabled(ctx, 'near_snipe') &&
        favoritePrice >= 0.92 && favoritePrice <= 0.98 &&
        hoursToResolve > 0 && hoursToResolve <= 1
      ) {
        const key = `near_snipe:${market.condition_id}`;
        if (!this.recentTrades.has(key)) {
          signals.push(this.buildSignal(ctx, market, 'near_snipe', favoriteSide, favoriteTokenId, favoritePrice, payoff, modelProb, hoursToResolve, 0.9, usingCalibration, usingOwnCalibration, usingMarkovCalibration));
          this.recentTrades.set(key, now);
        }
      }

      // ─── sub: stratified_bias (40-60% range) ───
      // 2026-04-16 Fix 5: market sophistication filter. stratified_bias was
      // -$147 all-time (35.1% WR on 194 resolutions) because it fires on
      // every 40-60% market regardless of whether the favorite-longshot
      // bias is actually present. Academic consensus: the bias is 2-5% in
      // LOW-VOLUME sports/entertainment markets and near-zero in
      // sophisticated CLOB-heavy markets (crypto, major political). Gate
      // the sub on `casual_score >= 2` — at least 2 of {low-volume,
      // casual-category, long-horizon} must be true for the bias to be
      // structurally present.
      if (
        this.isSubStrategyEnabled(ctx, 'stratified_bias') &&
        favoritePrice >= 0.40 && favoritePrice <= 0.60 &&
        hoursToResolve >= 2 && hoursToResolve <= 48
      ) {
        const soph = scoreCasualness(market);
        if (soph.casual_score < 2) {
          log.debug({
            condition_id: market.condition_id.substring(0, 14),
            casual_score: soph.casual_score,
            volume_casual: soph.volume_casual,
            category_casual: soph.category_casual,
            horizon_casual: soph.horizon_casual,
            matched_category: soph.matched_category,
          }, 'stratified_bias gated — market too sophisticated for bias trade');
        } else {
          const key = `stratified_bias:${market.condition_id}`;
          if (!this.recentTrades.has(key)) {
            const signal = this.buildSignal(ctx, market, 'stratified_bias', favoriteSide, favoriteTokenId, favoritePrice, payoff, modelProb, hoursToResolve, 0.5, usingCalibration, usingOwnCalibration, usingMarkovCalibration);
            // Tag the sophistication breakdown for post-hoc analysis of how
            // the filter is performing (are we still losing on 2-score markets?
            // Should we raise to 3?)
            signal.metadata = {
              ...signal.metadata,
              casual_score: soph.casual_score,
              volume_casual: soph.volume_casual,
              category_casual: soph.category_casual,
              horizon_casual: soph.horizon_casual,
              matched_category: soph.matched_category,
            };
            signals.push(signal);
            this.recentTrades.set(key, now);
          }
        }
      }

      // ─── sub: fan_fade (contrarian — fade hype markets >85%) ───
      // Emits a BUY on the OPPOSITE side (the underdog)
      if (
        this.isSubStrategyEnabled(ctx, 'fan_fade') &&
        favoritePrice >= 0.85 && favoritePrice < 0.92 &&
        hoursToResolve >= 2 && hoursToResolve <= 48
      ) {
        const underdogSide: 'YES' | 'NO' = favoriteSide === 'YES' ? 'NO' : 'YES';
        // Symmetry audit fix (2026-04-15): read the actual book price for the
        // underdog side, not `1 - favoritePrice`. CLOB books frequently have
        // `yes_price + no_price ≠ 1` due to spread; `1 - favoritePrice` would
        // place the maker a tick below/above the real book and either miss the
        // fill or execute at a stale price the strategy didn't intend. See
        // docs/symmetry-audit-2026-04-15.md §favorites.ts for the worked example.
        const underdogPrice = favoriteSide === 'YES' ? market.no_price : market.yes_price;
        const underdogTokenId = favoriteSide === 'YES' ? market.token_no_id : market.token_yes_id;
        // Markov calibration for the underdog side. The Becker grid shows
        // that at 10-15¢ (typical underdog price), empirical resolution runs
        // 8.9-13.7% — close to implied but with slight overpricing that
        // favors fading. We use the grid as model_prob so the advisor can
        // track whether fan_fade is actually capturing the residual edge.
        const underdogMarkovProb = calibratedSideProb(underdogPrice, underdogSide);
        const underdogModelProb = Number.isFinite(underdogMarkovProb)
          ? underdogMarkovProb
          : underdogPrice + 0.05;
        const underdogEdge = underdogModelProb - underdogPrice;
        const fanFadeOverlay = applyScoutOverlay(market.condition_id, underdogSide);
        const fanFadeSize = Math.max(1, 3 * fanFadeOverlay.multiplier);
        const key = `fan_fade:${market.condition_id}`;
        if (!this.recentTrades.has(key)) {
          signals.push({
            signal_id: nanoid(),
            entity_slug: ctx.entity.config.slug,
            strategy_id: this.id,
            sub_strategy_id: 'fan_fade',
            condition_id: market.condition_id,
            token_id: underdogTokenId,
            side: 'BUY',
            outcome: underdogSide,
            strength: 0.4,
            edge: underdogEdge,
            model_prob: underdogModelProb,
            market_price: underdogPrice,
            recommended_size_usd: fanFadeSize,
            metadata: {
              question: market.question,
              sub_strategy: 'fan_fade',
              hours_to_resolve: hoursToResolve,
              hyped_favorite_price: favoritePrice,
              using_markov_calibration: Number.isFinite(underdogMarkovProb),
              scout_overlay_multiplier: fanFadeOverlay.multiplier,
              scout_overlay_reason: fanFadeOverlay.reason,
              scout_overlay_scout_id: fanFadeOverlay.scoutId,
              // Phase A1: fan_fade buys the underdog priced 0.08-0.15 which
              // is inside the low-tail dead-band (<0.10 for most). No taker
              // override here — the underdog side is usually liquid enough
              // on the bid, and the whole thesis is that the book is mispriced
              // so we WANT to rest as a maker and collect any informed flow
              // that disagrees with the hype. Just flag the dead-band state
              // so the advisor can track performance separately.
              in_dead_band: underdogPrice < 0.10 || underdogPrice > 0.90,
            },
            created_at: new Date(),
          });
          this.recentTrades.set(key, now);
        }
      }
    }

    if (signals.length > 0) {
      const bySub = signals.reduce((acc, s) => {
        acc[s.sub_strategy_id ?? 'unknown'] = (acc[s.sub_strategy_id ?? 'unknown'] ?? 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      log.info({ count: signals.length, by_sub: bySub }, 'Favorites signals generated');
    }

    return signals;
  }

  private buildSignal(
    ctx: StrategyContext,
    market: { condition_id: string; question: string; market_slug?: string; yes_price: number; no_price: number },
    subStrategyId: string,
    side: 'YES' | 'NO',
    tokenId: string,
    price: number,
    payoff: number,
    modelProb: number,
    hoursToResolve: number,
    strength = 0.7,
    usingCalibration = false,
    usingOwnCalibration = false,
    usingMarkovCalibration = false,
  ): Signal {
    // Real edge = calibrated probability - market price. Two calibration
    // sources can drive `usingCalibration = true`: (a) our own resolved
    // positions via baseRateCalibrator, (b) Becker's 72.1M-trade Markov
    // empirical grid. Either way, the edge is `modelProb - price`, a real
    // statistical edge vs the market. The naive `payoff * 0.5` fallback is
    // only reachable if both calibration sources return unusable values,
    // which should be ~never in practice.
    const clampedModelProb = Math.min(0.99, modelProb);
    const edge = usingCalibration ? (clampedModelProb - price) : (payoff * 0.5);

    // Phase 3 (2026-04-11): scout overlay. If any scout has recently
    // written qualitative intel for this market, the overlay returns a
    // size multiplier (1.0 = no-op, up to 1.25x on agreement, down to
    // 0.5x on disagreement). The strategy's edge / calibration math is
    // unchanged — only recommended_size_usd gets the adjustment.
    const overlay = applyScoutOverlay(market.condition_id, side);
    // 2026-04-20 Action 5 (04-19 report): favorites/compounding is the only
    // strategy with substantial positive PnL (+$3.57 on n=90, 62.5% WR on
    // prod; +$135 on n=574 on R&D). Double the base allocation on compounding
    // specifically; other sub-strategies stay at base. Downstream risk-engine
    // caps (max_position_pct, max_position_usd, envelope) still bind.
    const compoundingMultiplier = subStrategyId === 'compounding' ? 2.0 : 1.0;
    const baseSize = 10;
    const adjustedSize = Math.max(1, baseSize * overlay.multiplier * compoundingMultiplier);
    return {
      signal_id: nanoid(),
      entity_slug: ctx.entity.config.slug,
      strategy_id: this.id,
      sub_strategy_id: subStrategyId,
      condition_id: market.condition_id,
      token_id: tokenId,
      side: 'BUY',
      outcome: side,
      strength,
      edge,
      model_prob: clampedModelProb,
      market_price: price,
      recommended_size_usd: adjustedSize,
      metadata: {
        scout_overlay_multiplier: overlay.multiplier,
        scout_overlay_reason: overlay.reason,
        scout_overlay_scout_id: overlay.scoutId,
        question: market.question,
        market_slug: market.market_slug,
        hours_to_resolve: Math.round(hoursToResolve * 10) / 10,
        yes_price: market.yes_price,
        no_price: market.no_price,
        payoff_ratio: Math.round(payoff * 1000) / 1000,
        sub_strategy: subStrategyId,
        using_calibration: usingCalibration,
        using_own_calibration: usingOwnCalibration,
        using_markov_calibration: usingMarkovCalibration,
        // Phase A1: tail-zone execution-mode override. Order-builder reads
        // this field and switches from maker to taker when set to 'taker'.
        preferred_execution_mode: preferredExecutionModeForTail(price),
        in_dead_band: price > 0.90,
      },
      created_at: new Date(),
    };
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [key, ts] of this.recentTrades) {
      if (now - ts > DEDUP_TTL_MS) this.recentTrades.delete(key);
    }
  }
}
