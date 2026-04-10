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
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

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

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;
      if (!market.yes_price || !market.no_price) continue;

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

      // R2 PR#1 base-rate calibration (2026-04-10): prefer the empirical Wilson LB
      // from historical resolutions in this price bucket. Falls back to the old
      // tautological `favoritePrice + payoff * 0.5` when there's insufficient
      // history — but the fallback is explicitly marked so the advisor can de-rate
      // any sub still running on fallback rather than calibrated data.
      const calibratedProb = baseRateCalibrator.getBaseRate(this.id, favoritePrice);
      const usingCalibration = calibratedProb !== null;
      const modelProb = calibratedProb ?? (favoritePrice + payoff * 0.5);

      // ─── sub: compounding (now 0.50-0.85 — audit A-P1-4 boundary fix) ───
      // Previously 0.50-0.92 which overlapped with fan_fade (0.85-0.92), causing
      // both subs to fire on the same markets with opposite sides. Compounding
      // now stops at 0.85 exclusive; fan_fade owns the 0.85-0.92 band.
      if (
        this.isSubStrategyEnabled(ctx, 'compounding') &&
        favoritePrice >= 0.50 && favoritePrice < 0.85 &&
        hoursToResolve >= 2 && hoursToResolve <= 48 &&
        payoff >= 0.03
      ) {
        const key = `compounding:${market.condition_id}`;
        if (!this.recentTrades.has(key)) {
          signals.push(this.buildSignal(ctx, market, 'compounding', favoriteSide, favoriteTokenId, favoritePrice, payoff, modelProb, hoursToResolve, 0.7, usingCalibration));
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
          signals.push(this.buildSignal(ctx, market, 'near_snipe', favoriteSide, favoriteTokenId, favoritePrice, payoff, modelProb, hoursToResolve, 0.9));
          this.recentTrades.set(key, now);
        }
      }

      // ─── sub: stratified_bias (40-60% range) ───
      if (
        this.isSubStrategyEnabled(ctx, 'stratified_bias') &&
        favoritePrice >= 0.40 && favoritePrice <= 0.60 &&
        hoursToResolve >= 2 && hoursToResolve <= 48
      ) {
        const key = `stratified_bias:${market.condition_id}`;
        if (!this.recentTrades.has(key)) {
          signals.push(this.buildSignal(ctx, market, 'stratified_bias', favoriteSide, favoriteTokenId, favoritePrice, payoff, modelProb, hoursToResolve, 0.5));
          this.recentTrades.set(key, now);
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
        const underdogPrice = 1 - favoritePrice;
        const underdogTokenId = favoriteSide === 'YES' ? market.token_no_id : market.token_yes_id;
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
            edge: 0.05,
            model_prob: underdogPrice + 0.05,
            market_price: underdogPrice,
            recommended_size_usd: 3,
            metadata: {
              question: market.question,
              sub_strategy: 'fan_fade',
              hours_to_resolve: hoursToResolve,
              hyped_favorite_price: favoritePrice,
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
  ): Signal {
    // Real edge = calibrated probability - market price, NOT the old `payoff * 0.5`
    // heuristic. When the calibrator has data, this is a real statistical edge.
    // When it doesn't, edge falls back to `payoff * 0.5` so the min_edge gate
    // still triggers on obvious high-payoff markets.
    const clampedModelProb = Math.min(0.99, modelProb);
    const edge = usingCalibration ? (clampedModelProb - price) : (payoff * 0.5);
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
      recommended_size_usd: 10,
      metadata: {
        question: market.question,
        market_slug: market.market_slug,
        hours_to_resolve: Math.round(hoursToResolve * 10) / 10,
        yes_price: market.yes_price,
        no_price: market.no_price,
        payoff_ratio: Math.round(payoff * 1000) / 1000,
        sub_strategy: subStrategyId,
        using_calibration: usingCalibration,
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
