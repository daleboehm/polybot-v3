// Deflated Sharpe Ratio + Probabilistic Sharpe Ratio — Phase B (2026-04-11).
//
// References:
//   - Bailey & Lopez de Prado, "The Deflated Sharpe Ratio" (2014, SSRN 2460551)
//   - Bailey & Lopez de Prado, "The Sharpe Ratio Efficient Frontier" (SSRN 1821643)
//
// NOTE: `walk-forward.ts` already has a `deflatedSharpeRatio` function from
// an earlier R2 PR, taking a pre-computed Sharpe + skew + kurtosis. This
// module is the successor with three improvements:
//   1. Takes raw returns (not pre-computed moments) — saves the caller a step
//   2. Adds PSR (probability form) and Minimum Track Record Length helpers
//   3. Uses the shared stats-helpers.ts for Φ(x), skew, kurtosis so the
//      numerics are consistent with future validation modules
// The walk-forward.ts DSR remains for backward compatibility with any
// existing callers. New code should import from dsr-psr.ts.
//
// Why this beats our current Wilson LB:
//   1. Wilson only bounds win rate. It's blind to payoff asymmetry — in
//      prediction markets the payoff distribution is heavily skewed.
//   2. We poll many sub-strategies every 5 min. With 14 subs and a 5%
//      p-value threshold, roughly one sub will look "significant" by
//      chance every ~14 evaluations even if all are random. DSR corrects
//      for this multiple-testing bias directly.
//   3. PSR gives us a Minimum Track Record Length per sub-strategy —
//      exactly how many trades we need to trust the Sharpe at 95%.
//      Replaces our hardcoded MIN_N_ENABLE=50 with a data-driven number.
//
// Usage (not yet wired into advisor — Phase B is STAGED not deployed):
//
//   import { probabilisticSharpeRatio, deflatedSharpeRatio } from './dsr-psr.js';
//
//   const returns = loadResolvedReturns(strategyId, subStrategyId);
//   const psr = probabilisticSharpeRatio(returns, 0.5); // benchmark SR = 0.5
//   if (psr < 0.95) continue; // fail the single-strategy gate
//
//   const dsrInfo = deflatedSharpeRatio(returns, numCandidatesPolled);
//   if (dsrInfo.dsr < 0.95) continue; // fail the multiple-testing gate

import {
  normalCdf,
  sampleMean,
  sampleStd,
  sampleSkew,
  sampleKurtosis,
  EULER_MASCHERONI,
} from './stats-helpers.js';

/**
 * Raw Sharpe ratio from a returns series. This is NOT annualized — the
 * caller decides the horizon.
 */
export function rawSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = sampleMean(returns);
  const std = sampleStd(returns);
  if (std === 0) return 0;
  return mean / std;
}

/**
 * Probabilistic Sharpe Ratio — the probability that the "true" Sharpe of
 * a strategy exceeds a benchmark SR.
 *
 * PSR(SR*) = Φ((SR_hat - SR*) * sqrt(n-1) / sqrt(1 - g3*SR_hat + ((g4-1)/4)*SR_hat^2))
 *
 * where:
 *   SR_hat = observed Sharpe ratio
 *   SR*    = benchmark Sharpe we're testing against
 *   n      = number of trades
 *   g3     = sample skewness of returns
 *   g4     = sample kurtosis (non-excess — so normal = 3, we add 1 to excess)
 *
 * Returns a probability in [0, 1]. A PSR of 0.95 means "we're 95% confident
 * the true Sharpe exceeds SR*." Use 0.95 as an enable gate.
 */
export function probabilisticSharpeRatio(
  returns: number[],
  benchmarkSharpe = 0,
): number {
  const n = returns.length;
  if (n < 4) return 0; // not enough data to compute skew/kurtosis reliably

  const srHat = rawSharpe(returns);
  const g3 = sampleSkew(returns);
  const g4Excess = sampleKurtosis(returns);
  const g4 = g4Excess + 3; // convert excess to non-excess kurtosis

  const denom = Math.sqrt(
    1 - g3 * srHat + ((g4 - 1) / 4) * srHat * srHat,
  );
  if (!isFinite(denom) || denom <= 0) return 0;

  const numer = (srHat - benchmarkSharpe) * Math.sqrt(n - 1);
  return normalCdf(numer / denom);
}

/**
 * Minimum Track Record Length — the minimum number of trades needed
 * before we can reject the null hypothesis that the true Sharpe equals
 * the benchmark, at a given confidence level.
 *
 * MinTRL = 1 + (1 - g3*SR_hat + ((g4-1)/4)*SR_hat^2) * (Φ⁻¹(α) / (SR_hat - SR*))^2
 *
 * For a 95% confidence level, Φ⁻¹(0.95) ≈ 1.645.
 *
 * Use case: "this sub-strategy needs at least N trades before its Sharpe
 * is statistically meaningful at 95% confidence." Replaces a hardcoded
 * minimum-sample gate with a data-driven one.
 */
export function minimumTrackRecordLength(
  returns: number[],
  benchmarkSharpe = 0,
  confidence = 0.95,
): number {
  const n = returns.length;
  if (n < 4) return Number.POSITIVE_INFINITY;

  const srHat = rawSharpe(returns);
  if (Math.abs(srHat - benchmarkSharpe) < 1e-9) return Number.POSITIVE_INFINITY;

  const g3 = sampleSkew(returns);
  const g4Excess = sampleKurtosis(returns);
  const g4 = g4Excess + 3;

  // Inverse normal CDF (quantile). Hardcoded common values; for general
  // confidence we'd compute via a root-finder. 0.95 and 0.99 cover us.
  let zAlpha: number;
  if (confidence >= 0.99) zAlpha = 2.326;
  else if (confidence >= 0.975) zAlpha = 1.96;
  else if (confidence >= 0.95) zAlpha = 1.645;
  else if (confidence >= 0.90) zAlpha = 1.282;
  else zAlpha = 1.645;

  const factor = 1 - g3 * srHat + ((g4 - 1) / 4) * srHat * srHat;
  const denom = (srHat - benchmarkSharpe) * (srHat - benchmarkSharpe);
  if (denom <= 0) return Number.POSITIVE_INFINITY;

  return 1 + factor * (zAlpha * zAlpha) / denom;
}

/**
 * Expected maximum Sharpe ratio under the null hypothesis of N independent
 * random strategies — used as the benchmark in DSR.
 *
 * E[max SR_N] ≈ E[Z] * sqrt((N-1)/N * Φ⁻¹(1 - 1/N) + 1/N * Φ⁻¹(1 - 1/(N*e)))
 *
 * Bailey & Lopez de Prado's simplification using Euler-Mascheroni:
 *
 * E[max SR] ≈ (1 - γ) * Φ⁻¹(1 - 1/N) + γ * Φ⁻¹(1 - 1/(N*e))
 *
 * where γ is the Euler-Mascheroni constant and e is Euler's number.
 * This assumes the N candidate strategies' Sharpe ratios are i.i.d. normal.
 */
export function expectedMaxSharpeUnderNull(numCandidates: number): number {
  if (numCandidates < 2) return 0;
  const n = numCandidates;
  const e = Math.E;

  // Inverse normal CDF helper for the two probabilities we need. Use a
  // simple Beasley-Springer-Moro approximation. For the accuracy we need
  // here (two evaluations per DSR call), a cruder approx is fine.
  const phiInv = (p: number): number => {
    // Clamp to valid range
    const pClamped = Math.max(1e-9, Math.min(1 - 1e-9, p));
    // Use rational approximation (Acklam)
    const a = [
      -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
      1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
    ];
    const b = [
      -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
      6.680131188771972e1, -1.328068155288572e1,
    ];
    const c = [
      -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
      -2.549732539343734, 4.374664141464968, 2.938163982698783,
    ];
    const d = [
      7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
      3.754408661907416,
    ];

    const pLow = 0.02425;
    const pHigh = 1 - pLow;
    let q: number;
    let r: number;
    let x: number;
    if (pClamped < pLow) {
      q = Math.sqrt(-2 * Math.log(pClamped));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (pClamped <= pHigh) {
      q = pClamped - 0.5;
      r = q * q;
      x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
          (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      q = Math.sqrt(-2 * Math.log(1 - pClamped));
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    return x;
  };

  return (1 - EULER_MASCHERONI) * phiInv(1 - 1 / n) +
         EULER_MASCHERONI * phiInv(1 - 1 / (n * e));
}

export interface DsrResult {
  /** Raw observed Sharpe of this strategy */
  sharpe: number;
  /** Benchmark: expected max Sharpe under the null across N candidates */
  benchmarkSharpe: number;
  /** The DSR itself: P(true SR > benchmark) */
  dsr: number;
  /** Number of trades (sample size) */
  n: number;
  /** Skew and kurtosis, for visibility */
  skew: number;
  kurtosis: number;
}

/**
 * Deflated Sharpe Ratio — PSR with the benchmark set to the expected max
 * Sharpe under the null hypothesis for N candidate strategies. This is
 * THE test for whether a strategy beats chance AFTER accounting for the
 * fact that we looked at N strategies.
 *
 * Returns a DsrResult with both the raw Sharpe and the DSR probability.
 * Gate at DSR >= 0.95 to enable a strategy.
 *
 * @param returns The strategy's historical realized returns (one per trade)
 * @param numCandidates The total number of sub-strategies we're evaluating
 *                       against this metric in the same time window
 */
export function deflatedSharpeRatio(
  returns: number[],
  numCandidates: number,
): DsrResult {
  const n = returns.length;
  const sharpe = rawSharpe(returns);
  const skew = sampleSkew(returns);
  const kurtosis = sampleKurtosis(returns);

  if (n < 4 || numCandidates < 2) {
    return {
      sharpe,
      benchmarkSharpe: 0,
      dsr: 0,
      n,
      skew,
      kurtosis,
    };
  }

  const benchmark = expectedMaxSharpeUnderNull(numCandidates);
  const dsr = probabilisticSharpeRatio(returns, benchmark);

  return {
    sharpe,
    benchmarkSharpe: benchmark,
    dsr,
    n,
    skew,
    kurtosis,
  };
}
