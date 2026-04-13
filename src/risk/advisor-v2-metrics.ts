// Advisor v2 metrics — Phase B (2026-04-11).
//
// Computes DSR, PSR, MinTRL, and Brier decomposition for a single
// (strategy_id, sub_strategy_id) pair and returns a structured decision
// that the advisor can log alongside its existing Wilson-LB decision.
//
// Architectural decisions (locked in this session):
//   1. dsr-psr.ts is the canonical DSR/PSR API for new code.
//      walk-forward.ts's DSR function is deprecated — new callers go here.
//   2. Feature flag ADVISOR_V2_ENABLED defaults OFF everywhere. This
//      module is called regardless, but its decision is ONLY acted on
//      when the flag is ON AND the v2 decision is strictly stricter or
//      strictly agrees with Wilson. Never downgrades an existing Wilson
//      decision.
//   3. numCandidates for DSR = count of currently-active sub-strategies
//      in R&D (not total), passed in by the advisor from its enabledKeys
//      set size.
//   4. Benchmark Sharpe for PSR = 0.0 (vs-zero test). Cash-preservation
//      mode, not alpha-chasing. We're asking "is this strategy's true
//      Sharpe clearly above zero?" not "is it better than a 0.5
//      benchmark?"
//   5. Brier reliability drift = log-only warning. Never auto-disable.
//      Too noisy and a single bad bucket can fire false positives.
//
// The advisor remains the decision-maker. This module's job is to
// *produce evidence*. The advisor's existing Wilson-LB logic stays
// in place; when ADVISOR_V2_ENABLED=true, the advisor consults the
// v2 decision as a second opinion.

import {
  probabilisticSharpeRatio,
  minimumTrackRecordLength,
  deflatedSharpeRatio,
  type DsrResult,
} from '../validation/dsr-psr.js';
import { computeBrier, type Prediction } from '../validation/brier.js';
import { loadReturnsSeries, type TradeReturn } from '../validation/returns-series.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('advisor-v2-metrics');

// Gate thresholds
const PSR_ENABLE_THRESHOLD = 0.95;   // Require 95% probability that true Sharpe > 0
const DSR_ENABLE_THRESHOLD = 0.95;   // Same threshold with multiple-testing correction
const PSR_DISABLE_THRESHOLD = 0.05;  // 95% confident the true Sharpe is BELOW 0 → disable
const MIN_RETURNS_FOR_METRICS = 30;  // need at least 30 trades for DSR/PSR to be meaningful
const BRIER_RELIABILITY_WARN = 0.05; // log warn if calibration gap exceeds 5%

export type AdvisorV2Action = 'enable' | 'disable' | 'keep' | 'insufficient_data';

export interface AdvisorV2Decision {
  action: AdvisorV2Action;
  reason: string;

  // Raw metrics so the advisor can log them side-by-side with Wilson
  n: number;
  sharpe: number;
  psr: number;                      // P(true SR > 0) in [0, 1]
  dsr: DsrResult;                   // full DSR result incl. benchmark + moments
  min_track_record_length: number;  // how many trades until Sharpe is trustworthy

  // Brier decomposition — the calibration health check
  brier_score: number | null;
  brier_reliability: number | null; // Murphy-decomposition reliabilityScalar
  brier_drift_warning: boolean;     // true if reliability > BRIER_RELIABILITY_WARN
  brier_n_with_prices: number;      // sample with entry_price present (subset of n)
}

/**
 * Run the full advisor v2 metric suite on one strategy pair. Returns a
 * structured decision without any side effects. The advisor decides
 * whether/how to act on the return value.
 *
 * @param rdDatabasePath path to read-only R&D DB
 * @param strategyId the parent strategy
 * @param subStrategyId sub-strategy ID (empty string = parent-only)
 * @param numCandidates total count of sub-strategies being evaluated in
 *                     the same window (for DSR multiple-testing correction)
 */
export function computeAdvisorV2Decision(
  rdDatabasePath: string,
  strategyId: string,
  subStrategyId: string,
  numCandidates: number,
): AdvisorV2Decision {
  let returns: TradeReturn[];
  try {
    returns = loadReturnsSeries(rdDatabasePath, strategyId, subStrategyId);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), strategy: strategyId, sub: subStrategyId },
      'Returns series load failed — treating as insufficient data',
    );
    return emptyDecision('returns-series load failed');
  }

  const n = returns.length;
  if (n < MIN_RETURNS_FOR_METRICS) {
    return {
      action: 'insufficient_data',
      reason: `need ${MIN_RETURNS_FOR_METRICS} trades, have ${n}`,
      n,
      sharpe: 0,
      psr: 0,
      dsr: { sharpe: 0, benchmarkSharpe: 0, dsr: 0, n, skew: 0, kurtosis: 0 },
      min_track_record_length: Number.POSITIVE_INFINITY,
      brier_score: null,
      brier_reliability: null,
      brier_drift_warning: false,
      brier_n_with_prices: 0,
    };
  }

  // Extract the returns values as a plain number[] for the dsr-psr
  // module (which takes raw returns).
  const rets = returns.map(r => r.return_pct);

  // PSR and MinTRL at vs-zero benchmark
  const psr = probabilisticSharpeRatio(rets, 0);
  const minTRL = minimumTrackRecordLength(rets, 0, 0.95);

  // DSR with multiple-testing correction
  const dsrResult = deflatedSharpeRatio(rets, Math.max(2, numCandidates));

  // Brier decomposition — only useful when we have entry prices
  // (old resolutions from before the base-rate-calibrator landed may
  // be missing them).
  let brier_score: number | null = null;
  let brier_reliability: number | null = null;
  let brier_drift_warning = false;
  let brier_n_with_prices = 0;

  // Build Prediction[] for the existing brier.ts module. We use the
  // pre-existing computeBrier() API (not a new one) so we don't
  // duplicate. Phase B already augmented its BrierResult with
  // reliabilityScalar and uncertainty fields to support this.
  const predictions: Prediction[] = [];
  for (const r of returns) {
    if (r.entry_price === null || !Number.isFinite(r.entry_price)) continue;
    if (r.entry_price <= 0 || r.entry_price >= 1) continue;
    predictions.push({
      predictedProb: r.entry_price,
      outcome: r.outcome,
    });
  }
  brier_n_with_prices = predictions.length;

  if (brier_n_with_prices >= 10) {
    const result = computeBrier(predictions, 10);
    brier_score = result.score;
    brier_reliability = result.reliabilityScalar;
    brier_drift_warning = brier_reliability > BRIER_RELIABILITY_WARN;
  }

  // Now the decision logic
  let action: AdvisorV2Action = 'keep';
  let reason: string;

  if (psr >= PSR_ENABLE_THRESHOLD && dsrResult.dsr >= DSR_ENABLE_THRESHOLD) {
    action = 'enable';
    reason = `PSR ${psr.toFixed(3)} ≥ ${PSR_ENABLE_THRESHOLD} AND DSR ${dsrResult.dsr.toFixed(3)} ≥ ${DSR_ENABLE_THRESHOLD} (SR ${dsrResult.sharpe.toFixed(3)}, n=${n})`;
  } else if (psr < PSR_DISABLE_THRESHOLD) {
    action = 'disable';
    reason = `PSR ${psr.toFixed(3)} < ${PSR_DISABLE_THRESHOLD} (95% confident SR ≤ 0; sharpe ${dsrResult.sharpe.toFixed(3)}, n=${n})`;
  } else {
    const parts = [
      `PSR ${psr.toFixed(3)}`,
      `DSR ${dsrResult.dsr.toFixed(3)}`,
      `SR ${dsrResult.sharpe.toFixed(3)}`,
      `n ${n}`,
    ];
    if (Number.isFinite(minTRL)) parts.push(`MinTRL ${Math.ceil(minTRL)}`);
    reason = `inconclusive — ${parts.join(', ')}`;
  }

  return {
    action,
    reason,
    n,
    sharpe: dsrResult.sharpe,
    psr,
    dsr: dsrResult,
    min_track_record_length: minTRL,
    brier_score,
    brier_reliability,
    brier_drift_warning,
    brier_n_with_prices,
  };
}

function emptyDecision(reason: string): AdvisorV2Decision {
  return {
    action: 'insufficient_data',
    reason,
    n: 0,
    sharpe: 0,
    psr: 0,
    dsr: { sharpe: 0, benchmarkSharpe: 0, dsr: 0, n: 0, skew: 0, kurtosis: 0 },
    min_track_record_length: Number.POSITIVE_INFINITY,
    brier_score: null,
    brier_reliability: null,
    brier_drift_warning: false,
    brier_n_with_prices: 0,
  };
}
