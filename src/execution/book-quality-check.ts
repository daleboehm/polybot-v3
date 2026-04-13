// Pre-trade book quality verification — 2026-04-13.
//
// Defensive layer against Polymarket CLOB bugs documented by
// @0x_Punisher (Apr 13 2026):
//   - Ghost fills: orders show matched but never execute on-chain
//   - Zero-balance exploit: phantom orders from empty wallets persist
//     in the CLOB orderbook, creating fake liquidity
//   - Nonce exploit: counterparties cancel after match
//
// This module checks the orderbook snapshot for a token BEFORE we
// submit an order. If the book looks unhealthy, we skip the trade
// rather than risk a ghost fill.
//
// Checks:
//   1. Book exists and has recent data (stale book = blind trading)
//   2. Both sides have at least MIN_LEVELS of depth (thin book =
//      single whale or exploit)
//   3. Spread is not wider than MAX_SPREAD_PCT (wide spread =
//      market makers have pulled back per Punisher's warning)
//   4. Top-of-book size is above MIN_TOP_SIZE (tiny quotes at best
//      bid/ask are likely phantom orders)
//
// All thresholds are intentionally loose — we're catching gross
// anomalies, not optimizing fill quality. The wash-trading penalty
// and liquidity sizer handle the finer-grained sizing.

import type { OrderBookSnapshot } from '../types/index.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('book-quality');

// Thresholds
const MIN_LEVELS = 2;           // need at least 2 bid + 2 ask levels
const MAX_SPREAD_PCT = 0.15;    // 15% spread = market makers gone
const MIN_TOP_SIZE = 3;         // top-of-book must have ≥3 shares (ghost orders are typically 0.01-1 share)
const MAX_BOOK_AGE_MS = 120_000; // 2 minutes — older than this = stale

export interface BookQualityResult {
  passed: boolean;
  reason: string | null;
  spread_pct: number | null;
  bid_levels: number;
  ask_levels: number;
  top_bid_size: number;
  top_ask_size: number;
  book_age_ms: number | null;
}

const PASS: BookQualityResult = {
  passed: true,
  reason: null,
  spread_pct: null,
  bid_levels: 0,
  ask_levels: 0,
  top_bid_size: 0,
  top_ask_size: 0,
  book_age_ms: null,
};

/**
 * Check whether the orderbook for a token is healthy enough to trade.
 * Returns { passed: true } if OK, { passed: false, reason: "..." } if not.
 *
 * If no book snapshot is available (WS disconnected, market not subscribed),
 * we PASS by default — the absence of a book is not the same as a bad book.
 * The liquidity sizer already handles the "no book" case by skipping
 * liquidity bounds.
 */
export function checkBookQuality(
  book: OrderBookSnapshot | null | undefined,
  side: 'BUY' | 'SELL',
): BookQualityResult {
  // No book = pass. We don't want to block all trading when the WS is down.
  if (!book) return PASS;

  const now = Date.now();
  const age = book.timestamp ? now - book.timestamp : null;
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];
  const bidLevels = bids.length;
  const askLevels = asks.length;

  // Check: book freshness
  if (age !== null && age > MAX_BOOK_AGE_MS) {
    return {
      passed: false,
      reason: `stale book (${Math.round(age / 1000)}s old, max ${MAX_BOOK_AGE_MS / 1000}s)`,
      spread_pct: null,
      bid_levels: bidLevels,
      ask_levels: askLevels,
      top_bid_size: bids[0]?.size ?? 0,
      top_ask_size: asks[0]?.size ?? 0,
      book_age_ms: age,
    };
  }

  // Check: minimum depth on the side we're trading INTO
  // For a BUY, we need asks (we're hitting the ask side). For a SELL,
  // we need bids. Also check the opposite side has depth — a one-sided
  // book is a red flag.
  if (side === 'BUY' && askLevels < MIN_LEVELS) {
    return fail('thin ask book', bidLevels, askLevels, bids, asks, age);
  }
  if (side === 'SELL' && bidLevels < MIN_LEVELS) {
    return fail('thin bid book', bidLevels, askLevels, bids, asks, age);
  }

  // Check: spread
  const bestBid = book.best_bid ?? (bids[0]?.price ?? null);
  const bestAsk = book.best_ask ?? (asks[0]?.price ?? null);
  if (bestBid !== null && bestAsk !== null && bestBid > 0) {
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = (bestAsk - bestBid) / mid;
    if (spreadPct > MAX_SPREAD_PCT) {
      return {
        passed: false,
        reason: `wide spread ${(spreadPct * 100).toFixed(1)}% (max ${MAX_SPREAD_PCT * 100}%)`,
        spread_pct: spreadPct,
        bid_levels: bidLevels,
        ask_levels: askLevels,
        top_bid_size: bids[0]?.size ?? 0,
        top_ask_size: asks[0]?.size ?? 0,
        book_age_ms: age,
      };
    }
  }

  // Check: top-of-book size (ghost order detection)
  // Phantom orders from the zero-balance exploit are typically tiny
  // (0.01-1 share). Real market maker quotes are 5-50+ shares.
  const topBidSize = bids[0]?.size ?? 0;
  const topAskSize = asks[0]?.size ?? 0;
  if (side === 'BUY' && topAskSize < MIN_TOP_SIZE) {
    return fail(`phantom ask (top size ${topAskSize.toFixed(1)} < ${MIN_TOP_SIZE})`, bidLevels, askLevels, bids, asks, age);
  }
  if (side === 'SELL' && topBidSize < MIN_TOP_SIZE) {
    return fail(`phantom bid (top size ${topBidSize.toFixed(1)} < ${MIN_TOP_SIZE})`, bidLevels, askLevels, bids, asks, age);
  }

  return {
    passed: true,
    reason: null,
    spread_pct: bestBid !== null && bestAsk !== null ? (bestAsk - bestBid) / ((bestBid + bestAsk) / 2) : null,
    bid_levels: bidLevels,
    ask_levels: askLevels,
    top_bid_size: topBidSize,
    top_ask_size: topAskSize,
    book_age_ms: age,
  };
}

function fail(
  reason: string,
  bidLevels: number,
  askLevels: number,
  bids: Array<{ price: number; size: number }>,
  asks: Array<{ price: number; size: number }>,
  age: number | null,
): BookQualityResult {
  return {
    passed: false,
    reason,
    spread_pct: null,
    bid_levels: bidLevels,
    ask_levels: askLevels,
    top_bid_size: bids[0]?.size ?? 0,
    top_ask_size: asks[0]?.size ?? 0,
    book_age_ms: age,
  };
}
