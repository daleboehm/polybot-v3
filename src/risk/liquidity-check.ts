// Liquidity-aware sizing guard.
//
// 2026-04-11 (Phase 1.3): pure defensive sizing layer. Given a desired
// position size and an orderbook snapshot, compute the maximum size we can
// take without walking the book more than `maxSlippagePct`.
//
// Contract:
//   bounds the size so the average fill price is at most
//   (midpoint + maxSlippagePct * midpoint) for a BUY.
//
// Why this matters on a $257 bankroll:
// - Typical Polymarket binary markets have thin books
// - A $1.90 Kelly-capped order can walk the top level and take adverse
//   selection of several cents per share
// - On a $1.00 stop-loss market, even 3c slippage = 3% free PnL loss
// - We don't need a fancy slippage curve yet; a simple "walk the asks"
//   simulator with a slippage budget gives us most of the protection
//
// This function is intentionally permissive by default: if the book is
// missing, stale, or empty, we return the full requested size and log a
// warning. The engine already has absolute-USD caps elsewhere; we're adding
// a defense, not replacing one.

import type { OrderBookSnapshot, OrderBookLevel } from '../types/index.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('liquidity-check');

export interface LiquidityBoundResult {
  /** Max USD size we can take without exceeding the slippage budget. */
  max_size_usd: number;
  /** The average fill price at max_size_usd. */
  avg_fill_price: number;
  /** Whether the book was usable; if false, we fell back to the requested size. */
  book_available: boolean;
  /** Reason we capped (or didn't). */
  reason: 'no_book' | 'empty_asks' | 'stale_book' | 'slippage_cap' | 'full_size_fits';
  /** Warning for the caller to emit if the book was present but thin. */
  warning?: string;
}

export interface LiquidityBoundOptions {
  /** Max average-fill slippage vs midpoint, as a fraction (0.02 = 2%). Default 0.02. */
  maxSlippagePct?: number;
  /** Age limit for the orderbook snapshot in ms. Default 30_000. */
  maxBookAgeMs?: number;
}

/**
 * Given a BUY order size in USD, the current orderbook, and slippage budget,
 * return the maximum USD we can deploy without exceeding the budget.
 */
export function computeLiquidityBound(
  desiredSizeUsd: number,
  marketPrice: number,
  book: OrderBookSnapshot | undefined,
  opts: LiquidityBoundOptions = {},
): LiquidityBoundResult {
  const maxSlippagePct = opts.maxSlippagePct ?? 0.02;
  const maxBookAgeMs = opts.maxBookAgeMs ?? 30_000;

  // Case 1: no book. Fall back to full size, log a warning.
  if (!book) {
    return {
      max_size_usd: desiredSizeUsd,
      avg_fill_price: marketPrice,
      book_available: false,
      reason: 'no_book',
      warning: 'No orderbook snapshot — sizing not liquidity-bounded',
    };
  }

  // Case 2: book is stale (>30s old). Fall back but warn.
  const ageMs = Date.now() - book.timestamp;
  if (ageMs > maxBookAgeMs) {
    return {
      max_size_usd: desiredSizeUsd,
      avg_fill_price: marketPrice,
      book_available: false,
      reason: 'stale_book',
      warning: `Orderbook stale (${Math.round(ageMs / 1000)}s old) — sizing not liquidity-bounded`,
    };
  }

  // Case 3: empty ask side. Shouldn't happen on an active market but be safe.
  if (!book.asks || book.asks.length === 0) {
    return {
      max_size_usd: desiredSizeUsd,
      avg_fill_price: marketPrice,
      book_available: false,
      reason: 'empty_asks',
      warning: 'Orderbook has no ask side — sizing not liquidity-bounded',
    };
  }

  // Compute the max avg fill price allowed by the slippage budget.
  // Reference is the midpoint when present, otherwise best_ask fallback.
  const reference = book.midpoint ?? book.best_ask ?? marketPrice;
  const maxAvgPrice = reference * (1 + maxSlippagePct);

  // Walk the asks, accumulating size, until we hit either the desired USD
  // or the slippage-bounded max. The asks are assumed sorted ascending.
  let accumulatedShares = 0;
  let accumulatedCost = 0;
  let lastSafePrice = book.asks[0].price;
  const sortedAsks = [...book.asks].sort((a, b) => a.price - b.price);

  for (const level of sortedAsks) {
    const costAtLevel = level.price * level.size;
    const nextTotalCost = accumulatedCost + costAtLevel;
    const nextTotalShares = accumulatedShares + level.size;
    const nextAvgPrice = nextTotalCost / nextTotalShares;

    // If adding this whole level would exceed the slippage budget, take only
    // the partial fill that keeps us at budget — or stop if we're already
    // above, which shouldn't happen if the first level is within budget.
    if (nextAvgPrice > maxAvgPrice) {
      // Try to partial-fill from this level. Solve for how many shares at
      // level.price keep avg ≤ maxAvgPrice.
      //   (accCost + x * level.price) / (accShares + x) <= maxAvgPrice
      //   accCost + x * level.price <= maxAvgPrice * (accShares + x)
      //   accCost + x * level.price <= maxAvgPrice * accShares + maxAvgPrice * x
      //   x * (level.price - maxAvgPrice) <= maxAvgPrice * accShares - accCost
      //   x <= (maxAvgPrice * accShares - accCost) / (level.price - maxAvgPrice)
      if (level.price > maxAvgPrice) {
        const numerator = maxAvgPrice * accumulatedShares - accumulatedCost;
        const denominator = level.price - maxAvgPrice;
        if (denominator > 0 && numerator > 0) {
          const xShares = numerator / denominator;
          accumulatedShares += xShares;
          accumulatedCost += xShares * level.price;
          lastSafePrice = level.price;
        }
      }
      break;
    }

    accumulatedCost = nextTotalCost;
    accumulatedShares = nextTotalShares;
    lastSafePrice = level.price;

    // Early exit if we've already accumulated enough cost for the desired size.
    if (accumulatedCost >= desiredSizeUsd) {
      break;
    }
  }

  const maxSizeUsd = Math.min(desiredSizeUsd, accumulatedCost);
  const avgFillPrice = accumulatedShares > 0 ? accumulatedCost / accumulatedShares : marketPrice;

  if (maxSizeUsd < desiredSizeUsd) {
    return {
      max_size_usd: maxSizeUsd,
      avg_fill_price: avgFillPrice,
      book_available: true,
      reason: 'slippage_cap',
      warning: `Requested ${desiredSizeUsd.toFixed(2)} USD, liquidity-bounded to ${maxSizeUsd.toFixed(2)} (would walk book > ${(maxSlippagePct * 100).toFixed(1)}%)`,
    };
  }

  return {
    max_size_usd: maxSizeUsd,
    avg_fill_price: avgFillPrice,
    book_available: true,
    reason: 'full_size_fits',
  };
}

/** Convenience wrapper that logs the slippage cap events at info level. */
export function logLiquidityEvent(
  result: LiquidityBoundResult,
  context: { strategy_id: string; condition_id: string; token_id: string },
): void {
  if (result.reason === 'slippage_cap') {
    log.info(
      {
        ...context,
        max_size_usd: result.max_size_usd,
        avg_fill_price: result.avg_fill_price,
        warning: result.warning,
      },
      'Liquidity-bounded sizing applied',
    );
  } else if (!result.book_available) {
    log.warn({ ...context, reason: result.reason, warning: result.warning }, 'Liquidity check fell back');
  }
}
