// Market sophistication / casualness scoring.
//
// 2026-04-16 Fix 5. Academic consensus on the favorite-longshot bias:
//   - 2-5% in LOW-VOLUME sports/entertainment markets (casual, inefficient)
//   - near-zero in HIGH-VOLUME crypto/major-political markets (sophisticated
//     CLOB-heavy, book is close to fair)
//
// `favorites/stratified_bias` is -$147 all-time (35.1% WR on 194 resolutions)
// because it fires on ALL markets in the 40-60% price band, not just the
// ones where the bias is structurally present. Gating on a casualness score
// filters out sophisticated markets where the 35.1% WR is actually the
// right answer (because there was no bias to capture) and keeps the
// strategy on markets where the bias is real.
//
// The score is 0-3, one point per "casual" dimension:
//   - VOLUME: 24h volume < $50K → casual point (+1)
//   - CATEGORY: sports/entertainment/weather → casual point (+1)
//                crypto/major-political → sophisticated (+0)
//   - HORIZON: time-to-resolution > 14 days → casual point (+1)
//                ≤ 14 days → sophisticated (close-in markets attract sharps)
//
// Downstream strategies require score ≥ 2 to fire. A market needs to be
// casual on at least 2 of 3 dimensions to be worth the stratified-bias bet.

import type { MarketData } from '../types/index.js';

const LOW_VOLUME_THRESHOLD_USD = 50_000;
const LONG_HORIZON_DAYS = 14;

// Category keyword patterns — order matters (more specific first).
// Sophisticated categories are checked first; if no match, check casual.
const SOPHISTICATED_PATTERNS: RegExp[] = [
  /\b(btc|bitcoin|ethereum|eth|crypto|token)\b/i,
  /\b(fed|fomc|rate decision|powell|fed funds|cpi|ppi)\b/i,
  /\b(presidential|president of the united states|potus)\b/i,
  // Major national elections (e.g., US, UK, French general election)
  /\b(general election|presidential election)\b/i,
  /\b(s&p|sp500|nasdaq|dow jones)\b/i,
];

const CASUAL_PATTERNS: RegExp[] = [
  // Sports
  /\b(mlb|nba|nfl|nhl|mls|epl|nba|ncaa|fifa|world cup|super bowl|nba finals)\b/i,
  /\b(match|game|vs\.?|vs |opponent|playoff|playoffs|championship)\b/i,
  // Entertainment / awards / celebrity
  /\b(oscars|emmys|grammys|tony|award|music|artist|singer|actor|celebrity)\b/i,
  /\b(movie|film|box office|netflix|stream|season)\b/i,
  // Weather
  /\b(temperature|weather|forecast|rain|snow|hurricane|storm)\b/i,
  // Local / entertainment political (state-level, governor, mayor)
  /\b(governor|mayor|state senate|state house)\b/i,
];

export interface SophisticationBreakdown {
  casual_score: number;                // 0-3, higher = more casual
  volume_casual: boolean;
  category_casual: boolean;
  horizon_casual: boolean;
  matched_category: 'sophisticated' | 'casual' | 'unknown';
  volume_24h: number;
  hours_to_resolve: number;
}

export function scoreCasualness(
  market: Pick<MarketData, 'question' | 'volume_24h' | 'tags' | 'end_date'>,
): SophisticationBreakdown {
  const q = market.question ?? '';
  const volume = market.volume_24h ?? 0;
  const endTime = market.end_date?.getTime() ?? Date.now();
  const hoursToResolve = Math.max(0, (endTime - Date.now()) / (1000 * 60 * 60));
  const days = hoursToResolve / 24;

  // Dimension 1: volume
  const volume_casual = volume < LOW_VOLUME_THRESHOLD_USD;

  // Dimension 2: category. Sophisticated wins ties — if a question mentions
  // both crypto and sports ("Will BTC price beat NBA score"), the crypto
  // reference pulls it into the efficient bucket.
  let category_casual = false;
  let matched_category: SophisticationBreakdown['matched_category'] = 'unknown';
  for (const pat of SOPHISTICATED_PATTERNS) {
    if (pat.test(q)) {
      matched_category = 'sophisticated';
      category_casual = false;
      break;
    }
  }
  if (matched_category === 'unknown') {
    // Check tags too — Polymarket tags things like "Sports", "Crypto"
    const tagsLower = (market.tags ?? []).map(t => t.toLowerCase());
    const hasSophTag = tagsLower.some(t =>
      t === 'crypto' || t === 'macroeconomics' || t === 'politics' || t === 'economics',
    );
    if (hasSophTag) {
      matched_category = 'sophisticated';
      category_casual = false;
    } else {
      for (const pat of CASUAL_PATTERNS) {
        if (pat.test(q)) {
          matched_category = 'casual';
          category_casual = true;
          break;
        }
      }
      if (matched_category === 'unknown') {
        const hasCasualTag = tagsLower.some(t =>
          t === 'sports' || t === 'entertainment' || t === 'weather' || t === 'culture',
        );
        if (hasCasualTag) {
          matched_category = 'casual';
          category_casual = true;
        }
      }
    }
  }

  // Dimension 3: horizon. Long-dated (> 14d) markets are less watched by
  // sharps — they're the ones casual traders buy-and-hold.
  const horizon_casual = days > LONG_HORIZON_DAYS;

  const casual_score =
    (volume_casual ? 1 : 0) +
    (category_casual ? 1 : 0) +
    (horizon_casual ? 1 : 0);

  return {
    casual_score,
    volume_casual,
    category_casual,
    horizon_casual,
    matched_category,
    volume_24h: volume,
    hours_to_resolve: hoursToResolve,
  };
}

/**
 * Convenience predicate: is this market "casual enough" to take a
 * favorite-longshot bias trade on?
 *
 * Default threshold is 2 — market needs to be casual on at least 2 of 3
 * dimensions. Override per-strategy if needed.
 */
export function isCasualEnoughForBiasTrade(
  market: Pick<MarketData, 'question' | 'volume_24h' | 'tags' | 'end_date'>,
  minScore = 2,
): boolean {
  return scoreCasualness(market).casual_score >= minScore;
}
