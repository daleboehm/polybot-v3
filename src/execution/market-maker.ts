// Two-sided market maker — R4 scaffold.
//
// R4 (2026-04-10). Per design-decisions §R4 #4: real market-making posts
// bids AND asks on the same market simultaneously, capturing the spread.
// Inventory-aware pricing tilts quotes based on current position.
//
// **SCAFFOLD ONLY** — this module documents the interface and math but
// is not wired into the engine. Activation requires R3b+R3c to be live and
// production capital > $10k so the inventory float is meaningful.
//
// Math (inventory-skew market making):
//
//   target_bid_price = midpoint * (1 - half_spread - inventory_skew)
//   target_ask_price = midpoint * (1 + half_spread - inventory_skew)
//
//   where inventory_skew = (inventory - target_inventory) / max_inventory
//
// If we're long-heavy the asks tighten (sell faster) and bids widen (slow down
// buying); if we're short-heavy the opposite. Spread width depends on volatility.
//
// Not wired into engine.ts. Activation plan: R4 milestone #4 in the rebuild plan.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('market-maker');

export interface QuotePair {
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  midpoint: number;
  inventorySkew: number;
}

export interface MarketMakerConfig {
  halfSpread: number;           // e.g. 0.01 = 1% half-spread
  targetInventoryShares: number;
  maxInventoryShares: number;
  quoteSize: number;            // shares per quote
  skewMultiplier: number;       // 1.0 = linear skew, >1 = aggressive skew
}

export const DEFAULT_MM_CONFIG: MarketMakerConfig = {
  halfSpread: 0.01,
  targetInventoryShares: 0,
  maxInventoryShares: 100,
  quoteSize: 10,
  skewMultiplier: 1.5,
};

export class MarketMaker {
  constructor(private readonly config: MarketMakerConfig = DEFAULT_MM_CONFIG) {}

  /**
   * Compute the bid/ask quotes for a market given current midpoint and our
   * current inventory in the token. Returns null if the skew would produce
   * invalid (negative or >1) prices.
   */
  computeQuotes(midpoint: number, currentInventory: number): QuotePair | null {
    const { halfSpread, targetInventoryShares, maxInventoryShares, quoteSize, skewMultiplier } = this.config;

    const inventoryDelta = currentInventory - targetInventoryShares;
    const inventorySkew = Math.tanh((inventoryDelta / maxInventoryShares) * skewMultiplier) * halfSpread;

    const bidPrice = midpoint * (1 - halfSpread) - inventorySkew;
    const askPrice = midpoint * (1 + halfSpread) - inventorySkew;

    if (bidPrice <= 0 || askPrice >= 1 || bidPrice >= askPrice) {
      log.debug({ midpoint, inventorySkew, bidPrice, askPrice }, 'Invalid quote pair — skipping');
      return null;
    }

    return {
      bidPrice: round4(bidPrice),
      bidSize: quoteSize,
      askPrice: round4(askPrice),
      askSize: quoteSize,
      midpoint: round4(midpoint),
      inventorySkew: round4(inventorySkew),
    };
  }

  /**
   * Risk check before placing quotes: don't quote if inventory is already
   * at the max in either direction, or if the spread between bid and ask
   * is smaller than our required edge.
   */
  shouldQuote(currentInventory: number, minSpread = 0.005): { allowed: boolean; reason?: string } {
    const abs = Math.abs(currentInventory);
    if (abs >= this.config.maxInventoryShares) {
      return { allowed: false, reason: `inventory ${currentInventory} at max ${this.config.maxInventoryShares}` };
    }
    if (this.config.halfSpread * 2 < minSpread) {
      return { allowed: false, reason: `configured spread ${this.config.halfSpread * 2} < min ${minSpread}` };
    }
    return { allowed: true };
  }
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
