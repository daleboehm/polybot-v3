// Wash-trading penalty — phase A3 (2026-04-11).
//
// Research context: Columbia Nov 2025 study found that ~25% of Polymarket
// volume between Apr 2023 and Oct 2025 was wash-traded. The number peaked
// at 60% in Dec 2024 and exceeded 90% in individual sports/election
// airdrop-speculation weeks. 14% of all wallets (out of 1.26M) were
// flagged as wash-trading.
//
// Our position sizing currently reads `volume_24h` and `liquidity` at
// face value. On a market where half the volume is fake, that means we
// over-allocate by ~2x to a market whose true liquidity is half of what
// it looks like. Every strategy inherits this bias because Kelly +
// correlation + envelope all read those same fields.
//
// The IDEAL fix would be to track unique counterparties per market over
// a 7-day window and compute a true `distinct_makers_takers /
// total_trades` ratio. We do NOT currently subscribe to the Polygon logs
// needed to compute that, and adding it is a Phase F item (whale event
// tracker). This module is the Phase A1 proxy — NOT as accurate but
// captures the biggest false-liquidity signal cheaply using data already
// in our market cache.
//
// Proxy signal: volume-to-liquidity churn ratio + category multiplier.
//
//   churn_ratio = volume_24h / max(liquidity, $100)
//
//   A genuine book with real depth has moderate churn — maybe 1x to
//   5x per day. Wash-traded books look like $500 liquidity + $50K
//   volume = 100x churn. That's the signal.
//
// Category multiplier: sports and election markets in high-airdrop
// windows get a HARDER penalty because the Columbia data showed
// wash-trading concentration there. We detect these from market tags.
//
// Output: a multiplier in [0.1, 1.0] applied to the strategy's
// recommended_size_usd BEFORE the risk engine's other caps.

import type { MarketData } from '../types/index.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('wash-trading-penalty');

// Thresholds — tunable
const CHURN_THRESHOLD_MILD = 20;       // >20x churn = suspicious
const CHURN_THRESHOLD_HIGH = 50;       // >50x churn = heavily suspicious
const CHURN_THRESHOLD_EXTREME = 100;   // >100x churn = near-certain wash

const MILD_MULTIPLIER = 0.8;           // 20% haircut
const HIGH_MULTIPLIER = 0.5;           // 50% haircut
const EXTREME_MULTIPLIER = 0.3;        // 70% haircut

// Categories with concentrated wash-trading per Columbia 2025
const HIGH_RISK_CATEGORY_TAGS = [
  'sports',
  'sport',
  'election',
  'politics',
  'political',
  'nfl',
  'nba',
  'mlb',
  'nhl',
  'soccer',
  'ufc',
];

const HIGH_RISK_CATEGORY_MULTIPLIER = 0.7; // extra 30% haircut on top

/**
 * Compute the churn ratio for a market: volume_24h / liquidity.
 * Higher = more turnover on smaller book = more suspicious.
 * Returns 0 if data is missing / zero.
 */
export function churnRatio(market: MarketData): number {
  const vol = market.volume_24h ?? 0;
  const liq = Math.max(100, market.liquidity ?? 0);
  if (vol <= 0 || liq <= 0) return 0;
  return vol / liq;
}

/**
 * Check if market is in a high-risk category (sports/election/etc.)
 * based on its tags.
 */
export function isHighRiskCategory(market: MarketData): boolean {
  if (!market.tags || market.tags.length === 0) return false;
  const lowerTags = market.tags.map(t => t.toLowerCase());
  return HIGH_RISK_CATEGORY_TAGS.some(risk =>
    lowerTags.some(tag => tag.includes(risk)),
  );
}

/**
 * Return the size multiplier for a given market based on its wash-trading
 * risk profile. Multiplier in [0.1, 1.0]. 1.0 = no penalty; 0.1 = near-
 * total rejection.
 *
 * Implementation: multiply the churn-ratio multiplier by the category
 * multiplier, so an extreme-churn market in a high-risk category gets
 * hit twice (0.3 * 0.7 = 0.21, a ~79% haircut).
 */
export function washTradingMultiplier(market: MarketData): {
  multiplier: number;
  churn: number;
  highRiskCategory: boolean;
  reason: string | null;
} {
  const churn = churnRatio(market);
  const highRisk = isHighRiskCategory(market);

  // Base multiplier from churn
  let base = 1.0;
  let churnLevel: 'none' | 'mild' | 'high' | 'extreme' = 'none';
  if (churn >= CHURN_THRESHOLD_EXTREME) {
    base = EXTREME_MULTIPLIER;
    churnLevel = 'extreme';
  } else if (churn >= CHURN_THRESHOLD_HIGH) {
    base = HIGH_MULTIPLIER;
    churnLevel = 'high';
  } else if (churn >= CHURN_THRESHOLD_MILD) {
    base = MILD_MULTIPLIER;
    churnLevel = 'mild';
  }

  // Additional category haircut
  const categoryMult = highRisk ? HIGH_RISK_CATEGORY_MULTIPLIER : 1.0;
  let finalMult = base * categoryMult;

  // Floor at 0.1 — never zero out entirely; if the strategy has a real
  // edge we still want to take a small position and measure.
  finalMult = Math.max(0.1, Math.min(1.0, finalMult));

  let reason: string | null = null;
  if (finalMult < 1.0) {
    const parts: string[] = [];
    if (churnLevel !== 'none') parts.push(`churn=${churn.toFixed(1)}x(${churnLevel})`);
    if (highRisk) parts.push('high-risk-category');
    reason = parts.join(', ');
  }

  return {
    multiplier: finalMult,
    churn,
    highRiskCategory: highRisk,
    reason,
  };
}

/**
 * Logging helper used by position-sizer when applying the penalty, so
 * we can see in the logs which markets are being haircut and why.
 */
export function logPenaltyDecision(
  conditionId: string,
  result: { multiplier: number; churn: number; highRiskCategory: boolean; reason: string | null },
): void {
  if (result.multiplier < 1.0) {
    log.debug(
      {
        condition_id: conditionId.substring(0, 12),
        multiplier: result.multiplier,
        churn: Math.round(result.churn * 10) / 10,
        high_risk: result.highRiskCategory,
        reason: result.reason,
      },
      'Wash-trading penalty applied',
    );
  }
}
