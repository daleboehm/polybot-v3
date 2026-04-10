// In-memory market data cache with LRU eviction

import type { MarketData, SamplingMarket, OrderBookSnapshot } from '../types/index.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('market-cache');
const MAX_CACHE_SIZE = 5000;

export class MarketCache {
  private markets = new Map<string, MarketData>();
  private orderbooks = new Map<string, OrderBookSnapshot>();
  private accessOrder: string[] = [];

  upsertFromSampling(market: SamplingMarket): MarketData {
    const existing = this.markets.get(market.condition_id);

    const data: MarketData = {
      condition_id: market.condition_id,
      question: market.question,
      market_slug: market.market_slug,
      end_date: new Date(market.end_date_iso),
      active: market.active,
      closed: market.closed,
      neg_risk: market.neg_risk,
      token_yes_id: market.tokens[0].token_id,
      token_no_id: market.tokens[1].token_id,
      yes_price: market.tokens[0].price,
      no_price: market.tokens[1].price,
      yes_book: existing?.yes_book ?? null,
      no_book: existing?.no_book ?? null,
      volume_24h: existing?.volume_24h ?? 0,
      liquidity: existing?.liquidity ?? 0,
      maker_fee: market.maker_base_fee,
      taker_fee: market.taker_base_fee,
      minimum_order_size: market.minimum_order_size,
      minimum_tick_size: market.minimum_tick_size,
      last_updated: new Date(),
    };

    this.set(market.condition_id, data);
    return data;
  }

  updateOrderbook(tokenId: string, book: OrderBookSnapshot): void {
    this.orderbooks.set(tokenId, book);

    // Update the parent market's book reference
    for (const market of this.markets.values()) {
      if (market.token_yes_id === tokenId) {
        market.yes_book = book;
        market.yes_price = book.midpoint ?? market.yes_price;
        market.last_updated = new Date();
        break;
      }
      if (market.token_no_id === tokenId) {
        market.no_book = book;
        market.no_price = book.midpoint ?? market.no_price;
        market.last_updated = new Date();
        break;
      }
    }
  }

  get(conditionId: string): MarketData | undefined {
    this.touch(conditionId);
    return this.markets.get(conditionId);
  }

  getAll(): MarketData[] {
    return Array.from(this.markets.values());
  }

  getActive(): MarketData[] {
    return this.getAll().filter(m => m.active && !m.closed);
  }

  getOrderbook(tokenId: string): OrderBookSnapshot | undefined {
    return this.orderbooks.get(tokenId);
  }

  remove(conditionId: string): void {
    this.markets.delete(conditionId);
    this.accessOrder = this.accessOrder.filter(id => id !== conditionId);
  }

  get size(): number {
    return this.markets.size;
  }

  private set(conditionId: string, data: MarketData): void {
    this.markets.set(conditionId, data);
    this.touch(conditionId);
    this.evictIfNeeded();
  }

  private touch(conditionId: string): void {
    this.accessOrder = this.accessOrder.filter(id => id !== conditionId);
    this.accessOrder.push(conditionId);
  }

  private evictIfNeeded(): void {
    while (this.markets.size > MAX_CACHE_SIZE && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!;
      this.markets.delete(oldest);
      log.debug({ conditionId: oldest }, 'Evicted from cache');
    }
  }
}
