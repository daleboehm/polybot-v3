// Mathematical utilities — Kelly criterion, slippage, decimal helpers

/**
 * Fractional Kelly criterion for position sizing.
 * Full Kelly: f* = (bp - q) / b
 * where b = odds (payout/wager), p = win prob, q = 1-p
 * Fractional Kelly = fraction * f*
 *
 * 2026-04-16 Fix 1: α-boundary correction at price extremes.
 *
 * Problem observed: `systematic_fade` on R&D shows 86.7% WR across 135
 * resolutions with -$33 PnL. Paradox is not a Kelly formula bug — it's a
 * model_prob vs true_prob calibration problem that the raw Kelly formula
 * AMPLIFIES at the tails.
 *
 * When `marketPrice` is extreme (near 0 or near 1), the decimal odds
 * `b = (1-p)/p` explode (b=99 at p=0.01, b=0.01 at p=0.99), and a tiny
 * error in the model's probability estimate produces an enormous swing
 * in `fullKelly`. Example: at marketPrice=0.01, modelProb=0.02 vs 0.04
 * (absolute error 0.02) changes fullKelly from 0.010 to 0.030 — 3x sizing
 * difference from a probability error smaller than our own calibration
 * noise floor. On the losing 13.3% of `systematic_fade` trades, the
 * per-share loss on a NO-at-$0.95 position is 19x the per-share gain on
 * a win — a single mispriced losing trade erases many winners. The full
 * Kelly criterion happily sizes these trades large because the headline
 * edge looks big, even though the actual edge is within the model's
 * estimation error.
 *
 * α-boundary correction per Chapman et al. (arXiv 2412.14144):
 *   - clamp `fullKelly` to `alphaMax` when marketPrice is in the extreme
 *     bands (< 0.05 or > 0.95). Default `alphaMax = 0.05` (5% of bankroll
 *     full-Kelly max at the tails).
 *   - optional `probUncertainty` parameter applies a one-sided shrinkage:
 *     compute Kelly at `p - probUncertainty` rather than `p`. A strategy
 *     that knows its calibration error can pass this in directly.
 *
 * Old callers that used `kellySize(...)` get the boundary correction
 * for free. This is the correct default: we'd rather leave a few basis
 * points on the table in the middle of the price curve than take a
 * sizing blowup at the tails.
 */

export interface KellyOptions {
  /**
   * One-sided probability uncertainty to subtract from modelProb before
   * computing Kelly. E.g., passing 0.03 shrinks p=0.87 to p=0.84 for
   * sizing purposes. Defaults to 0 (point-estimate Kelly).
   */
  probUncertainty?: number;
  /**
   * Cap on fullKelly when marketPrice is in the extreme bands. Default
   * 0.05 (5% of bankroll). Set higher to restore old behavior.
   */
  alphaMax?: number;
  /**
   * Lower-end of the "extreme" band. marketPrice below this triggers
   * alphaMax clamping. Default 0.05.
   */
  extremeLow?: number;
  /**
   * Upper-end of the "extreme" band. marketPrice above this triggers
   * alphaMax clamping. Default 0.95.
   */
  extremeHigh?: number;
}

export function kellySize(
  modelProb: number,
  marketPrice: number,
  fraction: number,
  bankroll: number,
  options: KellyOptions = {},
): number {
  if (modelProb <= 0 || modelProb >= 1) return 0;
  if (marketPrice <= 0 || marketPrice >= 1) return 0;

  const alphaMax = options.alphaMax ?? 0.05;
  const extremeLow = options.extremeLow ?? 0.05;
  const extremeHigh = options.extremeHigh ?? 0.95;
  const probUncertainty = Math.max(0, options.probUncertainty ?? 0);

  const b = (1 - marketPrice) / marketPrice; // decimal odds
  // Shrink modelProb toward market_price by the stated uncertainty. This
  // is the "conservative" Kelly input — if we're wrong about p in the
  // pessimistic direction, the bet still sizes positively.
  const p = Math.max(0.0001, Math.min(0.9999, modelProb - probUncertainty));
  const q = 1 - p;

  let fullKelly = (b * p - q) / b;
  if (fullKelly <= 0) return 0; // no edge (or edge wiped out by uncertainty)

  // α-boundary correction — clamp in the extreme price bands. A wide edge
  // computed at p=0.01 or p=0.99 is dominated by our estimation error;
  // size small even when the formula is screaming size big.
  if (marketPrice < extremeLow || marketPrice > extremeHigh) {
    if (fullKelly > alphaMax) fullKelly = alphaMax;
  }

  const kellyFraction = fraction * fullKelly;
  return Math.max(0, kellyFraction * bankroll);
}

/**
 * Apply slippage model to an expected fill price.
 * For buys: price goes up by slippage. For sells: price goes down.
 */
export function applySlippage(price: number, slippageBps: number, isBuy: boolean): number {
  const slip = price * (slippageBps / 10_000);
  return isBuy ? price + slip : price - slip;
}

/**
 * Round to nearest tick size (e.g., 0.01)
 */
export function roundToTick(value: number, tickSize: number): number {
  if (tickSize <= 0) return value;
  return Math.round(value / tickSize) * tickSize;
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate edge: difference between model probability and market price
 */
export function calculateEdge(modelProb: number, marketPrice: number): number {
  return modelProb - marketPrice;
}

// ─── Polymarket taker fee model (live since 2026-03-30) ─────────────
//
// Formula: fee_per_share = feeRate × p × (1 − p)
// where p = share price (probability 0-1), feeRate = category coefficient.
// Parabolic curve: peaks at p=0.50, zero at extremes. Taker-only; makers = 0.
// Source: Polymarket docs + CLOB API /fee-rate endpoint.

export const POLYMARKET_FEE_RATES: Record<string, number> = {
  crypto: 0.072,
  mentions: 0.0624,
  economics: 0.060,
  culture: 0.050,
  weather: 0.050,
  finance: 0.040,
  politics: 0.040,
  tech: 0.040,
  sports: 0.030,
  geopolitics: 0,
};

/**
 * Look up fee rate for a market by its tags. Falls back to 0 (conservative:
 * if we can't determine the category, assume no fee — the risk engine's
 * min_edge gate is the backstop).
 */
export function getFeeRateFromTags(tags: string[]): number {
  if (!tags?.length) return 0;
  const lower = tags.map(t => t.toLowerCase());
  for (const tag of lower) {
    if (tag in POLYMARKET_FEE_RATES) return POLYMARKET_FEE_RATES[tag];
  }
  return 0;
}

/**
 * Calculate taker fee per share at a given price.
 * fee_per_share = feeRate × p × (1 − p)
 */
export function takerFeePerShare(feeRate: number, price: number): number {
  return feeRate * price * (1 - price);
}

/**
 * Fee-adjusted edge: raw edge minus the fee drag as a fraction of cost basis.
 * For a BUY at price p, fee drag = feeRate × (1 − p).
 * For a SELL at price p, fee drag = feeRate × p.
 * Returns the edge net of fees — negative means the trade is unprofitable.
 */
export function feeAdjustedEdge(
  modelProb: number,
  marketPrice: number,
  feeRate: number,
): number {
  const rawEdge = modelProb - marketPrice;
  if (feeRate <= 0) return rawEdge;

  // Fee per share = feeRate * p * (1-p). Cost basis per share = p (for BUY).
  // Fee as fraction of cost = feeRate * (1-p). Subtract from |edge|.
  const feeDrag = feeRate * marketPrice * (1 - marketPrice) / marketPrice;
  // feeDrag simplifies to feeRate * (1-p) for buys

  if (rawEdge >= 0) {
    // BUY signal: edge must exceed fee drag
    return rawEdge - feeDrag;
  } else {
    // SELL/NO signal: symmetrically, fee drag on selling at (1-p)
    const sellFeeDrag = feeRate * marketPrice * (1 - marketPrice) / (1 - marketPrice);
    return rawEdge + sellFeeDrag; // rawEdge is negative, sellFeeDrag reduces magnitude
  }
}

/**
 * Round to N decimal places
 */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
