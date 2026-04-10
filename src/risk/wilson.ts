// Wilson score confidence interval for binomial proportions.
//
// Per `ar-statistical-analyst` + `agi-kelly-criterion`: always use the LOWER BOUND
// of the Wilson confidence interval for win-rate estimates rather than the point
// estimate. The raw win rate at small n is noise — Wilson gives a conservative
// lower bound that prevents overbetting due to sampling luck.
//
// This file is the single source of truth for all Wilson-based decisions in v3:
//   - R&D weighter tier assignment (avoid/monitor/buy)
//   - Advisor promote/disable gates
//   - Risk-adjusted strategy metrics in v_strategy_performance
//
// Reference: https://en.wikipedia.org/wiki/Binomial_proportion_confidence_interval

/**
 * Wilson score lower bound at a given confidence level.
 *
 * @param wins number of successes (wins)
 * @param n total trials (resolutions)
 * @param z z-score for the confidence level (default 1.96 = 95% two-sided)
 * @returns lower bound of the Wilson score interval, clamped to [0, 1]
 *
 * @example
 *   wilsonLowerBound(5, 10)         // ~0.237 — at n=10, 50% WR is statistically noise
 *   wilsonLowerBound(30, 50)        // ~0.474 — at n=50, 60% WR just barely crosses 0.50
 *   wilsonLowerBound(60, 100)       // ~0.503 — at n=100, 60% WR is meaningful signal
 */
export function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  if (wins < 0 || wins > n) {
    throw new Error(`wilsonLowerBound: wins=${wins} out of range for n=${n}`);
  }
  const phat = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n)) / denom;
  return Math.max(0, Math.min(1, center - halfWidth));
}

/**
 * Wilson score upper bound at a given confidence level. Used by the advisor's
 * DISABLE gate: a sub-strategy is only disabled when we're 95% confident its true
 * win rate is below 0.50. Prevents killing a merely-unlucky 47% strategy that
 * might still have positive EV.
 */
export function wilsonUpperBound(wins: number, n: number, z = 1.96): number {
  if (n <= 0) return 1;
  if (wins < 0 || wins > n) {
    throw new Error(`wilsonUpperBound: wins=${wins} out of range for n=${n}`);
  }
  const phat = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (phat + (z * z) / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n)) / denom;
  return Math.max(0, Math.min(1, center + halfWidth));
}

/**
 * The full Wilson score interval as [lower, upper]. Useful for dashboard display
 * and alert thresholds when both ends matter.
 */
export function wilsonInterval(wins: number, n: number, z = 1.96): [number, number] {
  return [wilsonLowerBound(wins, n, z), wilsonUpperBound(wins, n, z)];
}

/**
 * Classify a (wins, n) observation against Dale's Avoid/Monitor/Buy tier gates
 * per the 2026-04-10 design decision (rebuild-design-decisions-2026-04-10.md §A).
 *
 * These are the thresholds the R&D strategy weighter uses:
 *   - **Buy**:    Wilson LB ≥ 0.52 AND n ≥ 30
 *   - **Avoid**:  Wilson LB < 0.45 AND n ≥ 30
 *   - **Monitor** everything else (brand-new, ambiguous, or insufficient data)
 */
export type Tier = 'avoid' | 'monitor' | 'buy';

export function classifyTier(wins: number, n: number): { tier: Tier; lb: number } {
  if (n < 30) return { tier: 'monitor', lb: wilsonLowerBound(wins, n) };
  const lb = wilsonLowerBound(wins, n);
  if (lb >= 0.52) return { tier: 'buy', lb };
  if (lb < 0.45) return { tier: 'avoid', lb };
  return { tier: 'monitor', lb };
}
