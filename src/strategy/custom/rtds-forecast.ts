// RTDS forecast strategy — 2026-04-21.
//
// Trades Polymarket commodity / FX / equity markets using the Polymarket
// RTDS stream as the real-time price source. Previously zero coverage on
// these categories because our existing strategies are weather-, crypto-,
// favorites-, or longshot-focused.
//
// Architecture pattern mirrors crypto-price.ts but swaps Binance for RTDS:
//   1. Parse market question for asset symbol + threshold + direction + horizon
//   2. Pull current price via getRtdsPrice(symbol) (in-memory, <1s old)
//   3. Compute P(asset_at_resolution > threshold) via volatility-adjusted normal CDF
//   4. Compare to market price; emit signal if edge > min_edge
//
// Three sub-strategies distinguish the three asset classes so the
// strategy advisor can evaluate them independently. Identical pipeline;
// only the volatility table differs.
//
// v1 OBSERVATION-FRIENDLY: small positions, conservative edge threshold,
// no hold-to-settlement (weather-style) yet. Once R&D data accumulates
// (~50 resolutions) we revisit sub-sub tuning.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal, MarketData } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';
import { getRtdsPrice } from '../../market/polymarket-rtds.js';
import { getFeeRateFromTags, feeAdjustedEdge } from '../../utils/math.js';

const log = createChildLogger('strategy:rtds-forecast');

// Annualized volatility estimates per asset (empirical rough values).
// Used in the sqrt-of-time diffusion model. Update from RTDS history
// once we have 30+ days of observations.
const VOL: Record<string, number> = {
  // Commodities
  xauusd: 0.16, xagusd: 0.28, wti: 0.40,
  // FX (major + minor)
  eurusd: 0.08, gbpusd: 0.10, usdcad: 0.07, usdjpy: 0.10, usdkrw: 0.12,
  // Indices / ETFs
  spy: 0.17, qqq: 0.20, vxx: 0.90, ewy: 0.22,
  // Mega-cap tech
  aapl: 0.25, amzn: 0.30, googl: 0.28, meta: 0.35, msft: 0.22, nvda: 0.55,
  // Large-cap growth
  tsla: 0.55, nflx: 0.35,
  // Fintech / crypto-adjacent
  coin: 0.70, hood: 0.60,
  // Consumer / specialty
  abnb: 0.45, open: 0.80, cc: 0.50, ngd: 0.45, rklb: 0.70, pltr: 0.70,
};

// Regex families for question parsing. Capture group 1 = threshold value.
// Patterns are coarse by design — multiple regexes tried per market,
// first match wins.
const QUESTION_PATTERNS: Array<{ pattern: RegExp; symbol_hint: string; direction: 'above' | 'below' | null }> = [
  // "Will gold exceed $4700 ..." or "hit $4700"
  { pattern: /\b(?:gold|xau)\b.*?\b(?:above|exceed|hit|reach|over|cross)\b[^0-9]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'xauusd', direction: 'above' },
  { pattern: /\b(?:gold|xau)\b.*?\b(?:below|under|fall to|drop to)\b[^0-9]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'xauusd', direction: 'below' },
  { pattern: /\b(?:silver|xag)\b.*?\b(?:above|exceed|hit|reach|over|cross)\b[^0-9]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'xagusd', direction: 'above' },
  { pattern: /\b(?:oil|crude|wti)\b.*?\b(?:above|exceed|hit|reach|over|cross|settle\s*at|high)\b[^0-9]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'wti', direction: 'above' },
  { pattern: /\b(?:oil|crude|wti)\b.*?\b(?:below|under|fall to|low)\b[^0-9]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'wti', direction: 'below' },
  { pattern: /\bS(?:\s|&amp;|&)P\s*500\b.*?([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'spy', direction: 'above' },
  { pattern: /\b(?:SPY)\b.*?([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'spy', direction: 'above' },
  { pattern: /\b(?:VIX)\b.*?\b(?:above|exceed|hit|reach|over)\b[^0-9]*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'vxx', direction: 'above' },
  { pattern: /\b(?:TSLA|Tesla)\b.*?\b(?:above|exceed|hit|reach|over|close at)\b[^0-9]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'tsla', direction: 'above' },
  { pattern: /\b(?:NVDA|Nvidia)\b.*?\b(?:above|exceed|hit|reach|over|close at)\b[^0-9]*\$?\s*([0-9,]+(?:\.[0-9]+)?)/i, symbol_hint: 'nvda', direction: 'above' },
  // FX pairs generic
  { pattern: /\b(?:EUR\/USD|EURUSD)\b.*?([0-9.]+)/i, symbol_hint: 'eurusd', direction: 'above' },
  { pattern: /\b(?:GBP\/USD|GBPUSD)\b.*?([0-9.]+)/i, symbol_hint: 'gbpusd', direction: 'above' },
];

const CONFIG = {
  min_edge: 0.04,
  min_confidence: 0.55,
  min_hours_to_resolve: 1,
  max_hours_to_resolve: 168, // 7 days — longer than weather/crypto because equity markets often resolve at month/quarter end
  dedup_minutes: 120,
  max_position_usd: 5, // small-bet R&D observation
};

interface Parsed {
  symbol: string;
  threshold: number;
  direction: 'above' | 'below';
}

export class RtdsForecastStrategy extends BaseStrategy {
  readonly id = 'rtds_forecast';
  readonly name = 'RTDS Forecast';
  readonly description = 'Trade commodity/FX/equity Polymarket markets using Polymarket RTDS price stream';
  readonly version = '1.0.0';

  private recentTrades = new Map<string, number>();

  override getSubStrategies(): string[] {
    return ['commodity', 'fx', 'equity']; // advisor can A/B these independently
  }

  override shouldRun(ctx: StrategyContext): boolean {
    return (
      this.isSubStrategyEnabled(ctx, 'commodity') ||
      this.isSubStrategyEnabled(ctx, 'fx') ||
      this.isSubStrategyEnabled(ctx, 'equity')
    );
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    const signals: Signal[] = [];
    const markets = ctx.getActiveMarkets();
    const now = Date.now();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;

      const endTime = market.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (hoursToResolve < CONFIG.min_hours_to_resolve || hoursToResolve > CONFIG.max_hours_to_resolve) continue;

      const lastTrade = this.recentTrades.get(market.condition_id);
      if (lastTrade && (now - lastTrade) < CONFIG.dedup_minutes * 60 * 1000) continue;

      const parsed = this.parseQuestion(market.question);
      if (!parsed) continue;

      // Sub-category for the strategy advisor
      const sub = this.categorySub(parsed.symbol);
      if (!sub || !this.isSubStrategyEnabled(ctx, sub)) continue;

      const rtds = getRtdsPrice(parsed.symbol);
      if (!rtds) continue; // no recent RTDS update for this symbol

      const vol = VOL[parsed.symbol];
      if (!vol) continue;

      const estimate = this.estimateProbability(rtds.value, parsed.threshold, parsed.direction, hoursToResolve, vol);
      if (!estimate || estimate.confidence < CONFIG.min_confidence) continue;

      const yesPrice = market.yes_price;
      const noPrice = market.no_price;
      const rawEdge = estimate.yesProbability - yesPrice;
      const side: 'YES' | 'NO' = rawEdge > 0 ? 'YES' : 'NO';
      const tokenId = side === 'YES' ? market.token_yes_id : market.token_no_id;
      const marketPrice = side === 'YES' ? yesPrice : noPrice;
      const modelProb = side === 'YES' ? estimate.yesProbability : 1 - estimate.yesProbability;
      if (marketPrice < 0.05 || marketPrice > 0.95) continue;

      const feeRate = getFeeRateFromTags(market.tags ?? []);
      const adjEdge = feeAdjustedEdge(modelProb, marketPrice, feeRate);
      if (adjEdge < CONFIG.min_edge) continue;

      signals.push({
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: sub,
        condition_id: market.condition_id,
        token_id: tokenId,
        side: 'BUY',
        outcome: side,
        strength: Math.min(1, estimate.confidence),
        edge: adjEdge,
        model_prob: modelProb,
        market_price: marketPrice,
        recommended_size_usd: CONFIG.max_position_usd,
        metadata: {
          question: market.question,
          symbol: parsed.symbol,
          rtds_value: rtds.value,
          threshold: parsed.threshold,
          direction: parsed.direction,
          hours_to_resolve: Math.round(hoursToResolve * 10) / 10,
          volatility_annual: vol,
          model_yes_prob: estimate.yesProbability,
          raw_edge: Math.abs(rawEdge),
          fee_adjusted_edge: adjEdge,
          fee_rate: feeRate,
          sub_strategy: sub,
        },
        created_at: new Date(),
      });
      this.recentTrades.set(market.condition_id, now);
    }

    if (signals.length > 0) {
      log.info({ count: signals.length }, 'RTDS-forecast signals generated');
    }
    return signals;
  }

  private parseQuestion(q: string): Parsed | null {
    for (const { pattern, symbol_hint, direction } of QUESTION_PATTERNS) {
      const m = q.match(pattern);
      if (!m) continue;
      const raw = m[1];
      const threshold = parseFloat(raw.replace(/,/g, ''));
      if (!Number.isFinite(threshold)) continue;
      if (!direction) continue;
      return { symbol: symbol_hint, threshold, direction };
    }
    return null;
  }

  private categorySub(symbol: string): 'commodity' | 'fx' | 'equity' | null {
    if (['xauusd', 'xagusd', 'wti'].includes(symbol)) return 'commodity';
    if (['eurusd', 'gbpusd', 'usdcad', 'usdjpy', 'usdkrw'].includes(symbol)) return 'fx';
    if (symbol in VOL) return 'equity';
    return null;
  }

  /**
   * Normal-CDF probability of ending above threshold at horizon T, given
   * current spot S, annualized volatility σ, and hours_to_resolve h.
   */
  private estimateProbability(
    spot: number,
    threshold: number,
    direction: 'above' | 'below',
    hoursToResolve: number,
    annualVol: number,
  ): { yesProbability: number; confidence: number } | null {
    if (!(spot > 0) || !(threshold > 0) || !(hoursToResolve > 0) || !(annualVol > 0)) return null;
    const years = Math.max(hoursToResolve / 8760, 1 / 52560); // floor at ~10 min
    const sigma = annualVol * Math.sqrt(years);
    // Log-return z-score at horizon for end-of-period
    const z = (Math.log(threshold / spot)) / sigma;
    // Normal CDF via error-function approximation
    const phi = 0.5 * (1 + this.erf(z / Math.SQRT2));
    // P(S_T > threshold) = 1 - phi(z)
    let yesProbability = direction === 'above' ? 1 - phi : phi;
    yesProbability = Math.max(0.01, Math.min(0.99, yesProbability));

    // Confidence: shrink-toward-0.5 uncertainty based on sigma. Tight sigma
    // => confidence closer to 1; loose => closer to 0.5.
    const confidence = Math.max(0.3, Math.min(1.0, 1.0 - sigma * 0.5));
    return { yesProbability, confidence };
  }

  private erf(x: number): number {
    // Abramowitz & Stegun 7.1.26 approximation
    const sign = x < 0 ? -1 : 1;
    const ax = Math.abs(x);
    const a1 = 0.254829592,
      a2 = -0.284496736,
      a3 = 1.421413741,
      a4 = -1.453152027,
      a5 = 1.061405429,
      p = 0.3275911;
    const t = 1.0 / (1.0 + p * ax);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
    return sign * y;
  }
}
