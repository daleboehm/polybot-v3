// Macro-forecast strategy — FRED-driven Fed rate decision markets.
//
// R3a (2026-04-10). Per design-decisions §N3: Polymarket macro markets (Fed
// rate decisions, CPI prints, unemployment prints) are priced by retail that
// rarely reads Fed data directly. FRED has the authoritative data. A simple
// Fed reaction function based on current fed funds, trailing CPI, and
// trailing unemployment beats retail consensus on 10-30 macro markets at
// any given time.
//
// Market detection: look for "Fed", "rate cut", "FOMC", "CPI", "inflation",
// "unemployment", "jobs report" in the market question.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import type { FredClient } from '../../market/fred-client.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:macro-forecast');
const DEDUP_TTL_MS = 6 * 60 * 60 * 1000; // 6h — macro markets move slowly
const MIN_DIVERGENCE = 0.05; // wider than sports (higher uncertainty in the model)

const FED_KEYWORDS = ['fed', 'rate cut', 'rate hike', 'fomc', 'federal reserve', 'fed funds'];
const CPI_KEYWORDS = ['cpi', 'inflation', 'consumer price'];
const UNEMP_KEYWORDS = ['unemployment', 'jobs report', 'nfp', 'non-farm', 'nonfarm payroll'];

export class MacroForecastStrategy extends BaseStrategy {
  readonly id = 'macro_forecast';
  readonly name = 'Macro Forecast';
  readonly description = 'FRED-driven Fed/CPI/unemployment market predictions';
  readonly version = '3.0.0';

  private recent = new Map<string, number>();

  constructor(private fred: FredClient) {
    super();
  }

  override getSubStrategies(): string[] {
    return ['fed_reaction'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();
    const signals: Signal[] = [];

    // Pre-compute Fed reaction probability (cached daily)
    const probCut = await this.fred.fedReactionProbCut();
    if (probCut === null) {
      log.debug('FRED data unavailable — no macro-forecast signals this cycle');
      return signals;
    }

    const markets = ctx.getActiveMarkets();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;
      if (!market.yes_price || !market.no_price) continue;

      const question = (market.question ?? '').toLowerCase();
      const isFedRate = FED_KEYWORDS.some(k => question.includes(k));
      const isCpi = CPI_KEYWORDS.some(k => question.includes(k));
      const isUnemp = UNEMP_KEYWORDS.some(k => question.includes(k));
      if (!isFedRate && !isCpi && !isUnemp) continue;

      // For Fed rate markets: "Will the Fed cut rates in [month]?" — YES on
      // cut. The reaction function gives the implied prob directly.
      // For CPI/unemployment markets the reaction function doesn't map cleanly,
      // so we only fire for Fed rate decision questions in R3a. CPI and
      // unemployment forecasts are R4 scope.
      if (!isFedRate) continue;

      const isCutQuestion = question.includes('cut');
      const isHikeQuestion = question.includes('hike') || question.includes('raise');
      if (!isCutQuestion && !isHikeQuestion) continue;

      const modelProb = isCutQuestion ? probCut : (1 - probCut);
      const polyYesProb = market.yes_price;
      const divergence = modelProb - polyYesProb;

      if (Math.abs(divergence) < MIN_DIVERGENCE) continue;

      // If our model says YES prob is higher than Polymarket → buy YES
      // If lower → buy NO
      const buySide: 'YES' | 'NO' = divergence > 0 ? 'YES' : 'NO';
      const buyPrice = buySide === 'YES' ? market.yes_price : market.no_price;
      const buyTokenId = buySide === 'YES' ? market.token_yes_id : market.token_no_id;
      const sideProb = buySide === 'YES' ? modelProb : (1 - modelProb);
      const edge = sideProb - buyPrice;
      if (edge < MIN_DIVERGENCE) continue;

      const key = `macro_forecast:${market.condition_id}`;
      if (this.recent.has(key)) continue;

      signals.push({
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'fed_reaction',
        condition_id: market.condition_id,
        token_id: buyTokenId,
        side: 'BUY',
        outcome: buySide,
        strength: Math.min(1.0, Math.abs(divergence) * 5),
        edge,
        model_prob: Math.min(0.99, sideProb),
        market_price: buyPrice,
        recommended_size_usd: 10,
        metadata: {
          question: market.question,
          sub_strategy: 'fed_reaction',
          fed_reaction_prob_cut: probCut,
          divergence,
          is_cut_question: isCutQuestion,
        },
        created_at: new Date(),
      });
      this.recent.set(key, Date.now());
    }

    if (signals.length > 0) {
      log.info({ count: signals.length, prob_cut: probCut }, 'Macro-forecast signals generated');
    }
    return signals;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [k, t] of this.recent) if (now - t > DEDUP_TTL_MS) this.recent.delete(k);
  }
}
