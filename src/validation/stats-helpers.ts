// Statistical helpers — Phase B (2026-04-11).
//
// Closed-form math used by DSR, PSR, Brier score, and future validation
// modules. Zero external dependencies. Pure functions.
//
// Functions:
//   - normalCdf(x): standard normal CDF Φ(x) via Abramowitz & Stegun approx
//   - sampleMean(xs): arithmetic mean
//   - sampleVariance(xs): unbiased sample variance (n-1 denominator)
//   - sampleStd(xs): sqrt of sampleVariance
//   - sampleSkew(xs): Fisher-Pearson moment-based skew
//   - sampleKurtosis(xs): excess kurtosis (0 = normal)
//   - eulerMascheroni: Euler-Mascheroni constant (used in DSR)

export const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Standard normal cumulative distribution function Φ(x).
 * Abramowitz & Stegun 26.2.17 rational approximation.
 * Max error ~7.5e-8 for all real x.
 */
export function normalCdf(x: number): number {
  // Constants
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) / Math.SQRT2;

  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Arithmetic mean. Returns 0 for empty input.
 */
export function sampleMean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/**
 * Unbiased sample variance (n-1 denominator). Returns 0 for n<2.
 */
export function sampleVariance(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mean = sampleMean(xs);
  let sumSq = 0;
  for (const x of xs) {
    const d = x - mean;
    sumSq += d * d;
  }
  return sumSq / (n - 1);
}

/**
 * Sample standard deviation.
 */
export function sampleStd(xs: number[]): number {
  return Math.sqrt(sampleVariance(xs));
}

/**
 * Fisher-Pearson moment-based sample skewness (g1).
 * Returns 0 for n<3 or zero variance.
 */
export function sampleSkew(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const mean = sampleMean(xs);
  const std = sampleStd(xs);
  if (std === 0) return 0;

  let sumCubed = 0;
  for (const x of xs) {
    const z = (x - mean) / std;
    sumCubed += z * z * z;
  }
  // Bias correction: n / ((n-1)(n-2))
  return (n / ((n - 1) * (n - 2))) * sumCubed;
}

/**
 * Excess kurtosis (g2). Normal distribution = 0.
 * Returns 0 for n<4 or zero variance.
 */
export function sampleKurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) return 0;
  const mean = sampleMean(xs);
  const variance = sampleVariance(xs);
  if (variance === 0) return 0;

  let sum4 = 0;
  for (const x of xs) {
    const d = x - mean;
    sum4 += d * d * d * d;
  }

  // Unbiased excess kurtosis estimator
  const num = (n * (n + 1) * sum4) / ((n - 1) * (n - 2) * (n - 3) * variance * variance);
  const correction = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return num - correction;
}

/**
 * Compute Sharpe ratio from a returns series. Annualization is the
 * caller's job — this returns the raw `mean / std` value.
 */
export function sharpeRatio(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = sampleMean(returns);
  const std = sampleStd(returns);
  if (std === 0) return 0;
  return mean / std;
}
