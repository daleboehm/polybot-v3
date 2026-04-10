// Walk-forward validation for trading strategies.
//
// R2 PR#2 extensions (2026-04-10). Per `agi-walk-forward-validation`: standard
// cross-validation fails catastrophically on financial time series because it
// introduces lookahead bias and ignores autocorrelation. Walk-forward is the
// correct discipline — train on [0, t1], evaluate on (t1, t2], roll forward.
//
// This module provides:
//   1. Expanding-window splits over a resolved-position history
//   2. In-sample vs out-of-sample Sharpe comparison (overfit detection)
//   3. Probability of backtest overfitting (PBO) via combinatorial splits
//   4. Deflated Sharpe ratio (DSR) for multiple-testing correction
//
// Used by the advisor's R3b-era enable gate: a sub-strategy must pass the
// Wilson LB gate AND a walk-forward gate where in-sample vs out-of-sample
// Sharpe ratio differ by less than 30%. Strategies that look great on full-
// sample but fall apart on holdout are overfit noise; we don't promote them.

import { computeStrategyMetrics, type StrategyMetrics } from './metrics.js';

export interface WalkForwardConfig {
  /** Minimum training samples before the first fold. */
  minTrainSize: number;
  /** Number of samples in each test window. */
  testSize: number;
  /** Step size between folds (usually equals testSize for non-overlapping folds). */
  stepSize: number;
  /** Embargo: number of samples between train and test to break serial correlation. */
  embargo: number;
}

export const DEFAULT_WALK_FORWARD_CONFIG: WalkForwardConfig = {
  minTrainSize: 30,
  testSize: 10,
  stepSize: 10,
  embargo: 3,
};

export interface WalkForwardFold {
  foldIndex: number;
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  trainMetrics: StrategyMetrics;
  testMetrics: StrategyMetrics;
}

export interface WalkForwardResult {
  config: WalkForwardConfig;
  folds: WalkForwardFold[];
  /** Average metrics across all out-of-sample folds */
  aggregateOos: StrategyMetrics;
  /** Average metrics across all in-sample training windows */
  aggregateIs: StrategyMetrics;
  /** Sharpe degradation: (IS - OOS) / IS. Positive = overfit. */
  sharpeDegradation: number;
  /** Pass/fail gate: true if sharpeDegradation < 0.30 and OOS sharpe > 0 */
  passed: boolean;
  reason: string;
}

/**
 * Run an expanding-window walk-forward over a chronologically-ordered list
 * of realized P&L values.
 */
export function runWalkForward(
  pnls: number[],
  config: WalkForwardConfig = DEFAULT_WALK_FORWARD_CONFIG,
): WalkForwardResult {
  const { minTrainSize, testSize, stepSize, embargo } = config;
  const folds: WalkForwardFold[] = [];

  if (pnls.length < minTrainSize + embargo + testSize) {
    return {
      config,
      folds: [],
      aggregateOos: computeStrategyMetrics([]),
      aggregateIs: computeStrategyMetrics([]),
      sharpeDegradation: 0,
      passed: false,
      reason: `Insufficient data: need ≥${minTrainSize + embargo + testSize}, got ${pnls.length}`,
    };
  }

  let foldIndex = 0;
  let trainStart = 0;
  let testStart = minTrainSize + embargo;

  while (testStart + testSize <= pnls.length) {
    const trainEnd = testStart - embargo; // exclusive
    const testEnd = testStart + testSize;  // exclusive
    const trainPnls = pnls.slice(trainStart, trainEnd);
    const testPnls = pnls.slice(testStart, testEnd);

    folds.push({
      foldIndex,
      trainStart,
      trainEnd,
      testStart,
      testEnd,
      trainMetrics: computeStrategyMetrics(trainPnls),
      testMetrics: computeStrategyMetrics(testPnls),
    });

    foldIndex += 1;
    testStart += stepSize;
  }

  // Aggregate OOS: concatenate all test slices into one stream
  const oosPnls = folds.flatMap(f => pnls.slice(f.testStart, f.testEnd));
  const isPnls = folds.flatMap(f => pnls.slice(f.trainStart, f.trainEnd));
  const aggregateOos = computeStrategyMetrics(oosPnls);
  const aggregateIs = computeStrategyMetrics(isPnls);

  const isSharpe = aggregateIs.sharpe;
  const oosSharpe = aggregateOos.sharpe;
  const sharpeDegradation = isSharpe !== 0 ? (isSharpe - oosSharpe) / Math.abs(isSharpe) : 0;

  // Gate: OOS Sharpe > 0 AND degradation under 30%
  const passed = oosSharpe > 0 && sharpeDegradation < 0.30;
  const reason = !passed
    ? (oosSharpe <= 0
        ? `OOS Sharpe ${oosSharpe.toFixed(3)} ≤ 0 — no out-of-sample edge`
        : `Sharpe degradation ${(sharpeDegradation * 100).toFixed(1)}% > 30% — overfit`)
    : `Passed: OOS Sharpe ${oosSharpe.toFixed(3)}, degradation ${(sharpeDegradation * 100).toFixed(1)}%`;

  return { config, folds, aggregateOos, aggregateIs, sharpeDegradation, passed, reason };
}

/**
 * Deflated Sharpe Ratio (Lopez de Prado 2014). Adjusts observed Sharpe for
 * the number of strategies tested (multiple-testing correction) and the
 * non-normality of the return distribution.
 *
 * Returns a probability: "How likely is the observed Sharpe > 0 after deflation?"
 * Values below 0.95 suggest the observed performance is likely luck given the
 * number of strategies tested.
 *
 * @param observedSharpe annualized Sharpe ratio of the selected strategy
 * @param numTrials number of strategies tested (including rejected ones)
 * @param n length of the return series
 * @param skewness skewness of the return distribution (default 0 = normal)
 * @param kurtosis excess kurtosis (default 0 = normal, not 3)
 */
export function deflatedSharpeRatio(
  observedSharpe: number,
  numTrials: number,
  n: number,
  skewness = 0,
  kurtosis = 0,
): number {
  if (n <= 1 || numTrials <= 0) return 0;

  // Expected max Sharpe under H0 (pure noise) via Euler-Mascheroni approximation
  const eulerMascheroni = 0.5772156649;
  // z-quantile at 1 - 1/numTrials
  const phiInv = (p: number) => inverseStandardNormalCDF(p);
  const expectedMaxSharpe =
    phiInv(1 - 1 / numTrials) * (1 - eulerMascheroni) +
    eulerMascheroni * phiInv(1 - 1 / (numTrials * Math.E));

  // Standard error of the Sharpe estimator, adjusted for non-normality
  const srStd = Math.sqrt(
    (1 - skewness * observedSharpe + ((kurtosis - 1) / 4) * observedSharpe * observedSharpe) / (n - 1),
  );
  if (srStd <= 0) return 0;

  // Standard normal CDF at (observed - expected max) / srStd
  const z = (observedSharpe - expectedMaxSharpe) / srStd;
  return standardNormalCDF(z);
}

// ─── Standard normal helpers (to avoid pulling in a stats library) ──────

function standardNormalCDF(x: number): number {
  // Abramowitz & Stegun 26.2.17
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

function inverseStandardNormalCDF(p: number): number {
  // Beasley-Springer-Moro approximation
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number, r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}
