// Brier score + reliability diagram for strategy calibration assessment.
//
// R2 PR#2 extensions (2026-04-10). The Brier score measures how well a
// strategy's stated `model_prob` matches reality: lower is better, 0 is
// perfect, 0.25 is a coin flip.
//
// The reliability diagram bucketizes predictions by confidence and asks:
// "When my strategy said 70% probability, did it actually win 70% of the time?"
// Deviations from the diagonal mean the model is miscalibrated — over- or
// under-confident. A strategy with a great Sharpe but a bad reliability diagram
// is winning by luck, not by accurate probability estimation.
//
// Used by the advisor to prefer well-calibrated strategies over lucky ones,
// and by the dashboard to visualize calibration quality.

export interface BrierResult {
  score: number;          // 0 = perfect, 0.25 = random, 1 = maximally wrong
  n: number;
  meanPrediction: number; // average predicted probability
  meanOutcome: number;    // average realized outcome (0 = loss, 1 = win)
  reliability: ReliabilityBucket[];
  calibrationError: number; // weighted mean |predicted - actual| across buckets
  resolution: number;      // Brier decomposition: discrimination power (higher = better)
  // Phase B (2026-04-11): full Murphy 1973 decomposition adds the uncertainty
  // term so we can verify the identity `score ≈ reliabilityScalar - resolution + uncertainty`.
  // - reliabilityScalar: sum_i w_i * (avgPred_i - obsRate_i)^2 — the calibration gap as a single number
  // - uncertainty: p̄(1-p̄) where p̄ is the observed base rate — irreducible noise
  reliabilityScalar: number;
  uncertainty: number;
}

export interface ReliabilityBucket {
  bucketLow: number;      // e.g. 0.50
  bucketHigh: number;     // e.g. 0.60
  n: number;              // predictions in this bucket
  meanPredicted: number;  // average predicted_prob inside the bucket
  meanActual: number;     // fraction of wins inside the bucket
  avgEdgeVsMarket: number; // how far inside the bucket the prediction was from market_price
}

export interface Prediction {
  predictedProb: number;  // model_prob the strategy emitted at signal time
  outcome: 0 | 1;         // 1 = position won, 0 = position lost
  marketPrice?: number;   // market_price at signal time (for edge tracking)
}

/**
 * Compute the Brier score and 10-bucket reliability diagram from a list of
 * (predicted_prob, outcome) pairs.
 *
 * @param predictions chronologically-ordered predictions from resolved positions
 * @param bucketCount number of reliability buckets (default 10 → 0.0-0.1, 0.1-0.2, ...)
 */
export function computeBrier(predictions: Prediction[], bucketCount = 10): BrierResult {
  const n = predictions.length;
  if (n === 0) {
    return {
      score: 0, n: 0, meanPrediction: 0, meanOutcome: 0,
      reliability: [], calibrationError: 0, resolution: 0,
      reliabilityScalar: 0, uncertainty: 0,
    };
  }

  // Core Brier: average squared error between prediction and outcome
  let sumSq = 0;
  let sumPred = 0;
  let sumOutcome = 0;
  for (const p of predictions) {
    const err = p.predictedProb - p.outcome;
    sumSq += err * err;
    sumPred += p.predictedProb;
    sumOutcome += p.outcome;
  }
  const score = sumSq / n;
  const meanPrediction = sumPred / n;
  const meanOutcome = sumOutcome / n;

  // Reliability buckets
  const buckets: ReliabilityBucket[] = [];
  const bucketSize = 1 / bucketCount;
  for (let i = 0; i < bucketCount; i++) {
    buckets.push({
      bucketLow: i * bucketSize,
      bucketHigh: (i + 1) * bucketSize,
      n: 0,
      meanPredicted: 0,
      meanActual: 0,
      avgEdgeVsMarket: 0,
    });
  }

  const bucketAcc = buckets.map(() => ({ predSum: 0, outcomeSum: 0, edgeSum: 0, edgeN: 0 }));

  for (const p of predictions) {
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor(p.predictedProb / bucketSize)));
    buckets[idx].n += 1;
    bucketAcc[idx].predSum += p.predictedProb;
    bucketAcc[idx].outcomeSum += p.outcome;
    if (p.marketPrice !== undefined) {
      bucketAcc[idx].edgeSum += p.predictedProb - p.marketPrice;
      bucketAcc[idx].edgeN += 1;
    }
  }

  for (let i = 0; i < bucketCount; i++) {
    const b = buckets[i];
    const acc = bucketAcc[i];
    if (b.n > 0) {
      b.meanPredicted = acc.predSum / b.n;
      b.meanActual = acc.outcomeSum / b.n;
      b.avgEdgeVsMarket = acc.edgeN > 0 ? acc.edgeSum / acc.edgeN : 0;
    }
  }

  // Calibration error: weighted mean |predicted - actual| across populated buckets
  let calibrationError = 0;
  let weightSum = 0;
  for (const b of buckets) {
    if (b.n > 0) {
      const w = b.n / n;
      calibrationError += w * Math.abs(b.meanPredicted - b.meanActual);
      weightSum += w;
    }
  }
  if (weightSum > 0) calibrationError /= weightSum;

  // Full Murphy 1973 Brier decomposition:
  //   score ≈ reliabilityScalar - resolution + uncertainty
  //
  // resolution = Σ w_i * (obsRate_i - baseRate)^2
  //   Higher resolution = the strategy's confidence buckets actually
  //   differentiate winners from losers.
  //
  // reliabilityScalar = Σ w_i * (avgPred_i - obsRate_i)^2
  //   The squared calibration gap. 0 = perfectly calibrated. This is a
  //   stricter metric than calibrationError (which is |gap|, not gap^2)
  //   and is the term that actually appears in the Brier decomposition.
  //
  // uncertainty = p̄(1 - p̄)
  //   The irreducible outcome noise given the base rate. You would get
  //   `uncertainty` as your Brier score by always predicting p̄.
  let resolution = 0;
  let reliabilityScalar = 0;
  for (const b of buckets) {
    if (b.n > 0) {
      const w = b.n / n;
      resolution += w * (b.meanActual - meanOutcome) ** 2;
      reliabilityScalar += w * (b.meanPredicted - b.meanActual) ** 2;
    }
  }
  const uncertainty = meanOutcome * (1 - meanOutcome);

  return {
    score, n, meanPrediction, meanOutcome, reliability: buckets,
    calibrationError, resolution, reliabilityScalar, uncertainty,
  };
}
