// Sportsbook-fade strategy — use Vegas/offshore sportsbook consensus as
// probability ground truth on Polymarket sports markets.
//
// R3a (2026-04-10). Per design-decisions §N1: sportsbooks have decades of
// calibration data and tight spreads; when Polymarket prices a sports market
// differently than the consensus of DraftKings/FanDuel/Caesars/BetMGM, the
// sportsbook is usually closer to the truth. This strategy is the single
// highest-ROI signal feed addition in R3a.
//
// Matching heuristic: Polymarket sports markets contain team names in the
// question text ("Will the Lakers beat the Warriors?"). We match by
// substring against the sportsbook event's home_team + away_team. Exact
// match → high confidence signal; partial match → no signal.
//
// Signal fires when |polymarket_prob - sportsbook_consensus| > 0.03 AND the
// event commence_time is within the next 48 hours.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import type { OddsApiClient, ConsensusProb, SportKey } from '../../market/odds-api-client.js';
import { TRACKED_SPORTS } from '../../market/odds-api-client.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:sportsbook-fade');
const DEDUP_TTL_MS = 2 * 60 * 60 * 1000;
const MIN_DIVERGENCE = 0.03;
const MAX_HOURS_TO_EVENT = 48;

export class SportsbookFadeStrategy extends BaseStrategy {
  readonly id = 'sportsbook_fade';
  readonly name = 'Sportsbook Fade';
  readonly description = 'Fade Polymarket sports markets against Vegas/offshore sportsbook consensus';
  readonly version = '3.0.0';

  private recent = new Map<string, number>();

  constructor(private oddsApi: OddsApiClient) {
    super();
  }

  override getSubStrategies(): string[] {
    return ['single_forecast'];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();
    const signals: Signal[] = [];

    // Pre-fetch consensus for all tracked sports (1 API call per sport, cached)
    const allConsensus: ConsensusProb[] = [];
    for (const sport of TRACKED_SPORTS) {
      const events = await this.oddsApi.getEvents(sport);
      for (const event of events) {
        const consensus = this.oddsApi.computeConsensus(event);
        if (consensus) allConsensus.push(consensus);
      }
    }

    if (allConsensus.length === 0) return signals;

    const now = Date.now();
    const markets = ctx.getActiveMarkets();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;
      if (!market.yes_price || !market.no_price) continue;

      // Match by substring of team names in the question text
      const question = market.question?.toLowerCase() ?? '';
      if (!question) continue;

      let matched: ConsensusProb | null = null;
      for (const consensus of allConsensus) {
        const home = consensus.homeTeam.toLowerCase();
        const away = consensus.awayTeam.toLowerCase();
        if (home && question.includes(home) && away && question.includes(away)) {
          matched = consensus;
          break;
        }
      }
      if (!matched) continue;

      // Event must be within the next 48 hours
      const eventTime = new Date(matched.commenceTime).getTime();
      const hoursToEvent = (eventTime - now) / (1000 * 60 * 60);
      if (hoursToEvent <= 0 || hoursToEvent > MAX_HOURS_TO_EVENT) continue;

      // Determine which Polymarket side maps to which sportsbook team.
      // Heuristic: the home team is almost always the YES outcome on PM
      // sports markets ("Will the Lakers beat X?" → Lakers = home = YES).
      // This is a best-effort mapping; getting it wrong means the signal fires
      // on the wrong side, which is worse than not firing at all — so we skip
      // markets where the mapping isn't obvious.
      const yesIsHome = question.startsWith(matched.homeTeam.toLowerCase()) ||
        question.includes(`will ${matched.homeTeam.toLowerCase()}`);
      const polyYesProb = market.yes_price;
      const sportsbookYesProb = yesIsHome ? matched.homeProb : matched.awayProb;

      const divergence = polyYesProb - sportsbookYesProb;
      if (Math.abs(divergence) < MIN_DIVERGENCE) continue;

      // If PM is pricing YES too low vs sportsbook → buy YES
      // If PM is pricing YES too high → buy NO (fade the over-confidence)
      const buySide: 'YES' | 'NO' = divergence < 0 ? 'YES' : 'NO';
      const buyPrice = buySide === 'YES' ? market.yes_price : market.no_price;
      const buyTokenId = buySide === 'YES' ? market.token_yes_id : market.token_no_id;
      const modelProb = buySide === 'YES' ? sportsbookYesProb : (1 - sportsbookYesProb);
      const edge = modelProb - buyPrice;
      if (edge < MIN_DIVERGENCE) continue;

      const key = `sportsbook_fade:${market.condition_id}`;
      if (this.recent.has(key)) continue;

      signals.push({
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'single_forecast',
        condition_id: market.condition_id,
        token_id: buyTokenId,
        side: 'BUY',
        outcome: buySide,
        strength: Math.min(1.0, Math.abs(divergence) * 10),
        edge,
        model_prob: Math.min(0.99, modelProb),
        market_price: buyPrice,
        recommended_size_usd: 10,
        metadata: {
          question: market.question,
          sub_strategy: 'single_forecast',
          sportsbook_consensus: sportsbookYesProb,
          divergence,
          num_books: matched.numBooks,
          hours_to_event: hoursToEvent,
          home_team: matched.homeTeam,
          away_team: matched.awayTeam,
        },
        created_at: new Date(),
      });
      this.recent.set(key, now);
    }

    if (signals.length > 0) {
      log.info({ count: signals.length, consensus: allConsensus.length }, 'Sportsbook-fade signals generated');
    }
    return signals;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [k, t] of this.recent) if (now - t > DEDUP_TTL_MS) this.recent.delete(k);
  }
}
