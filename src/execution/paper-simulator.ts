// Paper trading simulator — realistic fills with slippage model

import type { Order, OrderFill, Outcome } from '../types/index.js';
import type { MarketCache } from '../market/market-cache.js';
import { applySlippage, roundTo } from '../utils/math.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('paper-sim');

export class PaperSimulator {
  constructor(
    private marketCache: MarketCache,
    private slippageBps: number,
    private fillDelayMs: number,
  ) {}

  async simulateFill(order: Order): Promise<OrderFill | null> {
    if (!order.is_paper) {
      throw new Error('PaperSimulator called with a live order');
    }

    // Simulate network latency
    if (this.fillDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.fillDelayMs));
    }

    // Get current market data for slippage
    const market = this.marketCache.get(order.condition_id);

    // 2026-04-11 Phase 3: respect maker vs taker execution mode.
    //
    // Taker orders (exits, urgent signals) fill immediately at order.price +
    // slippage. This is the previous default behavior.
    //
    // Maker orders (entries) only fill if the book has crossed us — i.e. the
    // opposite side of the orderbook is at or better than our limit price. If
    // the book is tighter than our bid, we don't fill, return null, and the
    // engine treats this as "order still resting." Next scan cycle reprices.
    //
    // This teaches R&D the real fill-rate cost of maker-only execution. If
    // we always instant-filled maker orders in paper, R&D would claim a
    // +1.12% edge that prod couldn't actually capture because prod would
    // frequently miss fills.
    //
    // Fallback: if we have no orderbook snapshot (first-sight market, WS
    // feed down, etc.), err on the side of filling. The logs will show the
    // fallback path so we can measure its frequency.
    if (order.execution_mode === 'maker' && market) {
      const book = this.marketCache.getOrderbook(order.token_id);
      if (book) {
        const crossed =
          order.side === 'BUY'
            ? book.best_ask !== null && book.best_ask <= order.price
            : book.best_bid !== null && book.best_bid >= order.price;
        if (!crossed) {
          log.debug(
            {
              order_id: order.order_id,
              side: order.side,
              limit: order.price,
              best_bid: book.best_bid,
              best_ask: book.best_ask,
            },
            'Maker order did not cross book — no fill',
          );
          return null;
        }
      }
    }

    // Apply slippage to get realistic fill price
    let fillPrice = order.price;
    fillPrice = applySlippage(fillPrice, this.slippageBps, order.side === 'BUY');
    fillPrice = roundTo(Math.max(0.01, Math.min(0.99, fillPrice)), 4);

    // Determine outcome from token
    let outcome: Outcome = 'YES';
    if (market) {
      outcome = order.token_id === market.token_yes_id ? 'YES' : 'NO';
    }

    const fillSize = order.remaining_size;
    const usdcSize = roundTo(fillPrice * fillSize, 4);
    // Fee model: Polymarket taker fees (live since 2026-03-30).
    // Formula: fee = shares × feeRate × price × (1 − price).
    // feeRate is the category coefficient from the CLOB API's taker_base_fee.
    // Safety: if the raw value is > 0.5, it's the old scaled-integer bug — clamp to 0.
    // History: see clob-router.ts for the full $51K fee bug post-mortem.
    const rawFeeRate = market?.taker_fee ?? 0;
    const safeFeeRate = rawFeeRate > 0.5 ? 0 : rawFeeRate;
    const feeUsdc = roundTo(fillSize * safeFeeRate * fillPrice * (1 - fillPrice), 4);
    const netUsdc = order.side === 'BUY'
      ? roundTo(usdcSize + feeUsdc, 4)     // buying costs more
      : roundTo(usdcSize - feeUsdc, 4);    // selling nets less

    const fill: OrderFill = {
      trade_id: `paper_fill_${nanoid(12)}`,
      order_id: order.order_id!,
      entity_slug: order.entity_slug,
      condition_id: order.condition_id,
      token_id: order.token_id,
      tx_hash: null, // paper trades have no on-chain tx
      side: order.side,
      size: fillSize,
      price: fillPrice,
      usdc_size: usdcSize,
      fee_usdc: feeUsdc,
      net_usdc: netUsdc,
      is_paper: true,
      strategy_id: order.strategy_id,
      sub_strategy_id: order.sub_strategy_id,
      outcome,
      market_question: market?.question ?? '',
      market_slug: market?.market_slug ?? '',
      timestamp: Math.floor(Date.now() / 1000),
    };

    log.info({
      order_id: order.order_id,
      side: order.side,
      fill_price: fillPrice,
      slippage_bps: this.slippageBps,
      size: fillSize,
      usdc: usdcSize,
      fee: feeUsdc,
    }, 'Paper fill simulated');

    return fill;
  }
}
