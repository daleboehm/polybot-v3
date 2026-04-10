// Market regime detector — volatility + trend classification.
//
// R3b (2026-04-10). Per `agi-regime-detection`: strategy performance is
// regime-dependent. Longshot fading works in low-volatility regimes but
// can get run over in high-vol ones. Convergence drift strategies work in
// ranging markets but lose money in trending ones. Tagging the current
// regime lets the advisor gate strategies by regime.
//
// Simple 4-regime classifier: {calm, choppy, trending, volatile} based on
// rolling price variance + autocorrelation of the aggregate market basket.
// "Price" here = average yes_price across all active markets (a basket
// index proxy) since Polymarket doesn't have a single index.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('regime-detector');

export type Regime = 'calm' | 'choppy' | 'trending' | 'volatile';

export interface RegimeSnapshot {
  regime: Regime;
  volatility: number;
  autocorr: number;
  sampleSize: number;
  at: Date;
  reasoning: string;
}

// Thresholds (tuned for Polymarket binary prices in [0, 1])
const CALM_VOL_THRESHOLD = 0.02;
const VOLATILE_VOL_THRESHOLD = 0.08;
const TRENDING_AUTOCORR_THRESHOLD = 0.30;

export class RegimeDetector {
  private history: Array<{ t: number; basketPrice: number }> = [];
  private readonly maxSamples = 500;
  private lastSnapshot: RegimeSnapshot | null = null;

  /**
   * Add a sample of the current aggregate market price. Called from
   * the engine scan cycle with the mean yes_price across active markets.
   */
  sample(basketPrice: number): void {
    this.history.push({ t: Date.now(), basketPrice });
    if (this.history.length > this.maxSamples) {
      this.history.shift();
    }
  }

  /**
   * Classify the current regime from the rolling history.
   */
  classify(): RegimeSnapshot {
    if (this.history.length < 30) {
      return {
        regime: 'calm',
        volatility: 0,
        autocorr: 0,
        sampleSize: this.history.length,
        at: new Date(),
        reasoning: `Insufficient history: ${this.history.length}/30 samples`,
      };
    }

    const prices = this.history.map(h => h.basketPrice);
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push(prices[i] - prices[i - 1]);
    }

    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const volatility = Math.sqrt(variance);

    // Lag-1 autocorrelation of returns
    let autocorrNum = 0;
    let autocorrDenom = 0;
    for (let i = 1; i < returns.length; i++) {
      autocorrNum += (returns[i] - mean) * (returns[i - 1] - mean);
      autocorrDenom += (returns[i - 1] - mean) ** 2;
    }
    const autocorr = autocorrDenom > 0 ? autocorrNum / autocorrDenom : 0;

    let regime: Regime;
    let reasoning: string;
    if (volatility < CALM_VOL_THRESHOLD) {
      regime = 'calm';
      reasoning = `Low volatility (${volatility.toFixed(4)} < ${CALM_VOL_THRESHOLD})`;
    } else if (volatility > VOLATILE_VOL_THRESHOLD) {
      regime = 'volatile';
      reasoning = `High volatility (${volatility.toFixed(4)} > ${VOLATILE_VOL_THRESHOLD})`;
    } else if (Math.abs(autocorr) > TRENDING_AUTOCORR_THRESHOLD) {
      regime = 'trending';
      reasoning = `Strong autocorrelation (${autocorr.toFixed(3)})`;
    } else {
      regime = 'choppy';
      reasoning = `Medium vol (${volatility.toFixed(4)}), low autocorr (${autocorr.toFixed(3)})`;
    }

    const snap: RegimeSnapshot = {
      regime,
      volatility,
      autocorr,
      sampleSize: this.history.length,
      at: new Date(),
      reasoning,
    };

    if (!this.lastSnapshot || this.lastSnapshot.regime !== regime) {
      log.info({ from: this.lastSnapshot?.regime ?? 'none', to: regime, reasoning }, 'Regime change');
    }
    this.lastSnapshot = snap;
    return snap;
  }

  getLastSnapshot(): RegimeSnapshot | null {
    return this.lastSnapshot;
  }
}
