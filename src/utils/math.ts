// Mathematical utilities — Kelly criterion, slippage, decimal helpers

/**
 * Fractional Kelly criterion for position sizing.
 * Full Kelly: f* = (bp - q) / b
 * where b = odds (payout/wager), p = win prob, q = 1-p
 * Fractional Kelly = fraction * f*
 */
export function kellySize(
  modelProb: number,
  marketPrice: number,
  fraction: number,
  bankroll: number,
): number {
  if (modelProb <= 0 || modelProb >= 1) return 0;
  if (marketPrice <= 0 || marketPrice >= 1) return 0;

  const b = (1 - marketPrice) / marketPrice; // decimal odds
  const p = modelProb;
  const q = 1 - p;

  const fullKelly = (b * p - q) / b;
  if (fullKelly <= 0) return 0; // no edge

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

/**
 * Round to N decimal places
 */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
