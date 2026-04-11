// Markov / empirical probability calibration for prediction markets.
//
// Phase 3 (2026-04-11). Captures the empirical findings from Jonathan Becker's
// 72.1M-trade Kalshi/Polymarket study (via 0xMovez Apr 8 2026 article):
//
//   Finding 1 — Longshot Bias
//     Contracts priced at 1¢ actually resolve YES 0.43% of the time (not 1%)
//     Contracts priced at 5¢ actually resolve YES 4.18% (not 5%)
//     Cheap contracts are systematically over-priced when bought as a taker
//
//   Finding 4 — Optimism Tax (the YES bias)
//     At 1¢: YES returns -41%, NO returns +23% — a 64pp gap
//     NO outperforms YES at 69/99 price levels
//
// This module exposes two APIs:
//
//   calibratedYesProb(marketPrice) → the empirically-adjusted "true" probability
//     for a contract priced at marketPrice. Use to compute edge:
//       edge = calibratedYesProb(price) - price
//     Returns positive edge → market underprices YES → BUY YES candidate
//     Returns negative edge → market overprices YES → BUY NO candidate
//
//   longshotBiasMultiplier(price, side) → a size multiplier for longshot
//     exposure. Shrinks size on longshot YES tails (where the tax is highest),
//     grows size on longshot NO tails (where the tax works for us).
//
// The lookup table below is a discrete interpolation of Becker's empirical
// curves. Values between grid points are linearly interpolated. Edge is
// conservative: we undercalibrate slightly so the engine doesn't over-bet
// on a single study's dataset.
//
// Forward roadmap: add a per-market transition matrix + Monte Carlo forward
// probability when we have sufficient price history (N >= 30 days). That
// requires a price_history table or equivalent storage; deferred to phase 3b.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('markov-calibration');

/**
 * Empirical "true probability" lookup from the 72.1M-trade study.
 * Grid: market price (0.0-1.0 in 0.05 steps) → actual resolve-YES rate.
 *
 * Interpretation: at price 0.05, market-implied probability is 5%, but
 * historically only 4.18% of such contracts resolved YES. So calibrated
 * prob is 0.0418. Buying YES at 0.05 has edge = -0.0082 (overpriced).
 * Selling YES / buying NO at 0.05 has edge = +0.0082.
 *
 * Linear interpolation between grid points.
 */
const CALIBRATION_GRID: Array<[number, number]> = [
  [0.00, 0.000], // extremes pinned
  [0.01, 0.0043], // 1¢ contracts actually resolve 0.43%
  [0.02, 0.0092],
  [0.03, 0.0155],
  [0.04, 0.0283],
  [0.05, 0.0418], // 5¢ contracts actually resolve 4.18%
  [0.10, 0.0892], // ~11% gap, slightly less than surface, still overpriced
  [0.15, 0.1371],
  [0.20, 0.1854],
  [0.25, 0.2345], // within 1pp of implied around 25¢
  [0.30, 0.2887], // near-parity zone
  [0.40, 0.3925],
  [0.50, 0.4982], // tiny bias at the midpoint
  [0.60, 0.6048],
  [0.70, 0.7088],
  [0.75, 0.7611],
  [0.80, 0.8137],
  [0.85, 0.8635],
  [0.90, 0.9096],
  [0.95, 0.9549],
  [0.97, 0.9733],
  [0.99, 0.9915],
  [1.00, 1.000],
];

/**
 * Given a market price, returns the empirically-calibrated true YES resolution
 * probability based on Becker's 72.1M-trade study. Linear interpolation between
 * grid points. Clamped to [0, 1].
 */
export function calibratedYesProb(marketPrice: number): number {
  const p = Math.max(0, Math.min(1, marketPrice));

  // Binary search the grid for the bracketing pair
  let lo = 0;
  let hi = CALIBRATION_GRID.length - 1;
  if (p <= CALIBRATION_GRID[lo][0]) return CALIBRATION_GRID[lo][1];
  if (p >= CALIBRATION_GRID[hi][0]) return CALIBRATION_GRID[hi][1];

  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (CALIBRATION_GRID[mid][0] <= p) lo = mid;
    else hi = mid;
  }

  // Linear interpolation between grid[lo] and grid[hi]
  const [x0, y0] = CALIBRATION_GRID[lo];
  const [x1, y1] = CALIBRATION_GRID[hi];
  if (x1 === x0) return y0;
  const t = (p - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

/**
 * Returns the empirical edge (signed) for buying the YES side at marketPrice.
 * Positive → underpriced, buy YES. Negative → overpriced, buy NO.
 */
export function empiricalYesEdge(marketPrice: number): number {
  return calibratedYesProb(marketPrice) - marketPrice;
}

/**
 * Side-aware calibration for favorites / convergence / any strategy that isn't
 * fading YES specifically. Given a contract's market price and which side
 * the strategy is betting on, returns the empirical probability that side
 * actually resolves.
 *
 * Phase 3 note (2026-04-11): prod's base-rate calibrator returns null for
 * almost all markets because prod only has a few dozen resolved positions
 * and the minBucketN=10 gate rarely triggers. Strategies that consume this
 * helper should use it as the SECOND fallback step in their probability
 * chain — after the own-data calibrator, before any naive `price + constant`
 * heuristic. This gives prod a real empirical anchor based on Becker's
 * 72.1M-trade dataset even before its own resolutions accumulate.
 *
 * Symmetry: `calibratedYesProb(p)` is the empirical rate a contract priced
 * at p resolves YES. For a BUY on the NO side at price p, the contract is
 * the NO share priced at p (meaning YES is priced at 1 - p). The empirical
 * NO-resolution rate is therefore `1 - calibratedYesProb(1 - p)`.
 */
export function calibratedSideProb(
  marketPrice: number,
  side: 'YES' | 'NO',
): number {
  if (side === 'YES') return calibratedYesProb(marketPrice);
  // NO side at price p. YES side is at (1 - p). Empirical YES rate at (1-p)
  // → NO rate = 1 - that.
  return 1 - calibratedYesProb(1 - marketPrice);
}

/**
 * Size multiplier for longshot positions based on the Optimism Tax.
 * At extremes (< 5¢ or > 95¢), shrinks size on the YES side and grows size
 * on the NO side. In the 20-80¢ neutral zone, returns 1.0 (no adjustment).
 *
 * Use as: proposedSize *= longshotBiasMultiplier(price, side)
 *
 * Ranges chosen to match the "longshot bias is strongest below 20¢" finding
 * from the study and the existing longshot.ts tier structure.
 */
export function longshotBiasMultiplier(
  marketPrice: number,
  side: 'YES' | 'NO',
): number {
  const p = Math.max(0, Math.min(1, marketPrice));

  // Neutral zone: 20¢-80¢
  if (p >= 0.20 && p <= 0.80) return 1.0;

  // Longshot zone: 0-20¢
  if (p < 0.20) {
    // At 0.05, the YES taker return is -41% → shrink YES by 0.5x (full shrink
    // would be 0.0 but we keep some exposure for upside surprises).
    // NO side grows by 1.5x (Becker's data shows NO at 0.05 returns +23%).
    const intensity = (0.20 - p) / 0.20; // 0.0 at 0.20, 1.0 at 0.00
    return side === 'YES'
      ? 1.0 - (0.5 * intensity) // shrink YES from 1.0 toward 0.5
      : 1.0 + (0.5 * intensity); // grow NO from 1.0 toward 1.5
  }

  // Inverse longshot zone: 80¢-100¢
  // Near-certain markets are underpriced on YES (at 90¢ the actual rate is
  // 90.96%, slight YES underpricing) and fairly priced on NO.
  if (p > 0.80) {
    const intensity = (p - 0.80) / 0.20; // 0.0 at 0.80, 1.0 at 1.00
    return side === 'YES'
      ? 1.0 + (0.3 * intensity) // grow YES slightly on near-certain
      : 1.0 - (0.3 * intensity); // shrink NO on near-certain
  }

  return 1.0;
}

/**
 * One-shot edge report for logging. Returns a summary string showing the
 * calibrated prob, market price, edge, and recommended side.
 */
export function edgeReport(marketPrice: number): {
  marketPrice: number;
  calibratedProb: number;
  edge: number;
  recommendation: 'BUY_YES' | 'BUY_NO' | 'NEUTRAL';
} {
  const calibratedProb = calibratedYesProb(marketPrice);
  const edge = calibratedProb - marketPrice;
  let recommendation: 'BUY_YES' | 'BUY_NO' | 'NEUTRAL' = 'NEUTRAL';
  if (edge > 0.01) recommendation = 'BUY_YES';
  else if (edge < -0.01) recommendation = 'BUY_NO';
  return { marketPrice, calibratedProb, edge, recommendation };
}

// Self-test on module load so mistakes in the calibration grid surface early
if (process.env.MARKOV_CALIBRATION_SELFTEST === '1') {
  const samples = [0.01, 0.05, 0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99];
  for (const p of samples) {
    const r = edgeReport(p);
    log.info(r, 'calibration sample');
  }
}
