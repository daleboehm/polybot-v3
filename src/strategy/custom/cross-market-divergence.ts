// Cross-market divergence strategy — ensemble-blend Polymarket ↔ Kalshi prices.
//
// R3a (2026-04-10). Per design-decisions §N2: when Polymarket and Kalshi
// disagree on the same question by more than 4%, one of them is wrong. The
// ensemble blend (weighted by volume) is closer to the truth than either
// venue alone. We fire a signal to buy the cheaper side on Polymarket.
//
// Matching: Jaccard title similarity + category + close-date proximity. The
// matching table is cached for 24h inside KalshiClient.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import type { KalshiClient, KalshiMarket } from '../../market/kalshi-client.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:cross-market');
const DEDUP_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_DIVERGENCE = 0.04;
const MIN_POLY_VOLUME = 5000;
const MIN_KALSHI_VOLUME = 2000;

export class CrossMarketDivergenceStrategy extends BaseStrategy {
  readonly id = 'cross_market';
  readonly name = 'Cross-Market Divergence';
  readonly description = 'Ensemble blend Polymarket + Kalshi prices; fade divergences';
  readonly version = '3.0.0';

  private recent = new Map<string, number>();

  constructor(private kalshi: KalshiClient) {
    super();
  }

  override getSubStrategies(): string[] {
    return ['ensemble_blend'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();
    const signals: Signal[] = [];

    // Fetch all tracked Kalshi categories in one sweep (cached)
    const kalshiMarkets = await this.kalshi.getAllMarkets();
    if (kalshiMarkets.length === 0) return signals;

    // Filter to liquid Kalshi markets only
    const liquidKalshi = kalshiMarkets.filter(k => k.volume >= MIN_KALSHI_VOLUME);
    if (liquidKalshi.length === 0) return signals;

    const markets = ctx.getActiveMarkets();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;
      if (!market.yes_price || !market.no_price) continue;
      if ((market.volume_24h ?? 0) < MIN_POLY_VOLUME) continue;

      // Find a Kalshi match via Jaccard similarity on the question text
      const match = this.kalshi.findMatch(market.condition_id, market.question ?? '', liquidKalshi);
      if (!match) continue;

      // Look up the matched market's current price
      const kalshiMarket: KalshiMarket | undefined = liquidKalshi.find(k => k.ticker === match.kalshiTicker);
      if (!kalshiMarket) continue;

      const ensemble = this.kalshi.computeEnsemble(
        market.yes_price,
        kalshiMarket.yesPrice,
        market.volume_24h ?? 0,
        kalshiMarket.volume,
      );

      if (ensemble.divergence < MIN_DIVERGENCE) continue;

      // Which side is cheaper on Polymarket relative to the ensemble blend?
      // If Polymarket YES < blend → YES is under-priced on PM → buy YES
      // If Polymarket YES > blend → YES is over-priced on PM → buy NO
      const buySide: 'YES' | 'NO' = market.yes_price < ensemble.blendedProb ? 'YES' : 'NO';
      const buyPrice = buySide === 'YES' ? market.yes_price : market.no_price;
      const buyTokenId = buySide === 'YES' ? market.token_yes_id : market.token_no_id;
      const modelProb = buySide === 'YES' ? ensemble.blendedProb : (1 - ensemble.blendedProb);
      const edge = modelProb - buyPrice;
      if (edge < MIN_DIVERGENCE) continue;

      const key = `cross_market:${market.condition_id}`;
      if (this.recent.has(key)) continue;

      signals.push({
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'ensemble_blend',
        condition_id: market.condition_id,
        token_id: buyTokenId,
        side: 'BUY',
        outcome: buySide,
        strength: Math.min(1.0, ensemble.divergence * 10),
        edge,
        model_prob: Math.min(0.99, modelProb),
        market_price: buyPrice,
        recommended_size_usd: 10,
        metadata: {
          question: market.question,
          sub_strategy: 'ensemble_blend',
          kalshi_ticker: kalshiMarket.ticker,
          kalshi_yes_price: kalshiMarket.yesPrice,
          blended_prob: ensemble.blendedProb,
          divergence: ensemble.divergence,
          match_similarity: match.similarity,
          poly_weight: ensemble.polyWeight,
          kalshi_weight: ensemble.kalshiWeight,
        },
        created_at: new Date(),
      });
      this.recent.set(key, Date.now());
    }

    if (signals.length > 0) {
      log.info({ count: signals.length, kalshi_markets: kalshiMarkets.length }, 'Cross-market divergence signals generated');
    }
    return signals;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [k, t] of this.recent) if (now - t > DEDUP_TTL_MS) this.recent.delete(k);
  }
}
