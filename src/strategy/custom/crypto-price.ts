// Crypto price strategy — uses CoinGecko spot prices + volatility model to find mispriced crypto markets
// Edge: compare current BTC/ETH/SOL price against market's target using time-to-expiry adjusted normal distribution

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal, MarketData } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';
import { getBinancePrice } from '../../market/data-feeds.js';

const log = createChildLogger('strategy:crypto');

// CoinGecko asset mapping
const CRYPTO_ASSETS: Record<string, string> = {
  'bitcoin': 'bitcoin', 'btc': 'bitcoin',
  'ethereum': 'ethereum', 'eth': 'ethereum',
  'solana': 'solana', 'sol': 'solana',
  'dogecoin': 'dogecoin', 'doge': 'dogecoin',
  'xrp': 'ripple', 'ripple': 'ripple',
  'cardano': 'cardano', 'ada': 'cardano',
};

// Annualized volatility by asset (for normal CDF model)
const VOLATILITY: Record<string, number> = {
  'bitcoin': 0.60, 'ethereum': 0.75, 'solana': 0.90,
  'dogecoin': 1.10, 'ripple': 0.85, 'cardano': 0.80,
};

interface PriceCache {
  price: number;
  fetched_at: number;
}

const CONFIG = {
  min_edge: 0.05,
  min_confidence: 0.40,
  max_hours_to_resolve: 48,
  min_hours_to_resolve: 1,
  dedup_minutes: 120,
  price_cache_ttl_ms: 5 * 60 * 1000, // 5 min
};

export class CryptoPriceStrategy extends BaseStrategy {
  readonly id = 'crypto_price';
  readonly name = 'Crypto Price';
  readonly description = 'Trade crypto price markets using CoinGecko spot + volatility model';
  readonly version = '3.0.0';

  private priceCache = new Map<string, PriceCache>();

  override getSubStrategies(): string[] {
    // 2026-04-10 expansion: added target_proximity and volatility_premium_fade
    // so the advisor has real variants to compare. All three subs share the
    // same spot-price + volatility-model pipeline; they differ only in how
    // they interpret the model output.
    return [
      'latency_arb',               // Baseline: fade Polymarket vs Binance spot (normal-CDF model)
      'target_proximity',          // Only trade when current ≈ target (near-boundary high-confidence zone)
      'volatility_premium_fade',   // Fade markets pricing implied vol >> realized vol
    ];
  }
  private recentTrades = new Map<string, number>();

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    const anyEnabled =
      this.isSubStrategyEnabled(ctx, 'latency_arb') ||
      this.isSubStrategyEnabled(ctx, 'target_proximity') ||
      this.isSubStrategyEnabled(ctx, 'volatility_premium_fade');
    if (!anyEnabled) return signals;
    const markets = ctx.getActiveMarkets();
    const now = Date.now();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id)
    );

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;

      // Must have valid end_date
      const endTime = market.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (isNaN(hoursToResolve) || hoursToResolve < CONFIG.min_hours_to_resolve || hoursToResolve > CONFIG.max_hours_to_resolve) continue;

      // Dedup
      const lastTrade = this.recentTrades.get(market.condition_id);
      if (lastTrade && (now - lastTrade) < CONFIG.dedup_minutes * 60 * 1000) continue;

      // Parse crypto market question
      const parsed = this.parseCryptoQuestion(market.question);
      if (!parsed) continue;

      // Phase R2.1 (2026-04-12): Lummox_eth whale analysis confirmed BTC
      // is the only crypto with sufficient Polymarket 5-min market depth.
      // ETH/SOL markets have too-thin books and our liquidity sizer would
      // reject most entries anyway. Hard-gate: only trade BTC markets.
      // Keep parsing ETH/SOL so the data stays visible in logs/dashboards,
      // but skip signal generation.
      if (parsed.coingeckoId !== 'bitcoin') continue;

      // Get current price — Binance first (1-min cache), CoinGecko fallback (5-min)
      let currentPrice = await getBinancePrice(parsed.coingeckoId);
      if (!currentPrice) currentPrice = await this.getPrice(parsed.coingeckoId);
      if (!currentPrice || currentPrice <= 0) continue;

      // Calculate probability using volatility-adjusted normal distribution
      const vol = VOLATILITY[parsed.coingeckoId] ?? 0.70;
      const estimate = this.estimateProbability(
        currentPrice, parsed.target, parsed.direction,
        hoursToResolve, vol,
      );

      if (!estimate || estimate.confidence < CONFIG.min_confidence) continue;

      // Compute edge vs market price (YES side)
      const yesPrice = market.yes_price;
      const noPrice = market.no_price;
      const edge = estimate.yesProbability - yesPrice;

      // Determine side + token from model (shared across subs)
      const side: 'YES' | 'NO' = edge > 0 ? 'YES' : 'NO';
      const tokenId = side === 'YES' ? market.token_yes_id : market.token_no_id;
      const marketPrice = side === 'YES' ? yesPrice : noPrice;
      const modelProb = side === 'YES' ? estimate.yesProbability : (1 - estimate.yesProbability);

      if (marketPrice < 0.05 || marketPrice > 0.95) continue;

      // Proximity metric: how many sigmas is current price from target?
      // Smaller = closer to decision boundary = higher per-signal information.
      const hoursForSigma = Math.max(hoursToResolve, 1);
      const sigmaUsd = currentPrice * vol * Math.sqrt(hoursForSigma / 8760);
      const zScore = sigmaUsd > 0 ? Math.abs(currentPrice - parsed.target) / sigmaUsd : 999;

      const baseMetadata = {
        question: market.question,
        asset: parsed.coingeckoId,
        current_price: currentPrice,
        target_price: parsed.target,
        direction: parsed.direction,
        yes_probability: estimate.yesProbability,
        confidence: estimate.confidence,
        hours_to_resolve: Math.round(hoursToResolve * 10) / 10,
        volatility: vol,
        z_score: Math.round(zScore * 100) / 100,
      };

      // ─── sub: latency_arb (baseline — Polymarket lags Binance spot) ───
      if (
        this.isSubStrategyEnabled(ctx, 'latency_arb') &&
        Math.abs(edge) >= CONFIG.min_edge
      ) {
        signals.push({
          signal_id: nanoid(),
          entity_slug: ctx.entity.config.slug,
          strategy_id: this.id,
          sub_strategy_id: 'latency_arb',
          condition_id: market.condition_id,
          token_id: tokenId,
          side: 'BUY',
          outcome: side,
          strength: Math.min(1, estimate.confidence),
          edge: Math.abs(edge),
          model_prob: modelProb,
          market_price: marketPrice,
          recommended_size_usd: 15,
          metadata: { ...baseMetadata, sub_strategy: 'latency_arb' },
          created_at: new Date(),
        });
        this.recentTrades.set(market.condition_id, now);
      }

      // ─── sub: target_proximity (current price near target — high-info zone) ───
      // When z-score < 0.5, the outcome is genuinely uncertain and the model's
      // edge estimate is at its most informative. Accept a smaller edge because
      // confidence is higher; require short horizons (<12h) where the spot
      // price signal is freshest.
      if (
        this.isSubStrategyEnabled(ctx, 'target_proximity') &&
        zScore < 0.5 &&
        hoursToResolve <= 12 &&
        Math.abs(edge) >= 0.03
      ) {
        signals.push({
          signal_id: nanoid(),
          entity_slug: ctx.entity.config.slug,
          strategy_id: this.id,
          sub_strategy_id: 'target_proximity',
          condition_id: market.condition_id,
          token_id: tokenId,
          side: 'BUY',
          outcome: side,
          strength: 0.85,
          edge: Math.abs(edge),
          model_prob: modelProb,
          market_price: marketPrice,
          recommended_size_usd: 10,
          metadata: { ...baseMetadata, sub_strategy: 'target_proximity' },
          created_at: new Date(),
        });
      }

      // ─── sub: volatility_premium_fade (fade markets pricing excessive vol) ───
      // When the model says YES is likely (e.g. 75%) but the market prices NO
      // at 45% (edge = 30%), the market is implicitly pricing FAR more volatility
      // than the historical annualized vol constant suggests. Fade the fear:
      // side with the model. Large edge (>12%) distinguishes this from the
      // baseline latency_arb case; smaller size because the thesis is
      // model-trust-heavy.
      if (
        this.isSubStrategyEnabled(ctx, 'volatility_premium_fade') &&
        Math.abs(edge) >= 0.12 &&
        estimate.confidence >= 0.55 &&
        hoursToResolve <= 36
      ) {
        signals.push({
          signal_id: nanoid(),
          entity_slug: ctx.entity.config.slug,
          strategy_id: this.id,
          sub_strategy_id: 'volatility_premium_fade',
          condition_id: market.condition_id,
          token_id: tokenId,
          side: 'BUY',
          outcome: side,
          strength: 0.75,
          edge: Math.abs(edge),
          model_prob: modelProb,
          market_price: marketPrice,
          recommended_size_usd: 8,
          metadata: { ...baseMetadata, sub_strategy: 'volatility_premium_fade' },
          created_at: new Date(),
        });
      }

      log.debug({
        market: market.question.substring(0, 60),
        asset: parsed.coingeckoId,
        current: currentPrice,
        target: parsed.target,
        z_score: zScore.toFixed(2),
        side,
        edge: (edge * 100).toFixed(1) + '%',
        modelProb: modelProb.toFixed(3),
      }, 'Crypto market scored');
    }

    if (signals.length > 0) {
      log.info({ count: signals.length }, 'Crypto signals generated');
    }

    return signals;
  }

  private parseCryptoQuestion(question: string): { coingeckoId: string; target: number; direction: string } | null {
    const q = question.toLowerCase();

    // Find asset
    let coingeckoId: string | null = null;
    for (const [keyword, id] of Object.entries(CRYPTO_ASSETS)) {
      if (q.includes(keyword)) {
        coingeckoId = id;
        break;
      }
    }
    if (!coingeckoId) return null;

    // Find target price and direction
    const patterns = [
      { regex: /above \$([0-9,]+)/i, direction: 'above' },
      { regex: /below \$([0-9,]+)/i, direction: 'below' },
      { regex: /reach \$([0-9,]+)/i, direction: 'reach' },
      { regex: /dip to \$([0-9,]+)/i, direction: 'dip' },
      { regex: /exceed \$([0-9,]+)/i, direction: 'above' },
      { regex: /hit \$([0-9,]+)/i, direction: 'reach' },
      { regex: />\s*\$([0-9,]+)/i, direction: 'above' },
      { regex: /<\s*\$([0-9,]+)/i, direction: 'below' },
    ];

    for (const { regex, direction } of patterns) {
      const match = question.match(regex);
      if (match) {
        const target = parseFloat(match[1].replace(/,/g, ''));
        if (target > 0) return { coingeckoId, target, direction };
      }
    }

    return null;
  }

  private async getPrice(coingeckoId: string): Promise<number | null> {
    const cached = this.priceCache.get(coingeckoId);
    if (cached && (Date.now() - cached.fetched_at) < CONFIG.price_cache_ttl_ms) {
      return cached.price;
    }

    try {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`;
      const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!response.ok) return null;

      const data = await response.json() as Record<string, { usd: number }>;
      const price = data[coingeckoId]?.usd;
      if (!price || price <= 0) return null;

      this.priceCache.set(coingeckoId, { price, fetched_at: Date.now() });
      return price;
    } catch (err) {
      log.debug({ asset: coingeckoId, err }, 'Price fetch failed');
      return null;
    }
  }

  private estimateProbability(
    currentPrice: number, target: number, direction: string,
    hoursToResolve: number, annualizedVol: number,
  ): { yesProbability: number; confidence: number } | null {
    const hours = Math.max(hoursToResolve, 1);
    const sigma = currentPrice * annualizedVol * Math.sqrt(hours / 8760);

    if (sigma <= 0) return null;

    let yesProbability: number;

    if (direction === 'above' || direction === 'reach') {
      // P(price > target at expiry)
      const z = (currentPrice - target) / sigma;
      yesProbability = normalCDF(z);
    } else if (direction === 'below' || direction === 'dip') {
      // P(price < target at expiry)
      const z = (target - currentPrice) / sigma;
      yesProbability = normalCDF(z);
    } else {
      return null;
    }

    yesProbability = Math.max(0.02, Math.min(0.98, yesProbability));

    // Confidence based on time to expiry
    let confidence: number;
    if (hours <= 6) confidence = 0.85;
    else if (hours <= 24) confidence = 0.65;
    else if (hours <= 48) confidence = 0.45;
    else confidence = 0.30;

    return { yesProbability, confidence };
  }

  shouldRun(_ctx: StrategyContext): boolean {
    const cutoff = Date.now() - (4 * 60 * 60 * 1000);
    for (const [key, ts] of this.recentTrades) {
      if (ts < cutoff) this.recentTrades.delete(key);
    }
    return true;
  }
}

// Approximate normal CDF using the error function
function normalCDF(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
